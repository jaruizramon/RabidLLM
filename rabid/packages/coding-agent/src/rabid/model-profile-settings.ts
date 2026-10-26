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
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
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

/**
 * Text of the matching profile's `systemPromptAppend` file, or undefined.
 *
 * The file is read on every prompt rebuild rather than cached, so editing a
 * model's discipline block applies on the next turn. A missing file is logged
 * and skipped: a bad path must not cost the session its prompt.
 */
export async function loadModelSystemPromptAppend(
	scope: ScopeLike,
	model: ModelLike,
	agentDir: string,
): Promise<string | undefined> {
	const configured = model
		? matchModelProfile(cfgModelProfiles.get(scope), model)?.profile.systemPromptAppend
		: undefined;
	if (!configured) return undefined;
	const expanded = configured.startsWith("~") ? path.join(os.homedir(), configured.slice(1)) : configured;
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(agentDir, expanded);
	try {
		const content = (await fs.readFile(resolved, "utf8")).trim();
		return content === "" ? undefined : content;
	} catch (error) {
		if (isEnoent(error)) {
			logger.warn("Model profile systemPromptAppend file is missing", { path: resolved });
			return undefined;
		}
		throw error;
	}
}
