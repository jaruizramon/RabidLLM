/**
 * `profiles` resolves per model: exact `provider/model-id` beats a `…*` prefix,
 * and models without a match keep the global settings.
 */
import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { normalizeModelProfiles } from "@oh-my-pi/pi-coding-agent/rabid/model-profiles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveModelCompactionSettings } from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
import { cfgRabidMode } from "@oh-my-pi/pi-coding-agent/rabid/rabid-modes";
import {
	resolveDisabledToolNames,
	resolveModelSampling,
	resolveModelThinkingBudgets,
} from "@oh-my-pi/pi-coding-agent/rabid/model-profile-settings";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function model(provider: string, id: string, baseUrl: string) {
	return buildModel({
		id,
		name: id,
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

const localModel = model("local-llama", "qwen3.8-27b", "http://127.0.0.1:8101/v1");
const cloudModel = model("deepseek", "deepseek-v4", "https://api.deepseek.com/v1");

const PROFILE = {
	compaction: {
		thresholdPercent: 60,
		methodOrder: ["handoff", "shake", "soft"],
	},
	thinkingBudgets: { high: 4096 },
	tools: { disabled: ["task"] },
	sampling: { temperature: 0.7, topP: 0.8, topK: 20 },
};

describe("profiles", () => {
	const settings = Settings.isolated({
		"compaction.thresholdPercent": 80,
		"compaction.methodOrder": ["soft", "shake"],
		"thinkingBudgets.high": 8192,
		"tools.disabled": ["browser"],
		temperature: 0.2,
		topP: 0.95,
		topK: 40,
		profiles: {
			"local-llama/*": PROFILE,
			"local-llama/qwen3.8-27b": { sampling: { temperature: 0.6 } },
		},
	});

	it("applies the exact selector over the provider prefix", () => {
		expect(resolveModelCompactionSettings(settings, localModel)).toMatchObject({
			thresholdPercent: 60,
			methodOrder: ["handoff", "shake", "soft"],
		});
		expect(resolveModelThinkingBudgets(settings, localModel).high).toBe(4096);
		expect(resolveDisabledToolNames(settings, localModel)).toEqual(["browser", "task"]);
		// The exact selector wins field by field over the wider prefix profile;
		// the prefix's topP/topK still apply over the globals.
		expect(resolveModelSampling(settings, localModel)).toMatchObject({
			temperature: 0.6,
			topP: 0.8,
			topK: 20,
		});
	});

	it("keeps the global settings for an unmatched model", () => {
		expect(resolveModelCompactionSettings(settings, cloudModel)).toMatchObject({
			thresholdPercent: 80,
			methodOrder: ["soft", "shake"],
		});
		expect(resolveModelThinkingBudgets(settings, cloudModel).high).toBe(8192);
		expect(resolveDisabledToolNames(settings, cloudModel)).toEqual(["browser"]);
		expect(resolveModelSampling(settings, cloudModel)).toMatchObject({
			temperature: 0.2,
			topP: 0.95,
			topK: 40,
		});
	});

	it("applies a runtime rabid mode over globals and the model profile", () => {
		const live = Settings.isolated({
			"thinkingBudgets.high": 8192,
			temperature: 0.2,
			"tools.disabled": ["browser"],
		});

		cfgRabidMode.override(live, "fast");
		expect(resolveModelThinkingBudgets(live, cloudModel).high).toBe(2048);
		expect(resolveModelSampling(live, cloudModel).temperature).toBe(0.7);
		expect(resolveDisabledToolNames(live, cloudModel)).toEqual(["browser", "task"]);

		cfgRabidMode.override(live, "deep");
		expect(resolveModelThinkingBudgets(live, cloudModel).high).toBe(32_768);

		cfgRabidMode.override(live, "off");
		expect(resolveModelThinkingBudgets(live, cloudModel).high).toBe(8192);
		expect(resolveModelSampling(live, cloudModel).temperature).toBe(0.2);
	});

	it("rejects malformed entries instead of silently ignoring them", () => {
		expect(() => normalizeModelProfiles({ "no-slash": {} })).toThrow(/provider\/model-id/);
		expect(() => normalizeModelProfiles({ "local-llama/*": { sampling: { temperature: -1 } } })).toThrow(
			/temperature/,
		);
		expect(() => normalizeModelProfiles({ "local-llama/*": { compaction: { methodOrder: ["nope"] } } })).toThrow(
			/compaction method/,
		);
	});
});
