/**
 * `profiles`: a settings layer keyed by model, resolved after model selection.
 * Each entry may override the compaction policy, thinking budgets, disabled
 * tools, and sampling defaults for the models its selector covers. Global
 * settings such as `compaction.thresholdPercent` and `thinkingBudgets.*`
 * remain the fallback for every model without a matching profile.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { isCompactionMethod, type CompactionMethod } from "../session/compaction-methods";
import { checkModelSelectorKey } from "./model-selectors";

/** Compaction overrides a profile may apply on top of the global policy. */
export interface ModelProfileCompaction {
	/** Percent of the window; `-1` clears the percentage trigger. */
	thresholdPercent?: number;
	/** Fixed token trigger (`-1` clears it); overrides `thresholdPercent` like the global settings. */
	thresholdTokens?: number;
	/** Automatic maintenance fallback order. */
	methodOrder?: CompactionMethod[];
	/** Recent history kept verbatim; clamped again to the model's resolved trigger. */
	keepRecentTokens?: number;
	/** Per-model summary output ceiling, on top of the reserve budget and the global cap. */
	maxSummaryTokens?: number;
	/** Tokens reserved below the window; explicit values disable small-window reserve recovery. */
	reserveTokens?: number;
}

/** Per-effort thinking-token budgets; unset efforts keep the global value. */
export type ModelProfileThinkingBudgets = Partial<Record<(typeof THINKING_EFFORTS)[number], number>>;

/** Sampling defaults a profile may pin for its models. */
export interface ModelProfileSampling {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
	hideThinkingSummary?: boolean;
}

/** One `profiles` entry. */
export interface ModelProfile {
	compaction?: ModelProfileCompaction;
	thinkingBudgets?: ModelProfileThinkingBudgets;
	tools?: { disabled?: string[] };
	sampling?: ModelProfileSampling;
}

const PROFILE_KEYS: Record<string, true> = { compaction: true, thinkingBudgets: true, tools: true, sampling: true };
const COMPACTION_KEYS: Record<string, true> = {
	thresholdPercent: true,
	thresholdTokens: true,
	methodOrder: true,
	keepRecentTokens: true,
	maxSummaryTokens: true,
	reserveTokens: true,
};
const TOOLS_KEYS: Record<string, true> = { disabled: true };
const SAMPLING_KEYS: Record<string, true> = {
	temperature: true,
	topP: true,
	topK: true,
	minP: true,
	presencePenalty: true,
	repetitionPenalty: true,
	hideThinkingSummary: true,
};

function rejectUnknownKeys(scope: string, value: Record<string, unknown>, allowed: Record<string, true>): void {
	for (const key in value) {
		if (!allowed[key]) {
			throw new Error(`Invalid ${scope}: unknown key "${key}" (expected ${Object.keys(allowed).join(", ")}).`);
		}
	}
}

function nonNegativeNumber(scope: string, value: unknown): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid ${scope}: expected a non-negative number, got ${String(value)}.`);
	}
}

function normalizeCompaction(scope: string, value: unknown): ModelProfileCompaction {
	if (!isRecord(value)) throw new Error(`Invalid ${scope}: expected an object.`);
	rejectUnknownKeys(scope, value, COMPACTION_KEYS);
	const compaction: ModelProfileCompaction = {};
	const percent = value.thresholdPercent;
	if (percent !== undefined) {
		if (
			typeof percent !== "number" ||
			!Number.isFinite(percent) ||
			(percent !== -1 && (percent <= 0 || percent > 100))
		) {
			throw new Error(`Invalid ${scope}.thresholdPercent: expected -1 or a percentage in (0, 100].`);
		}
		compaction.thresholdPercent = percent;
	}
	const tokens = value.thresholdTokens;
	if (tokens !== undefined) {
		if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || (tokens !== -1 && tokens <= 0)) {
			throw new Error(`Invalid ${scope}.thresholdTokens: expected -1 or a positive integer token count.`);
		}
		compaction.thresholdTokens = tokens;
	}
	const methodOrder = value.methodOrder;
	if (methodOrder !== undefined) {
		if (!Array.isArray(methodOrder) || methodOrder.length === 0) {
			throw new Error(`Invalid ${scope}.methodOrder: expected a non-empty list of compaction methods.`);
		}
		const methods: CompactionMethod[] = [];
		for (const method of methodOrder) {
			if (!isCompactionMethod(method)) {
				throw new Error(`Invalid ${scope}.methodOrder: unknown compaction method ${JSON.stringify(method)}.`);
			}
			if (!methods.includes(method)) methods.push(method);
		}
		compaction.methodOrder = methods;
	}
	for (const key of ["keepRecentTokens", "maxSummaryTokens", "reserveTokens"] as const) {
		const budget = value[key];
		if (budget === undefined) continue;
		if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget <= 0) {
			throw new Error(`Invalid ${scope}.${key}: expected a positive integer token count.`);
		}
		compaction[key] = budget;
	}
	return compaction;
}

function normalizeThinkingBudgets(scope: string, value: unknown): ModelProfileThinkingBudgets {
	if (!isRecord(value)) throw new Error(`Invalid ${scope}: expected an object of effort → token budget.`);
	const budgets: ModelProfileThinkingBudgets = {};
	for (const key in value) {
		if (!(THINKING_EFFORTS as readonly string[]).includes(key)) {
			throw new Error(`Invalid ${scope}: unknown effort "${key}" (expected ${THINKING_EFFORTS.join(", ")}).`);
		}
		const budget = value[key];
		if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < 0) {
			throw new Error(`Invalid ${scope}.${key}: expected a non-negative integer token budget.`);
		}
		budgets[key as keyof ModelProfileThinkingBudgets] = budget;
	}
	return budgets;
}

function normalizeSampling(scope: string, value: unknown): ModelProfileSampling {
	if (!isRecord(value)) throw new Error(`Invalid ${scope}: expected an object.`);
	rejectUnknownKeys(scope, value, SAMPLING_KEYS);
	const sampling: ModelProfileSampling = {};
	for (const key of ["temperature", "topP", "minP", "presencePenalty", "repetitionPenalty"] as const) {
		if (value[key] !== undefined) {
			nonNegativeNumber(`${scope}.${key}`, value[key]);
			sampling[key] = value[key] as number;
		}
	}
	if (value.topK !== undefined) {
		const topK = value.topK;
		if (typeof topK !== "number" || !Number.isSafeInteger(topK) || topK < 0) {
			throw new Error(`Invalid ${scope}.topK: expected a non-negative integer.`);
		}
		sampling.topK = topK;
	}
	if (value.hideThinkingSummary !== undefined) {
		if (typeof value.hideThinkingSummary !== "boolean") {
			throw new Error(`Invalid ${scope}.hideThinkingSummary: expected a boolean.`);
		}
		sampling.hideThinkingSummary = value.hideThinkingSummary;
	}
	return sampling;
}

function normalizeTools(scope: string, value: unknown): ModelProfile["tools"] {
	if (!isRecord(value)) throw new Error(`Invalid ${scope}: expected an object.`);
	rejectUnknownKeys(scope, value, TOOLS_KEYS);
	if (value.disabled === undefined) return {};
	if (!Array.isArray(value.disabled)) {
		throw new Error(`Invalid ${scope}.disabled: expected a list of tool names.`);
	}
	const disabled: string[] = [];
	for (const name of value.disabled) {
		if (typeof name !== "string" || name.trim() === "") {
			throw new Error(`Invalid ${scope}.disabled: entries must be non-empty tool names.`);
		}
		if (!disabled.includes(name)) disabled.push(name);
	}
	return { disabled };
}

/** Validate and normalize `profiles`; throws a message naming the offending key. */
export function normalizeModelProfiles(value: unknown): Record<string, ModelProfile> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		const received = Array.isArray(value) ? "an array" : `a ${typeof value}`;
		throw new Error(`Invalid profiles: expected a map of model selectors to profiles, got ${received}.`);
	}
	const profiles: Record<string, ModelProfile> = {};
	for (const [key, entry] of Object.entries(value)) {
		const keyError = checkModelSelectorKey(key);
		if (keyError) throw new Error(`Invalid profiles key "${key}": ${keyError}.`);
		if (!isRecord(entry)) throw new Error(`Invalid profiles["${key}"]: expected an object.`);
		rejectUnknownKeys(`profiles["${key}"]`, entry, PROFILE_KEYS);
		const profile: ModelProfile = {};
		if (entry.compaction !== undefined) {
			profile.compaction = normalizeCompaction(`profiles["${key}"].compaction`, entry.compaction);
		}
		if (entry.thinkingBudgets !== undefined) {
			profile.thinkingBudgets = normalizeThinkingBudgets(
				`profiles["${key}"].thinkingBudgets`,
				entry.thinkingBudgets,
			);
		}
		if (entry.tools !== undefined) {
			profile.tools = normalizeTools(`profiles["${key}"].tools`, entry.tools);
		}
		if (entry.sampling !== undefined) {
			profile.sampling = normalizeSampling(`profiles["${key}"].sampling`, entry.sampling);
		}
		profiles[key] = profile;
	}
	return profiles;
}

/** Validation hook for the `profiles` setting definition. */
export function validateModelProfiles(value: unknown): void {
	normalizeModelProfiles(value);
}

const parsedProfiles = new WeakMap<object, Record<string, ModelProfile>>();

function profilesOf(raw: unknown): Record<string, ModelProfile> {
	if (!isRecord(raw)) return {};
	let parsed = parsedProfiles.get(raw);
	if (!parsed) {
		parsed = normalizeModelProfiles(raw);
		parsedProfiles.set(raw, parsed);
	}
	return parsed;
}

function mergeProfile(into: ModelProfile, from: ModelProfile): ModelProfile {
	const merged: ModelProfile = { ...into };
	if (from.compaction) merged.compaction = { ...into.compaction, ...from.compaction };
	if (from.thinkingBudgets) merged.thinkingBudgets = { ...into.thinkingBudgets, ...from.thinkingBudgets };
	if (from.tools?.disabled) {
		merged.tools = { disabled: [...new Set([...(into.tools?.disabled ?? []), ...from.tools.disabled])] };
	}
	if (from.sampling) merged.sampling = { ...into.sampling, ...from.sampling };
	return merged;
}

/**
 * The `profiles` entry governing `model`, layered from the widest matching
 * `…*` prefix to an exact `provider/model-id` (which wins field by field, and
 * whose key is reported). Unmatched fields fall back to the global settings.
 */
export function matchModelProfile(
	raw: unknown,
	model: { provider: string; id: string },
): { key: string; profile: ModelProfile } | undefined {
	const entries = profilesOf(raw);
	const selector = `${model.provider}/${model.id}`;
	const prefixes = Object.keys(entries)
		.filter(key => key.endsWith("*") && selector.startsWith(key.slice(0, -1)))
		.sort((a, b) => a.length - b.length || a.localeCompare(b));
	const exact = Object.hasOwn(entries, selector) ? selector : undefined;
	if (!exact && prefixes.length === 0) return undefined;
	let profile: ModelProfile = {};
	for (const key of prefixes) profile = mergeProfile(profile, entries[key]);
	if (exact) profile = mergeProfile(profile, entries[exact]);
	return { key: exact ?? prefixes[prefixes.length - 1], profile };
}
