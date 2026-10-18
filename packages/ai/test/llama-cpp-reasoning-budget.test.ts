/**
 * llama.cpp caps its reasoning sampler with a top-level token budget
 * (`reasoning_budget_tokens`), not OpenAI's `reasoning.max_tokens`. The field
 * is provider-scoped: local openai-completions hosts emit it, cloud hosts do
 * not.
 */
import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function build(provider: string, baseUrl: string): Model<"openai-completions"> {
	return buildModel({
		id: "qwen3.8-27b",
		name: "Qwen3.8 27B",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 32_768,
	} satisfies ModelSpec<"openai-completions">);
}

function context(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
}

async function capturePayload(model: Model<"openai-completions">): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const fetchImpl: FetchImpl = async () =>
		new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
	streamSimple(model, context(), {
		apiKey: "test-key",
		fetch: fetchImpl,
		signal: AbortSignal.abort(),
		reasoning: Effort.Medium,
		thinkingBudgets: { medium: 2_048 },
		onPayload: payload => resolve(payload),
	});
	return (await promise) as Record<string, unknown>;
}

describe("llama.cpp reasoning budget", () => {
	it("resolves the budget field for a local provider and sends it on the wire", async () => {
		const model = build("local-llama", "http://127.0.0.1:8101/v1");
		expect(model.compat.reasoningBudgetField).toBe("reasoning_budget_tokens");

		const payload = await capturePayload(model);
		expect(payload.reasoning_budget_tokens).toBe(2_048);
		expect(payload.thinking_budget_tokens).toBeUndefined();
	});

	it("leaves the budget off the wire when the host has no budget field", async () => {
		const model = build("openai", "https://api.openai.com/v1");
		expect(model.compat.reasoningBudgetField).toBeUndefined();

		const payload = await capturePayload(model);
		expect(payload.reasoning_budget_tokens).toBeUndefined();
		expect(payload.thinking_budget_tokens).toBeUndefined();
	});
});
