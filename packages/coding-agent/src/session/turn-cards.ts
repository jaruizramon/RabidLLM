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

function actionFromToolCall(name: string, args: unknown): FileAction {
	const kind = ACTION_KIND_BY_TOOL[name] ?? "other";
	const record = isRecord(args) ? args : {};
	const path =
		typeof record.path === "string"
			? record.path
			: typeof record.file_path === "string"
				? record.file_path
				: typeof record.filePath === "string"
					? record.filePath
					: undefined;
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
): Promise<{ text: string; blocks: number; truncated: boolean }> {
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
	};
}
