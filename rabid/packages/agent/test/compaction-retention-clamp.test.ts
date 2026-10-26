import { describe, expect, test } from "bun:test";
import {
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	resolveKeepRecentTokens,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createAssistantMessage, createUserMessage } from "./helpers";

const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!baseModel) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");

// An 8K local preset with the rig's global 12K retained tail and 75% trigger.
const window = 8192;
const settings = {
	...DEFAULT_COMPACTION_SETTINGS,
	thresholdPercent: 75,
	keepRecentTokens: 12_000,
};
const model = { ...baseModel, contextWindow: window };

let seq = 0;
function entry(type: string) {
	return { id: `e${seq++}`, parentId: null, timestamp: new Date().toISOString(), type };
}

function userEntry(text: string): SessionMessageEntry {
	return { ...entry("message"), type: "message", message: createUserMessage(text) };
}

function assistantEntry(text: string): SessionMessageEntry {
	return {
		...entry("message"),
		type: "message",
		message: createAssistantMessage([{ type: "text", text }]),
	};
}

describe("retained-tail clamp", () => {
	test("caps the tail at a quarter of the resolved trigger", () => {
		// 75% of 8192 = 6144; a quarter of that is 1536.
		expect(resolveKeepRecentTokens(window, settings)).toBe(1536);
	});

	test("leaves a configured tail alone when it already fits the trigger", () => {
		expect(resolveKeepRecentTokens(163_840, settings)).toBe(12_000);
	});

	test("prepares a compaction on a small window instead of retaining everything", () => {
		const entries = [
			userEntry("x".repeat(8_000)),
			assistantEntry("first answer"),
			userEntry("y".repeat(8_000)),
			assistantEntry("second answer"),
		];

		// Without the clamp the 12K tail exceeds the whole 8K window, so
		// findCutPoint keeps every message and preparation is a no-op.
		const preparation = prepareCompaction(entries, settings, model);
		expect(preparation).toBeDefined();
		expect(preparation?.messagesToSummarize.length).toBeGreaterThan(0);
		expect(preparation?.recentMessages.length).toBeGreaterThan(0);
	});
});
