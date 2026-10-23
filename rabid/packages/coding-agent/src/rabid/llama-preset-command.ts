/**
 * `/preset` — load a llama-server preset from inside omp through llama-manager.
 *
 * The manager (:8090) reads `models.ini` on every call, so it sees presets added
 * while the router is running; the router itself reads the file only at startup.
 * A preset the running router does not know is therefore refused here instead of
 * restarting the router behind the user's back: restarting would unload the
 * resident model from VRAM. `/preset reload` refreshes omp's model list only and
 * always leaves the loaded model untouched.
 *
 * The manager client itself lives in `./llama-manager`, shared with `/llama`.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { cfgRabidMode } from "./rabid-modes";
import { commandConsumed, errorMessage } from "../slash-commands/helpers/parse";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "../slash-commands/types";
import {
	fetchManagerState,
	formatModelList,
	isModelLoaded,
	loadPreset,
	restartRouter,
	switchToLocalModel,
	unloadPreset,
} from "./llama-manager";
import type { LlamaManagerModel } from "./llama-manager";

const PROVIDER = "llama-rabid";
/** Modes the Alt+Q / `/preset` picker offers, in display order. */
const RABID_MODES = ["fast", "balanced", "deep"] as const;
/** Server bundles that encode a mode; excluded from the model picker. */
const RABID_PRESET_BUNDLES: ReadonlySet<string> = new Set(["rabid-fast", "rabid-balanced", "rabid-deep"]);

type RabidModeName = (typeof RABID_MODES)[number];

function isRabidMode(value: string | undefined): value is RabidModeName {
	return value !== undefined && (RABID_MODES as readonly string[]).includes(value);
}

/** Parse `list` / `reload` / `restart` / `load <id>` / `unload <id>` / `<mode> [id]`. */
function parsePresetArgs(arg: string): {
	action: "list" | "reload" | "restart" | "load" | "unload" | "mode";
	id?: string;
	mode?: RabidModeName;
} {
	const text = arg.trim();
	if (text === "" || text === "list" || text === "status") return { action: "list" };
	if (text === "reload") return { action: "reload" };
	if (text === "restart") return { action: "restart" };
	const [verb, rest] = text.split(/\s+/, 2);
	if (isRabidMode(verb)) return { action: "mode", mode: verb, id: rest };
	if ((verb === "load" || verb === "unload") && rest) return { action: verb, id: rest };
	return { action: "load", id: text };
}

/** Apply a mode to one local model: load it only when it is not already resident. */
async function applyMode(
	runtime: { session: SlashCommandRuntime["session"]; settings: SlashCommandRuntime["settings"] },
	mode: RabidModeName,
	modelId: string,
	onStatus: (text: string) => void,
): Promise<{ provider: string; id: string }> {
	const state = await fetchManagerState();
	const preset = state.models.find(model => model.id === modelId);
	if (!preset) throw new Error(`"${modelId}" is not a preset in models.ini`);
	if (!isModelLoaded(preset)) await loadPreset(modelId, onStatus);
	cfgRabidMode.set(runtime.settings, mode);
	return await switchToLocalModel(runtime.session, modelId, PROVIDER);
}

async function switchToPreset(
	runtime: { session: SlashCommandRuntime["session"] },
	id: string,
): Promise<{ provider: string; id: string }> {
	return await switchToLocalModel(runtime.session, id, PROVIDER);
}

async function reloadModels(runtime: { session: SlashCommandRuntime["session"] }): Promise<void> {
	await runtime.session.modelRegistry.refreshProvider(PROVIDER, "online-if-uncached");
}

/** The manager's model list, with the mode bundles hidden for the mode picker. */
function localModelsForMode(models: readonly LlamaManagerModel[]): LlamaManagerModel[] {
	return models.filter(
		model => model.engine === "llama" && !RABID_PRESET_BUNDLES.has(model.id) && model.exists !== false,
	);
}

function modeLabel(model: LlamaManagerModel): string {
	const state = isModelLoaded(model) ? "loaded" : (model.status ?? "unloaded");
	return `${model.id} (${state})`;
}

export const BUILTIN_LLAMA_PRESET_SLASH_COMMANDS: SlashCommandSpec[] = [
	{
		name: "preset",
		icon: "action",
		description:
			"Load or unload a llama-rabid preset through llama-manager (router routing); `reload` re-reads models.yml in omp without touching the resident model",
		allowArgs: true,
		inlineHint: "[list|reload|load <id>|unload <id>]",
		subcommands: [
			{ name: "list", description: "List llama-server presets and their status" },
			{ name: "load", description: "Load a preset through the router and switch omp to it" },
			{ name: "unload", description: "Unload a preset (the manager parks its context for a fast reload)" },
			{ name: "reload", description: "Re-read models.yml in omp; the loaded model stays in VRAM" },
			{ name: "restart", description: "Restart the router to re-read models.ini (evicts the resident model)" },
		],
		async handle(command, runtime): Promise<SlashCommandResult> {
			const parsed = parsePresetArgs(command.args);
			try {
				if (parsed.action === "reload") {
					await reloadModels(runtime);
					await runtime.output("Model list reloaded. The loaded model was left resident.");
					return commandConsumed();
				}
				if (parsed.action === "restart") {
					await restartRouter(text => logger.debug(text, { source: "preset" }));
					await reloadModels(runtime);
					await runtime.output("Router restarted and models.ini re-read; omp's model list refreshed.");
					return commandConsumed();
				}
				if (parsed.action === "mode") {
					const mode = parsed.mode!;
					const current = runtime.session.model;
					const modelId = parsed.id ?? (current?.provider === PROVIDER ? current.id : "");
					if (!modelId) throw new Error("name a local model, e.g. /preset fast qwen3.8-27b");
					const target = await applyMode(runtime, mode, modelId, text => logger.debug(text, { source: "preset" }));
					await runtime.output(`Applied ${mode} to ${modelId}; omp is on ${target.provider}/${target.id}.`);
					return commandConsumed();
				}
				if (parsed.action === "list") {
					await runtime.output(`llama-server presets:\n${formatModelList((await fetchManagerState()).models)}`);
					return commandConsumed();
				}
				const id = parsed.id ?? "";
				if (parsed.action === "unload") {
					const result = await unloadPreset(id, text => logger.debug(text, { source: "preset" }));
					await runtime.output(
						`Unloaded ${id}; its context was parked for a fast reload${result.detail ? ` (${result.detail})` : ""}.`,
					);
					return commandConsumed();
				}
				await loadPreset(id, text => logger.debug(text, { source: "preset" }));
				const target = await switchToPreset(runtime, id);
				await runtime.output(`Loaded ${id} and switched omp to ${target.provider}/${target.id}.`);
			} catch (error) {
				await runtime.output(`Preset failed: ${errorMessage(error)}`);
			}
			return commandConsumed();
		},
		async handleTui(command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): Promise<SlashCommandResult> {
			const ctx = runtime.ctx;
			const parsed = parsePresetArgs(command.args);
			try {
				if (parsed.action === "reload") {
					await reloadModels(ctx);
					ctx.statusLine.invalidate();
					ctx.showStatus("Model list reloaded; the loaded model was left resident.");
					return commandConsumed();
				}
				if (parsed.action === "restart") {
					const choice = await ctx.showHookSelector("Restart the llama router?", [
						"Restart router (unloads the resident model)",
						"Cancel",
					]);
					if (choice !== "Restart router (unloads the resident model)") return commandConsumed();
					await restartRouter(text => ctx.showStatus(text));
					await reloadModels(ctx);
					ctx.statusLine.invalidate();
					ctx.showStatus("Router restarted and models.ini re-read; model list refreshed.");
					return commandConsumed();
				}
				if (parsed.action === "list") {
					if (command.args.trim() !== "") {
						ctx.showStatus(`llama-server presets:\n${formatModelList((await fetchManagerState()).models)}`);
						return commandConsumed();
					}
					// 1) Mode. 2) Which local model it applies to. 3) Confirm.
					const chosenMode = parsed.mode
						? parsed.mode
						: (
								await ctx.showHookSelector(
									"Rabid mode",
									RABID_MODES.map(mode => `${mode} mode`),
								)
							)?.split(" ")[0];
					if (!isRabidMode(chosenMode)) return commandConsumed();

					const all = (await fetchManagerState()).models;
					const models = localModelsForMode(all);
					if (models.length === 0) {
						ctx.showError("No local llama models are available in models.ini.");
						return commandConsumed();
					}
					const pickedModel = await ctx.showHookSelector(
						`Apply ${chosenMode} to which model?`,
						models.map(modeLabel),
					);
					if (!pickedModel) return commandConsumed();
					const modelId = pickedModel.split(" ")[0] ?? "";
					if (!modelId) return commandConsumed();

					const target = models.find(model => model.id === modelId);
					const resident = all.find(model => isModelLoaded(model) && model.id !== modelId);
					const evict = target && !isModelLoaded(target) && resident ? ` (unloads ${resident.id})` : "";
					const confirmed = await ctx.showHookSelector(`Apply ${chosenMode} to ${modelId}?${evict}`, [
						"Apply (Enter)",
						"Cancel (Esc)",
					]);
					if (confirmed !== "Apply (Enter)") return commandConsumed();
					const switched = await applyMode(ctx, chosenMode, modelId, text => ctx.showStatus(text));
					ctx.statusLine.invalidate();
					ctx.showStatus(`Applied ${chosenMode} to ${modelId}; omp is on ${switched.provider}/${switched.id}.`);
					return commandConsumed();
				}
				const id = parsed.id ?? "";
				if (parsed.action === "unload") {
					const result = await unloadPreset(id, text => ctx.showStatus(text));
					ctx.statusLine.invalidate();
					ctx.showStatus(
						`Unloaded ${id}; its context was parked for a fast reload${result.detail ? ` (${result.detail})` : ""}.`,
					);
					return commandConsumed();
				}
				await loadPreset(id, text => ctx.showStatus(text));
				const target = await switchToPreset(ctx, id);
				ctx.statusLine.invalidate();
				ctx.showStatus(`Loaded ${id}; omp is on ${target.provider}/${target.id}.`);
			} catch (error) {
				ctx.showError(`Preset failed: ${errorMessage(error)}`);
			}
			return commandConsumed();
		},
	},
];
