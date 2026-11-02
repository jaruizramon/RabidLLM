/**
 * `deps`: resolved dependency versions and installed-source symbol lookup.
 *
 * The oracle is the lockfile, never the registry head. A model that writes an
 * API from memory against the latest docs is wrong the moment the project pins
 * an older major — the axum 0.6 project edited with 0.7/0.8 idioms is the
 * canonical failure. `resolve` reports what is actually installed and, more
 * importantly, which packages appear under more than one major; `api` answers
 * "does this symbol exist in the version I have?" from the source on disk, so
 * it works offline and cannot drift from the build.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from ".";
import depsDescription from "../prompts/tools/deps.md" with { type: "text" };

const depsSchema = type({
	op: type
		.enumerated("resolve", "api")
		.describe(
			"`resolve` reports installed versions and duplicate majors; `api` finds a symbol in the installed source",
		),
	"path?": type("string").describe("project directory (default: the session cwd)"),
	"ecosystem?": type.enumerated("cargo", "npm").describe("force an ecosystem instead of detecting it"),
	"package?": type("string").describe("`api`: package name as it appears in the lockfile"),
	"symbol?": type("string").describe("`api`: type, function, trait, or export name to locate"),
	"context?": type("number").describe("`api`: source lines kept around each match (default 2)"),
	"limit?": type("number").describe("`api`: maximum matches returned (default 8)"),
});

type DepsParams = typeof depsSchema.infer;
export type DependencyEcosystem = "cargo" | "npm";

export interface ResolvedDependency {
	readonly name: string;
	readonly version: string;
	/** Names this package depends on, when the lockfile records the edges. */
	readonly dependsOn?: readonly string[];
}

export interface DuplicateMajor {
	readonly name: string;
	readonly versions: readonly string[];
	/** Packages that depend on it; the bridges that matter rank first. */
	readonly dependents: number;
	/** Whether the manifest declares it directly (ranked above transitive noise). */
	readonly direct: boolean;
}

export interface DirectDependency {
	readonly name: string;
	readonly declared?: string;
	readonly resolved?: string;
}

export interface DependencyReport {
	readonly ecosystem: DependencyEcosystem;
	/** Every resolved package, direct and transitive. */
	readonly packages: readonly ResolvedDependency[];
	/** Lockfile path relative to the project directory. */
	readonly source: string;
	readonly total: number;
	readonly direct: readonly DirectDependency[];
	readonly duplicates: readonly DuplicateMajor[];
}

export interface SymbolMatch {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

export interface DepsToolDetails {
	readonly op: string;
	readonly ecosystem?: DependencyEcosystem;
	readonly source?: string;
	readonly duplicates?: readonly string[];
	readonly matches?: readonly SymbolMatch[];
}

const DEFAULT_CONTEXT = 2;
const MAX_CONTEXT = 6;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const MAX_FILE_BYTES = 1_048_576;
const MAX_FILES = 4_000;
const MAX_VERSIONS_PER_PACKAGE = 3;
const MAX_OUTPUT_LINES = 180;
const MAX_DUPLICATE_LINES = 12;
const MAX_LINE_CHARS = 220;
const MAX_SEARCH_DIRS = 40;

const SKIP_DIRS: Readonly<Record<DependencyEcosystem, Readonly<Record<string, true>>>> = {
	cargo: { ".git": true, target: true },
	npm: { ".git": true, node_modules: true },
};

const SOURCE_EXTENSIONS: Readonly<Record<DependencyEcosystem, readonly string[]>> = {
	cargo: [".rs"],
	npm: [".d.ts", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"],
};

/**
 * Semver "breaking" bucket: the major, except below 1.0 where the minor is the
 * breaking component (0.4 and 0.6 are as incompatible as 1.x and 2.x).
 */
export function majorOf(version: string): string {
	const normalized = version.trim().replace(/^[v=^~]+/, "");
	const [major, minor] = normalized.split(".");
	if (major === undefined) return normalized;
	if (major !== "0") return major;
	return minor === undefined ? "0" : `0.${minor}`;
}

/** `[[package]]` entries of a Cargo.lock. */
export function parseCargoLock(text: string): ResolvedDependency[] {
	const document = Bun.TOML.parse(text) as {
		package?: Array<{ name?: unknown; version?: unknown; dependencies?: unknown }>;
	};
	const packages = Array.isArray(document.package) ? document.package : [];
	const out: ResolvedDependency[] = [];
	for (const entry of packages) {
		if (typeof entry.name !== "string" || typeof entry.version !== "string") continue;
		const dependsOn = Array.isArray(entry.dependencies)
			? entry.dependencies
					.filter((dependency): dependency is string => typeof dependency === "string")
					.map(dependency => dependency.split(" ")[0]!)
			: undefined;
		out.push({ name: entry.name, version: entry.version, dependsOn });
	}
	return out;
}

/** Declared requirements from the dependency tables of a Cargo.toml. */
export function parseCargoManifest(text: string): Record<string, string> {
	const document = Bun.TOML.parse(text) as Record<string, unknown>;
	const out: Record<string, string> = {};
	for (const table of ["dependencies", "dev-dependencies", "build-dependencies", "workspace"]) {
		const block = document[table];
		if (!block || typeof block !== "object") continue;
		const deps = table === "workspace" ? (block as Record<string, unknown>).dependencies : block;
		if (!deps || typeof deps !== "object") continue;
		for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
			if (typeof value === "string") out[name] = value;
			else if (value && typeof value === "object" && "version" in value) {
				const version = (value as { version?: unknown }).version;
				if (typeof version === "string") out[name] = version;
			}
		}
	}
	return out;
}

/** Resolved `node_modules` entries of a package-lock.json (v2/v3 `packages`, v1 `dependencies`). */
export function parsePackageLock(text: string): ResolvedDependency[] {
	const document = JSON.parse(text) as {
		packages?: Record<string, { version?: unknown; dependencies?: unknown; peerDependencies?: unknown }>;
		dependencies?: Record<string, { version?: unknown }>;
	};
	const out: ResolvedDependency[] = [];
	if (document.packages) {
		for (const [key, entry] of Object.entries(document.packages)) {
			if (!key.startsWith("node_modules/")) continue;
			const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
			if (!name || typeof entry?.version !== "string") continue;
			const edges = [entry.dependencies, entry.peerDependencies].flatMap(block =>
				block && typeof block === "object" ? Object.keys(block as Record<string, unknown>) : [],
			);
			out.push({ name, version: entry.version, dependsOn: edges.length > 0 ? edges : undefined });
		}
		return out;
	}
	for (const [name, entry] of Object.entries(document.dependencies ?? {})) {
		if (typeof entry?.version === "string") out.push({ name, version: entry.version });
	}
	return out;
}

/** Declared ranges from package.json (dependencies + devDependencies). */
export function parsePackageManifest(text: string): Record<string, string> {
	const document = JSON.parse(text) as Record<string, unknown>;
	const out: Record<string, string> = {};
	for (const table of ["dependencies", "devDependencies", "peerDependencies"]) {
		const block = document[table];
		if (!block || typeof block !== "object") continue;
		for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
			if (typeof value === "string") out[name] = value;
		}
	}
	return out;
}

/** Packages installed under more than one breaking-version bucket. */
export function findDuplicateMajors(
	dependencies: readonly ResolvedDependency[],
	declared: Readonly<Record<string, string>> = {},
): DuplicateMajor[] {
	const versionsByName = new Map<string, Set<string>>();
	for (const dependency of dependencies) {
		let versions = versionsByName.get(dependency.name);
		if (!versions) {
			versions = new Set();
			versionsByName.set(dependency.name, versions);
		}
		versions.add(dependency.version);
	}
	const dependents = new Map<string, number>();
	for (const dependency of dependencies) {
		for (const target of dependency.dependsOn ?? []) {
			dependents.set(target, (dependents.get(target) ?? 0) + 1);
		}
	}
	const duplicates: DuplicateMajor[] = [];
	for (const [name, versions] of versionsByName) {
		const majors = new Set([...versions].map(majorOf));
		if (majors.size < 2) continue;
		duplicates.push({
			name,
			versions: [...versions].sort(),
			dependents: dependents.get(name) ?? 0,
			direct: declared[name] !== undefined,
		});
	}
	// A package the manifest declares directly is the one being reasoned about;
	// after that, the bridges (http, hyper, tower) outrank platform-only noise.
	return duplicates.sort(
		(left, right) =>
			Number(right.direct) - Number(left.direct) ||
			right.dependents - left.dependents ||
			left.name.localeCompare(right.name),
	);
}

/** Combined report for one lockfile. */
export function buildDependencyReport(
	ecosystem: DependencyEcosystem,
	source: string,
	dependencies: readonly ResolvedDependency[],
	declared: Readonly<Record<string, string>>,
): DependencyReport {
	const byName = new Map<string, string[]>();
	for (const dependency of dependencies) {
		const versions = byName.get(dependency.name);
		if (versions) versions.push(dependency.version);
		else byName.set(dependency.name, [dependency.version]);
	}
	const direct: DirectDependency[] = Object.keys(declared)
		.sort()
		.map(name => {
			const versions = byName.get(name);
			return {
				name,
				declared: declared[name],
				resolved: versions ? [...versions].sort().join(", ") : undefined,
			};
		});
	return {
		ecosystem,
		source,
		packages: dependencies,
		total: dependencies.length,
		direct,
		duplicates: findDuplicateMajors(dependencies, declared),
	};
}

/** Pattern matching a definition of `symbol` inside one ecosystem's source. */
export function buildSymbolMatcher(ecosystem: DependencyEcosystem, symbol: string): RegExp {
	const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (ecosystem === "cargo") {
		return new RegExp(
			`\\b(?:` +
				`pub\\s+(?:async\\s+)?fn\\s+${escaped}\\b` +
				`|pub\\s+(?:struct|enum|trait|type|const|static|union)\\s+${escaped}\\b` +
				`|impl(?:\\s*<[^>]*>)?\\s+${escaped}\\b` +
				`|macro_rules!\\s*${escaped}\\b` +
				`)`,
		);
	}
	return new RegExp(
		`\\b(?:` +
			`export\\s+(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:class|function|const|let|var|interface|type|enum)\\s+${escaped}\\b` +
			`|(?:class|function|interface|type|enum)\\s+${escaped}\\b` +
			`|exports\\.${escaped}\\b` +
			`)`,
	);
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

interface LockfileEntry {
	readonly ecosystem: DependencyEcosystem;
	readonly lockfile: string;
	readonly manifest: string;
}

/** Lockfiles in `directory`, or in its immediate children when it is a monorepo root. */
async function findLockfiles(directory: string): Promise<LockfileEntry[]> {
	const found: LockfileEntry[] = [];
	const scan = async (base: string, prefix: string, depth: number) => {
		const candidates: Array<[DependencyEcosystem, string, string]> = [
			["cargo", "Cargo.lock", "Cargo.toml"],
			["npm", "package-lock.json", "package.json"],
		];
		for (const [ecosystem, lockfile, manifest] of candidates) {
			const lockPath = path.join(base, lockfile);
			if (await exists(lockPath)) {
				found.push({ ecosystem, lockfile: path.join(prefix, lockfile), manifest: path.join(prefix, manifest) });
			}
		}
		if (found.length > 0 || depth > 0) return;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(base, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.slice(0, 20)) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			await scan(path.join(base, entry.name), entry.name, depth + 1);
		}
	};
	await scan(directory, "", 0);
	return found;
}

async function readIfPresent(target: string): Promise<string | undefined> {
	try {
		return await Bun.file(target).text();
	} catch {
		return undefined;
	}
}

async function resolveReports(projectDir: string, ecosystem?: DependencyEcosystem): Promise<DependencyReport[]> {
	const lockfiles = (await findLockfiles(projectDir)).filter(
		entry => ecosystem === undefined || entry.ecosystem === ecosystem,
	);
	const reports: DependencyReport[] = [];
	for (const entry of lockfiles) {
		const lockText = await readIfPresent(path.join(projectDir, entry.lockfile));
		if (!lockText) continue;
		const manifestText = await readIfPresent(path.join(projectDir, entry.manifest));
		if (entry.ecosystem === "cargo") {
			reports.push(
				buildDependencyReport(
					"cargo",
					entry.lockfile,
					parseCargoLock(lockText),
					manifestText ? parseCargoManifest(manifestText) : {},
				),
			);
		} else {
			reports.push(
				buildDependencyReport(
					"npm",
					entry.lockfile,
					parsePackageLock(lockText),
					manifestText ? parsePackageManifest(manifestText) : {},
				),
			);
		}
	}
	return reports;
}

async function collectSourceFiles(
	root: string,
	ecosystem: DependencyEcosystem,
): Promise<{ files: string[]; searched: number }> {
	const extensions = SOURCE_EXTENSIONS[ecosystem];
	const skip = SKIP_DIRS[ecosystem];
	const files: string[] = [];
	const stack = [root];
	let visited = 0;
	while (stack.length > 0 && files.length < MAX_FILES && visited < MAX_SEARCH_DIRS) {
		const current = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		visited++;
		for (const entry of entries) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (!skip[entry.name]) stack.push(absolute);
				continue;
			}
			if (!extensions.some(extension => entry.name.endsWith(extension))) continue;
			files.push(absolute);
			if (files.length >= MAX_FILES) break;
		}
	}
	return { files, searched: visited };
}

function clipLine(line: string): string {
	const trimmed = line.replace(/\s+$/, "");
	return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed;
}

async function searchSymbol(
	files: readonly string[],
	matcher: RegExp,
	context: number,
	limit: number,
): Promise<SymbolMatch[]> {
	const matches: SymbolMatch[] = [];
	for (const file of files) {
		let stat: Stats;
		try {
			stat = await fs.stat(file);
		} catch {
			continue;
		}
		if (stat.size > MAX_FILE_BYTES) continue;
		let text: string;
		try {
			text = await Bun.file(file).text();
		} catch {
			continue;
		}
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index++) {
			if (!matcher.test(lines[index]!)) continue;
			const start = Math.max(0, index - context);
			const end = Math.min(lines.length, index + context + 1);
			const snippet = lines
				.slice(start, end)
				.map(line => clipLine(line))
				.join("\n");
			matches.push({ file, line: index + 1, text: snippet });
			if (matches.length >= limit) return matches;
		}
	}
	return matches;
}

async function locatePackageSources(
	projectDir: string,
	ecosystem: DependencyEcosystem,
	name: string,
	versions: readonly string[],
): Promise<Array<{ version: string; root: string }>> {
	const located: Array<{ version: string; root: string }> = [];
	if (ecosystem === "cargo") {
		const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
		const registryRoot = path.join(cargoHome, "registry", "src");
		let indexes: string[] = [];
		try {
			indexes = await fs.readdir(registryRoot);
		} catch {
			indexes = [];
		}
		const vendor = path.join(projectDir, "vendor");
		for (const version of versions) {
			if (await exists(vendor)) {
				const vendored = path.join(vendor, name);
				if (await exists(path.join(vendored, "src"))) {
					located.push({ version, root: path.join(vendored, "src") });
					continue;
				}
			}
			for (const index of indexes) {
				const root = path.join(registryRoot, index, `${name}-${version}`, "src");
				if (await exists(root)) {
					located.push({ version, root });
					break;
				}
			}
		}
		return located;
	}
	const candidates = [path.join(projectDir, "node_modules", name)];
	for (const candidate of candidates) {
		if (await exists(candidate)) {
			located.push({ version: versions[0] ?? "unknown", root: candidate });
		}
	}
	return located;
}

function renderReport(report: DependencyReport): string[] {
	const lines: string[] = [];
	const duplicateNames = new Set(report.duplicates.map(duplicate => duplicate.name));
	lines.push(`${report.ecosystem} — ${report.source} (${report.total} packages)`);
	if (report.duplicates.length > 0) {
		lines.push("duplicate majors (two breaking generations installed at once):");
		for (const duplicate of report.duplicates.slice(0, MAX_DUPLICATE_LINES)) {
			const majors = [...new Set(duplicate.versions.map(majorOf))].join(" / ");
			const suffix = duplicate.direct ? "  ← declared here" : `  (${duplicate.dependents} dependents)`;
			lines.push(`  ${duplicate.name.padEnd(24)} ${duplicate.versions.join(", ")}  [${majors}]${suffix}`);
		}
		if (report.duplicates.length > MAX_DUPLICATE_LINES) {
			lines.push(`  … ${report.duplicates.length - MAX_DUPLICATE_LINES} more duplicate package(s)`);
		}
	} else {
		lines.push("duplicate majors: none");
	}
	if (report.direct.length > 0) {
		lines.push("direct dependencies (declared → resolved):");
		for (const dependency of report.direct) {
			const resolved = dependency.resolved ?? "MISSING from lockfile";
			const marker = duplicateNames.has(dependency.name) ? "  ← duplicate majors" : "";
			lines.push(`  ${dependency.name.padEnd(24)} ${dependency.declared ?? "?"} → ${resolved}${marker}`);
		}
	}
	return lines;
}

export class DepsTool implements AgentTool<typeof depsSchema, DepsToolDetails> {
	readonly name = "deps";
	readonly approval = "read" as const;
	readonly label = "Deps";
	readonly summary = "Resolved dependency versions, duplicate majors, and installed-source symbol lookup";
	readonly description: string;
	readonly parameters = depsSchema;
	readonly strict = true;
	readonly concurrency = "shared";
	// Top-level like `calculate`: the model must reach for it before writing an
	// API from memory, not after discovering xd:// devices.
	readonly loadMode = "essential";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(depsDescription);
	}

	async execute(
		_toolCallId: string,
		params: DepsParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<DepsToolDetails>> {
		try {
			const projectDir = path.resolve(this.session.cwd, params.path ?? ".");
			if (params.op === "resolve") return await this.#resolve(projectDir, params.ecosystem);
			return await this.#api(projectDir, params, signal);
		} catch (error) {
			return {
				content: [{ type: "text", text: `deps: ${error instanceof Error ? error.message : String(error)}` }],
				details: { op: params.op },
				isError: true,
			};
		}
	}

	async #resolve(projectDir: string, ecosystem?: DependencyEcosystem): Promise<AgentToolResult<DepsToolDetails>> {
		const reports = await resolveReports(projectDir, ecosystem);
		if (reports.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `deps: no Cargo.lock or package-lock.json under ${projectDir} (or its immediate children)`,
					},
				],
				details: { op: "resolve" },
				isError: true,
			};
		}
		const lines: string[] = [];
		for (const report of reports) {
			if (lines.length > 0) lines.push("");
			lines.push(...renderReport(report));
		}
		const duplicates = reports.flatMap(report => report.duplicates.map(duplicate => duplicate.name));
		return {
			content: [{ type: "text", text: lines.slice(0, MAX_OUTPUT_LINES).join("\n") }],
			details: {
				op: "resolve",
				ecosystem: reports[0]!.ecosystem,
				source: reports[0]!.source,
				duplicates,
			},
		};
	}

	async #api(projectDir: string, params: DepsParams, signal?: AbortSignal): Promise<AgentToolResult<DepsToolDetails>> {
		const name = params.package?.trim();
		const symbol = params.symbol?.trim();
		if (!name || !symbol) {
			return {
				content: [{ type: "text", text: "deps api: `package` and `symbol` are required" }],
				details: { op: "api" },
				isError: true,
			};
		}
		const context = Math.min(MAX_CONTEXT, Math.max(0, Math.trunc(params.context ?? DEFAULT_CONTEXT)));
		const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)));
		const reports = await resolveReports(projectDir, params.ecosystem);
		const report =
			reports.find(candidate => candidate.packages.some(dependency => dependency.name === name)) ?? reports[0];
		if (!report) {
			return {
				content: [{ type: "text", text: `deps api: no lockfile under ${projectDir}` }],
				details: { op: "api" },
				isError: true,
			};
		}
		const versions = [
			...new Set(
				report.packages.filter(dependency => dependency.name === name).map(dependency => dependency.version),
			),
		];
		if (versions.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `deps api: ${name} is not in ${report.source}; run \`deps resolve\` for the packages that are`,
					},
				],
				details: { op: "api", ecosystem: report.ecosystem },
				isError: true,
			};
		}
		const sources = await locatePackageSources(
			projectDir,
			report.ecosystem,
			name,
			versions.slice(0, MAX_VERSIONS_PER_PACKAGE),
		);
		if (sources.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `deps api: ${name} ${versions.join(", ")} is in ${report.source} but its source is not on disk (build once, or vendor it)`,
					},
				],
				details: { op: "api", ecosystem: report.ecosystem, source: report.source },
				isError: true,
			};
		}
		const matcher = buildSymbolMatcher(report.ecosystem, symbol);
		const lines: string[] = [];
		const matches: SymbolMatch[] = [];
		for (const source of sources) {
			if (signal?.aborted) break;
			const { files, searched } = await collectSourceFiles(source.root, report.ecosystem);
			const found = await searchSymbol(files, matcher, context, Math.max(1, limit - matches.length));
			lines.push(`${name} ${source.version} — ${shortenPath(source.root)}`);
			if (found.length === 0) {
				lines.push(
					`  no definition of "${symbol}" in this version (searched ${files.length} files in ${searched} dirs)`,
				);
				lines.push(`  the symbol may belong to another version; \`deps resolve\` lists what is installed`);
			} else {
				for (const match of found) {
					const relative = path.relative(source.root, match.file);
					lines.push(`  ${relative}:${match.line}`);
					for (const line of match.text.split("\n")) lines.push(`    ${line}`);
					matches.push({ file: path.relative(projectDir, match.file), line: match.line, text: match.text });
				}
			}
			if (matches.length >= limit) break;
		}
		return {
			content: [{ type: "text", text: lines.slice(0, MAX_OUTPUT_LINES).join("\n") }],
			details: { op: "api", ecosystem: report.ecosystem, source: report.source, matches },
		};
	}
}
