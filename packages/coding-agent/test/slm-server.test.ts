import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { requestSlmCompletion, type SlmCompletionRequest } from "@oh-my-pi/pi-coding-agent/session/slm-server";

interface WorkerReply {
	content: string;
	finishReason: string;
}

/** The body `SlmHandoffServer.complete` sends for a 4096/2048 worker. */
const REQUEST: SlmCompletionRequest = {
	model: "slm-worker",
	messages: [
		{ role: "system", content: "You maintain a handoff document." },
		{ role: "user", content: "<new_turn>fix the parser</new_turn>" },
	],
	temperature: 0.2,
	top_p: 0.95,
	max_tokens: 4_096 + 2_048 + 256,
	cache_prompt: false,
	stream: false,
	stop: ["<|im_end|>"],
	reasoning_budget_tokens: 4_096,
	chat_template_kwargs: { enable_thinking: true },
};

let server: Bun.Server<undefined> | null = null;
let received: SlmCompletionRequest[] = [];
let replies: WorkerReply[] = [];
let httpStatus = 200;

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			received.push((await request.json()) as SlmCompletionRequest);
			if (httpStatus !== 200) return new Response("worker exploded", { status: httpStatus });
			const reply = replies.shift() ?? { content: "", finishReason: "stop" };
			return Response.json({
				choices: [
					{
						message: { content: reply.content, reasoning_content: "private chain of thought" },
						finish_reason: reply.finishReason,
					},
				],
				usage: { prompt_tokens: 12, completion_tokens: 7 },
			});
		},
	});
});

beforeEach(() => {
	received = [];
	replies = [];
	httpStatus = 200;
});

afterAll(() => {
	server?.stop(true);
	server = null;
});

function baseUrl(): string {
	if (!server) throw new Error("fake worker is not running");
	return `http://127.0.0.1:${server.port}`;
}

describe("requestSlmCompletion", () => {
	it("sends the worker request shape and returns the normalized answer", async () => {
		replies = [{ content: "<think>hidden</think>## Goal\nShip it", finishReason: "stop" }];

		const result = await requestSlmCompletion(baseUrl(), REQUEST, AbortSignal.timeout(30_000));

		expect(received).toHaveLength(1);
		const body = received[0]!;
		expect(body.model).toBe("slm-worker");
		expect(body.messages).toHaveLength(2);
		expect(body.messages[0]?.role).toBe("system");
		expect(body.max_tokens).toBe(4_096 + 2_048 + 256);
		expect(body.cache_prompt).toBe(false);
		expect(body.reasoning_budget_tokens).toBe(4_096);
		expect(body.chat_template_kwargs.enable_thinking).toBe(true);

		expect(result.document.startsWith("## Goal")).toBe(true);
		expect(result.document).not.toContain("hidden");
		expect(result.document).not.toContain("private chain of thought");
		expect(result.formatFallback).toBe(false);
		expect(result.truncated).toBe(false);
		expect(result.inputTokens).toBe(12);
		expect(result.outputTokens).toBe(7);
	});

	it("flags a length-truncated answer", async () => {
		replies = [{ content: "## Goal\nShip it", finishReason: "length" }];

		const result = await requestSlmCompletion(baseUrl(), REQUEST, AbortSignal.timeout(30_000));

		expect(result.truncated).toBe(true);
	});

	it("retries once on empty content, then fails", async () => {
		replies = [
			{ content: "", finishReason: "stop" },
			{ content: "   ", finishReason: "stop" },
		];

		await expect(requestSlmCompletion(baseUrl(), REQUEST, AbortSignal.timeout(30_000))).rejects.toThrow(
			"SLM worker returned no handoff document",
		);
		expect(received).toHaveLength(2);
	});

	it("surfaces the HTTP status and body on a worker error", async () => {
		httpStatus = 503;

		await expect(requestSlmCompletion(baseUrl(), REQUEST, AbortSignal.timeout(30_000))).rejects.toThrow(
			"SLM worker HTTP 503: worker exploded",
		);
	});
});
