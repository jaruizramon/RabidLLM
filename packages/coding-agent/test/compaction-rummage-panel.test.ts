/**
 * The archive panel shows the live offload phase and, once finished, the
 * context percentage pair the pass bought. A finished pass lingers briefly and
 * then disappears; tmpfs archives read as `ramdisk`.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { CompactionRummagePanel } from "@oh-my-pi/pi-coding-agent/modes/compaction-rummage-panel";
import { CompactionRummageTracker } from "@oh-my-pi/pi-coding-agent/session/compaction-rummage";
import type { CompactionRummageStatus } from "@oh-my-pi/pi-tui/status-line/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ANSI = /\x1b\[[0-9;]*m/g;

function plain(rows: readonly string[]): string {
	return rows.join("\n").replace(ANSI, "");
}

const panels: CompactionRummagePanel[] = [];

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

afterEach(() => {
	for (const panel of panels.splice(0)) panel.dispose();
});

function renderRows(status: CompactionRummageStatus | undefined): string[] {
	const panel = new CompactionRummagePanel({ status: () => status, requestRender: () => {} });
	panels.push(panel);
	const rows = panel.render(160);
	return rows.length === 0 ? [] : plain(rows).split("\n");
}

describe("CompactionRummagePanel", () => {
	it("shows the live archive phase with scan and offload counters", () => {
		const rows = renderRows({
			action: "shake",
			phase: "offloading",
			startedAt: Date.now() - 1_200,
			scannedEntries: 412,
			regions: 37,
			archivedTokens: 18_400,
			archivedBytes: 2_200_000,
			archivePath: "/dev/shm/qwen-thoughts/shake.log",
			tokensBefore: 61_000,
			contextWindow: 100_000,
		});

		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("rummaging ramdisk");
		expect(rows[0]).toContain("shake");
		expect(rows[0]).toContain("61% → …");
		expect(rows[0]).not.toContain("412 entries");
		expect(rows[1]).toContain("412 entries");
		expect(rows[1]).toContain("37 regions");
		expect(rows[1]).toContain("18K tok");
		expect(rows[1]).toContain("2.1MB");
		expect(rows[1]).toContain("/dev/shm/qwen-thoughts/shake.log");
		expect(rows[1]).toContain("1.2s");
	});

	it("shows the reduced context percentage and reclaimed tokens when finished", () => {
		const endedAt = Date.now();
		const rows = renderRows({
			action: "handoff",
			phase: "rewriting",
			startedAt: endedAt - 3_200,
			endedAt,
			tokensBefore: 62_000,
			tokensAfter: 41_000,
			contextWindow: 100_000,
			tokensFreed: 21_000,
			archivePath: "/home/pipo/.omp/sessions/artifacts/4.shake.log",
		});

		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("archive");
		expect(rows[0]).toContain("62% → 41%");
		expect(rows[0]).toContain("(−21 pts)");
		expect(rows[0]).not.toContain("tok reclaimed");
		expect(rows[1]).toContain("21K tok reclaimed");
		expect(rows[1]).toContain("~/.omp/sessions/artifacts/4.shake.log");
		expect(rows[1]).toContain("3.2s");
		expect(rows.join("\n")).not.toContain("rummaging");
	});

	it("reports a skipped pass without inventing a reduction", () => {
		const rows = renderRows({
			action: "shake",
			phase: "rewriting",
			startedAt: Date.now() - 400,
			endedAt: Date.now(),
			skipped: true,
			tokensBefore: 40_000,
			tokensAfter: 40_000,
			contextWindow: 100_000,
		});

		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("archive skipped");
		expect(rows[0]).toContain("40% → 40%");
		expect(rows[1]).not.toContain("tok reclaimed");
	});

	it("surfaces an archive error", () => {
		const rows = renderRows({
			action: "handoff",
			phase: "rewriting",
			startedAt: Date.now() - 500,
			endedAt: Date.now(),
			error: "artifact directory unavailable",
		});

		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("archive failed");
		expect(rows[1]).toContain("artifact directory unavailable");
	});

	it("hides a finished pass after its linger window", () => {
		expect(
			renderRows({
				action: "shake",
				phase: "rewriting",
				startedAt: Date.now() - 20_000,
				endedAt: Date.now() - 12_000,
				tokensBefore: 50_000,
				tokensAfter: 30_000,
				contextWindow: 100_000,
			}),
		).toEqual([]);
	});
});

describe("CompactionRummageTracker", () => {
	it("closes once, ignores late updates, and starts clean on the next pass", () => {
		const tracker = new CompactionRummageTracker();
		expect(tracker.get()).toBeUndefined();
		expect(tracker.active).toBe(false);

		tracker.begin("shake", "scanning", { tokens: 70_000, contextWindow: 100_000 });
		expect(tracker.active).toBe(true);
		tracker.update({ phase: "offloading", regions: 3 });
		tracker.end({ tokensAfter: 50_000 });
		expect(tracker.active).toBe(false);

		const done = tracker.get();
		expect(done).toMatchObject({
			action: "shake",
			phase: "offloading",
			regions: 3,
			tokensBefore: 70_000,
			tokensAfter: 50_000,
		});
		expect(done?.endedAt).toBeNumber();

		// A finished pass ignores updates and a second end.
		tracker.update({ phase: "rewriting", regions: 9 });
		tracker.end({ tokensAfter: 1 });
		expect(tracker.get()).toMatchObject({ phase: "offloading", regions: 3, tokensAfter: 50_000 });

		tracker.begin("handoff", "summarizing");
		expect(tracker.get()).toMatchObject({ action: "handoff", phase: "summarizing" });
		expect(tracker.get()?.endedAt).toBeUndefined();
	});
});
