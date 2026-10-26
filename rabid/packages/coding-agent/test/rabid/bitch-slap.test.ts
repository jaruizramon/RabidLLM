/** The 30-second watchdog behind the "can I bitch slap it?" header. */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	BITCH_SLAP_INTERVAL_MS,
	BitchSlapWatchdog,
	detectBitchSlap,
	type BitchSlapState,
} from "@oh-my-pi/pi-coding-agent/rabid/bitch-slap";

const NOW = 10_000_000;

function toolCall(name: string, args: Record<string, unknown>, id = `${name}-1`) {
	return { type: "toolCall" as const, id, name, arguments: args };
}

function assistant(
	timestamp: number,
	content: Array<Record<string, unknown>>,
	stopReason: "stop" | "toolUse" = "toolUse",
): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason,
		timestamp,
	} as unknown as AgentMessage;
}

function state(overrides: Partial<BitchSlapState> = {}): BitchSlapState {
	return {
		messages: [],
		isStreaming: false,
		incompleteTasks: 0,
		now: NOW,
		...overrides,
	};
}

describe("detectBitchSlap", () => {
	it("stays quiet when the last turn used a tool", () => {
		const messages = [assistant(NOW - 120_000, [toolCall("bash", { command: "pytest" })])];
		expect(detectBitchSlap(state({ messages, incompleteTasks: 5 })).verdict).toBe("nah");
	});

	it("slaps a turn that yielded text-only with open todos", () => {
		const messages = [
			assistant(NOW - BITCH_SLAP_INTERVAL_MS - 1_000, [{ type: "text", text: "done for now" }], "stop"),
		];
		expect(detectBitchSlap(state({ messages, incompleteTasks: 2 }))).toMatchObject({
			verdict: "bitchslapping",
			reason: "stalled",
			detail: "you stopped with 2 todo item(s) still open",
		});
	});

	it("does not slap before the idle window elapses", () => {
		const messages = [
			assistant(NOW - BITCH_SLAP_INTERVAL_MS + 5_000, [{ type: "text", text: "still here" }], "stop"),
		];
		expect(detectBitchSlap(state({ messages, incompleteTasks: 2 })).verdict).toBe("nah");
	});

	it("does not slap a streaming turn or a finished ledger", () => {
		const messages = [assistant(NOW - 120_000, [{ type: "text", text: "waiting" }], "stop")];
		expect(detectBitchSlap(state({ messages, incompleteTasks: 2, isStreaming: true })).verdict).toBe("nah");
		expect(detectBitchSlap(state({ messages, incompleteTasks: 0 })).verdict).toBe("nah");
	});

	it("slaps a tool call repeated three times in the recent window", () => {
		const messages = [1, 2, 3].map(index =>
			assistant(NOW - 90_000 + index * 1_000, [toolCall("bash", { command: "probe" }, `call-${index}`)]),
		);
		expect(detectBitchSlap(state({ messages, isStreaming: true, incompleteTasks: 3 }))).toMatchObject({
			verdict: "bitchslapping",
			reason: "looping",
			detail: "you called `bash` 3 times with the same arguments in the last 3 turns",
		});
	});

	it("slaps an answer repeated verbatim", () => {
		const text = "I keep re-reading the same file. Let me stop and think about what I know. ".repeat(3);
		const messages = [
			assistant(NOW - 90_000, [{ type: "text", text }], "stop"),
			assistant(NOW - 40_000, [{ type: "text", text }], "stop"),
		];
		expect(detectBitchSlap(state({ messages, incompleteTasks: 1 }))).toMatchObject({
			verdict: "bitchslapping",
			reason: "looping",
		});
	});

	it("slaps a near-duplicate answer that differs by a token", () => {
		const base =
			"The parser reads 243 bytes for a record the format says is 239 bytes, so it is four bytes too many. ".repeat(
				3,
			);
		const variant = base.replace("four bytes", "4 bytes");
		const messages = [
			assistant(NOW - 90_000, [{ type: "text", text: base }], "stop"),
			assistant(NOW - 40_000, [{ type: "text", text: variant }], "stop"),
		];
		expect(detectBitchSlap(state({ messages, incompleteTasks: 1 }))).toMatchObject({
			verdict: "bitchslapping",
			reason: "looping",
		});
	});

	it("slaps the same tool output coming back three times", () => {
		const output =
			"sampleLength: 128 sampleLoopStart: 0 sampleLoopLength: 0 volume: 64 finetune: 0 type: 18 pan: 128".repeat(2);
		const messages = [1, 2, 3].map(index => ({
			role: "toolResult",
			toolCallId: `call-${index}`,
			toolName: "bash",
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: NOW - 60_000 + index * 1_000,
		})) as unknown as AgentMessage[];
		expect(detectBitchSlap(state({ messages, isStreaming: true, incompleteTasks: 3 }))).toMatchObject({
			verdict: "bitchslapping",
			reason: "looping",
			detail: "the same tool output came back 3 times in the last 3 results",
		});
	});
});

describe("BitchSlapWatchdog", () => {
	it("slaps a stuck state soft, then hard, then stays silent", () => {
		const messages = [assistant(NOW - BITCH_SLAP_INTERVAL_MS - 1_000, [{ type: "text", text: "paused" }], "stop")];
		const watchdog = new BitchSlapWatchdog();
		const openTasks = ["II. Parser: fix the record offset"];

		const first = watchdog.evaluate(state({ messages, incompleteTasks: 3, openTasks }));
		expect(first.slap).toBe(true);
		expect(first.hard).toBe(false);
		expect(first.text).toContain("bitch_slap");
		expect(first.text).not.toContain("bitch_slap_hard");
		expect(watchdog.verdict()).toBe("bitchslapping");

		// Same stuck state on the next tick: escalate, and name the work.
		const second = watchdog.evaluate(state({ messages, incompleteTasks: 3, openTasks }));
		expect(second.slap).toBe(true);
		expect(second.hard).toBe(true);
		expect(second.text).toContain("bitch_slap_hard");
		expect(second.text).toContain("II. Parser: fix the record offset");

		// Two slaps per state, then silence until the transcript moves.
		expect(watchdog.evaluate(state({ messages, incompleteTasks: 3, openTasks })).slap).toBe(false);
		expect(watchdog.verdict()).toBe("bitchslapping");

		const moved = [...messages, assistant(NOW - 1_000, [toolCall("bash", { command: "ls" })])];
		expect(watchdog.evaluate(state({ messages: moved, incompleteTasks: 3 })).slap).toBe(false);
		expect(watchdog.verdict()).toBe("nah");
	});

	it("re-arms after the transcript moves on", () => {
		const stalled = [assistant(NOW - BITCH_SLAP_INTERVAL_MS - 1_000, [{ type: "text", text: "paused" }], "stop")];
		const watchdog = new BitchSlapWatchdog();
		expect(watchdog.evaluate(state({ messages: stalled, incompleteTasks: 2 })).slap).toBe(true);

		const moved = [...stalled, assistant(NOW - 1_000, [toolCall("bash", { command: "ls" })])];
		expect(watchdog.evaluate(state({ messages: moved, incompleteTasks: 2 })).slap).toBe(false);

		const nextStall = [assistant(NOW + 60_000, [{ type: "text", text: "paused again" }], "stop")];
		expect(watchdog.evaluate(state({ messages: nextStall, incompleteTasks: 2, now: NOW + 120_000 })).slap).toBe(true);
	});
});
