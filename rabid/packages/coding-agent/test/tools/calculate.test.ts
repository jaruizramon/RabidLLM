/** `calculate`: deterministic slider sweeps the model drives without writing code. */
import { describe, expect, it } from "bun:test";
import { CalculateTool } from "@oh-my-pi/pi-coding-agent/tools/calculate";

async function run(params: Record<string, unknown>) {
	const result = await new CalculateTool().execute("call-1", params as never);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	return { text, isError: result.isError === true, details: result.details };
}

describe("calculate", () => {
	it("sweeps sliders in declaration order with the first axis outermost", async () => {
		const { text, details } = await run({
			formula: "2.5 * speed / tempo",
			unit: "s/row",
			sliders: [
				{ name: "tempo", values: [100, 125] },
				{ name: "speed", values: [6, 7] },
			],
		});

		expect(details?.total).toBe(4);
		expect(details?.rows).toEqual([
			["100", "6", "0.15"],
			["100", "7", "0.175"],
			["125", "6", "0.12"],
			["125", "7", "0.14"],
		]);
		expect(text).toContain("| tempo | speed | s/row |");
	});

	it("is byte-identical across runs", async () => {
		const params = {
			formula: "60 / tempo / speed",
			sliders: [{ name: "tempo", from: 100, to: 140, step: 20 }],
		};
		expect((await run(params)).text).toBe((await run(params)).text);
	});

	it("compares two timing models and reports the ratio", async () => {
		const { details } = await run({
			formula: "60 / tempo / speed",
			compare: "2.5 * speed / tempo",
			sliders: [
				{ name: "tempo", values: [125] },
				{ name: "speed", values: [6] },
			],
		});

		expect(details?.columns).toEqual(["tempo", "speed", "result", "compare", "delta", "ratio"]);
		expect(details?.rows[0]).toEqual(["125", "6", "0.08", "0.12", "-0.04", "0.666667"]);
	});

	it("expands an inclusive range", async () => {
		const { details } = await run({
			formula: "x * 2",
			sliders: [{ name: "x", from: 3, to: 5, step: 1 }],
		});
		expect(details?.rows.map(row => row[0])).toEqual(["3", "4", "5"]);
	});

	it("honours precedence, unary minus and right-associative power", async () => {
		const { details } = await run({
			formula: "-x^2 + 2^3^2",
			sliders: [{ name: "x", values: [2] }],
		});
		expect(details?.rows[0]?.[1]).toBe("508");
	});

	it("rejects an unknown name instead of evaluating it", async () => {
		const { text, isError } = await run({ formula: "bpm * 2" });
		expect(isError).toBe(true);
		expect(text).toContain('unknown name "bpm"');
	});

	it("refuses a sweep wider than the row cap", async () => {
		const { text, isError } = await run({
			formula: "x",
			maxRows: 10,
			sliders: [{ name: "x", from: 1, to: 100, step: 1 }],
		});
		expect(isError).toBe(true);
		expect(text).toContain("exceeds the cap of 10");
	});
});
