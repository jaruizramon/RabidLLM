/**
 * Per-prompt episodic cards: one small LLM-distilled record per completed
 * turn (prompt, touched files, pointer + 50-word summary per operation),
 * capped at `turnCards.maxTokens` and archived under the fork's agent dir.
 *
 * Cards are archive/recall material only — they are never injected into the
 * live context. The live transcript stays authoritative; compaction handles
 * context pressure separately.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { isRecord } from "@oh-my-pi/pi-utils";

export type TurnCardOperationKind = "read" | "edit" | "write" | "bash" | "grep" | "other";

export interface TurnCardOperation {
	kind: TurnCardOperationKind;
	path?: string;
	detail?: string;
	summary: string;
}

export interface TurnCard {
	prompt: string;
	files: string[];
	operations: TurnCardOperation[];
}

const TRANSCRIPT_PART_LIMIT = 1_500;
const MAX_OPERATIONS = 32;

export function messageText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.flatMap(part => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

function clip(text: string, limit = TRANSCRIPT_PART_LIMIT): string {
	const trimmed = text.trim();
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}… [${trimmed.length - limit} chars omitted]`;
}

/**
 * Middle-clip a rendered transcript to `limit` characters, keeping the head and the
 * tail and marking what was dropped.
 *
 * A single message can be larger than one worker run — an assistant message with
 * dozens of tool calls, or a tool result the renderer could not shorten further — and
 * a message cannot be split by the chunker, so the transcript itself must fit.
 * Head and tail are kept because the opening states the task and the tail holds the
 * latest state.
 */
export function clipMiddle(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const markerFor = (omitted: number) => `\n… [${omitted} chars omitted] …\n`;
	const headShare = 0.6;
	const budget = Math.max(0, limit - markerFor(0).length - 8);
	const head = text.slice(0, Math.floor(budget * headShare));
	const tail = text.slice(text.length - (budget - head.length));
	return `${head}${markerFor(text.length - head.length - tail.length)}${tail}`;
}

/** One thing the turn did, reduced to a path or a command. */
export interface FileAction {
	kind: "edit" | "write" | "read" | "search" | "bash" | "other";
	label: string;
}

const ACTION_CLIP = 120;
const DEFAULT_ACTION_LIMIT = 24;

/** Tool name → the action kind it represents. Unknown tools keep their name. */
const ACTION_KIND_BY_TOOL: Record<string, FileAction["kind"]> = {
	edit: "edit",
	write: "write",
	apply_patch: "edit",
	multi_edit: "edit",
	read: "read",
	grep: "search",
	glob: "search",
	bash: "bash",
};

/** `[PATH#TAG]` header the `edit` tool uses for anchored patch input. */
const PATCH_PATH_RE = /^\s*\[([^\]\n#]+)(?:#[^\]\n]*)?\]/;

function actionFromToolCall(name: string, args: unknown): FileAction {
	const kind = ACTION_KIND_BY_TOOL[name] ?? "other";
	const record = isRecord(args) ? args : {};
	const patchPath = typeof record.input === "string" ? PATCH_PATH_RE.exec(record.input)?.[1]?.trim() : undefined;
	const path =
		typeof record.path === "string"
			? record.path
			: typeof record.file_path === "string"
				? record.file_path
				: typeof record.filePath === "string"
					? record.filePath
					: patchPath === undefined || patchPath === ""
						? undefined
						: patchPath;
	const label = (() => {
		if (kind === "bash") {
			const command = typeof record.command === "string" ? record.command.trim().split("\n")[0] : "";
			return command === "" ? name : command;
		}
		if (kind === "search") {
			const pattern = typeof record.pattern === "string" ? record.pattern : "";
			const where = path ?? (typeof record.query === "string" ? record.query : "");
			if (pattern !== "") return where === "" ? pattern : `${pattern} in ${where}`;
			return where === "" ? name : where;
		}
		if (kind === "other") return name;
		return path ?? name;
	})();
	return { kind, label: label.length > ACTION_CLIP ? `${label.slice(0, ACTION_CLIP)}…` : label };
}

/**
 * File-level actions in `messages`, most recent last: what the turn edited,
 * wrote, read, searched, and ran.
 *
 * This is the deterministic record of "what just happened"; the handoff prompt
 * and the committed summary both take paths from here so a worker never has to
 * invent (or silently drop) a file.
 */
export function extractFileActions(messages: readonly AgentMessage[]): FileAction[] {
	const actions: FileAction[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") continue;
			actions.push(actionFromToolCall(part.name, part.arguments));
		}
	}
	return actions;
}

/**
 * Render the action log as Markdown, newest `maxItems` kept (older detail is
 * already folded into the document by the time it falls off), with consecutive
 * repeats collapsed.
 */
export function renderFileActions(messages: readonly AgentMessage[], maxItems = DEFAULT_ACTION_LIMIT): string {
	const actions = extractFileActions(messages).slice(-maxItems);
	if (actions.length === 0) return "";
	const lines: string[] = [];
	for (const action of actions) {
		const previous = lines[lines.length - 1];
		const repeated = previous === undefined ? undefined : /^- (.+?)(?: \(×(\d+)\))?$/.exec(previous);
		const text = `${action.kind} \`${action.label}\``;
		if (repeated?.[1] === text) {
			const count = Number(repeated[2] ?? "1") + 1;
			lines[lines.length - 1] = `- ${text} (×${count})`;
			continue;
		}
		lines.push(`- ${text}`);
	}
	return `## Recent file actions\n\n${lines.join("\n")}`;
}

/**
 * Deterministic failures and loops in `messages`, for the compaction summary.
 *
 * A weak summarizer can drop a failing test or describe an ignored loop as
 * progress. This block is computed from the transcript, so the successor sees
 * the failed call and the repeated payload even when the prose summary misses
 * them. A failure only counts as open when the same tool has no later success.
 */
export function renderOpenFailures(messages: readonly AgentMessage[], maxItems = 4): string {
	const calls: Array<{ id: string; name: string; fingerprint: string }> = [];
	const results = new Map<string, { name: string; isError: boolean; text: string; index: number }>();
	messages.forEach((message, index) => {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (
					!isRecord(part) ||
					part.type !== "toolCall" ||
					typeof part.id !== "string" ||
					typeof part.name !== "string"
				) {
					continue;
				}
				calls.push({
					id: part.id,
					name: part.name,
					fingerprint: `${part.name}:${isRecord(part.arguments) ? JSON.stringify(part.arguments) : ""}`,
				});
			}
			return;
		}
		if (message.role !== "toolResult") return;
		results.set(message.toolCallId, {
			name: message.toolName,
			isError: message.isError === true,
			text: messageText(message.content).replace(/\s+/g, " ").trim(),
			index,
		});
	});

	const repeated: Array<{ name: string; count: number; result: string }> = [];
	let run: { fingerprint: string; name: string; count: number; lastId: string } | undefined;
	const flushRun = () => {
		if (!run || run.count < 3) return;
		const result = results.get(run.lastId);
		// A repeated read or a retried command that eventually passed is not an
		// open failure; only a run whose last result failed belongs here.
		if (result?.isError) repeated.push({ name: run.name, count: run.count, result: result.text });
	};
	for (const call of calls) {
		if (run?.fingerprint === call.fingerprint) {
			run.count++;
			run.lastId = call.id;
			continue;
		}
		flushRun();
		run = { fingerprint: call.fingerprint, name: call.name, count: 1, lastId: call.id };
	}
	flushRun();

	const lastSuccessByTool = new Map<string, number>();
	for (const result of results.values()) {
		if (result.isError) continue;
		lastSuccessByTool.set(result.name, Math.max(lastSuccessByTool.get(result.name) ?? -1, result.index));
	}
	const seen = new Set(repeated.map(entry => `${entry.name}\u0000${entry.result}`));
	const failures = [...results.values()]
		.filter(result => result.isError && (lastSuccessByTool.get(result.name) ?? -1) < result.index)
		.filter(result => {
			const key = `${result.name}\u0000${result.text}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(-maxItems);

	if (repeated.length === 0 && failures.length === 0) return "";
	const lines = [
		...repeated.map(
			entry =>
				`- \`${entry.name}\` repeated ${entry.count}× with identical arguments; last result: \`${clip(entry.result, 240)}\``,
		),
		...failures.map(failure => `- \`${failure.name}\` failed: \`${clip(failure.text, 240)}\``),
	];
	return `## Open failures\n\n${lines.join("\n")}\n\nA later passing command or test must prove these; do not record their targets as Done.`;
}

/**
 * Live todo ledger for a committed summary.
 *
 * Todo phases are tool state, not transcript text, so a compaction that only
 * carries prose silently drops the successor's task pointer. Rendering the
 * open items here keeps the resume position exact even when the summarizer
 * never saw a `todo` call.
 */
export function renderTodoLedger(phases: readonly TodoPhase[]): string {
	const open = phases.flatMap(phase =>
		phase.tasks
			.filter(task => task.status === "pending" || task.status === "in_progress" || task.status === "blocked")
			.map(task => ({ phase: phase.name, task })),
	);
	if (open.length === 0) return "";
	const total = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	const closed = total - open.length;
	const lines = [
		"## Todo (live)",
		"",
		`${closed}/${total} done, ${open.length} open. This is live state, not transcript decoration: update it with \`todo\` before working past an item.`,
	];
	for (const phase of phases) {
		const tasks = phase.tasks.filter(
			task => task.status === "pending" || task.status === "in_progress" || task.status === "blocked",
		);
		if (tasks.length === 0) continue;
		lines.push(`- ${phase.name.replace(/\s+/g, " ")}`);
		for (const task of tasks) {
			const blocker = task.blocker === undefined ? "" : ` — ${task.blocker.replace(/\s+/g, " ")}`;
			lines.push(`  - [${task.status}] ${task.content.replace(/\s+/g, " ")}${blocker}`);
		}
	}
	return lines.join("\n");
}

/** Render the turn's messages as the archivist transcript (thinking omitted). */
export function renderTurnTranscript(messages: readonly AgentMessage[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = clip(messageText(message.content));
			if (text) lines.push(`USER:\n${text}`);
			continue;
		}
		if (message.role === "assistant") {
			const text = clip(messageText(message.content), 800);
			if (text) lines.push(`ASSISTANT:\n${text}`);
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") continue;
					const args = isRecord(part.arguments) ? JSON.stringify(part.arguments) : "";
					lines.push(`CALL ${part.name}(${clip(args, 600)})`);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const name = typeof message.toolName === "string" ? message.toolName : "tool";
			const text = clip(messageText(message.content));
			lines.push(`RESULT ${name}${message.isError ? " (error)" : ""}:\n${text}`);
		}
	}
	return lines.join("\n\n");
}

function asOperation(value: unknown): TurnCardOperation | undefined {
	if (!isRecord(value) || typeof value.summary !== "string" || value.summary.trim() === "") return undefined;
	const kind = typeof value.kind === "string" ? value.kind.toLowerCase() : "other";
	const allowed: TurnCardOperationKind[] = ["read", "edit", "write", "bash", "grep", "other"];
	return {
		kind: allowed.includes(kind as TurnCardOperationKind) ? (kind as TurnCardOperationKind) : "other",
		...(typeof value.path === "string" && value.path.trim() !== "" ? { path: value.path.trim() } : {}),
		...(typeof value.detail === "string" && value.detail.trim() !== "" ? { detail: value.detail.trim() } : {}),
		summary: value.summary.trim(),
	};
}

/** Parse the archivist's JSON (tolerating fences or surrounding prose). */
export function parseTurnCard(raw: string): TurnCard | undefined {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
	const files = Array.isArray(parsed.files)
		? [...new Set(parsed.files.flatMap(file => (typeof file === "string" && file.trim() ? [file.trim()] : [])))]
		: [];
	const operations = Array.isArray(parsed.operations)
		? parsed.operations.flatMap(operation => {
				const parsedOperation = asOperation(operation);
				return parsedOperation ? [parsedOperation] : [];
			})
		: [];
	if (!prompt && files.length === 0 && operations.length === 0) return undefined;
	return { prompt, files, operations: operations.slice(0, MAX_OPERATIONS) };
}

/** Approximate token count used for the card cap (no tokenizer round-trip per card). */
export function estimateCardTokens(card: TurnCard): number {
	return Math.ceil(JSON.stringify(card).length / 4);
}

function shorten(summary: string, words: number): string {
	const parts = summary.split(/\s+/);
	return parts.length <= words ? summary : `${parts.slice(0, words).join(" ")}…`;
}

/** Enforce the token cap: shorten long summaries, then drop the least important operations. */
export function trimTurnCard(card: TurnCard, maxTokens: number): TurnCard {
	const trimmed: TurnCard = { ...card, operations: [...card.operations] };
	while (estimateCardTokens(trimmed) > maxTokens && trimmed.operations.length > 0) {
		let longest = 0;
		for (let index = 1; index < trimmed.operations.length; index++) {
			if (trimmed.operations[index]!.summary.length > trimmed.operations[longest]!.summary.length) longest = index;
		}
		const operation = trimmed.operations[longest]!;
		const words = operation.summary.split(/\s+/).length;
		if (words > 12) {
			trimmed.operations[longest] = { ...operation, summary: shorten(operation.summary, Math.max(12, words - 10)) };
		} else {
			trimmed.operations.pop();
		}
	}
	if (estimateCardTokens(trimmed) > maxTokens) {
		trimmed.files = trimmed.files.slice(0, 16);
		trimmed.prompt = shorten(trimmed.prompt, 40);
	}
	return trimmed;
}

/** Human-readable block appended to the archive log. */
export function formatTurnCardMarkdown(card: TurnCard, meta: { sessionId: string; timestamp: number }): string {
	const when = new Date(meta.timestamp).toISOString();
	const lines = [`## [${when}] ${card.prompt || "(no prompt)"}`, `<!-- session:${meta.sessionId} -->`, ""];
	if (card.files.length > 0) lines.push(`Files: ${card.files.map(file => `\`${file}\``).join(", ")}`, "");
	for (const operation of card.operations) {
		const pointer = [operation.path, operation.detail].filter(Boolean).join(" ");
		lines.push(`- **${operation.kind}**${pointer ? ` \`${pointer}\`` : ""}: ${operation.summary}`);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

/** Append the JSONL record and the Markdown block under `<agentDir>/turn-cards/`. */
export async function writeTurnCard(agentDir: string, sessionId: string, card: TurnCard): Promise<void> {
	const directory = path.join(agentDir, "turn-cards");
	await fs.mkdir(directory, { recursive: true });
	const safeId = sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_");
	const timestamp = Date.now();
	const block = formatTurnCardMarkdown(card, { sessionId, timestamp });
	await fs.appendFile(
		path.join(directory, `${safeId}.jsonl`),
		`${JSON.stringify({ timestamp, sessionId, ...card })}\n`,
		"utf8",
	);
	await fs.appendFile(path.join(directory, `${safeId}.md`), block, "utf8");
	// The cumulative chain: compaction reads this instead of calling a model.
	await fs.appendFile(path.join(directory, `${safeId}.chain.md`), block, "utf8");
}

/**
 * Read the session's cumulative card chain, keeping the most recent blocks
 * within `maxTokens` (approximate). Returns the chain text and the number of
 * card blocks present before truncation.
 */
export async function readTurnCardChain(
	agentDir: string,
	sessionId: string,
	maxTokens: number,
): Promise<{ text: string; blocks: number; truncated: boolean; newestTimestamp?: number }> {
	const safeId = sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_");
	let raw: string;
	try {
		raw = await fs.readFile(path.join(agentDir, "turn-cards", `${safeId}.chain.md`), "utf8");
	} catch {
		return { text: "", blocks: 0, truncated: false };
	}
	const blocks = raw
		.split(/\n(?=## \[)/)
		.map(block => block.trim())
		.filter(block => block.length > 0);
	if (blocks.length === 0) return { text: "", blocks: 0, truncated: false };
	const newestTimestamp = (() => {
		const match = /^## \[([^\]]+)\]/.exec(blocks[blocks.length - 1]!);
		if (!match) return undefined;
		const parsed = Date.parse(match[1]!);
		return Number.isFinite(parsed) ? parsed : undefined;
	})();
	const selected: string[] = [];
	let chars = 0;
	const budget = maxTokens * 4;
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index]!;
		if (selected.length > 0 && chars + block.length > budget) break;
		selected.push(block);
		chars += block.length;
	}
	selected.reverse();
	const truncated = selected.length < blocks.length;
	return {
		text: `${truncated ? "… older cards omitted …\n\n" : ""}${selected.join("\n\n")}`,
		blocks: blocks.length,
		truncated,
		...(newestTimestamp === undefined ? {} : { newestTimestamp }),
	};
}

function messageTimestamp(message: AgentMessage): number | undefined {
	if (!("timestamp" in message)) return undefined;
	const timestamp = message.timestamp;
	return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * Whether the cumulative card chain actually covers the region being
 * summarized.
 *
 * The block count alone is not coverage: a stale chain from an earlier turn
 * passes `blocks >= userTurns` while describing none of the current work. A
 * card is written at `agent_end`, so a card timestamp at or after the newest
 * summarized message proves the last completed turn is represented. Mid-turn
 * compactions have no such card and must fall back to a summarizer.
 */
export function turnCardChainCoversRegion(
	messages: readonly AgentMessage[],
	blocks: number,
	newestTimestamp: number | undefined,
): boolean {
	const userTurns = messages.filter(message => message.role === "user").length;
	if (blocks < userTurns) return false;
	if (newestTimestamp === undefined) return false;
	let newestMessage: number | undefined;
	for (const message of messages) {
		const timestamp = messageTimestamp(message);
		if (timestamp !== undefined && (newestMessage === undefined || timestamp > newestMessage)) {
			newestMessage = timestamp;
		}
	}
	return newestMessage !== undefined && newestTimestamp >= newestMessage;
}
