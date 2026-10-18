/**
 * `/models-worker` — manage the CPU SmolLM3 worker that maintains the
 * background handoff for the `slm` compaction method.
 *
 * The command owns provisioning and selection only: it never touches the
 * session's main model, the model catalog, or the V100 router (which admits one
 * resident model at a time and would evict the main model for a CPU worker).
 */
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { $which } from "@oh-my-pi/pi-utils";
import {
	cfgCompactionMethodOrder,
	cfgSlmHandoffDevice,
	cfgSlmHandoffGpuFreeMiB,
	cfgSlmHandoffGpuLayers,
	cfgSlmHandoffModelPath,
	cfgSlmHandoffReasoningBudgetTokens,
	cfgSlmHandoffThreads,
} from "../session/context-settings";
import {
	DEFAULT_COMPACTION_METHOD_ORDER,
	resolveCompactionMethodOrder,
	withSlmFirst,
} from "../session/compaction-methods";
import {
	ensureSlmModelDownloaded,
	resolveSlmModelPath,
	resolveSlmServerConfig,
	resolveSlmThreads,
	slmHandoffFilePaths,
} from "../session/slm-handoff";
import { SlmHandoffServer, type SlmServerStatus } from "../session/slm-server";
import { expandTilde } from "../tools/path-utils";
import { commandConsumed } from "./helpers/parse";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

interface ModelsWorkerDeps {
	session: AgentSession;
	settings: Settings;
	cwd: string;
	output: (text: string) => void;
}

/** The GGUF `/models-worker` can fetch by name; other paths are user-supplied. */
const DEFAULT_WORKER_MODEL_FILE = "SmolLM3-Q4_K_M.gguf";
const DEFAULT_WORKER_MODEL_REPO = "ggml-org/SmolLM3-3B-GGUF";

function compactionMethodLine(settings: Settings): string {
	const order = resolveCompactionMethodOrder(cfgCompactionMethodOrder.get(settings));
	const position = order.indexOf("slm");
	if (position === 0) return "Compaction method: slm is first in compaction.methodOrder";
	if (position > 0) return `Compaction method: slm is at position ${position + 1} in compaction.methodOrder`;
	return "Compaction method: slm is not in compaction.methodOrder";
}

function describeStatus(status: SlmServerStatus, deps: ModelsWorkerDeps): string {
	const paths = slmHandoffFilePaths(deps.settings.getAgentDir(), deps.session.sessionId);
	const lines = [
		`Worker SLM: running (pid ${status.pid ?? "?"}, 127.0.0.1:${status.port ?? "?"})`,
		`Model: ${status.modelPath ?? resolveSlmModelPath(cfgSlmHandoffModelPath.get(deps.settings))}`,
		`Context: ${status.ctxSize ?? "?"} · Threads: ${status.threads ?? "?"} · Reasoning budget: ${status.reasoningBudgetTokens ?? "?"}`,
		`Worker: ${status.external ? "adopted (not owned by this session)" : "spawned by the harness"}`,
		`Device: ${status.device ?? "?"} · GPU layers: ${status.gpuLayers ?? "?"}${status.device?.startsWith("cuda") ? ` · Leaves ${cfgSlmHandoffGpuFreeMiB.get(deps.settings)} MiB free` : ""}`,
		`Handoff RAM: ${paths.ram}`,
		`Handoff disk: ${paths.disk}`,
	];
	return lines.join("\n");
}

function printStatus(deps: ModelsWorkerDeps): void {
	const status = SlmHandoffServer.global().status();
	if (status.running) {
		deps.output(`${describeStatus(status, deps)}\n${compactionMethodLine(deps.settings)}`);
		return;
	}
	const modelPath = resolveSlmModelPath(cfgSlmHandoffModelPath.get(deps.settings));
	const present = fsSync.existsSync(modelPath);
	const fileName = path.basename(modelPath);
	const lines = [
		"Worker SLM: stopped",
		`Model: ${modelPath}`,
		`Model file: ${present ? "present" : "missing"}`,
		`Threads: ${resolveSlmThreads(cfgSlmHandoffThreads.get(deps.settings))} · Reasoning budget: ${cfgSlmHandoffReasoningBudgetTokens.get(deps.settings)}`,
		`Device: ${cfgSlmHandoffDevice.get(deps.settings)} · GPU layers: ${cfgSlmHandoffGpuLayers.get(deps.settings) === -1 ? "auto" : cfgSlmHandoffGpuLayers.get(deps.settings)}`,
		`GPU headroom: leave ${cfgSlmHandoffGpuFreeMiB.get(deps.settings)} MiB free (${cfgSlmHandoffGpuFreeMiB.get(deps.settings) < 0 ? "auto-fit off" : "auto-fit on"})`,
		compactionMethodLine(deps.settings),
	];
	if (!present) {
		const hf = $which("hf");
		// Only the default GGUF has a known upstream repo to fetch by name.
		const repo = fileName === DEFAULT_WORKER_MODEL_FILE ? DEFAULT_WORKER_MODEL_REPO : "<repo>";
		lines.push(
			hf
				? `Download: ${hf} download ${repo} ${fileName} --local-dir ${path.dirname(modelPath)}`
				: "Download: pip install -U huggingface_hub, then rerun /models-worker",
		);
	}
	deps.output(lines.join("\n"));
}

async function loadWorker(deps: ModelsWorkerDeps): Promise<void> {
	const modelPath = resolveSlmModelPath(cfgSlmHandoffModelPath.get(deps.settings));
	await ensureSlmModelDownloaded(modelPath, deps.output);
	const order = resolveCompactionMethodOrder(cfgCompactionMethodOrder.get(deps.settings));
	const next = withSlmFirst(order);
	if (next.length !== order.length || next.some((method, index) => method !== order[index])) {
		cfgCompactionMethodOrder.set(deps.settings, next);
	}
	const config = resolveSlmServerConfig(deps.settings, deps.session.model?.contextWindow);
	const status = await SlmHandoffServer.global().preload(config, { download: false, output: deps.output });
	deps.output(`${describeStatus(status, deps)}\n${compactionMethodLine(deps.settings)}`);
}

async function unloadWorker(deps: ModelsWorkerDeps): Promise<void> {
	await SlmHandoffServer.global().unload();
	const remaining = resolveCompactionMethodOrder(cfgCompactionMethodOrder.get(deps.settings)).filter(
		method => method !== "slm",
	);
	// Undo exactly what `load` did: `slm` goes, and the fallback it appended is
	// dropped too, so a user who only ever selected `slm` lands back on the default
	// order instead of on a lone `handoff` they never chose.
	const injectedFallbackOnly = remaining.length === 1 && remaining[0] === "handoff";
	cfgCompactionMethodOrder.set(
		deps.settings,
		remaining.length === 0 || injectedFallbackOnly ? [...DEFAULT_COMPACTION_METHOD_ORDER] : remaining,
	);
	deps.output("Worker SLM stopped; slm removed from compaction.methodOrder.");
}

/** Accept a GGUF path as the argument and make it the configured worker model. */
function configureModelPath(raw: string, deps: ModelsWorkerDeps): void {
	const expanded = expandTilde(raw);
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(deps.cwd, expanded);
	if (!resolved.toLowerCase().endsWith(".gguf")) {
		throw new Error(`Not a GGUF model file: ${raw}`);
	}
	cfgSlmHandoffModelPath.set(deps.settings, resolved);
}

/** Shared body for the text/ACP and TUI handlers. */
async function runModelsWorker(arg: string, deps: ModelsWorkerDeps): Promise<void> {
	const action = arg.trim();
	if (action === "status") {
		printStatus(deps);
		return;
	}
	if (action === "unload") {
		await unloadWorker(deps);
		return;
	}
	if (action !== "" && action !== "load") configureModelPath(action, deps);
	await loadWorker(deps);
}

async function runReporting(arg: string, deps: ModelsWorkerDeps): Promise<void> {
	try {
		await runModelsWorker(arg, deps);
	} catch (error) {
		deps.output(error instanceof Error ? error.message : String(error));
	}
}

export const BUILTIN_WORKER_MODEL_SLASH_COMMANDS: SlashCommandSpec[] = [
	{
		name: "models-worker",
		icon: "model",
		description: "Load or unload the CPU SmolLM3 worker that maintains the background compaction handoff",
		allowArgs: true,
		inlineHint: "[status|unload|<gguf-path>]",
		subcommands: [
			{ name: "status", description: "Show worker server, model, and compaction-method state" },
			{ name: "unload", description: "Stop the worker and remove the SLM method from compaction" },
		],
		subcommandOptional: true,
		handle: async (command: ParsedSlashCommand, runtime): Promise<SlashCommandResult> => {
			await runReporting(command.args, {
				session: runtime.session,
				settings: runtime.settings,
				cwd: runtime.cwd,
				output: text => void runtime.output(text),
			});
			return commandConsumed();
		},
		handleTui: async (command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): Promise<SlashCommandResult> => {
			await runReporting(command.args, {
				session: runtime.ctx.session,
				settings: runtime.ctx.settings,
				cwd: runtime.ctx.session.sessionManager.getCwd(),
				output: text => runtime.ctx.showStatus(text),
			});
			return commandConsumed();
		},
	},
];
