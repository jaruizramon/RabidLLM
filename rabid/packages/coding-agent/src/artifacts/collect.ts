/**
 * Discovery of visual artifacts for the `/artifacts` gallery.
 *
 * Two sources are merged:
 * - Tool calls in the session transcript: mutating tools name the exact file
 *   they wrote (`write`/`edit` details carry `resolvedPath`, `generate_image`
 *   carries `imagePaths`), including files outside the workspace such as
 *   generated images in the OS temp directory.
 * - A bounded workspace scan for visual files modified since the session
 *   began, which catches images and pages produced by `bash`/`eval` scripts
 *   whose commands never name their outputs.
 */
import * as fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type VisualArtifactKind, visualArtifactKind } from "@oh-my-pi/pi-tui/tools/artifacts";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Where the artifact was discovered. */
export type VisualArtifactSource = "tool" | "workspace";

/** One displayable file the session produced. */
export interface VisualArtifact {
	/** Absolute path. */
	readonly path: string;
	/** Path relative to the session cwd when inside it, else the absolute path. */
	readonly displayPath: string;
	readonly kind: VisualArtifactKind;
	readonly size: number;
	readonly mtimeMs: number;
	readonly source: VisualArtifactSource;
	/** Tool that reported the write, for {@link source} `"tool"`. */
	readonly tool?: string;
}

export interface CollectVisualArtifactsOptions {
	readonly messages: readonly AgentMessage[];
	readonly cwd: string;
	/** Files older than this are only shown when a tool named them. Defaults to the first message's timestamp. */
	readonly sinceMs?: number;
	/** Most artifacts to return. Defaults to 100. */
	readonly limit?: number;
}

/** Tools whose arguments or result details name files they wrote. */
const MUTATING_TOOLS: Readonly<Record<string, true>> = {
	write: true,
	edit: true,
	apply_patch: true,
	ast_edit: true,
	generate_image: true,
	image_gen: true,
};

const DEFAULT_LIMIT = 100;
const SCAN_MAX_DEPTH = 6;
const SCAN_MAX_VISITED = 20_000;
const SCAN_MAX_MATCHES = 200;
const SCAN_SKIP_DIRS: Readonly<Record<string, true>> = {
	node_modules: true,
	dist: true,
	build: true,
	out: true,
	target: true,
	coverage: true,
	__pycache__: true,
	venv: true,
	".venv": true,
	".git": true,
	".hg": true,
	".svn": true,
	".next": true,
	".nuxt": true,
	".turbo": true,
	".cache": true,
	"artifact-previews": true,
};

function displayPathFor(absolute: string, cwd: string): string {
	const relative = path.relative(path.resolve(cwd), absolute);
	if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
	return absolute;
}

/** Absolute paths a tool result's details name, limited to fields mutating tools populate. */
function pathsFromResultDetails(details: unknown): string[] {
	if (!isRecord(details)) return [];
	const paths: string[] = [];
	for (const key of ["resolvedPath", "mediaPath", "path", "filePath", "outputPath"] as const) {
		const value = details[key];
		if (typeof value === "string" && value.length > 0) paths.push(value);
	}
	for (const key of ["imagePaths", "files"] as const) {
		const value = details[key];
		if (!Array.isArray(value)) continue;
		for (const entry of value) {
			if (typeof entry === "string") paths.push(entry);
			else if (isRecord(entry) && typeof entry.path === "string") paths.push(entry.path);
		}
	}
	const images = details.images;
	if (Array.isArray(images)) {
		for (const entry of images) {
			if (isRecord(entry) && typeof entry.path === "string") paths.push(entry.path);
		}
	}
	return paths;
}

/** Paths a tool call's arguments name. */
function pathsFromToolArguments(name: string, args: unknown): string[] {
	if (!isRecord(args)) return [];
	const paths: string[] = [];
	for (const key of ["path", "file_path"] as const) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) paths.push(value);
	}
	// `apply_patch` versions that take a file list name each entry.
	const files = args.files;
	if (name === "apply_patch" && Array.isArray(files)) {
		for (const entry of files) if (typeof entry === "string") paths.push(entry);
	}
	return paths;
}

interface Candidate {
	readonly absolute: string;
	readonly tool: string;
}

/**
 * Paths named by mutating tool calls/results, in first-seen order. Failed calls
 * are dropped: a rejected write must not surface a pre-existing file.
 */
function toolArtifactCandidates(messages: readonly AgentMessage[]): Candidate[] {
	const failed = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult" || !message.isError) continue;
		failed.add(message.toolCallId);
	}

	const candidates: Candidate[] = [];
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "toolCall" || failed.has(block.id) || !Object.hasOwn(MUTATING_TOOLS, block.name))
					continue;
				for (const filePath of pathsFromToolArguments(block.name, block.arguments)) {
					candidates.push({ absolute: filePath, tool: block.name });
				}
			}
			continue;
		}
		if (message.role !== "toolResult" || message.isError || !Object.hasOwn(MUTATING_TOOLS, message.toolName))
			continue;
		for (const filePath of pathsFromResultDetails(message.details)) {
			candidates.push({ absolute: filePath, tool: message.toolName });
		}
	}
	return candidates;
}

/** Stat a candidate and turn it into a {@link VisualArtifact}, or `undefined` when it is gone/non-visual. */
async function readArtifact(
	absolutePath: string,
	cwd: string,
	source: VisualArtifactSource,
	tool: string | undefined,
): Promise<VisualArtifact | undefined> {
	if (absolutePath.includes("://")) return undefined;
	const absolute = path.isAbsolute(absolutePath) ? path.resolve(absolutePath) : path.resolve(cwd, absolutePath);
	const kind = visualArtifactKind(absolute);
	if (!kind) return undefined;
	try {
		const stat = await fs.stat(absolute);
		if (!stat.isFile()) return undefined;
		return {
			path: absolute,
			displayPath: displayPathFor(absolute, cwd),
			kind,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			source,
			tool,
		};
	} catch {
		return undefined;
	}
}

/**
 * Visual files under `cwd` modified at or after `sinceMs`. Bounded by depth,
 * visited entries, and matches; hidden and dependency/build directories,
 * symlinks, and the preview cache are skipped.
 */
export async function scanWorkspaceVisualArtifacts(
	cwd: string,
	sinceMs: number,
	limit = DEFAULT_LIMIT,
): Promise<VisualArtifact[]> {
	const root = path.resolve(cwd);
	const matches: VisualArtifact[] = [];
	let visited = 0;

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > SCAN_MAX_DEPTH || visited >= SCAN_MAX_VISITED || matches.length >= SCAN_MAX_MATCHES) return;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (visited >= SCAN_MAX_VISITED || matches.length >= SCAN_MAX_MATCHES) return;
			visited++;
			const absolute = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || Object.hasOwn(SCAN_SKIP_DIRS, entry.name)) continue;
				await walk(absolute, depth + 1);
				continue;
			}
			if (!entry.isFile() || !visualArtifactKind(entry.name)) continue;
			let stat: Stats;
			try {
				stat = await fs.stat(absolute);
			} catch {
				continue;
			}
			if (!stat.isFile() || stat.mtimeMs < sinceMs) continue;
			matches.push({
				path: absolute,
				displayPath: displayPathFor(absolute, root),
				kind: visualArtifactKind(entry.name)!,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				source: "workspace",
			});
		}
	}

	await walk(root, 0);
	return matches.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

/** First message timestamp, the boundary for the workspace scan. */
export function sessionStartTime(messages: readonly AgentMessage[]): number {
	for (const message of messages) {
		if ("timestamp" in message && typeof message.timestamp === "number") return message.timestamp;
	}
	return Date.now();
}

/**
 * Every visual artifact this session produced, newest first. Tool-named files
 * win over a workspace-scan hit for the same path.
 */
export async function collectVisualArtifacts(options: CollectVisualArtifactsOptions): Promise<VisualArtifact[]> {
	const { messages, cwd } = options;
	const limit = options.limit ?? DEFAULT_LIMIT;
	const sinceMs = options.sinceMs ?? sessionStartTime(messages);
	const byPath = new Map<string, VisualArtifact>();

	for (const candidate of toolArtifactCandidates(messages)) {
		const artifact = await readArtifact(candidate.absolute, cwd, "tool", candidate.tool);
		if (!artifact) continue;
		const existing = byPath.get(artifact.path);
		if (!existing || existing.mtimeMs < artifact.mtimeMs) byPath.set(artifact.path, artifact);
	}

	for (const artifact of await scanWorkspaceVisualArtifacts(cwd, sinceMs, limit)) {
		if (!byPath.has(artifact.path)) byPath.set(artifact.path, artifact);
	}

	return [...byPath.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}
