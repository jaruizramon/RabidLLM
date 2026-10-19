/**
 * Rolling SLM handoff: a CPU-hosted SmolLM3 distils each completed turn into a
 * cumulative handoff document, and compaction commits the ready document
 * instead of paying the main model for a summary of the overflowing context.
 *
 * The file lives in `/dev/shm` first (the path maintenance reads) and mirrors
 * onto disk under `<agentDir>/slm-handoffs/` for durability across reboots.
 * Metadata rides in an HTML comment so the `.md` stays hand-editable.
 */
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { $which, isEnoent, isRecord, logger, prompt, writeFileAtomically } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import slmHandoffInputPrompt from "../prompts/system/slm-handoff-input.md" with { type: "text" };
import slmHandoffSystemPrompt from "../prompts/system/slm-handoff.md" with { type: "text" };
import slmNotesInputPrompt from "../prompts/system/slm-notes-input.md" with { type: "text" };
import slmNotesSystemPrompt from "../prompts/system/slm-notes.md" with { type: "text" };
import { expandTilde } from "../tools/path-utils";
import {
	cfgCompaction,
	cfgCompactionEnabled,
	cfgCompactionMethodOrder,
	cfgSlmHandoffDetail,
	cfgSlmHandoffDevice,
	cfgSlmHandoffGpuFreeMiB,
	cfgSlmHandoffGpuLayers,
	cfgSlmHandoffMaxContextTokens,
	cfgSlmHandoffMaxHandoffTokens,
	cfgSlmHandoffAbridgeOlder,
	cfgSlmHandoffContractEveryTurns,
	cfgSlmHandoffMaxInputTokens,
	cfgSlmHandoffMaxNotesTokens,
	cfgSlmHandoffModelPath,
	cfgSlmHandoffReasoningBudgetTokens,
	cfgSlmHandoffServerPath,
	cfgSlmHandoffThreads,
	cfgSlmHandoffWorkerUrl,
	type CompactionSettings,
} from "../session/context-settings";
import { resolveCompactionMethodOrder } from "../session/compaction-methods";
import { parseSlmDevice, SlmHandoffServer, type SlmCompletionResult, type SlmServerConfig } from "./server";
import { clipMiddle, messageText, renderFileActions } from "../rabid/turn-cards";
import { boundScratchpad, countLogEchoes, renderScratchpad, stripLogEchoes, unknownPaths } from "./scratchpad";
import { sessionMessagePersistenceKey } from "../session/turn-persistence";

export { ensureSlmModelDownloaded } from "./server";

/** Provenance for one written handoff document. */
export interface SlmHandoffMetadata {
	version: 1;
	sessionId: string;
	coveredLeafKey: string;
	coveredAt: number;
	coveredUserTurns: number;
	modelPath: string;
	ctxSize: number;
	reasoningBudgetTokens: number;
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
	truncated: boolean;
	formatFallback: boolean;
}

export interface SlmHandoffRecord {
	document: string;
	metadata: SlmHandoffMetadata;
}

/** A parsed handoff file: the document, with metadata only when the comment survived. */
export interface SlmHandoffFile {
	document: string;
	metadata?: SlmHandoffMetadata;
}

const METADATA_OPEN = "<!-- rabid-slm-handoff";
const METADATA_CLOSE = "-->";
/** Approximate token→character ratio used for every budget comparison here. */
const CHARS_PER_TOKEN = 4;
/**
 * Splitting budget for one worker run. Code, JSON arguments and paths tokenize far
 * denser than prose (measured: a transcript estimated at 13 824 tokens arrived as
 * 22 141), so chunks are sized against a conservative ratio and the server's own
 * overflow error still splits them further.
 */
const CHUNK_CHARS_PER_TOKEN = 2.5;
const USER_MESSAGE_CLIP = 2_000;
const GOAL_CLIP = 160;
const FALLBACK_GOAL = "SLM handoff";
const DEFAULT_CONTEXT_WINDOW = 32_768;
const MIN_CONTEXT_WINDOW = 4_096;
const REASONING_BUDGET_CEILING = 16_384;
const MIN_INPUT_TOKENS = 2_048;
const INPUT_BUDGET_SLACK_TOKENS = 512;
/** How long a failed background run waits before retrying the same turns. */
const RETRY_BACKOFF_MS = 60_000;
/** Backlog ceiling, as a multiple of one run's input budget. */
const BACKLOG_BUDGET_FACTOR = 4;
/** A layer count above any real model: offload everything when a GPU is selected. */
const AUTO_GPU_LAYERS = 999;
/** How long `dispose` lets an in-flight run finish before aborting it. */
const DISPOSE_DRAIN_WAIT_MS = 5_000;

/**
 * `true` when `/dev/shm` is a real tmpfs (Linux): the RAM copy is authoritative
 * and must not pay disk latency, so it is written before the durable one.
 */
const RAM_DIR =
	process.platform === "linux" && fsSync.statSync("/dev/shm", { throwIfNoEntry: false })?.isDirectory() === true
		? "/dev/shm/rabid-slm-handoff"
		: path.join(os.tmpdir(), "rabid-slm-handoff");

/**
 * Stable, collision-free digest of an id. `sanitize()` used to map every run of
 * unusual characters to `_`, so `a:b`, `a b`, and `a/b` shared one file; a digest
 * makes two distinct ids two distinct files. SHA-256 (not `Bun.hash`) because the
 * name must survive an engine upgrade — a changed hash would orphan every handoff.
 */
function idDigest(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex").slice(0, 20);
}

/**
 * Handoff paths for one transcript.
 *
 * The RAM copy is namespaced by the agent directory: `/dev/shm` is process- and
 * profile-global, so without this a deleted profile's document could outrank the
 * current profile's disk copy for the same session id. A short readable prefix is
 * kept beside the digest so the file can be identified at a glance.
 */
export function slmHandoffFilePaths(agentDir: string, sessionId: string): { ram: string; disk: string } {
	const prefix = sessionId.slice(0, 8).replace(/[^a-zA-Z0-9._-]+/g, "_");
	const name = `${prefix}-${idDigest(sessionId)}.md`;
	const ramDir = path.join(RAM_DIR, idDigest(path.resolve(agentDir)));
	return { ram: path.join(ramDir, name), disk: path.join(agentDir, "slm-handoffs", name) };
}

/**
 * Whether `message` is an operator turn — real user input, not harness-authored
 * (an auto-continue, a steering injection, or the agent-attributed compaction
 * summary that replaces history). Only these advance the handoff or count as a
 * covered user turn.
 */
function isOperatorTurn(message: AgentMessage): boolean {
	return message.role === "user" && message.attribution !== "agent" && message.synthetic !== true;
}

/**
 * Whether a document covering `coveredKey` still describes every operator turn
 * in `messages`.
 *
 * Coverage is about *asks*, not about the newest message: after a compaction the
 * live tail holds assistant/tool output and harness notes, and a region-derived
 * run legitimately stops at the summarized boundary. What must never be true is
 * an uncovered operator turn — that is the only kind of message that changes what
 * the successor has to do.
 */
export function coversOperatorTurns(messages: readonly AgentMessage[], coveredKey: string | undefined): boolean {
	if (coveredKey === undefined) return false;
	const index = messages.findLastIndex(message => messageKey(message) === coveredKey);
	if (index === -1) return false;
	return !messages.slice(index + 1).some(isOperatorTurn);
}

/** Provenance for a turn's notes. */
export interface SlmNotesMetadata {
	version: 1;
	sessionId: string;
	coveredLeafKey: string;
	coveredAt: number;
	turns: number;
}

export interface SlmNotesRecord {
	text: string;
	metadata: SlmNotesMetadata;
}

const NOTES_METADATA_OPEN = "<!-- rabid-slm-notes";

/** Notes live beside the document; same digest, distinguishable name. */
export function slmNotesFilePaths(agentDir: string, sessionId: string): { ram: string; disk: string } {
	const handoff = slmHandoffFilePaths(agentDir, sessionId);
	return {
		ram: handoff.ram.replace(/\.md$/, ".notes.md"),
		disk: handoff.disk.replace(/\.md$/, ".notes.md"),
	};
}

function formatSlmNotesFile(record: SlmNotesRecord): string {
	return `${NOTES_METADATA_OPEN}\n${JSON.stringify(record.metadata)}\n-->\n\n${record.text.trim()}\n`;
}

export function parseSlmNotesFile(raw: string): SlmNotesRecord | undefined {
	const text = raw.trim();
	if (!text.startsWith(NOTES_METADATA_OPEN)) return undefined;
	const close = text.indexOf("-->");
	if (close === -1) return undefined;
	const body = text
		.slice(close + 3)
		.split("\n")
		.filter(line => !/^## /.test(line.trim()))
		.join("\n")
		.trim();
	if (body === "") return undefined;
	let metadata: SlmNotesMetadata | undefined;
	try {
		const parsed: unknown = JSON.parse(text.slice(NOTES_METADATA_OPEN.length, close).trim());
		if (
			isRecord(parsed) &&
			parsed.version === 1 &&
			typeof parsed.sessionId === "string" &&
			typeof parsed.coveredLeafKey === "string" &&
			typeof parsed.coveredAt === "number" &&
			typeof parsed.turns === "number"
		) {
			metadata = {
				version: 1,
				sessionId: parsed.sessionId,
				coveredLeafKey: parsed.coveredLeafKey,
				coveredAt: parsed.coveredAt,
				turns: parsed.turns,
			};
		}
	} catch {
		metadata = undefined;
	}
	return metadata === undefined ? undefined : { text: body, metadata };
}

async function readNotesFile(file: string, sessionId: string): Promise<SlmNotesRecord | undefined> {
	try {
		const parsed = parseSlmNotesFile(await Bun.file(file).text());
		if (parsed === undefined) return undefined;
		return parsed.metadata.sessionId === sessionId ? parsed : undefined;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

export async function readSlmNotes(agentDir: string, sessionId: string): Promise<SlmNotesRecord | undefined> {
	const paths = slmNotesFilePaths(agentDir, sessionId);
	const copies = (
		await Promise.all([readNotesFile(paths.ram, sessionId), readNotesFile(paths.disk, sessionId)])
	).filter((copy): copy is SlmNotesRecord => copy !== undefined);
	if (copies.length === 0) return undefined;
	copies.sort((a, b) => b.metadata.coveredAt - a.metadata.coveredAt);
	return copies[0];
}

export async function writeSlmNotes(agentDir: string, sessionId: string, record: SlmNotesRecord): Promise<void> {
	const paths = slmNotesFilePaths(agentDir, sessionId);
	const text = formatSlmNotesFile(record);
	await fs.mkdir(path.dirname(paths.ram), { recursive: true });
	await writeFileAtomically(paths.ram, text);
	try {
		await fs.mkdir(path.dirname(paths.disk), { recursive: true });
		await writeFileAtomically(paths.disk, text);
	} catch (error) {
		logger.warn("SLM notes disk write failed", { error: String(error) });
	}
}

/**
 * Output budget for one notes run.
 *
 * Measured: a turn with ~30 events produced 3 209 tokens of notes at the 4 096 cap —
 * almost the size of its input, which would fill the accumulated budget in one turn.
 * Notes are lines, not prose; 1 024 tokens is ~60 of them.
 */
const NOTES_PER_RUN_TOKENS = 1024;

/**
 * Tokens one notes line costs. Measured: 3 209 output tokens for ~60 lines. A run whose
 * note lines exceed its cap is cut off at the end — which is the part of the turn that
 * matters most — so the batch is split by line count, not only by rendered size.
 */
const NOTE_TOKENS_PER_LINE = 64;

/** Stable identity for a live message, matching the persisted session's keys. */
function messageKey(message: AgentMessage): string {
	return sessionMessagePersistenceKey(message) ?? `${message.role}:${message.timestamp}`;
}

function readMetadata(value: unknown): SlmHandoffMetadata | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version !== 1 || typeof value.sessionId !== "string" || typeof value.coveredLeafKey !== "string") {
		return undefined;
	}
	if (typeof value.coveredAt !== "number") return undefined;
	const number = (key: keyof SlmHandoffMetadata, fallback: number): number => {
		const raw = value[key];
		return typeof raw === "number" ? raw : fallback;
	};
	return {
		version: 1,
		sessionId: value.sessionId,
		coveredLeafKey: value.coveredLeafKey,
		coveredAt: value.coveredAt,
		coveredUserTurns: number("coveredUserTurns", 0),
		modelPath: typeof value.modelPath === "string" ? value.modelPath : "",
		ctxSize: number("ctxSize", 0),
		reasoningBudgetTokens: number("reasoningBudgetTokens", 0),
		inputTokens: number("inputTokens", 0),
		outputTokens: number("outputTokens", 0),
		durationMs: number("durationMs", 0),
		truncated: value.truncated === true,
		formatFallback: value.formatFallback === true,
	};
}

/**
 * Parse a handoff file. A missing or corrupt metadata comment is not an error —
 * a hand-edited or pre-SLM document still compacts, it just cannot be matched
 * to a covered leaf.
 */
export function parseSlmHandoffFile(raw: string): SlmHandoffFile | undefined {
	const text = raw.trim();
	if (text === "") return undefined;
	if (!text.startsWith(METADATA_OPEN)) return { document: text };
	const closeIndex = text.indexOf(METADATA_CLOSE);
	if (closeIndex === -1) return { document: text };
	const document = text.slice(closeIndex + METADATA_CLOSE.length).trim();
	if (document === "") return undefined;
	const json = text.slice(METADATA_OPEN.length, closeIndex).trim();
	let metadata: SlmHandoffMetadata | undefined;
	try {
		metadata = readMetadata(JSON.parse(json));
	} catch {
		metadata = undefined;
	}
	return metadata === undefined ? { document } : { document, metadata };
}

export function formatSlmHandoffFile(record: SlmHandoffRecord): string {
	return `${METADATA_OPEN}\n${JSON.stringify(record.metadata)}\n${METADATA_CLOSE}\n\n${record.document.trim()}\n`;
}

/** One-line goal for the compaction summary badge; never empty. */
export function extractSlmHandoffGoal(document: string): string {
	let inGoal = false;
	for (const line of document.split("\n")) {
		const trimmed = line.trim();
		if (!inGoal) {
			if (/^##\s+goal\b/i.test(trimmed)) inGoal = true;
			continue;
		}
		if (trimmed === "") continue;
		if (trimmed.startsWith("#")) break;
		return trimmed.length > GOAL_CLIP ? `${trimmed.slice(0, GOAL_CLIP)}…` : trimmed;
	}
	return FALLBACK_GOAL;
}

async function readHandoffFile(file: string, sessionId: string): Promise<SlmHandoffFile | undefined> {
	let parsed: SlmHandoffFile | undefined;
	try {
		parsed = parseSlmHandoffFile(await Bun.file(file).text());
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	if (parsed?.metadata && parsed.metadata.sessionId !== sessionId) {
		// The path says this session; the file says otherwise. Never adopt it —
		// the document would be merged into the wrong transcript.
		logger.warn("Ignoring SLM handoff written by another session", {
			file,
			expected: sessionId,
			found: parsed.metadata.sessionId,
		});
		return undefined;
	}
	return parsed;
}

/** Read whichever copy is newer; a document without metadata sorts last. */
export async function readSlmHandoff(agentDir: string, sessionId: string): Promise<SlmHandoffFile | undefined> {
	const paths = slmHandoffFilePaths(agentDir, sessionId);
	const copies = (
		await Promise.all([readHandoffFile(paths.ram, sessionId), readHandoffFile(paths.disk, sessionId)])
	).filter((copy): copy is SlmHandoffFile => copy !== undefined);
	if (copies.length === 0) return undefined;
	copies.sort((a, b) => (b.metadata?.coveredAt ?? 0) - (a.metadata?.coveredAt ?? 0));
	return copies[0];
}

/**
 * Publish a handoff: RAM first (compaction reads it), then disk. A disk failure
 * is logged and swallowed — the RAM copy is authoritative for the live session.
 */
export async function writeSlmHandoff(agentDir: string, sessionId: string, record: SlmHandoffRecord): Promise<void> {
	const paths = slmHandoffFilePaths(agentDir, sessionId);
	const text = formatSlmHandoffFile(record);
	await fs.mkdir(path.dirname(paths.ram), { recursive: true });
	await writeFileAtomically(paths.ram, text);
	try {
		await fs.mkdir(path.dirname(paths.disk), { recursive: true });
		await writeFileAtomically(paths.disk, text);
	} catch (error) {
		logger.warn("SLM handoff disk write failed", { error: String(error) });
	}
}

/** Heading that marks the deterministic requirement block in a committed summary. */
const VERBATIM_HEADING = "## User messages (verbatim; authoritative)";
/** Marker inserted when the middle of a long user-message list is dropped. */
const VERBATIM_OMISSION = "… middle user messages omitted …";

/**
 * Render requirement bodies as the summary's authoritative section.
 *
 * The SLM paraphrases — that is the point of a small model — so the user's own
 * words ride along unparaphrased and survive a dropped or softened constraint.
 */
function renderVerbatimSection(bodies: readonly string[], maxTokens: number): string {
	if (bodies.length === 0) return "";
	const render = (from: number, to: number): string =>
		bodies
			.slice(from, to)
			.map((text, offset) => `### User message ${from + offset + 1}\n${text}`)
			.join("\n\n");
	let body = render(0, bodies.length);
	const budget = maxTokens * CHARS_PER_TOKEN;
	if (body.length > budget && bodies.length > 2) {
		const keep = Math.max(1, Math.floor(bodies.length / 2));
		body = [render(0, keep), VERBATIM_OMISSION, render(bodies.length - keep, bodies.length)].join("\n\n");
	}
	return `${VERBATIM_HEADING}\n\n${body}`;
}

/** Message bodies of an already-rendered verbatim section, in order. */
export function verbatimRequirementBodies(section: string | undefined): string[] {
	if (!section) return [];
	const start = section.indexOf(VERBATIM_HEADING);
	if (start === -1) return [];
	const bodies: string[] = [];
	for (const part of section.slice(start + VERBATIM_HEADING.length).split(/^### User message \d+$/m)) {
		// A part may carry the omission marker that followed the previous body.
		const text = part.replace(VERBATIM_OMISSION, "").trim();
		if (text !== "") bodies.push(text);
	}
	return bodies;
}

/**
 * Deterministic requirement block for a committed summary: this pass's operator
 * messages plus every body already recorded by an earlier compaction.
 *
 * The carry-forward is what keeps the guarantee across a summary chain: a pass
 * that summarizes only harness-attributed messages (an auto-retry turn) has no
 * fresh bodies, yet the requirements established two compactions ago must not
 * vanish merely because the SLM rewrote the document that held them.
 */
export function renderVerbatimUserRequirements(
	messages: readonly AgentMessage[],
	maxTokens: number,
	previousSummary?: string,
): string {
	const bodies = verbatimRequirementBodies(previousSummary);
	for (const message of messages) {
		if (message.role !== "user") continue;
		// Agent-attributed and synthetic user messages are harness chatter, not
		// operator requirements.
		if (message.attribution === "agent" || message.synthetic === true) continue;
		const images = Array.isArray(message.content)
			? message.content.filter(part => isRecord(part) && part.type === "image").length
			: 0;
		const text = [messageText(message.content), ...Array.from({ length: images }, () => "[image]")].join("\n").trim();
		if (text === "") continue;
		const clipped =
			text.length > USER_MESSAGE_CLIP
				? `${text.slice(0, USER_MESSAGE_CLIP)}… [${text.length - USER_MESSAGE_CLIP} chars omitted]`
				: text;
		if (!bodies.includes(clipped)) bodies.push(clipped);
	}
	return renderVerbatimSection(bodies, maxTokens);
}

/** Tilde-expanded GGUF path for the worker. */
export function resolveSlmModelPath(value: string): string {
	return expandTilde(value.trim());
}

/** Configured binary, else the stock build, else the plain build; undefined when absent. */
export function resolveSlmServerPath(value: string): string | undefined {
	const configured = value.trim();
	if (configured !== "") return expandTilde(configured);
	return $which("llama-server-stock") ?? $which("llama-server") ?? undefined;
}

/** `0` means a quarter of the box's logical CPUs, never fewer than one. */
export function resolveSlmThreads(value: number): number {
	if (Number.isFinite(value) && value > 0) return Math.max(1, Math.floor(value));
	return Math.max(1, Math.floor(os.availableParallelism() / 4));
}

/**
 * Whether the worker can run at all: the GGUF and an executable server binary
 * must both exist. Synchronous and network-free — this gates every turn.
 */
export function isSlmHandoffConfigured(
	settings: Pick<CompactionSettings, "slmHandoffModelPath" | "slmHandoffServerPath" | "slmHandoffWorkerUrl">,
): boolean {
	// An adopted worker owns the model and the binary; the harness only needs the URL,
	// and the health check happens at use.
	if (settings.slmHandoffWorkerUrl.trim() !== "") return true;
	if (!fsSync.existsSync(resolveSlmModelPath(settings.slmHandoffModelPath))) return false;
	const serverPath = resolveSlmServerPath(settings.slmHandoffServerPath);
	if (!serverPath) return false;
	try {
		fsSync.accessSync(serverPath, fsSync.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Worker launch configuration derived from the live model window and settings. */
export function resolveSlmServerConfig(
	settings: Settings,
	contextWindow: number | null | undefined,
	workerCtxSize?: number,
): SlmServerConfig {
	const modelPath = resolveSlmModelPath(cfgSlmHandoffModelPath.get(settings));
	const serverPath = resolveSlmServerPath(cfgSlmHandoffServerPath.get(settings));
	if (!serverPath) {
		throw new Error(
			"llama-server binary not found; set compaction.slmHandoff.serverPath or install llama-server-stock",
		);
	}
	const configuredCtx = Math.min(
		Math.max(contextWindow ?? DEFAULT_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW),
		cfgSlmHandoffMaxContextTokens.get(settings),
	);
	// An adopted worker (the manager panel's, a previous session's) can serve less
	// context than the setting asks for. What the worker actually serves is the
	// authority for what fits: budgets sized for the configured ceiling overflow its
	// real window, and every run then pays a 400 and a split.
	const ctxSize =
		workerCtxSize === undefined || !Number.isFinite(workerCtxSize) || workerCtxSize <= 0
			? configuredCtx
			: Math.min(configuredCtx, workerCtxSize);
	const threads = resolveSlmThreads(cfgSlmHandoffThreads.get(settings));
	const reasoningBudgetTokens = Math.min(
		Math.max(cfgSlmHandoffReasoningBudgetTokens.get(settings), 0),
		REASONING_BUDGET_CEILING,
	);
	const maxHandoffTokens = Math.max(1, cfgSlmHandoffMaxHandoffTokens.get(settings));
	const room = ctxSize - maxHandoffTokens - reasoningBudgetTokens - INPUT_BUDGET_SLACK_TOKENS;
	const maxInputTokens = Math.min(
		Math.max(cfgSlmHandoffMaxInputTokens.get(settings), 1),
		Math.max(MIN_INPUT_TOKENS, room),
	);
	const device = parseSlmDevice(cfgSlmHandoffDevice.get(settings));
	if (!device) {
		throw new Error('compaction.slmHandoff.device must be "cpu", "cuda", or "cuda:N"');
	}
	const configuredLayers = cfgSlmHandoffGpuLayers.get(settings);
	// The device is the authority: a CPU worker offloads nothing, whatever the
	// layer setting says; on a GPU the default (-1) offloads the whole model.
	const gpuLayers = device.kind === "cpu" ? 0 : configuredLayers >= 0 ? Math.floor(configuredLayers) : AUTO_GPU_LAYERS;
	return {
		serverPath,
		modelPath,
		ctxSize,
		threads,
		reasoningBudgetTokens,
		maxInputTokens,
		maxHandoffTokens,
		device,
		gpuLayers,
		gpuFreeMiB: cfgSlmHandoffGpuFreeMiB.get(settings),
		workerUrl: cfgSlmHandoffWorkerUrl.get(settings).trim() || undefined,
		maxNotesTokens: Math.max(256, cfgSlmHandoffMaxNotesTokens.get(settings)),
		contractEveryTurns: Math.max(0, Math.floor(cfgSlmHandoffContractEveryTurns.get(settings))),
	};
}

/** Greedy split of a turn batch into runs whose rendered transcript fits the input budget. */
function chunkByRenderedLength(messages: readonly AgentMessage[], budgetChars: number): AgentMessage[][] {
	const chunks: AgentMessage[][] = [];
	let current: AgentMessage[] = [];
	let size = 0;
	for (const message of messages) {
		const rendered = renderScratchpad([message]).length + 1;
		// A single oversized message still gets its own run: the renderer clips
		// individual parts, so it can only exceed the budget by so much.
		if (current.length > 0 && size + rendered > budgetChars) {
			chunks.push(current);
			current = [];
			size = 0;
		}
		current.push(message);
		size += rendered;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/**
 * Per-session owner of the rolling handoff.
 *
 * `schedule()` is fire-and-forget after every completed turn; the drain runs one
 * stateless request per chunk (system + previous handoff + new turns) so the
 * model never sees its own earlier answers and cannot loop on them.
 */
export class SlmHandoffCoordinator {
	readonly #options: {
		settings: Settings;
		sessionId: () => string;
		agentDir: () => string;
		agentKind: () => "main" | "sub";
		messages: () => readonly AgentMessage[];
		modelContextWindow: () => number | null | undefined;
	};
	#pending: AgentMessage[] = [];
	#drainPromise: Promise<void> | undefined;
	#lastProcessedKey: string | undefined;
	#retryAfter = 0;
	#disposed = false;
	readonly #abort = new AbortController();
	readonly #server = SlmHandoffServer.global();

	constructor(options: {
		settings: Settings;
		sessionId: () => string;
		agentDir: () => string;
		agentKind: () => "main" | "sub";
		messages: () => readonly AgentMessage[];
		modelContextWindow: () => number | null | undefined;
	}) {
		this.#options = options;
	}

	/** Queue the turns completed since the last run. Synchronous by contract. */
	schedule(): void {
		if (this.#disposed) return;
		const inactive = this.#gateReason();
		if (inactive !== undefined) {
			logger.debug("SLM handoff inactive", { reason: inactive });
			return;
		}
		const messages = this.#options.messages();
		const last = messages[messages.length - 1];
		if (!last) return;
		// A covered key that no longer exists (compaction, branch change, resume)
		// re-seeds from the whole live context: index -1 + 1 = 0.
		const start =
			this.#lastProcessedKey === undefined
				? 0
				: Math.max(0, messages.findLastIndex(m => messageKey(m) === this.#lastProcessedKey) + 1);
		this.#lastProcessedKey = messageKey(last);
		const batch = messages.slice(start);
		// A batch with no operator turn (the agent-attributed summary that follows a
		// compaction, a continuation, a steer) has nothing new to chain: distilling
		// it would paraphrase our own summary back over the document. Leave
		// `#lastProcessedKey` alone so the next real turn starts from it.
		if (!batch.some(isOperatorTurn)) return;
		const lastAssistant = batch.findLast(message => message.role === "assistant");
		// A failed turn has nothing trustworthy to distil, matching turn cards.
		if (lastAssistant?.stopReason === "error") return;
		this.#pending.push(...batch);
		// Fire-and-forget by contract: never delays prompt admission.
		void this.#startDrain();
	}

	/**
	 * Hand the document covering the live leaf to compaction, waiting up to
	 * `awaitMs` for an in-flight run. `undefined` means the caller must fall
	 * back to the next configured method.
	 */
	async prepareForCompaction(options: {
		signal?: AbortSignal;
		awaitMs: number;
		/** The messages this compaction discards; the contract is built from their notes. */
		region?: readonly AgentMessage[];
	}): Promise<SlmHandoffRecord | undefined> {
		if (this.#disposed || !this.#gateOpen()) return undefined;
		const messages = this.#options.messages();
		const last = messages[messages.length - 1];
		if (!last) return undefined;
		const key = messageKey(last);
		const agentDir = this.#options.agentDir();
		const sessionId = this.#options.sessionId();

		// A contract already covering the live leaf is reused: there is nothing new to judge.
		const existing = await readSlmHandoff(agentDir, sessionId);
		if (existing?.metadata && coversOperatorTurns(messages, existing.metadata.coveredLeafKey)) {
			return { document: existing.document, metadata: existing.metadata };
		}

		// Notes are the contract's input, so freshness is measured on the notes.
		let notes = await readSlmNotes(agentDir, sessionId);
		if (!coversOperatorTurns(messages, notes?.metadata.coveredLeafKey)) {
			// A drain scheduled at the last turn boundary is already covering the live
			// leaf: enqueueing the region on top of it would pay for the same content
			// twice (measured: two 118s runs for one turn with a 4B worker).
			const coveredByScheduledDrain = this.#drainPromise !== undefined && this.#lastProcessedKey === key;
			const region = coveredByScheduledDrain ? [] : (options.region ?? []);
			if (coveredByScheduledDrain) {
				// The in-flight drain already owns this exact batch. Re-enqueueing it
				// here would run the notes (and the per-turn contract) twice.
			} else if (region.length > 0) {
				// The warm chain does not cover the live leaf, so note the region
				// compaction is about to discard rather than a chain that may have drifted.
				this.#pending = [...region];
				this.#lastProcessedKey = key;
			} else {
				this.#ensureCoverage(messages, notes?.metadata.coveredLeafKey);
			}
			const drain = this.#startDrain();
			if (drain) {
				const { promise: deadline, resolve: arriveAtDeadline } = Promise.withResolvers<void>();
				const timer = setTimeout(arriveAtDeadline, options.awaitMs);
				timer.unref();
				await Promise.race([drain, deadline]);
				clearTimeout(timer);
			}
			if (options.signal?.aborted) return undefined;
			notes = await readSlmNotes(agentDir, sessionId);
		}
		if (!notes || !coversOperatorTurns(messages, notes.metadata.coveredLeafKey)) return undefined;

		// The drain that just finished may have written the contract for the live
		// leaf (`contractEveryTurns`). Re-read before paying for a second contract
		// run over the same notes: the per-turn contract is exactly the document
		// compaction would produce.
		const refreshed = await readSlmHandoff(agentDir, sessionId);
		if (refreshed?.metadata && coversOperatorTurns(messages, refreshed.metadata.coveredLeafKey)) {
			logger.debug("SLM contract reused after drain", {
				chars: refreshed.document.length,
				notes: notes.metadata.turns,
			});
			return { document: refreshed.document, metadata: refreshed.metadata };
		}

		// The only judgment step in the handoff: select from the notes.
		try {
			const config = await this.#workerConfig();
			const actionLog = renderFileActions(options.region ?? messages);
			const record = await this.#runContract(config, notes, refreshed?.document ?? existing?.document, actionLog);
			return options.signal?.aborted ? undefined : record;
		} catch (error) {
			logger.warn("SLM contract failed", { error: String(error) });
			return undefined;
		}
	}

	/**
	 * One-shot summarization on the same supervised worker, for work that is not
	 * the rolling handoff (turn cards). Cards are archive-only, but they are still
	 * summarization: they must never be produced by the live model or a network
	 * provider. No worker, no card.
	 */
	async completeTurnCard(options: {
		system: string;
		prompt: string;
		maxTokens: number;
		signal?: AbortSignal;
	}): Promise<string | undefined> {
		if (this.#disposed || !this.#gateOpen()) return undefined;
		try {
			const config = await this.#workerConfig();
			const maxTokens = Math.max(128, Math.floor(options.maxTokens));
			// The card is one user message plus a small system prompt; middle-clip the
			// transcript to what one run can actually hold and keep both ends.
			const budgetChars = Math.max(
				2_048,
				Math.floor((config.maxInputTokens - maxTokens - INPUT_BUDGET_SLACK_TOKENS) * CHUNK_CHARS_PER_TOKEN),
			);
			const result = await this.#completeWithRetry(
				config,
				options.system,
				clipMiddle(options.prompt, budgetChars),
				{ temperature: 0, maxTokens, normalize: "notes" },
				options.signal,
			);
			return result.document;
		} catch (error) {
			logger.warn("SLM turn-card completion failed", { error: String(error) });
			return undefined;
		}
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		// Let a run already in flight finish: aborting it throws away the turn's
		// work, and in a one-shot session that is the only chance it gets.
		const drain = this.#drainPromise;
		if (drain !== undefined) {
			const { promise: deadline, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, DISPOSE_DRAIN_WAIT_MS);
			timer.unref();
			await Promise.race([drain.catch(() => {}), deadline]);
			clearTimeout(timer);
		}
		this.#disposed = true;
		this.#abort.abort();
		this.#pending = [];
		await this.#server.release();
	}

	/**
	 * Why the coordinator is inactive, or undefined when it is active. The reason is
	 * logged by `schedule()`: a silently-closed gate is indistinguishable from a
	 * broken worker when the only symptom is "no handoff file".
	 */
	#gateReason(): string | undefined {
		// Subagents never compete with the main session for the worker's CPU.
		if (this.#options.agentKind() !== "main") return "subagent session";
		const settings = this.#options.settings;
		if (!cfgCompactionEnabled.get(settings)) return "compaction.enabled is false";
		if (!resolveCompactionMethodOrder(cfgCompactionMethodOrder.get(settings)).includes("slm")) {
			return "slm is not in compaction.methodOrder";
		}
		const snapshot = cfgCompaction.get(settings);
		if (!isSlmHandoffConfigured(snapshot)) {
			return `worker not configured (model=${snapshot.slmHandoffModelPath}, server=${snapshot.slmHandoffServerPath || "auto"})`;
		}
		return undefined;
	}

	#gateOpen(): boolean {
		return this.#gateReason() === undefined;
	}

	/**
	 * Settings resolved against the context the live worker actually serves.
	 *
	 * `resolveSlmServerConfig` alone knows only the configured ceiling. Adoption
	 * deliberately accepts a smaller worker (the manager panel's, a previous
	 * session's) instead of spawning a second process on the same card, so the
	 * live `/ctx-size` is the number every input budget must be derived from.
	 */
	async #workerConfig(): Promise<SlmServerConfig> {
		const settings = this.#options.settings;
		const contextWindow = this.#options.modelContextWindow();
		const configured = resolveSlmServerConfig(settings, contextWindow);
		const status = await this.#server.ensure(configured);
		if (status.ctxSize === undefined || status.ctxSize >= configured.ctxSize) return configured;
		logger.debug("SLM worker serves a smaller context than configured; shrinking the run budgets", {
			workerCtx: status.ctxSize,
			configuredCtx: configured.ctxSize,
		});
		return resolveSlmServerConfig(settings, contextWindow, status.ctxSize);
	}

	/**
	 * The only judgment step: build the document from the turn's notes.
	 *
	 * Notes are transcribed facts; the contract is the selection made over them. This
	 * runs at compaction, never during a turn, so the main model's critical path is
	 * untouched.
	 */
	async #runContract(
		config: SlmServerConfig,
		notes: SlmNotesRecord,
		previous: string | undefined,
		actionLog: string,
	): Promise<SlmHandoffRecord> {
		const sessionId = this.#options.sessionId();
		const agentDir = this.#options.agentDir();
		const detail = cfgSlmHandoffDetail.get(this.#options.settings);
		const abridgeOlder = cfgSlmHandoffAbridgeOlder.get(this.#options.settings);
		// A hard decay budget is the only thing that reliably shrinks the document: an
		// instruction alone measured longer than no instruction (5 711 vs 4 173 chars).
		// The new turn gets an allowance; everything older must fit in the remainder.
		const previousTokens = previous === undefined ? 0 : Math.ceil(previous.length / CHARS_PER_TOKEN);
		const targetTokens = Math.min(
			config.maxHandoffTokens,
			previousTokens === 0 ? config.maxHandoffTokens : Math.max(600, Math.round(previousTokens * 0.9) + 300),
		);
		const systemPrompt = prompt.render(slmHandoffSystemPrompt, {
			maxHandoffTokens: config.maxHandoffTokens,
			targetTokens,
			abridgeOlder,
			detailConcise: detail === "concise",
			detailStandard: detail === "standard",
			detailDetailed: detail === "detailed",
		});
		const userPrompt = prompt.render(slmHandoffInputPrompt, {
			previousHandoff: previous || "(none)",
			turnTranscript: notes.text,
			actionLog: actionLog || "(none)",
			maxHandoffTokens: config.maxHandoffTokens,
		});
		const startedAt = Date.now();
		let result = await this.#completeWithRetry(config, systemPrompt, userPrompt, {
			maxTokens: targetTokens,
		});
		// A path the input never contained is an invention, not an abbreviation.
		// The previous document is a legitimate source: a path carried forward from it is not
		// an invention (measured: `scripts/sim-smoke.mjs` was flagged on every contract).
		const source = `${notes.text}\n${actionLog}\n${previous ?? ""}`;
		const invented = unknownPaths(result.document, source);
		if (invented.length > 0) {
			logger.warn("SLM contract named paths absent from the notes; retrying", { paths: invented });
			const stricter = `${userPrompt}\n\nYour previous answer named paths that do not appear in the notes or recent_actions: ${invented.join(", ")}. Copy paths character for character from those sections; if a path is not there, do not name it.`;
			const second = await this.#completeWithRetry(config, systemPrompt, stricter);
			if (unknownPaths(second.document, source).length < invented.length) result = second;
		}
		// Notes are cheap to copy; the document must not be a copy of them.
		const echoes = countLogEchoes(result.document);
		if (echoes >= 3) {
			logger.warn("SLM contract echoed the notes; retrying with a stricter instruction", { echoedLines: echoes });
			const stricter = `${userPrompt}\n\nYour previous answer copied note lines. Do not transcribe notes. Select only what a successor needs to continue.`;
			const second = await this.#completeWithRetry(config, systemPrompt, stricter);
			if (countLogEchoes(second.document) < echoes) result = second;
		}
		if (countLogEchoes(result.document) >= 3) {
			logger.warn("SLM contract still transcribed the notes; stripping the copied lines", {
				document: result.document.length,
			});
			result = { ...result, document: stripLogEchoes(result.document) };
		}
		const record: SlmHandoffRecord = {
			document: result.document,
			metadata: {
				version: 1,
				sessionId,
				coveredLeafKey: notes.metadata.coveredLeafKey,
				coveredAt: Date.now(),
				coveredUserTurns: notes.metadata.turns,
				modelPath: config.modelPath,
				ctxSize: config.ctxSize,
				reasoningBudgetTokens: config.reasoningBudgetTokens,
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				durationMs: Date.now() - startedAt,
				truncated: result.truncated,
				formatFallback: result.formatFallback,
			},
		};
		await writeSlmHandoff(agentDir, sessionId, record);
		logger.debug("SLM contract written", {
			chars: record.document.length,
			ms: record.metadata.durationMs,
			notes: notes.metadata.turns,
		});
		return record;
	}

	/**
	 * Force a run that covers the live leaf. Replaces the queue rather than
	 * appending: the batch always restarts from the covered key, so appending
	 * would duplicate turns already waiting to be distilled.
	 */
	#ensureCoverage(messages: readonly AgentMessage[], coveredKey: string | undefined): void {
		let start = 0;
		if (coveredKey !== undefined) {
			const index = messages.findLastIndex(message => messageKey(message) === coveredKey);
			// The covered message survived: only what came after it is new.
			if (index !== -1) start = index + 1;
		}
		const batch = messages.slice(start);
		if (batch.length === 0) return;
		this.#pending = batch;
		this.#lastProcessedKey = messageKey(messages[messages.length - 1]!);
	}

	#startDrain(): Promise<void> | undefined {
		if (this.#drainPromise) return this.#drainPromise;
		const run = this.#drain().finally(() => {
			if (this.#drainPromise === run) this.#drainPromise = undefined;
		});
		this.#drainPromise = run;
		return run;
	}

	async #drain(): Promise<void> {
		while (!this.#disposed && this.#pending.length > 0) {
			if (Date.now() < this.#retryAfter) return;
			const batch = this.#pending.splice(0);
			try {
				await this.#runBatch(batch);
				this.#retryAfter = 0;
			} catch (error) {
				if (this.#disposed || this.#abort.signal.aborted) return;
				logger.warn("SLM handoff run failed", { error: String(error) });
				this.#requeue(batch);
				this.#retryAfter = Date.now() + RETRY_BACKOFF_MS;
				return;
			}
		}
	}

	/** Put a failed batch back in front, bounded so a wedged worker cannot hoard memory. */
	#requeue(batch: AgentMessage[]): void {
		this.#pending = [...batch, ...this.#pending];
		// Read the budget straight from settings: resolving the server config can
		// throw (a vanished binary), which must not escape a failure handler.
		const limit =
			cfgCompaction.get(this.#options.settings).slmHandoffMaxInputTokens * CHARS_PER_TOKEN * BACKLOG_BUDGET_FACTOR;
		let total = 0;
		const sizes = this.#pending.map(message => renderScratchpad([message]).length + 1);
		for (const size of sizes) total += size;
		let dropped = 0;
		while (this.#pending.length > 1 && total > limit) {
			total -= sizes.shift() ?? 0;
			this.#pending.shift();
			dropped++;
		}
		if (dropped > 0) logger.warn("SLM handoff backlog exceeded its budget; dropped the oldest turns", { dropped });
	}

	/**
	 * One worker call, retried once when the socket dies.
	 *
	 * A worker can be killed by hand, by the manager panel, or by a crash mid-run; the run
	 * is stateless, so a retry is safe and `ensure()` will respawn a dead process. Without
	 * this, a single ECONNRESET at compaction time costs the whole handoff and falls back
	 * to the main model (observed live).
	 */
	async #completeWithRetry(
		config: SlmServerConfig,
		system: string,
		user: string,
		options?: { temperature?: number; maxTokens?: number; normalize?: "handoff" | "notes" },
		signal?: AbortSignal,
	): Promise<SlmCompletionResult> {
		// A caller may bound one run (a turn card must not hold the next prompt
		// forever); the session abort still cancels every run.
		const callSignal = signal ? AbortSignal.any([this.#abort.signal, signal]) : this.#abort.signal;
		try {
			return await this.#server.complete(config, system, user, callSignal, options);
		} catch (error) {
			if (this.#disposed || callSignal.aborted) throw error;
			const text = String(error);
			if (!/ECONNRESET|ECONNREFUSED|socket|fetch failed/i.test(text)) throw error;
			logger.warn("SLM worker connection dropped; retrying once", { error: text.slice(0, 160) });
			await Bun.sleep(500);
			return await this.#server.complete(config, system, user, callSignal, options);
		}
	}

	/**
	 * Per-turn stage: transcribe statements, summarise thoughts, record tool outcomes.
	 *
	 * Notes are the only thing written during a session. They cost one small run per turn
	 * over a bounded pad, and they are the input the contract is built from — so the
	 * judgment step reads notes, never the raw turn.
	 */
	async #runBatch(batch: readonly AgentMessage[]): Promise<void> {
		const config = await this.#workerConfig();
		const sessionId = this.#options.sessionId();
		const agentDir = this.#options.agentDir();
		const existing = await readSlmNotes(agentDir, sessionId);
		const previousDocument = (await readSlmHandoff(agentDir, sessionId))?.document;
		// One increment per batch: `turns` counts completed turns, not chunk runs.
		const turnNumber = (existing?.metadata.turns ?? 0) + 1;
		const notesBudget = Math.floor(config.maxNotesTokens * CHUNK_CHARS_PER_TOKEN);
		let notes = existing?.text ?? "";
		const systemPrompt = prompt.render(slmNotesSystemPrompt, {});
		let lastRecord: SlmNotesRecord | undefined;
		const perRunTokens = Math.min(NOTES_PER_RUN_TOKENS, config.maxNotesTokens);
		const perRunLines = Math.max(8, Math.floor(perRunTokens / NOTE_TOKENS_PER_LINE));
		// Split by note lines first, then by rendered size: a run that overruns its budget
		// loses the turn's tail, and the tail is the newest work.
		const queue: AgentMessage[][] = [];
		let group: AgentMessage[] = [];
		let groupLines = 0;
		for (const message of batch) {
			const lines = Math.max(1, renderScratchpad([message]).split("\n").length);
			if (group.length > 0 && groupLines + lines > perRunLines) {
				queue.push(...chunkByRenderedLength(group, config.maxInputTokens * CHUNK_CHARS_PER_TOKEN));
				group = [];
				groupLines = 0;
			}
			group.push(message);
			groupLines += lines;
		}
		if (group.length > 0) queue.push(...chunkByRenderedLength(group, config.maxInputTokens * CHUNK_CHARS_PER_TOKEN));
		while (queue.length > 0) {
			const chunk = queue.shift()!;
			// The worker reads the pad, not the turn: an 88K turn and a four-message turn
			// produce the same bounded input.
			const scratchpad = boundScratchpad(
				renderScratchpad(chunk),
				Math.floor(config.maxInputTokens * CHUNK_CHARS_PER_TOKEN),
			);
			const userPrompt = prompt.render(slmNotesInputPrompt, {
				previousNotes: notes || "(none)",
				turnTranscript: scratchpad,
				maxNotesTokens: config.maxNotesTokens,
			});
			const startedAt = Date.now();
			let result: Awaited<ReturnType<SlmHandoffServer["complete"]>>;
			try {
				// Transcription, not generation: temperature 0 keeps identifiers intact, and a
				// per-run cap keeps one turn's notes from consuming the whole accumulated budget.
				result = await this.#completeWithRetry(config, systemPrompt, userPrompt, {
					temperature: 0,
					maxTokens: perRunTokens,
					// Notes are lines, not a document: the handoff normalizer would wrap
					// them in `## Handoff` and that heading then reaches the contract.
					normalize: "notes",
				});
			} catch (error) {
				const text = String(error);
				if (chunk.length > 1 && /exceeds the (?:available )?context|context size/i.test(text)) {
					const mid = Math.ceil(chunk.length / 2);
					logger.warn("SLM worker rejected an oversized notes chunk; splitting it", {
						messages: chunk.length,
						error: text.slice(0, 160),
					});
					queue.unshift(chunk.slice(mid), chunk.slice(0, mid));
					continue;
				}
				throw error;
			}
			const leaf = messageKey(chunk[chunk.length - 1]!);
			// Hitting the cap leaves a half-written line; drop it rather than smuggling a
			// truncated path or outcome into the notes the contract reads.
			const fresh = result.truncated ? result.document.replace(/\n[^\n]*$/, "").trimEnd() : result.document;
			notes = boundScratchpad(notes === "" ? fresh : `${notes}\n${fresh}`, notesBudget);
			const record: SlmNotesRecord = {
				text: notes,
				metadata: {
					version: 1,
					sessionId,
					coveredLeafKey: leaf,
					coveredAt: Date.now(),
					turns: turnNumber,
				},
			};
			await writeSlmNotes(agentDir, sessionId, record);
			lastRecord = record;
			logger.debug("SLM handoff notes written", {
				turns: record.metadata.turns,
				lines: notes.split("\n").length,
				chars: notes.length,
				ms: Date.now() - startedAt,
			});
		}
		// Cadence: at 1 the contract is written as the turn ends, so the summary is ready
		// when the next prompt starts and compaction reuses it without another call.
		const every = config.contractEveryTurns;
		if (lastRecord !== undefined && every > 0 && turnNumber % every === 0) {
			try {
				await this.#runContract(config, lastRecord, previousDocument, renderFileActions(batch));
			} catch (error) {
				// The notes survive: compaction retries the contract from them.
				logger.warn("SLM contract after turn failed", { error: String(error) });
			}
		}
	}
}
