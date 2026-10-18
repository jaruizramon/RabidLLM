/**
 * Scratchpad: the worker's input.
 *
 * A turn can be tens of thousands of tokens — every thought block, every file read, every
 * tool result — far more than a 4B worker can hold, and far more than it needs. The worker
 * does not need the turn; it needs a compressed record of what happened in it.
 *
 * Each event is reduced to one bounded line, and the pad itself is bounded to the newest
 * events that fit, so the input is the same size for a two-message turn and an
 * eighty-thousand-token one. The reductions are deterministic — clipping and extraction,
 * never another model call: a thought contributes its opening, a read contributes its path
 * and range, a conclusion contributes its first sentences.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { messageText } from "../rabid/turn-cards";

/** Characters kept from one thought block. */
const THOUGHT_CHARS = 160;
/** Characters kept from the assistant's visible text — the conclusion. */
const CONCLUSION_CHARS = 320;
/** Characters kept from a tool call's arguments. */
const CALL_CHARS = 160;
/** Characters kept from a tool result. */
const RESULT_CHARS = 200;
/** Characters kept from one user message. */
const USER_CHARS = 600;

function oneLine(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat === "") return "";
	return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/**
 * What a call acted on, in the fewest characters.
 *
 * `read` gets its range; a patch gets the file it names (the JSON arguments of an edit are
 * a paragraph of diff and would swamp the line); anything else keeps `path` or its command.
 */
function callTarget(name: string, args: Record<string, unknown>): string {
	if (name === "read") return readTarget(args);
	if (typeof args.path === "string") return args.path;
	const input = typeof args.input === "string" ? args.input : typeof args.patch === "string" ? args.patch : undefined;
	if (input !== undefined) {
		const header = /^\s*(?:\*\*\*\s*(?:Update|Add|Delete) File:\s*|PUT\s+|ADD\s+|DELETE\s+)(\S+)/m.exec(input);
		if (header?.[1] !== undefined) return header[1];
	}
	if (typeof args.command === "string") return args.command;
	return JSON.stringify(args);
}

/** `path:26-438` when a read narrows a range, the plain path otherwise. */
function readTarget(args: Record<string, unknown>): string {
	const path = typeof args.path === "string" ? args.path : undefined;
	if (path === undefined) return "";
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (offset === undefined) return path;
	return limit === undefined ? `${path}:${offset}-` : `${path}:${offset}-${offset + limit - 1}`;
}

/**
 * One line per event, in the notes' own vocabulary.
 *
 * The labels are the ones the notes stage must emit. Measured: with `CALL`/`RESULT` labels
 * here, a 4B worker mirrored them into `[CALL]`/`[RESULT]` note lines and invented its own
 * format; with the output's labels as input, there is nothing to translate, and a tool call
 * and its result arrive as the single `→ outcome` line the notes want.
 */
export function renderScratchpad(messages: readonly AgentMessage[]): string {
	const lines: string[] = [];
	/** Tool calls waiting for their result, by call id: `- [TOOL name] target`. */
	const pending = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "user") {
			const text = oneLine(messageText(message.content), USER_CHARS);
			if (text !== "") lines.push(`- [USER] ${text}`);
			continue;
		}
		if (message.role === "assistant") {
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (!isRecord(part)) continue;
					if (part.type === "thinking" && typeof part.thinking === "string") {
						const thought = oneLine(part.thinking, THOUGHT_CHARS);
						if (thought !== "") lines.push(`- [THOUGHT] ${thought}`);
						continue;
					}
					if (part.type !== "toolCall" || typeof part.name !== "string") continue;
					const args = isRecord(part.arguments) ? part.arguments : {};
					const detail = oneLine(callTarget(part.name, args), CALL_CHARS);
					const header = `- [TOOL ${part.name}]${detail === "" ? "" : ` ${detail}`}`;
					const id = typeof part.id === "string" ? part.id : undefined;
					if (id === undefined) lines.push(`${header} → (no result captured)`);
					else pending.set(id, header);
				}
			}
			const conclusion = oneLine(messageText(message.content), CONCLUSION_CHARS);
			if (conclusion !== "") lines.push(`- [SAID] ${conclusion}`);
			continue;
		}
		if (message.role === "toolResult") {
			const name = typeof message.toolName === "string" ? message.toolName : "tool";
			const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
			// An id that does not match (or is missing) belongs to the most recent open call:
			// emitting a bare line instead would lose the target the result actually answers.
			const lastOpen = [...pending.entries()].at(-1);
			const matched = id !== undefined ? pending.get(id) : undefined;
			const header = matched ?? lastOpen?.[1] ?? `- [TOOL ${name}]`;
			if (matched !== undefined) pending.delete(id!);
			else if (lastOpen !== undefined) pending.delete(lastOpen[0]);
			const text = oneLine(messageText(message.content), RESULT_CHARS);
			const outcome = message.isError ? `${text} (error)` : text;
			lines.push(`${header} → ${outcome}`);
		}
	}
	for (const header of pending.values()) lines.push(`${header} → (no result captured)`);
	return lines.join("\n");
}

/**
 * Keep the newest lines that fit in `maxChars`.
 *
 * The tail is kept, not the head: the latest events are what the handoff must reflect. A
 * marker records how much was dropped, so the worker knows the pad is partial rather than
 * thinking the turn began mid-way.
 */
export function boundScratchpad(pad: string, maxChars: number): string {
	if (pad.length <= maxChars) return pad;
	const lines = pad.split("\n");
	const kept: string[] = [];
	let size = 0;
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]!;
		if (size + line.length + 1 > maxChars && kept.length > 0) break;
		kept.unshift(line);
		size += line.length + 1;
	}
	return `… [${lines.length - kept.length} earlier events omitted] …\n${kept.join("\n")}`;
}

/** Lines that are a verbatim echo of the log or the notes rather than a selection from them. */
const LOG_ECHO = /^(?:THOUGHT|CALL|RESULT)\b|^[-*]\s*\[(?:USER|SAID|THOUGHT|TOOL)\b/;

/** How many lines of `document` are copied log lines. */
export function countLogEchoes(document: string): number {
	return document.split("\n").filter(line => LOG_ECHO.test(line.trim())).length;
}

/**
 * Drop copied log lines, keeping everything the model actually wrote.
 *
 * Used only after a retry failed to stop the transcription: a document with a few fewer
 * lines is better than one that hands the successor the raw event log.
 */
export function stripLogEchoes(document: string): string {
	const kept = document.split("\n").filter(line => !LOG_ECHO.test(line.trim()));
	return kept
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
