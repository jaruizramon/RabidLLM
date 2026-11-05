import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-tui/theme";
import { formatLayaCall, layaToolRenderer } from "@oh-my-pi/pi-tui/tools/laya";

beforeAll(async () => {
	await initTheme();
});

/**
 * Wrapping and the blockquote's border glyph (`▏`) split a long state across rows, so a
 * plain substring check is useless: compare with whitespace and that glyph removed.
 */
function squash(value: string): string {
	return value.replace(/[\s▏]/g, "");
}

async function render(args: Parameters<typeof formatLayaCall>[0], width = 80): Promise<string> {
	const theme = (await getThemeByName("dark")) as Theme;
	const component = layaToolRenderer.renderCall(args, { expanded: true, isPartial: false }, theme);
	if (!component) throw new Error("renderCall returned no component");
	return stripVTControlCharacters(component.render(width).join("\n"));
}

describe("laya call card", () => {
	it("shows the whole state and every question instead of the 160-character summary", async () => {
		const state =
			"The parquet reader buffers every row group before it streams, so a 2 GB file allocates 2 GB " +
			"and the consumer shows no output for forty seconds; the fix has to keep the read incremental.";
		const output = await render({
			state,
			questions: [
				{
					id: "kind",
					type: "choice",
					instructions: "What kind of problem is this?",
					criteria: ["memory", "latency", "correctness"],
					descriptions: ["allocates too much", "stalls the consumer", "returns wrong rows"],
				},
				{ id: "urgency", type: "score", instructions: "How urgent?", criteria: ["low", "medium", "high"] },
			],
		});

		// No truncation: the tail of a 200-character state must still be on screen.
		expect(squash(output)).toContain(squash("the fix has to keep the read incremental."));
		expect(output).not.toContain("…");
		// Every question and every option, not `questions=[3…`.
		for (const id of ["kind", "urgency"]) expect(output).toContain(id);
		for (const label of ["memory", "latency", "correctness", "low", "medium", "high"]) {
			expect(output).toContain(label);
		}
		expect(output).toContain("stalls the consumer");
	});

	it("names a shipped profile when no questions are given", async () => {
		const output = await render({ state: "error[E0432]: unresolved import `serde`", profile: "triage" });
		expect(output).toContain("triage");
		expect(squash(output)).toContain(squash("unresolved import"));
	});

	it("does not invent a body while arguments are still streaming", async () => {
		const output = await render({});
		expect(output).toContain("waiting for arguments");
	});
});
