import type { AgentToolResult, AfterToolCallResult, BeforeToolCallResult } from "@oh-my-pi/pi-agent-core";

/** Longest error excerpt echoed back in a hint; enough to identify the class, short enough not to replay a payload. */
const MAX_ERROR_EXCERPT = 300;

/**
 * Recovery guidance for a repeated failure. The `edit` tool's contract errors
 * are not argument-serialization defects: the model usually reused a stale
 * content tag or mistook `PUT N:` for a block replacement. Steer it to the
 * current tag and to the range-replacement/`write` paths instead of letting it
 * retry the same broken shape.
 */
function failureGuidance(toolName: string, text: string): string {
	if (toolName === "edit") {
		if (text.includes("input must begin with") && text.includes("[PATH#HASH]")) {
			return "Start the edit `input` with `[PATH#HASH]` copied from the latest `read`. Put the patch in `input`; keep `i` short. Do not put the patch in `i`.";
		}
		if (text.includes("file changed between read and edit")) {
			return "The file changed since that tag. Use the current `[path#newhash]` shown in the error (or re-read) and do not reuse the old tag.";
		}
		if (text.includes("Input header must be [PATH]")) {
			return "Re-read the target file with `read` and retry using its current `[PATH#TAG]` (the 4-hex content hash from the read result). A line number is not a tag; do not reuse the failed header.";
		}
		if (/register `PUT`|without `:`|body ends by restating|single-line block/.test(text)) {
			return "Use `PUT N.=M:` with the complete final content of the range, or rewrite the whole file with `write`. `PUT N:` inserts at N without deleting; `PUT N*` only walks a real multi-line construct; register PUTs paste without body rows.";
		}
		return "Re-read the target file with `read`, use its current `[PATH#TAG]`, and replace ranges with `PUT N.=M:` plus their complete final content (or use `write`). Do not retry the same edit.";
	}
	return (
		"This is an argument-shape problem, not a change in the environment. " +
		'Check scalar arguments for JSON-string-literal wrapping (path: "\\"/abs/file\\"", op: "\\"init\\""); ' +
		"pass raw values, and do not retry the same call shape."
	);
}

/**
 * Tracks repeated tool failures inside one session.
 *
 * Two failure classes matter:
 *
 * - **Repeated exact call.** The same tool with the same arguments failed
 *   twice. Retrying it a third time cannot change the outcome; the model is
 *   looping (a wrong argument shape, not a transient environment). The third
 *   call is blocked with an actionable reason.
 * - **Repeated error class.** Different calls to one tool fail with the same
 *   message. The second occurrence earns a context note naming the likely
 *   cause (a serialization defect in the arguments, not the tool), because the
 *   model has already shown it will invent an environment theory instead.
 *
 * Success clears the exact-call counter and the tool's recent error, so a
 * recovered tool does not keep receiving notes.
 */
export class ToolFailureTracker {
	#errorCounts = new Map<string, number>();
	#lastErrorByTool = new Map<string, string>();
	#lastFailedFingerprint: string | undefined;
	#identicalFailures = 0;

	/** Pre-dispatch guard: block a third identical call after two failures. */
	beforeCall(toolName: string, args: Record<string, unknown>): BeforeToolCallResult | undefined {
		const fingerprint = toolCallFingerprint(toolName, args);
		if (fingerprint !== this.#lastFailedFingerprint || this.#identicalFailures < 2) return undefined;
		const last = this.#lastErrorByTool.get(toolName);
		return {
			block: true,
			reason:
				`Repeated-failure guard: this exact ${toolName} call has already failed ${this.#identicalFailures} times, so it was not run again. ` +
				failureGuidance(toolName, last ?? "") +
				(last ? ` Last error: ${last}` : ""),
		};
	}

	/** Post-execution bookkeeping; returns the steering note when an error class repeats. */
	recordOutcome(
		toolName: string,
		args: Record<string, unknown>,
		isError: boolean,
		content: AgentToolResult<unknown>["content"],
	): AfterToolCallResult | undefined {
		if (!isError) {
			this.#identicalFailures = 0;
			this.#lastFailedFingerprint = undefined;
			this.#lastErrorByTool.delete(toolName);
			return undefined;
		}
		const text = errorExcerpt(content);
		if (text.length === 0) return undefined;

		const signature = `${toolName}\u0000${text}`;
		const count = (this.#errorCounts.get(signature) ?? 0) + 1;
		this.#errorCounts.set(signature, count);

		const fingerprint = toolCallFingerprint(toolName, args);
		this.#identicalFailures = fingerprint === this.#lastFailedFingerprint ? this.#identicalFailures + 1 : 1;
		this.#lastFailedFingerprint = fingerprint;
		this.#lastErrorByTool.set(toolName, text);

		if (count < 2) return undefined;
		return {
			additionalContext:
				`Repeated tool failure (${count}×) for \`${toolName}\`: ${text}\n` + failureGuidance(toolName, text),
		};
	}

	/** Drop all state between sessions so a prior session's loop cannot block a fresh one. */
	reset(): void {
		this.#errorCounts.clear();
		this.#lastErrorByTool.clear();
		this.#lastFailedFingerprint = undefined;
		this.#identicalFailures = 0;
	}
}

/**
 * Stable fingerprint of a call's arguments. Key order is normalized so a
 * reordered but otherwise identical call still counts as the same loop.
 * Content payloads are hashed, not retained, so a large `write` costs one
 * allocation and no long-lived memory.
 */
export function toolCallFingerprint(toolName: string, args: Record<string, unknown>): string {
	return `${toolName}:${Bun.hash(stableSerialize(args)).toString(16)}`;
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function errorExcerpt(content: AgentToolResult<unknown>["content"]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	const compact = parts.join(" ").replace(/\s+/g, " ").trim();
	return compact.length > MAX_ERROR_EXCERPT ? `${compact.slice(0, MAX_ERROR_EXCERPT)}…` : compact;
}
