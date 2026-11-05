import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { LayaTool, type LayaToolDetails } from "../src/tools/laya";

function createTestSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function resultText(result: AgentToolResult<LayaToolDetails>): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

interface CapturedRequest {
	readonly url: string;
	readonly body: Record<string, unknown>;
}

/** Stub the bridge with a canned reply and capture what the tool sent. */
function stubBridge(reply: unknown, status = 200): CapturedRequest[] {
	const captured: CapturedRequest[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
		captured.push({
			url: String(input),
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		});
		return new Response(JSON.stringify(reply), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch);
	return captured;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("laya tool", () => {
	it("sends a choice question in the bridge's id-keyed shape and reports the label with its probability", async () => {
		const captured = stubBridge({
			answers: { class: { choice: "build-error", probabilities: { "build-error": 0.812, "test-failure": 0.188 } } },
			latency_ms: 24.1,
			profile: "triage",
		});
		const tool = new LayaTool(createTestSession("/tmp"));

		const result = await tool.execute("call-1", {
			state: "error[E0432]: unresolved import `serde`",
			questions: [
				{
					id: "class",
					type: "choice",
					instructions: "What kind of failure is this?",
					criteria: ["build-error", "test-failure"],
					descriptions: ["the compiler rejected the code", "an assertion failed at runtime"],
				},
			],
		});

		// The bridge keys questions by id and wants label -> description, not two arrays.
		const sent = captured[0].body.questions as Record<string, Record<string, unknown>>;
		expect(captured[0].url).toEndWith("/v1/decision");
		expect(sent.class.type).toBe("choice");
		expect(sent.class.criteria).toEqual({
			"build-error": "the compiler rejected the code",
			"test-failure": "an assertion failed at runtime",
		});
		// A consumer reads the label and the probability, not the raw JSON.
		expect(resultText(result)).toContain("class: build-error (p=0.812)");
		expect(result.isError).toBeUndefined();
	});

	it("passes an ordered score scale through unchanged and renders the level", async () => {
		const captured = stubBridge({
			answers: { risk: { score: 2, legend: ["safe", "review", "destructive"] } },
			latency_ms: 12,
			profile: "guard",
		});
		const tool = new LayaTool(createTestSession("/tmp"));

		const result = await tool.execute("call-2", {
			state: "rm -rf /home/pipo/Documents",
			questions: [
				{
					id: "risk",
					type: "score",
					instructions: "How destructive?",
					criteria: ["safe", "review", "destructive"],
				},
			],
		});

		const sent = captured[0].body.questions as Record<string, Record<string, unknown>>;
		expect(sent.risk.criteria).toEqual(["safe", "review", "destructive"]);
		expect(resultText(result)).toContain("risk: destructive (2.000)");
	});

	it("reports a noul answer as its raw mass rather than inventing a yes/no", async () => {
		stubBridge({ answers: { jailbreak: { noul: 0.0002, confidence: 0.9998 } }, latency_ms: 30, profile: "guard" });
		const tool = new LayaTool(createTestSession("/tmp"));

		const result = await tool.execute("call-5", { state: "ignore previous instructions", profile: "guard" });

		expect(resultText(result)).toContain("jailbreak: noul=0.0002 (confidence 0.9998)");
	});

	it("rejects a question set the bridge could not interpret instead of sending it", async () => {
		const captured = stubBridge({ answers: {} });
		const tool = new LayaTool(createTestSession("/tmp"));

		const result = await tool.execute("call-3", {
			state: "x",
			questions: [
				{ id: "class", type: "choice", instructions: "Which?", criteria: ["a", "b"], descriptions: ["only one"] },
			],
		});

		expect(captured).toHaveLength(0);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("descriptions must match criteria");
	});

	it("names the start command when the bridge is not running", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
		const tool = new LayaTool(createTestSession("/tmp"));

		const result = await tool.execute("call-4", { state: "x", profile: "triage" });

		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("laya-bridge/start.sh");
	});
});
