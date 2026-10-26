import { describe, expect, test } from "bun:test";
import { DEFAULT_COMPACTION_SETTINGS } from "@oh-my-pi/pi-agent-core/compaction";
import { resolveTurnCardChainBudget } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";

const settings = {
	...DEFAULT_COMPACTION_SETTINGS,
	thresholdPercent: 75,
	keepRecentTokens: 12_000,
};

describe("turn-card chain budget", () => {
	test("scales the chain to a small local window", () => {
		// 75% of 8192 = 6144; a quarter of that is 1536, not the fixed 8K cap.
		expect(resolveTurnCardChainBudget(8192, settings)).toBe(1536);
	});

	test("keeps the 8K ceiling on a large window", () => {
		expect(resolveTurnCardChainBudget(163_840, settings)).toBe(8192);
	});

	test("falls back to the ceiling when the window is unknown", () => {
		expect(resolveTurnCardChainBudget(0, settings)).toBe(8192);
	});
});
