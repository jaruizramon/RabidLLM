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
	cfgSlmHandoffMaxInputTokens,
	cfgSlmHandoffModelPath,
	cfgSlmHandoffReasoningBudgetTokens,
	cfgSlmHandoffServerPath,
	cfgSlmHandoffThreads,
	cfgSlmHandoffWorkerUrl,
	type CompactionSettings,
} from "../session/context-settings";
import { resolveCompactionMethodOrder } from "../session/compaction-methods";
import { parseSlmDevice, SlmHandoffServer, type SlmServerConfig } from "./server";
import { clipMiddle, messageText, renderFileActions, renderTurnTranscript } from "../rabid/turn-cards";
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
export function resolveSlmServerConfig(settings: Settings, contextWindow: number | null | undefined): SlmServerConfig {
	const modelPath = resolveSlmModelPath(cfgSlmHandoffModelPath.get(settings));
	const serverPath = resolveSlmServerPath(cfgSlmHandoffServerPath.get(settings));
	if (!serverPath) {
		throw new Error(
			"llama-server binary not found; set compaction.slmHandoff.serverPath or install llama-server-stock",
		);
	}
	const ctxSize = Math.min(
		Math.max(contextWindow ?? DEFAULT_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW),
		cfgSlmHandoffMaxContextTokens.get(settings),
	);
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
	};
}

/** Greedy split of a turn batch into runs whose rendered transcript fits the input budget. */
function chunkByRenderedLength(messages: readonly AgentMessage[], budgetChars: number): AgentMessage[][] {
	const chunks: AgentMessage[][] = [];
	let current: AgentMessage[] = [];
	let size = 0;
	for (const message of messages) {
		const rendered = renderTurnTranscript([message]).length;
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
		/** The messages this compaction discards; the document is re-derived from them. */
		region?: readonly AgentMessage[];
	}): Promise<SlmHandoffRecord | undefined> {
		if (this.#disposed || !this.#gateOpen()) return undefined;
		const messages = this.#options.messages();
		const last = messages[messages.length - 1];
		if (!last) return undefined;
		const key = messageKey(last);
		const existing = await readSlmHandoff(this.#options.agentDir(), this.#options.sessionId());
		if (existing?.metadata && coversOperatorTurns(messages, existing.metadata.coveredLeafKey)) {
			return { document: existing.document, metadata: existing.metadata };
		}
		// A drain scheduled at the last turn boundary is already covering the live
		// leaf: enqueueing the region on top of it would pay for the same content
		// twice (measured: two 118s runs for one turn with a 4B worker).
		const coveredByScheduledDrain = this.#drainPromise !== undefined && this.#lastProcessedKey === key;
		const region = coveredByScheduledDrain ? [] : (options.region ?? []);
		if (region.length > 0) {
			// The warm chain does not cover the live leaf, so derive the document from
			// the region compaction is about to discard rather than from a chain that
			// may have drifted: waiting then buys a document over the real content.
			this.#pending = [...region];
			this.#lastProcessedKey = key;
		} else {
			this.#ensureCoverage(messages, existing);
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
		const written = await readSlmHandoff(this.#options.agentDir(), this.#options.sessionId());
		if (!written?.metadata || !coversOperatorTurns(messages, written.metadata.coveredLeafKey)) return undefined;
		return { document: written.document, metadata: written.metadata };
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
	 * Force a run that covers the live leaf. Replaces the queue rather than
	 * appending: the batch always restarts from the covered key, so appending
	 * would duplicate turns already waiting to be distilled.
	 */
	#ensureCoverage(messages: readonly AgentMessage[], record: SlmHandoffFile | undefined): void {
		const coveredKey = record?.metadata?.coveredLeafKey;
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
		const sizes = this.#pending.map(message => renderTurnTranscript([message]).length);
		for (const size of sizes) total += size;
		let dropped = 0;
		while (this.#pending.length > 1 && total > limit) {
			total -= sizes.shift() ?? 0;
			this.#pending.shift();
			dropped++;
		}
		if (dropped > 0) logger.warn("SLM handoff backlog exceeded its budget; dropped the oldest turns", { dropped });
	}

	async #runBatch(batch: readonly AgentMessage[]): Promise<void> {
		const config = resolveSlmServerConfig(this.#options.settings, this.#options.modelContextWindow());
		const sessionId = this.#options.sessionId();
		const agentDir = this.#options.agentDir();
		const stored = await readSlmHandoff(agentDir, sessionId);
		let previous: SlmHandoffRecord | undefined =
			stored?.metadata === undefined ? undefined : { document: stored.document, metadata: stored.metadata };
		// Detail is a setting, not a prompt edit: the same template carries all three
		// registers and exactly one branch is enabled.
		const detail = cfgSlmHandoffDetail.get(this.#options.settings);
		const systemPrompt = prompt.render(slmHandoffSystemPrompt, {
			maxHandoffTokens: config.maxHandoffTokens,
			detailConcise: detail === "concise",
			detailStandard: detail === "standard",
			detailDetailed: detail === "detailed",
		});
		// A queue rather than a plain loop: an oversized chunk is split in half and both
		// halves are retried with their own rendered prompt. The character estimate
		// cannot be exact (code tokenizes denser than prose), so the server's own
		// overflow rejection is the authority.
		const queue: AgentMessage[][] = chunkByRenderedLength(batch, config.maxInputTokens * CHUNK_CHARS_PER_TOKEN);
		while (queue.length > 0) {
			const chunk = queue.shift()!;
			const transcript = clipMiddle(
				renderTurnTranscript(chunk),
				Math.floor(config.maxInputTokens * CHUNK_CHARS_PER_TOKEN),
			);
			const userPrompt = prompt.render(slmHandoffInputPrompt, {
				previousHandoff: previous?.document || "(none)",
				turnTranscript: transcript,
				actionLog: renderFileActions(chunk) || "(none)",
				maxHandoffTokens: config.maxHandoffTokens,
			});
			const startedAt = Date.now();
			let result: Awaited<ReturnType<SlmHandoffServer["complete"]>>;
			try {
				result = await this.#server.complete(config, systemPrompt, userPrompt, this.#abort.signal);
			} catch (error) {
				const text = String(error);
				if (chunk.length > 1 && /exceeds the (?:available )?context|context size/i.test(text)) {
					const mid = Math.ceil(chunk.length / 2);
					logger.warn("SLM worker rejected an oversized chunk; splitting it", {
						messages: chunk.length,
						error: text.slice(0, 160),
					});
					queue.unshift(chunk.slice(mid), chunk.slice(0, mid));
					continue;
				}
				throw error;
			}
			const leaf = chunk[chunk.length - 1]!;
			const record: SlmHandoffRecord = {
				document: result.document,
				metadata: {
					version: 1,
					sessionId,
					coveredLeafKey: messageKey(leaf),
					coveredAt: Date.now(),
					coveredUserTurns: (previous?.metadata.coveredUserTurns ?? 0) + chunk.filter(isOperatorTurn).length,
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
			previous = record;
		}
	}
}
