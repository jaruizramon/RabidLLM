import { describe, expect, test } from "bun:test";
import { compactRepeatedLines } from "../src/utils/compact-repeats";

describe("compactRepeatedLines", () => {
	test("collapses a run of identical lines and preserves order", () => {
		const result = compactRepeatedLines("a\nb\nb\nb\nc");

		expect(result.text).toBe("a\nb\n   [×3]\nc");
		expect(result.beforeLines).toBe(5);
		expect(result.afterLines).toBe(4);
		expect(result.collapsedLines).toBe(2);
		expect(result.uniqueLines).toBe(3);
	});

	test("leaves a pair untouched and never merges non-consecutive duplicates", () => {
		expect(compactRepeatedLines("a\nb\nb\na").text).toBe("a\nb\nb\na");
		expect(compactRepeatedLines("a\nb\na").text).toBe("a\nb\na");
	});

	test("does not collapse blank lines", () => {
		expect(compactRepeatedLines("a\n\n\n\n\nb").text).toBe("a\n\n\n\n\nb");
	});

	test("minRun sets the longest run left untouched", () => {
		expect(compactRepeatedLines("x\nx\nx", { minRun: 3 }).text).toBe("x\nx\nx");
		expect(compactRepeatedLines("x\nx\nx\nx", { minRun: 3 }).text).toBe("x\n   [×4]");
	});

	test("is idempotent", () => {
		const once = compactRepeatedLines("head\nframe\nframe\nframe\nframe\ntail").text;
		expect(compactRepeatedLines(once).text).toBe(once);
	});
});
