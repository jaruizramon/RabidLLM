/**
 * Runtime resolution of the `profiles` layer for the active model. Every
 * consumer reads the global setting first and layers the matching profile over
 * it, so a model without a profile keeps the global behavior.
 */
import { cfgModelProfiles } from "../config/model-settings";
import { matchModelProfile } from "./model-profiles";
import type { ScopeLike } from "../config/registry";
import { cfgToolsDisabled } from "../tools/settings";
import { cfgRabidMode, rabidModePolicy } from "./rabid-modes";
import {
	cfgSampling,
	cfgThinkingBudgets,
	type SamplingSettings,
	type ThinkingBudgetsSettings,
} from "../session/settings";

type ModelLike = { provider: string; id: string } | null | undefined;

/** Disabled tool names for `model`: `tools.disabled` plus the matching profile's list. */
export function resolveDisabledToolNames(scope: ScopeLike, model: ModelLike): readonly string[] {
	const configured = cfgToolsDisabled.get(scope);
	const profileTools = model
		? matchModelProfile(cfgModelProfiles.get(scope), model)?.profile.tools?.disabled
		: undefined;
	const modeTools = rabidModePolicy(cfgRabidMode.get(scope))?.disabledTools;
	if ((!profileTools || profileTools.length === 0) && (!modeTools || modeTools.length === 0)) return configured;
	return [...new Set([...configured, ...(profileTools ?? []), ...(modeTools ?? [])])];
}

/** Thinking-token budgets per effort for `model`: globals overlaid by the matching profile. */
export function resolveModelThinkingBudgets(scope: ScopeLike, model: ModelLike): ThinkingBudgetsSettings {
	const configured = cfgThinkingBudgets.get(scope);
	const profileBudgets = model
		? matchModelProfile(cfgModelProfiles.get(scope), model)?.profile.thinkingBudgets
		: undefined;
	const withProfile = profileBudgets ? { ...configured, ...profileBudgets } : configured;
	const modeBudgets = rabidModePolicy(cfgRabidMode.get(scope))?.thinkingBudgets;
	return modeBudgets ? { ...withProfile, ...modeBudgets } : withProfile;
}

/** Sampling defaults for `model`: globals overlaid by the matching profile. */
export function resolveModelSampling(scope: ScopeLike, model: ModelLike): SamplingSettings {
	const configured = cfgSampling.get(scope);
	const profileSampling = model ? matchModelProfile(cfgModelProfiles.get(scope), model)?.profile.sampling : undefined;
	const withProfile = profileSampling ? { ...configured, ...profileSampling } : configured;
	const modeSampling = rabidModePolicy(cfgRabidMode.get(scope))?.sampling;
	return modeSampling ? { ...withProfile, ...modeSampling } : withProfile;
}
