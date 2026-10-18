/**
 * `/preset` — load a llama-server preset from inside omp through llama-manager.
 *
 * The manager (:8090) reads `models.ini` on every call, so it sees presets added
 * while the router is running; the router itself reads the file only at startup.
 * A preset the running router does not know is therefore refused here instead of
 * restarting the router behind the user's back: restarting would unload the
 * resident model from VRAM. `/preset reload` refreshes omp's model list only and
 * always leaves the loaded model untouched.
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

const PROVIDER = "llama-rabid";
/** Modes the Alt+Q / `/preset` picker offers, in display order. */
const RABID_MODES = ["fast", "balanced", "deep"] as const;
/** Server bundles that encode a mode; excluded from the model picker. */
const RABID_PRESET_BUNDLES: ReadonlySet<string> = new Set(["rabid-fast", "rabid-balanced", "rabid-deep"]);

type RabidModeName = (typeof RABID_MODES)[number];

function isRabidMode(value: string | undefined): value is RabidModeName {
	return value !== undefined && (RABID_MODES as readonly string[]).includes(value);
}

/** Read per call so tests and alternate rigs can redirect the endpoints. */
function managerUrl(): string {
	return process.env.RABID_LLAMA_MANAGER ?? "http://127.0.0.1:8090";
}

function routerUrl(): string {
	return process.env.RABID_LLAMA_ROUTER ?? "http://127.0.0.1:8080";
}
const LOAD_TIMEOUT_MS = 180_000;
const POLL_MS = 1_000;

interface ManagerPreset {
	id: string;
	status?: string;
	active?: boolean;
	exists?: boolean;
	engine?: string;
}

interface ManagerState {
	models?: ManagerPreset[];
}

function timeoutSignal(ms: number): AbortSignal {
	return AbortSignal.timeout(ms);
}

async function managerState(): Promise<ManagerPreset[]> {
	const response = await fetch(`${managerUrl()}/api/state`, { signal: timeoutSignal(5_000) });
	if (!response.ok) throw new Error(`llama-manager state: HTTP ${response.status}`);
	const state = (await response.json()) as ManagerState;
	return state.models ?? [];
}

/** Preset ids the *running router* knows (its preset file snapshot). */
async function routerPresets(): Promise<Set<string>> {
	const response = await fetch(`${routerUrl()}/v1/models`, { signal: timeoutSignal(5_000) });
	if (!response.ok) throw new Error(`llama router: HTTP ${response.status}`);
	const data = (await response.json()) as { data?: Array<{ id?: string }> };
	return new Set((data.data ?? []).flatMap(entry => (entry.id ? [entry.id] : [])));
}

function isLoaded(preset: ManagerPreset | undefined): boolean {
	return preset?.status === "loaded" || preset?.status === "sleeping";
}

function formatPresets(models: readonly ManagerPreset[]): string {
	const lines = models.map(model => {
		const here = isLoaded(model) ? "loaded" : (model.status ?? "unloaded");
		return `  ${model.id} (${here}${model.exists === false ? ", missing file" : ""})`;
	});
	return lines.length > 0 ? lines.join("\n") : "  (no presets)";
}

/** Poll for readiness; `onTick` receives elapsed seconds so callers can narrate. */
async function waitUntilLoaded(id: string, onTick: (seconds: number, status: string) => void): Promise<ManagerPreset> {
	const startedAt = Date.now();
	for (;;) {
		const preset = (await managerState()).find(model => model.id === id);
		const elapsed = Math.round((Date.now() - startedAt) / 1000);
		if (!preset) throw new Error(`llama-manager stopped reporting ${id}`);
		if (preset.status === "failed") throw new Error(`${id} failed to load`);
		if (isLoaded(preset)) return preset;
		if (Date.now() - startedAt > LOAD_TIMEOUT_MS) {
			throw new Error(`timed out loading ${id} (${elapsed}s)`);
		}
		onTick(elapsed, preset.status ?? "unloaded");
		await Bun.sleep(POLL_MS);
	}
}

async function loadPreset(id: string, onStatus: (text: string) => void): Promise<void> {
	const presets = await managerState();
	const preset = presets.find(model => model.id === id);
	if (!preset) {
		throw new Error(`unknown preset "${id}"; models.ini has:\n${formatPresets(presets)}`);
	}
	if (preset.exists === false) throw new Error(`${id}: model file is missing from disk`);
	if (isLoaded(preset)) return;

	const known = await routerPresets();
	if (!known.has(id)) {
		throw new Error(
			`${id} is in models.ini but the running router was started before it was added. ` +
				"Restarting the router would unload the resident model from VRAM, so it was left resident; " +
				"run /preset restart when the card is free, then run /preset again.",
		);
	}

	onStatus(`Loading ${id}…`);
	const response = await fetch(`${managerUrl()}/api/load`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: id }),
		signal: timeoutSignal(20_000),
	});
	const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string };
	if (!response.ok || result.ok === false) throw new Error(result.error ?? `load failed (HTTP ${response.status})`);
	await waitUntilLoaded(id, (seconds, status) => {
		if (seconds % 5 === 0) onStatus(`Loading ${id}… ${seconds}s (${status})`);
	});
}

async function unloadPreset(id: string, onStatus: (text: string) => void): Promise<void> {
	const presets = await managerState();
	const preset = presets.find(model => model.id === id);
	if (!preset) {
		throw new Error(`unknown preset "${id}"; models.ini has:\n${formatPresets(presets)}`);
	}
	if (!isLoaded(preset)) {
		onStatus(`${id} is not loaded.`);
		return;
	}
	onStatus(`Unloading ${id}…`);
	const response = await fetch(`${managerUrl()}/api/unload`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: id }),
		signal: timeoutSignal(20_000),
	});
	const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string };
	if (!response.ok || result.ok === false) throw new Error(result.error ?? `unload failed (HTTP ${response.status})`);
	// The manager parks the context during unload, so a later load resumes it.
	const startedAt = Date.now();
	while (Date.now() - startedAt < 60_000) {
		const current = (await managerState()).find(model => model.id === id);
		if (!current || !isLoaded(current)) return;
		await Bun.sleep(POLL_MS);
	}
	throw new Error(`timed out unloading ${id}`);
}

/** Parse `list` / `reload` / `load <id>` / `unload <id>` / bare `<id>` (load shorthand). */
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
): Promise<void> {
	const preset = (await managerState()).find(model => model.id === modelId);
	if (!preset) throw new Error(`"${modelId}" is not a preset in models.ini`);
	if (!isLoaded(preset)) await loadPreset(modelId, onStatus);
	cfgRabidMode.set(runtime.settings, mode);
	await switchToPreset(runtime, modelId);
}

async function postManager(path: string, body: object, timeoutMs = 30_000): Promise<void> {
	const response = await fetch(`${managerUrl()}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: timeoutSignal(timeoutMs),
	});
	const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string };
	if (!response.ok || result.ok === false) throw new Error(result.error ?? `${path} failed (HTTP ${response.status})`);
}

/**
 * Restarts the router so it re-reads models.ini. This is the one operation that
 * deliberately evicts the resident model; callers must confirm it first.
 */
async function restartRouter(onStatus: (text: string) => void): Promise<void> {
	onStatus("Stopping the llama router (the resident model will leave VRAM)…");
	await postManager("/api/server/stop", {});
	onStatus("Starting the llama router (re-reading models.ini)…");
	await postManager("/api/server/start", {}, 60_000);
	const startedAt = Date.now();
	while (Date.now() - startedAt < 60_000) {
		try {
			await managerState();
			return;
		} catch {
			await Bun.sleep(500);
		}
	}
	throw new Error("router did not come back after restart");
}

async function switchToPreset(runtime: { session: SlashCommandRuntime["session"] }, id: string): Promise<void> {
	const model = runtime.session.modelRegistry
		.getAll("all")
		.find(candidate => candidate.provider === PROVIDER && candidate.id === id);
	if (!model) {
		throw new Error(`${PROVIDER}/${id} is not in omp's model list yet; run /preset reload first`);
	}
	await runtime.session.setModel(model);
}

async function reloadModels(runtime: { session: SlashCommandRuntime["session"] }): Promise<void> {
	await runtime.session.modelRegistry.refreshProvider(PROVIDER, "online-if-uncached");
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
					await applyMode(runtime, mode, modelId, text => logger.debug(text, { source: "preset" }));
					await runtime.output(`Applied ${mode} to ${modelId}; omp is on ${PROVIDER}/${modelId}.`);
					return commandConsumed();
				}
				if (parsed.action === "list") {
					await runtime.output(`llama-server presets (${managerUrl()}):\n${formatPresets(await managerState())}`);
					return commandConsumed();
				}
				const id = parsed.id ?? "";
				if (parsed.action === "unload") {
					await unloadPreset(id, text => logger.debug(text, { source: "preset" }));
					await runtime.output(`Unloaded ${id}; its context was parked for a fast reload.`);
					return commandConsumed();
				}
				await loadPreset(id, text => logger.debug(text, { source: "preset" }));
				await switchToPreset(runtime, id);
				await runtime.output(`Loaded ${id} and switched omp to ${PROVIDER}/${id}.`);
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
						ctx.showStatus(`llama-server presets:\n${formatPresets(await managerState())}`);
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

					const all = await managerState();
					const models = all.filter(
						model => model.engine === "llama" && !RABID_PRESET_BUNDLES.has(model.id) && model.exists !== false,
					);
					if (models.length === 0) {
						ctx.showError("No local llama models are available in models.ini.");
						return commandConsumed();
					}
					const modelLabels = models.map(model => {
						const state = isLoaded(model) ? "loaded" : (model.status ?? "unloaded");
						return `${model.id} (${state})`;
					});
					const pickedModel = await ctx.showHookSelector(`Apply ${chosenMode} to which model?`, modelLabels);
					if (!pickedModel) return commandConsumed();
					const modelId = pickedModel.split(" ")[0] ?? "";
					if (!modelId) return commandConsumed();

					const target = models.find(model => model.id === modelId);
					const resident = all.find(model => isLoaded(model) && model.id !== modelId);
					const evict = target && !isLoaded(target) && resident ? ` (unloads ${resident.id})` : "";
					const confirmed = await ctx.showHookSelector(`Apply ${chosenMode} to ${modelId}?${evict}`, [
						"Apply (Enter)",
						"Cancel (Esc)",
					]);
					if (confirmed !== "Apply (Enter)") return commandConsumed();
					await applyMode(ctx, chosenMode, modelId, text => ctx.showStatus(text));
					ctx.statusLine.invalidate();
					ctx.showStatus(`Applied ${chosenMode} to ${modelId}; omp is on ${PROVIDER}/${modelId}.`);
					return commandConsumed();
				}
				const id = parsed.id ?? "";
				if (parsed.action === "unload") {
					await unloadPreset(id, text => ctx.showStatus(text));
					ctx.statusLine.invalidate();
					ctx.showStatus(`Unloaded ${id}; its context was parked for a fast reload.`);
					return commandConsumed();
				}
				await loadPreset(id, text => ctx.showStatus(text));
				await switchToPreset(ctx, id);
				ctx.statusLine.invalidate();
				ctx.showStatus(`Loaded ${id}; omp is on ${PROVIDER}/${id}.`);
			} catch (error) {
				ctx.showError(`Preset failed: ${errorMessage(error)}`);
			}
			return commandConsumed();
		},
	},
];
