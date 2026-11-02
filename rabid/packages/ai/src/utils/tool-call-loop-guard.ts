import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;
/**
 * Tool output shorter than this is not evidence of a loop: `(no output)` and
 * one-line confirmations repeat for reasons unrelated to a repeated probe.
 */
const RESULT_DIGEST_MIN_CHARS = 120;
/**
 * A full repeating sequence is stronger evidence than one repeated output, so
 * the cycle window accepts shorter turns (e.g. a one-line size check).
 */
const CYCLE_DIGEST_MIN_CHARS = 40;
/**
 * A loop does not have to be byte-identical back to back: a model can cycle
 * through the same few probes (A→B→C→A→B→C) and never repeat two consecutive
 * turns. These bound the sequence detector: periods 2–4, confirmed after two
 * full cycles, judged only on non-trivial output.
 */
const CYCLE_MIN_PERIOD = 2;
const CYCLE_MAX_PERIOD = 4;
const CYCLE_HISTORY = CYCLE_MAX_PERIOD * 2;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	/**
	 * Consecutive turns returning identical non-trivial tool output before the
	 * guard reports it, independent of the arguments that produced it. `0`
	 * disables output-based detection.
	 */
	readonly resultThreshold?: number;
	/**
	 * Consecutive turns whose output carries the same error signature before the
	 * guard reports a failure loop, even when the arguments and the exact bytes
	 * differ. `0` disables signature detection.
	 */
	readonly failureThreshold?: number;
	readonly exemptTools: readonly string[];
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

/** Details needed to steer the model away from a repeated tool call. */
export interface RepeatedToolCallDetection {
	/**
	 * `repeated_tool_call`: the same arguments came back.
	 * `repeated_tool_result`: different arguments produced the same output.
	 * `repeated_tool_cycle`: the same sequence of probes repeated.
	 * `repeated_tool_failure`: the same error signature kept coming back while
	 * the arguments and the surrounding bytes changed (edit → rebuild → same error).
	 */
	readonly kind: "repeated_tool_call" | "repeated_tool_result" | "repeated_tool_cycle" | "repeated_tool_failure";
	readonly toolName: string;
	readonly count: number;
	/** For `repeated_tool_cycle`: the number of turns in the repeating sequence. */
	readonly period?: number;
	/** For `repeated_tool_failure`: the normalized error line that keeps recurring. */
	readonly signature?: string;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

function canonicalizeToolCallValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeToolCallValue(item));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		output[key] = canonicalizeToolCallValue(input[key]);
	}
	return output;
}

function summarizeText(text: string, limit: number): string {
	let summary = text.replace(/\s+/g, " ").trim();
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

const FAILURE_SIGNATURE_LIMIT = 200;
/**
 * Diagnostic lines worth counting across turns. The first line of an error is
 * the stable part; source spans, `help:` and `note:` lines move on every edit,
 * which is why byte-identical comparison misses an edit-rebuild loop.
 */
const FAILURE_LINE_PATTERNS: readonly { readonly re: RegExp; readonly code: "prefix" | "none" }[] = [
	{ re: /^\s*error\[([A-Za-z]+\d+)\]:\s*(.+?)\s*$/u, code: "prefix" },
	{ re: /^\s*error\s+(TS\d+):\s*(.+?)\s*$/u, code: "prefix" },
	{ re: /^\s*error:\s*(.+?)\s*$/u, code: "none" },
	{ re: /^\s*Error:\s*(.+?)\s*$/u, code: "none" },
];

/** Normalized error lines in one tool result, in output order. */
function failureSignatures(text: string): string[] {
	const signatures: string[] = [];
	let seen: Set<string> | undefined;
	for (const line of text.split("\n")) {
		if (!/error/i.test(line)) continue;
		for (const { re, code } of FAILURE_LINE_PATTERNS) {
			const match = re.exec(line);
			if (!match) continue;
			const label = code === "prefix" ? `${match[1]}: ` : "";
			const message = match[code === "prefix" ? 2 : 1]!.replace(/\s+/g, " ").trim();
			const signature = `${label}${message.slice(0, FAILURE_SIGNATURE_LIMIT)}`;
			seen ??= new Set();
			if (!seen.has(signature)) {
				seen.add(signature);
				signatures.push(signature);
			}
			break;
		}
	}
	return signatures;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return summarizeText(textParts.join("\n"), RESULT_SUMMARY_LIMIT);
}

/**
 * Digest of one turn's tool output (name, error flag, text), independent of the
 * arguments that produced it. Identical output from different probes is the
 * signal that the model is not learning; identical arguments are already the
 * other detector's job. `undefined` means there is no output to compare
 * (missing results).
 */
function toolOutputDigest(
	toolCalls: readonly ToolCall[],
	toolResults: readonly ToolResultMessage[],
): { digest: string; chars: number } | undefined {
	const parts: string[] = [];
	let textChars = 0;
	for (const call of toolCalls) {
		const result = toolResults.find(candidate => candidate.toolCallId === call.id);
		if (!result) return undefined;
		const text = summarizeText(
			result.content.map(block => (block.type === "text" ? block.text : "")).join("\n"),
			Number.MAX_SAFE_INTEGER,
		);
		textChars += text.length;
		parts.push(`${call.name}\u0000${result.isError ? "error" : "ok"}\u0000${text}`);
	}
	return { digest: Bun.hash(parts.join("\u0001")).toString(36), chars: textChars };
}

/** Detects consecutive identical assistant tool calls across model turns. */
export class ToolCallLoopGuard {
	#threshold: number;
	#resultThreshold: number;
	#failureThreshold: number;
	#exemptTools: ReadonlySet<string>;
	#lastHash: string | undefined;
	#count = 0;
	#lastResultDigest: string | undefined;
	#resultCount = 0;
	/** Consecutive turns each error signature has appeared in. */
	#failureCounts = new Map<string, number>();
	/** Digests of the newest turns, for period-2..4 sequence detection. */
	#recentOutputs: Array<string | undefined> = [];

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#resultThreshold = Math.max(0, Math.trunc(options.resultThreshold ?? 0));
		this.#failureThreshold = Math.max(0, Math.trunc(options.failureThreshold ?? 0));
		this.#exemptTools = new Set(options.exemptTools);
	}

	/** Records one completed turn and reports repetitions at or beyond the threshold. */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length === 0) {
			this.#reset();
			return null;
		}
		if (toolCalls.every(tc => this.#exemptTools.has(tc.name))) {
			this.#reset();
			return null;
		}

		const reportCall = toolCalls.find(tc => !this.#exemptTools.has(tc.name)) ?? toolCalls[0]!;
		const detection = this.#recordArguments(toolCalls, turn, reportCall);
		const resultDetection = this.#recordOutput(toolCalls, turn, reportCall);
		// Runs every turn: the signature counts only reset by observing a turn
		// that no longer carries them, so skipping it would keep a stale streak.
		const failureDetection = this.#recordFailure(toolCalls, turn, reportCall);
		// Precedence: the argument detector names the exact call to stop, then a
		// consecutive output repeat, then a repeated error signature, then a
		// repeating multi-turn sequence.
		return detection ?? resultDetection ?? failureDetection ?? this.#detectCycle(turn, reportCall);
	}

	#recordArguments(
		toolCalls: readonly ToolCall[],
		turn: ToolCallLoopTurn,
		reportCall: ToolCall,
	): RepeatedToolCallDetection | null {
		const canonicalCalls = toolCalls
			.map(tc => JSON.stringify([tc.name, canonicalizeToolCallValue(tc.arguments)]))
			.sort();
		const turnHash = JSON.stringify(canonicalCalls);
		if (turnHash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = turnHash;
			this.#count = 1;
		}
		if (this.#count < this.#threshold) return null;
		return {
			kind: "repeated_tool_call",
			toolName: reportCall.name,
			count: this.#count,
			resultSummary: summarizeToolResult(turn.toolResults, reportCall.id),
			argumentsSummary: summarizeText(
				JSON.stringify(canonicalizeToolCallValue(reportCall.arguments)),
				ARGUMENT_SUMMARY_LIMIT,
			),
		};
	}

	#recordOutput(
		toolCalls: readonly ToolCall[],
		turn: ToolCallLoopTurn,
		reportCall: ToolCall,
	): RepeatedToolCallDetection | null {
		const output = toolOutputDigest(toolCalls, turn.toolResults);
		const digest = output !== undefined && output.chars >= RESULT_DIGEST_MIN_CHARS ? output.digest : undefined;
		this.#recentOutputs.push(
			output !== undefined && output.chars >= CYCLE_DIGEST_MIN_CHARS ? output.digest : undefined,
		);
		if (this.#recentOutputs.length > CYCLE_HISTORY) this.#recentOutputs.shift();
		if (digest === undefined) {
			this.#lastResultDigest = undefined;
			this.#resultCount = 0;
			return null;
		}
		if (digest === this.#lastResultDigest) {
			this.#resultCount++;
		} else {
			this.#lastResultDigest = digest;
			this.#resultCount = 1;
		}
		if (this.#resultThreshold === 0 || this.#resultCount < this.#resultThreshold) return null;
		return {
			kind: "repeated_tool_result",
			toolName: reportCall.name,
			count: this.#resultCount,
			resultSummary: summarizeToolResult(turn.toolResults, reportCall.id),
			argumentsSummary: summarizeText(
				JSON.stringify(canonicalizeToolCallValue(reportCall.arguments)),
				ARGUMENT_SUMMARY_LIMIT,
			),
		};
	}

	/**
	 * Same error signature across consecutive turns, regardless of the arguments
	 * that produced it. This is the edit-rebuild loop the byte digests miss: the
	 * error's first line stays put while the source span, `note:` and `help:`
	 * lines move with every edit, so no two turns are ever identical.
	 *
	 * The pre-dispatch `ToolFailureTracker` blocks an identical call after two
	 * failures; this covers what escapes it — different arguments, `isError:
	 * false` results from piped commands, and moving diagnostic bodies.
	 */
	#recordFailure(
		toolCalls: readonly ToolCall[],
		turn: ToolCallLoopTurn,
		_reportCall: ToolCall,
	): RepeatedToolCallDetection | null {
		if (this.#failureThreshold === 0) return null;
		const present = new Map<string, ToolCall>();
		for (const call of toolCalls) {
			if (this.#exemptTools.has(call.name)) continue;
			const result = turn.toolResults.find(candidate => candidate.toolCallId === call.id);
			if (!result) continue;
			const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			for (const signature of failureSignatures(text)) {
				if (!present.has(signature)) present.set(signature, call);
			}
		}
		// A signature missing from this turn ends its streak; anything else would
		// count failures separated by genuine progress. Deleting from a Map while
		// iterating its keys is safe: deleted entries are simply skipped.
		for (const signature of this.#failureCounts.keys()) {
			if (!present.has(signature)) this.#failureCounts.delete(signature);
		}
		let winner: { signature: string; count: number; call: ToolCall } | undefined;
		for (const [signature, call] of present) {
			const count = (this.#failureCounts.get(signature) ?? 0) + 1;
			this.#failureCounts.set(signature, count);
			if (count >= this.#failureThreshold && (!winner || count > winner.count)) {
				winner = { signature, count, call };
			}
		}
		if (!winner) return null;
		return {
			kind: "repeated_tool_failure",
			toolName: winner.call.name,
			count: winner.count,
			signature: winner.signature,
			resultSummary: summarizeToolResult(turn.toolResults, winner.call.id),
			argumentsSummary: summarizeText(
				JSON.stringify(canonicalizeToolCallValue(winner.call.arguments)),
				ARGUMENT_SUMMARY_LIMIT,
			),
		};
	}

	/**
	 * Two full periods of the same output sequence, with distinct entries.
	 * Judged on output digests only: alternating two probes that keep returning
	 * the same evidence is the pathology, while alternating two calls whose
	 * outputs move is ordinary work.
	 */
	#detectCycle(turn: ToolCallLoopTurn, reportCall: ToolCall): RepeatedToolCallDetection | null {
		const recent = this.#recentOutputs;
		for (let period = CYCLE_MIN_PERIOD; period <= CYCLE_MAX_PERIOD; period++) {
			if (recent.length < period * 2) continue;
			const tail = recent.slice(-period);
			const previous = recent.slice(-period * 2, -period);
			if ([...tail, ...previous].some(digest => digest === undefined)) continue;
			if (new Set(tail).size !== period) continue;
			if (!tail.every((digest, index) => digest === previous[index])) continue;
			return {
				kind: "repeated_tool_cycle",
				toolName: reportCall.name,
				count: period * 2,
				period,
				resultSummary: summarizeToolResult(turn.toolResults, reportCall.id),
				argumentsSummary: summarizeText(
					JSON.stringify(canonicalizeToolCallValue(reportCall.arguments)),
					ARGUMENT_SUMMARY_LIMIT,
				),
			};
		}
		return null;
	}

	#reset(): void {
		this.#lastHash = undefined;
		this.#count = 0;
		this.#lastResultDigest = undefined;
		this.#resultCount = 0;
		this.#failureCounts.clear();
		this.#recentOutputs = [];
	}
}
