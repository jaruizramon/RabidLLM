/**
 * Shared key grammar for settings records keyed by model: `compaction.modelThresholds`
 * and `profiles`. An exact `provider/model-id` key wins, else the longest
 * `*`-terminated prefix (`deepseek/*`, `openrouter/anthropic/*`).
 */

/** Why `key` is not a model selector; undefined when it is. */
export function checkModelSelectorKey(key: string): string | undefined {
	const star = key.indexOf("*");
	if (star !== -1 && star !== key.length - 1) return "`*` is only allowed as the last character";
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1) return "expected `provider/model-id` or a `provider/…*` prefix";
	return undefined;
}

/** The entry governing `model`: exact key first, else the longest matching `…*` prefix. */
export function matchModelSelector<T>(
	entries: Readonly<Record<string, T>>,
	model: { provider: string; id: string },
): { key: string; value: T } | undefined {
	const selector = `${model.provider}/${model.id}`;
	if (Object.hasOwn(entries, selector)) return { key: selector, value: entries[selector] };
	let best: { key: string; value: T } | undefined;
	for (const key in entries) {
		if (!key.endsWith("*") || !selector.startsWith(key.slice(0, -1))) continue;
		if (!best || key.length > best.key.length) best = { key, value: entries[key] };
	}
	return best;
}
