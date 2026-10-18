import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { renderSegment } from "@oh-my-pi/pi-tui/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-tui/status-line/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { calculateTokensPerSecond, TokenRateMeter } from "@oh-my-pi/pi-coding-agent/utils/token-rate";

beforeAll(async () => {
	await initTheme();
});

function assistantMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4.5",
		usage: {
			input: 10,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 60,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_000,
		...overrides,
	};
}

function ctxWithTokenRate(tokensPerSecond: number | null): SegmentContext {
	return {
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond,
		},
	} as unknown as SegmentContext;
}

describe("token_rate status-line segment", () => {
	it("renders per-second throughput without a numeric slash path", () => {
		const rendered = renderSegment("token_rate", ctxWithTokenRate(35.5));
		const content = stripVTControlCharacters(rendered.content);

		expect(rendered.visible).toBe(true);
		expect(content).toContain("35.5");
		expect(content).toMatch(/(?:\/s|\bs\b|\bsec(?:ond)?s?\b|\btps\b)/i);
		expect(content).not.toContain("35.5/s");
		expect(content).not.toMatch(/\b\d+(?:\.\d+)?\/s\b/);
	});
});

describe("token rate calculation", () => {
	it("computes from completed message duration metadata", () => {
		const base = assistantMessage();
		const rate = calculateTokensPerSecond(
			[assistantMessage({ usage: { ...base.usage, output: 120 }, duration: 2_000 })],
			false,
		);
		expect(rate).toBe(60);
	});

	it("computes from elapsed time while streaming when duration metadata is missing", () => {
		const base = assistantMessage();
		const rate = calculateTokensPerSecond(
			[assistantMessage({ timestamp: 10_000, duration: undefined, usage: { ...base.usage, output: 45 } })],
			true,
			13_000,
		);
		expect(rate).toBe(15);
	});

	it("returns null for near-zero durations to avoid unstable spikes", () => {
		const base = assistantMessage();
		const rate = calculateTokensPerSecond(
			[assistantMessage({ duration: 50, usage: { ...base.usage, output: 5 } })],
			false,
		);
		expect(rate).toBeNull();
	});

	it("returns null when stream is interrupted and duration metadata is unavailable", () => {
		const rate = calculateTokensPerSecond([assistantMessage({ stopReason: "aborted", duration: undefined })], false);
		expect(rate).toBeNull();
	});

	it("returns null when usage metadata has no output tokens", () => {
		const base = assistantMessage();
		const rate = calculateTokensPerSecond(
			[assistantMessage({ usage: { ...base.usage, output: 0, totalTokens: 10 } })],
			false,
		);
		expect(rate).toBeNull();
	});
});

describe("decode throughput vs prompt prefill", () => {
	it("seeds the meter with the decode window, ignoring prefill", () => {
		const meter = new TokenRateMeter(text => text.length);
		meter.seed(200, 10_000, 8_000);
		// 200 tokens in the 2s after ttft is 100 tok/s, not 20 for the whole request.
		expect(meter.rate()).toBeCloseTo(100, 0);
	});

	it("falls back to the whole duration when ttft is absent or implausible", () => {
		const noTtft = new TokenRateMeter(text => text.length);
		noTtft.seed(200, 10_000);
		expect(noTtft.rate()).toBeCloseTo(20, 0);

		const badTtft = new TokenRateMeter(text => text.length);
		badTtft.seed(200, 10_000, 12_000);
		expect(badTtft.rate()).toBeCloseTo(20, 0);
	});

	it("reports the same decode rate on the display path", () => {
		const message = assistantMessage({
			usage: { ...assistantMessage().usage, output: 200 },
			duration: 10_000,
			ttft: 8_000,
		});
		expect(calculateTokensPerSecond([message], false)).toBeCloseTo(100, 0);
	});
});
