/** The generation-rate row above the archive panel: one decimal, hidden until measured. */
import { beforeAll, describe, expect, it } from "bun:test";
import { TokenRatePanel } from "@oh-my-pi/pi-coding-agent/modes/token-rate-panel";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ANSI = /\x1b\[[0-9;]*m/g;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

function render(
	rate: number | null,
	mode?: { name: string; budget?: number },
	width = 120,
	extra?: {
		reasoning?: { tokens: number; budget: number };
		context?: { tokens: number; contextWindow: number; thresholdTokens?: number };
	},
): string {
	const panel = new TokenRatePanel({
		rate: () => rate,
		mode: () => mode,
		reasoning: () => extra?.reasoning,
		context: () => extra?.context,
	});
	return panel.render(width).join("\n").replace(ANSI, "");
}

describe("TokenRatePanel", () => {
	it("renders nothing until a rate has been measured", () => {
		expect(render(null)).toBe("");
	});

	it("shows the live rate with one decimal and the tok/s unit", () => {
		expect(render(42.34)).toContain("42.3 tok/s");
		expect(render(0)).toContain("0.0 tok/s");
	});

	it("confirms the active rabid mode and budget even before a rate exists", () => {
		const text = render(null, { name: "fast", budget: 2048 });
		expect(text).toContain("rabid-fast");
		expect(text).toContain("2,048 budget");
		expect(text).not.toContain("tok/s");
	});

	it("shows the mode, budget and rate together", () => {
		const text = render(30.04, { name: "fast", budget: 2048 });
		expect(text).toContain("rabid-fast · 2,048 budget");
		expect(text).toContain("30.0 tok/s");
	});

	it("draws the reasoning-budget gauge against the sent budget", () => {
		const text = render(null, undefined, 120, { reasoning: { tokens: 1220, budget: 2048 } });
		expect(text).toContain("reasoning 1,220/2,048");
		expect(text).toContain("██████░░░░");
	});

	it("scales the context gauge to the compaction trigger and shows token counts", () => {
		const text = render(null, undefined, 120, {
			context: { tokens: 62_000, contextWindow: 100_000, thresholdTokens: 75_000 },
		});
		expect(text).toContain("ctx 62% · 62K/75K");
		// 62K of a 75K trigger is 83%: the bar is nearly full, not 62%-empty.
		expect(text).toContain("████████░░");
	});

	it("combines mode, reasoning, context and rate on one row", () => {
		const text = render(30.04, { name: "fast", budget: 2048 }, 160, {
			reasoning: { tokens: 1220, budget: 2048 },
			context: { tokens: 62_000, contextWindow: 100_000, thresholdTokens: 75_000 },
		});
		expect(text).toContain("rabid-fast");
		expect(text).toContain("reasoning 1,220/2,048");
		expect(text).toContain("ctx 62%");
		expect(text).toContain("30.0 tok/s");
	});

	it("truncates to the available width", () => {
		const line = render(123.45, { name: "deep", budget: 32768 }, 6, {
			reasoning: { tokens: 1, budget: 32768 },
			context: { tokens: 62_000, contextWindow: 100_000, thresholdTokens: 75_000 },
		});
		expect(visibleWidth(line)).toBe(6);
	});
});
