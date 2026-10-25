/**
 * "Can I bitch slap it?" — a periodic watchdog over the live transcript.
 *
 * The turn-end loop guard only sees one turn boundary at a time, and it is
 * silent when the model stops on its own. This watchdog samples the branch
 * every {@link BITCH_SLAP_INTERVAL_MS} and answers one question: is the agent
 * making progress? Two failures count:
 *
 * - `looping`: the same tool call (same name and arguments) appears three
 *   times in the recent window, or the same answer is repeated verbatim.
 * - `stalled`: the session is idle, the final assistant turn produced no tool
 *   call, and the todo ledger still has open items.
 *
 * Detection is deterministic and the signature is stable per stuck state, so a
 * single slap is delivered per state rather than one every tick.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";

import bitchSlapPrompt from "../prompts/system/bitch-slap.md" with { type: "text" };
import bitchSlapHardPrompt from "../prompts/system/bitch-slap-hard.md" with { type: "text" };

/** Cadence of the watchdog, and the minimum idle time before a stalled turn is slapped. */
export const BITCH_SLAP_INTERVAL_MS = 30_000;
/** Assistant turns inspected for repetition. */
const LOOP_WINDOW = 12;
const LOOP_TOOL_REPEATS = 3;
const LOOP_RESULT_REPEATS = 3;
const LOOP_TEXT_REPEATS = 2;
/** Five-word shingle overlap above this counts as the same answer restated. */
const LOOP_TEXT_SIMILARITY = 0.85;
/** Shorter answers repeat for benign reasons (acks, one-line status). */
const MIN_LOOP_TEXT = 80;
/** A stuck state gets one soft slap and one hard slap, then silence. */
const SLAPS_PER_STATE = 2;

export type BitchSlapVerdict = "nah" | "bitchslapping";
export type BitchSlapReason = "stalled" | "looping";

/** What the watchdog samples; the caller owns the session and the clock. */
export interface BitchSlapState {
	readonly messages: readonly AgentMessage[];
	readonly isStreaming: boolean;
	readonly incompleteTasks: number;
	/** Open todo lines, used by the escalated corrective. */
	readonly openTasks?: readonly string[];
	readonly now: number;
}

export interface BitchSlapDecision {
	readonly verdict: BitchSlapVerdict;
	readonly reason?: BitchSlapReason;
	readonly detail?: string;
	/** Stable key for the stuck state; the watchdog slaps each key once. */
	readonly signature?: string;
}

function stableValue(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
	if (!isRecord(value)) return JSON.stringify(value) ?? "null";
	const keys = Object.keys(value).sort();
	return `{${keys.map(key => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
}

function toolSignatures(message: AgentMessage): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const signatures: string[] = [];
	for (const part of message.content) {
		if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") continue;
		signatures.push(`${part.name}:${stableValue(part.arguments)}`);
	}
	return signatures;
}

function textOf(message: AgentMessage): string {
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	return (message.content as unknown[])
		.filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text")
		.map(part => part.text)
		.join("\n")
		.replace(/\s+/g, " ")
		.trim();
}

/** Five-word shingles: near-duplicate answers differ by a token, not a rewrite. */
function shingles(text: string): Set<string> {
	const words = text.split(" ");
	if (words.length < 5) return new Set([text]);
	const set = new Set<string>();
	for (let index = 0; index + 5 <= words.length; index++) {
		set.add(words.slice(index, index + 5).join(" "));
	}
	return set;
}

/**
 * Overlap coefficient, not Jaccard: one answer is often the other plus a
 * sentence or a truncation, and a repeated short answer dedupes its own
 * shingles. `shared / min` measures "one restates the other".
 */
function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const shingle of left) if (right.has(shingle)) shared++;
	return shared / Math.min(left.size, right.size);
}

/** Sample the branch and decide whether the agent is stuck. */
export function detectBitchSlap(state: BitchSlapState): BitchSlapDecision {
	const assistants = state.messages.filter(message => message.role === "assistant").slice(-LOOP_WINDOW);

	const toolCounts = new Map<string, number>();
	for (const message of assistants) {
		for (const signature of toolSignatures(message)) {
			toolCounts.set(signature, (toolCounts.get(signature) ?? 0) + 1);
		}
	}
	for (const [signature, count] of toolCounts) {
		if (count < LOOP_TOOL_REPEATS) continue;
		const tool = signature.slice(0, signature.indexOf(":"));
		return {
			verdict: "bitchslapping",
			reason: "looping",
			detail: `you called \`${tool}\` ${count} times with the same arguments in the last ${assistants.length} turns`,
			signature: `loop:tool:${signature}`,
		};
	}

	// The same tool output three times: different probes, or the same probe
	// rephrased, cannot make the answer change.
	const results = state.messages.filter(message => message.role === "toolResult").slice(-LOOP_WINDOW);
	const resultCounts = new Map<string, number>();
	for (const message of results) {
		const text = textOf(message);
		if (text.length < MIN_LOOP_TEXT) continue;
		resultCounts.set(text, (resultCounts.get(text) ?? 0) + 1);
	}
	for (const [text, count] of resultCounts) {
		if (count < LOOP_RESULT_REPEATS) continue;
		return {
			verdict: "bitchslapping",
			reason: "looping",
			detail: `the same tool output came back ${count} times in the last ${results.length} results`,
			signature: `loop:result:${Bun.hash(text).toString(36)}`,
		};
	}

	// Near-duplicate answers: the model restates the same reasoning with a
	// token changed, so exact equality misses it.
	const answers = assistants
		.map(message => textOf(message))
		.filter(text => text.length >= MIN_LOOP_TEXT)
		.map(text => ({ text, shingles: shingles(text), digest: Bun.hash(text).toString(36) }));
	for (let first = 0; first < answers.length; first++) {
		for (let second = first + 1; second < answers.length; second++) {
			if (overlap(answers[first]!.shingles, answers[second]!.shingles) < LOOP_TEXT_SIMILARITY) continue;
			return {
				verdict: "bitchslapping",
				reason: "looping",
				detail: `you wrote essentially the same ${answers[second]!.text.length}-character answer ${LOOP_TEXT_REPEATS}+ times`,
				signature: `loop:text:${answers[first]!.digest}`,
			};
		}
	}

	// Stopped mid-work: the turn yielded text-only, the ledger is open, and the
	// session has been idle long enough that no model call is in flight.
	const last = assistants.at(-1);
	if (state.isStreaming || !last || state.incompleteTasks <= 0) return { verdict: "nah" };
	if (last.stopReason !== "stop" || toolSignatures(last).length > 0) return { verdict: "nah" };
	const lastAt = typeof last.timestamp === "number" ? last.timestamp : undefined;
	if (lastAt === undefined || state.now - lastAt < BITCH_SLAP_INTERVAL_MS) return { verdict: "nah" };
	return {
		verdict: "bitchslapping",
		reason: "stalled",
		detail: `you stopped with ${state.incompleteTasks} todo item(s) still open`,
		signature: `yield:${lastAt}`,
	};
}

/** Holds the display state and escalates a stuck state that ignores its first slap. */
export class BitchSlapWatchdog {
	#signature: string | undefined;
	#stuck = false;
	#slaps = 0;

	/** Panel readout: the last evaluation's verdict, held until the next tick. */
	verdict(): BitchSlapVerdict {
		return this.#stuck ? "bitchslapping" : "nah";
	}

	/** Decide; the same stuck state gets one soft slap, then one hard one, then silence. */
	evaluate(state: BitchSlapState): { slap: boolean; text?: string; reason?: BitchSlapReason; hard?: boolean } {
		const decision = detectBitchSlap(state);
		this.#stuck = decision.verdict !== "nah";
		if (!this.#stuck) {
			this.#signature = undefined;
			this.#slaps = 0;
			return { slap: false };
		}
		if (decision.signature !== this.#signature) {
			this.#signature = decision.signature;
			this.#slaps = 0;
		}
		if (this.#slaps >= SLAPS_PER_STATE) return { slap: false };
		this.#slaps++;
		const hard = this.#slaps > 1;
		const tasks =
			state.openTasks !== undefined && state.openTasks.length > 0
				? state.openTasks
				: ["(no open todo item: name the next concrete action)"];
		return {
			slap: true,
			reason: decision.reason,
			hard,
			text: prompt.render(hard ? bitchSlapHardPrompt : bitchSlapPrompt, {
				detail: decision.detail ?? "you are not making progress",
				tasks,
			}),
		};
	}
}
