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
const THOUGHT_CHARS = 240;
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

/** `path:26-438` when a read narrows a range, the plain path otherwise. */
function readTarget(args: Record<string, unknown>): string {
	const path = typeof args.path === "string" ? args.path : undefined;
	if (path === undefined) return "";
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (offset === undefined) return path;
	return limit === undefined ? `${path}:${offset}-` : `${path}:${offset}-${offset + limit - 1}`;
}

/** One line per event, in order: what was thought, called, learned, and concluded. */
export function renderScratchpad(messages: readonly AgentMessage[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = oneLine(messageText(message.content), USER_CHARS);
			if (text !== "") lines.push(`USER: ${text}`);
			continue;
		}
		if (message.role === "assistant") {
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (!isRecord(part)) continue;
					if (part.type === "thinking" && typeof part.thinking === "string") {
						const thought = oneLine(part.thinking, THOUGHT_CHARS);
						if (thought !== "") lines.push(`THOUGHT: ${thought}`);
						continue;
					}
					if (part.type !== "toolCall" || typeof part.name !== "string") continue;
					const args = isRecord(part.arguments) ? part.arguments : {};
					const target = part.name === "read" ? readTarget(args) : "";
					const detail =
						target !== ""
							? target
							: oneLine(typeof args.command === "string" ? args.command : JSON.stringify(args), CALL_CHARS);
					lines.push(`CALL ${part.name}${detail === "" ? "" : `(${detail})`}`);
				}
			}
			const conclusion = oneLine(messageText(message.content), CONCLUSION_CHARS);
			if (conclusion !== "") lines.push(`CONCLUSION: ${conclusion}`);
			continue;
		}
		if (message.role === "toolResult") {
			const name = typeof message.toolName === "string" ? message.toolName : "tool";
			const text = oneLine(messageText(message.content), RESULT_CHARS);
			lines.push(`RESULT ${name}${message.isError ? " (error)" : ""}: ${text}`);
		}
	}
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
