/**
 * RabidAI speed/coherence modes, selectable at runtime (`Alt+Q`, `/preset`) and
 * applied to whichever local model is loaded. They are request-side policies
 * (thinking budget, sampling, task hiding), deliberately independent of the
 * server preset that chooses the weights: switching a mode never unloads a
 * model, and changing the budget works on an already-loaded model.
 */
import type { ModelProfileSampling, ModelProfileThinkingBudgets } from "../config/model-profiles";
import { register } from "../config/registry";

export const RABID_MODE_VALUES = ["off", "fast", "balanced", "deep"] as const;
export type RabidMode = (typeof RABID_MODE_VALUES)[number];

/** Session-scoped policy layer applied over `profiles` and the global settings. */
export const cfgRabidMode = register({
	id: "rabid.mode",
	type: "enum",
	values: RABID_MODE_VALUES,
	default: "off",
	ui: {
		tab: "model",
		group: "RabidAI",
		label: "Speed Mode",
		description:
			"Request-side policy applied to the loaded local model: fast (2048 thinking tokens, temp 0.7/0.8/20), balanced (4096), deep (32768). Off uses only the model profile and global settings. Does not load or unload a model.",
		options: [
			{ value: "off", label: "Off", description: "Use the model profile / global thinking and sampling settings." },
			{ value: "fast", label: "Fast", description: "2048-token budget, temp 0.7, top-p 0.8, top-k 20." },
			{ value: "balanced", label: "Balanced", description: "4096-token budget." },
			{ value: "deep", label: "Deep", description: "32768-token budget (effectively uncapped)." },
		],
	},
});

export interface RabidModePolicy {
	thinkingBudgets: Required<ModelProfileThinkingBudgets>;
	sampling?: ModelProfileSampling;
	disabledTools: string[];
}

const FAST_SAMPLING: ModelProfileSampling = { temperature: 0.7, topP: 0.8, topK: 20 };

export const RABID_MODE_POLICIES: Record<Exclude<RabidMode, "off">, RabidModePolicy> = {
	fast: {
		thinkingBudgets: { minimal: 2_048, low: 2_048, medium: 2_048, high: 2_048, xhigh: 2_048, max: 2_048 },
		sampling: FAST_SAMPLING,
		disabledTools: ["task"],
	},
	balanced: {
		thinkingBudgets: { minimal: 4_096, low: 4_096, medium: 4_096, high: 4_096, xhigh: 4_096, max: 4_096 },
		disabledTools: ["task"],
	},
	deep: {
		thinkingBudgets: { minimal: 32_768, low: 32_768, medium: 32_768, high: 32_768, xhigh: 32_768, max: 32_768 },
		disabledTools: ["task"],
	},
};

/** The policy for a mode value, or undefined for `off`/unknown. */
export function rabidModePolicy(mode: string | undefined): RabidModePolicy | undefined {
	if (mode !== "fast" && mode !== "balanced" && mode !== "deep") return undefined;
	return RABID_MODE_POLICIES[mode];
}
