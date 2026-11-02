/**
 * `--resume-stream`: host the interactive TUI in a `screen` session that the
 * Rabid web terminal (ttyd + `tailscale serve`) can attach to.
 *
 * The web picker names a directory's shell session `term-<sha1(dir)[:10]>` and
 * attaches it by that name. The agent hosts itself as `rabid-<sha1(dir)[:10]>`
 * so a leftover shell session never swallows the resume; the installed
 * `rabid-session` wrapper prefers the `rabid-` name when it exists.
 *
 * `screen` holds the terminal, not this process: detaching (Ctrl-A D) returns
 * here and the TUI keeps running for the next attached viewer (the phone).
 */
import { $ } from "bun";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, logger } from "@oh-my-pi/pi-utils";
import { CliUsageError } from "../cli/usage-error";
import { resolveCliEntryCmd } from "../subprocess/worker-client";

/** The hosting flag. The inner (screen-hosted) launch runs without it. */
export const HOSTED_SESSION_FLAG = "--resume-stream";

const SCREEN_HASH_LENGTH = 10;
const RABID_WEB_DIR = path.join(os.homedir(), ".local", "share", "rabid-web");
const URL_FILE = path.join(RABID_WEB_DIR, "stream-last-url");

export interface HostedSessionPlan {
	screenName: string;
	argv: string[];
	cwd: string;
}

/**
 * Screen session name for a project directory.
 *
 * Must stay byte-identical to the picker's hash input (`os.path.realpath` →
 * sha1 → first 10 hex), because the web wrapper attaches by this name.
 */
export function hostedScreenName(projectDir: string): string {
	return `rabid-${createHash("sha1").update(projectDir).digest("hex").slice(0, SCREEN_HASH_LENGTH)}`;
}

/**
 * The launch argv for the hosted process: the same invocation with the hosting
 * flag removed, so the inner CLI runs the normal interactive resume instead of
 * spawning a second screen.
 *
 * A bare `--resume-stream` means "put me back on my last session", so it becomes
 * `--continue` when no session selector is present. `continueRecent` starts a
 * fresh session when the directory has none.
 */
export function innerLaunchArgv(rawArgs: readonly string[]): string[] {
	const stripped = rawArgs.filter(arg => arg !== HOSTED_SESSION_FLAG && !arg.startsWith(`${HOSTED_SESSION_FLAG}=`));
	const hasSessionSelector = stripped.some(
		arg => SESSION_SELECTOR_FLAGS[arg] === true || SESSION_SELECTOR_PREFIXES.some(prefix => arg.startsWith(prefix)),
	);
	return hasSessionSelector ? stripped : [...stripped, "--continue"];
}

/** Flags that already choose the session to resume (`--resume`, `-c`, …). */
const SESSION_SELECTOR_FLAGS: Readonly<Record<string, true>> = {
	"--resume": true,
	"-r": true,
	"--restore": true,
	"--session": true,
	"--continue": true,
	"-c": true,
	"--fork": true,
	"--from-claude": true,
	"--from-codex": true,
};

const SESSION_SELECTOR_PREFIXES = ["--resume=", "--restore=", "--session=", "--fork="] as const;

/** Pure plan builder; the caller resolves the screen binary and real path. */
export function buildHostedSessionPlan(options: {
	projectDir: string;
	screenPath: string;
	innerArgv: readonly string[];
}): HostedSessionPlan {
	const screenName = hostedScreenName(options.projectDir);
	return {
		screenName,
		argv: [options.screenPath, "-c", "/dev/null", "-D", "-R", screenName, ...options.innerArgv],
		cwd: options.projectDir,
	};
}

async function gatewayRunning(): Promise<boolean> {
	const [term, picker] = await Promise.all([
		$`systemctl --user is-active --quiet rabid-web-term`.quiet().nothrow(),
		$`systemctl --user is-active --quiet rabid-web-picker`.quiet().nothrow(),
	]);
	return term.exitCode === 0 && picker.exitCode === 0;
}

/** Start the installed gateway when it is not already serving; never fatal. */
async function ensureGateway(): Promise<boolean> {
	if (await gatewayRunning()) return true;
	if (!$which("rabid-web")) return false;
	logger.debug("--resume-stream: starting rabid-web gateway");
	const started = await $`rabid-web start`.quiet().nothrow();
	return started.exitCode === 0;
}

async function tailnetHost(): Promise<string> {
	const status = await $`tailscale status --json`.quiet().nothrow();
	if (status.exitCode === 0) {
		try {
			const dns = JSON.parse(status.text())?.Self?.DNSName;
			if (typeof dns === "string" && dns.length > 0) return dns.replace(/\.$/, "");
		} catch {
			// Malformed tailnet status: fall back to the machine's hostname.
		}
	}
	return os.hostname();
}

/** `true` when this process already runs under a terminal multiplexer. */
export function insideMultiplexer(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.STY) || Boolean(env.TMUX);
}

/**
 * Host the interactive session in screen and block until it is detached.
 *
 * Returns the screen exit code. The URL is printed before the attach (screen
 * restores that screen content on detach) and written to
 * `~/.local/share/rabid-web/stream-last-url`.
 */
export async function hostInteractiveSession(options: {
	projectDir: string;
	rawArgs: readonly string[];
}): Promise<number> {
	const screenPath = $which("screen");
	if (!screenPath) {
		throw new CliUsageError(
			"--resume-stream needs `screen` to keep the session alive after you leave; install screen (e.g. `apt install screen`) and retry",
		);
	}
	const projectDir = await fs.realpath(options.projectDir);
	const plan = buildHostedSessionPlan({
		projectDir,
		screenPath,
		innerArgv: [...resolveCliEntryCmd(), ...innerLaunchArgv(options.rawArgs)],
	});

	const gateway = await ensureGateway();
	const host = await tailnetHost();
	const directUrl = `https://${host}/terminal/?arg=${encodeURIComponent(projectDir)}`;
	process.stderr.write(
		[
			`stream: screen "${plan.screenName}" — detach with Ctrl-A D; the session keeps running`,
			gateway
				? `stream: phone → https://${host}/picker/ (choose ${projectDir})`
				: `stream: gateway is not running — run \`rabid-web start\`, then open https://${host}/picker/`,
			`stream: direct → ${directUrl}`,
			"",
		].join("\n"),
	);
	await writeUrlFile(directUrl);

	const child = Bun.spawn(plan.argv, {
		cwd: plan.cwd,
		stdio: ["inherit", "inherit", "inherit"],
	});
	return await child.exited;
}

async function writeUrlFile(url: string): Promise<void> {
	try {
		await fs.mkdir(RABID_WEB_DIR, { recursive: true });
		await fs.writeFile(URL_FILE, `${url}\n`, "utf8");
	} catch (error) {
		logger.debug("--resume-stream: could not persist the terminal URL", { error: String(error) });
	}
}
