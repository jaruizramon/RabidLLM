/**
 * Client for the local llama-model manager (`llama-manager`, UI on :8090).
 *
 * The manager owns the rig's lifecycle: it loads/unloads one model at a time
 * on the V100, starts/stops the router, force-clears VRAM, parks/restores
 * router contexts, and runs the CPU/GPU SLM handoff worker. The harness talks
 * to it over its loopback HTTP API; `/preset` and `/llama` both use this
 * module so there is one request/response contract.
 */
import * as path from "node:path";
import { getAgentDir, isRecord, logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";

/** Providers whose models are served by the local rig. */
export const LOCAL_PROVIDERS: readonly string[] = ["llama-rabid", "local-llama"];

export type ManagerEngine = "llama" | "1cat" | "stock";

export interface LlamaManagerModel {
	readonly id: string;
	readonly engine: ManagerEngine | string;
	readonly status: string;
	readonly active: boolean;
	readonly failed: boolean;
	readonly exists: boolean;
	readonly size_bytes?: number | null;
	readonly vram_peak_mib?: number | null;
	readonly context?: number | null;
	readonly mmproj?: string | null;
	readonly path?: string;
	readonly file?: string;
	readonly tags?: readonly string[];
}

export interface LlamaManagerGpu {
	readonly index: number;
	readonly name: string;
	readonly used_mib: number;
	readonly total_mib: number;
	readonly util: number;
	readonly uuid?: string;
}

export interface LlamaManagerSlm {
	readonly running: boolean;
	readonly loaded: boolean;
	readonly pid?: number | null;
	readonly port?: number | null;
	readonly model?: string | null;
	readonly file?: string | null;
	readonly device?: string | null;
	readonly ctx?: number | null;
	readonly threads?: number | null;
	readonly gpu_free_mib?: number | null;
	readonly cpu_pct?: number | null;
	readonly rss_mib?: number | null;
	readonly uptime_s?: number | null;
	readonly choices?: ReadonlyArray<{ id: string; path: string; exists: boolean; size_bytes?: number | null }>;
}

export interface LlamaManagerState {
	readonly server: {
		readonly up: boolean;
		readonly engine?: string;
		readonly router_port: number;
		readonly ui_port: number;
		readonly log_file?: string;
		readonly cat_log_file?: string;
		readonly error?: string | null;
	};
	readonly gpu: {
		readonly devices?: readonly LlamaManagerGpu[];
		readonly target?: LlamaManagerGpu;
		readonly error?: string;
	};
	readonly models: readonly LlamaManagerModel[];
	readonly active?: string | null;
	readonly baseline_mib?: number;
	readonly slm?: LlamaManagerSlm;
}

export interface LlamaManagerContext {
	readonly model: string;
	readonly name: string;
	readonly slot: number;
	readonly tokens: number;
	readonly bytes: number;
	readonly on_disk: boolean;
	readonly disk_bytes: number;
	readonly saved_at?: number;
	readonly restored_at?: number;
}

export interface LlamaManagerContexts {
	readonly parking: { readonly resume: boolean; readonly park_on_idle: boolean; readonly quiet_seconds: number };
	readonly contexts: readonly LlamaManagerContext[];
}

export interface ManagerResult {
	readonly detail?: string;
}

const STATE_TIMEOUT_MS = 5_000;
const ACTION_TIMEOUT_MS = 20_000;
const LOAD_TIMEOUT_MS = 180_000;
const SERVER_TIMEOUT_MS = 60_000;
const POLL_MS = 1_000;

/** Read per call so tests and alternate rigs can redirect the endpoints. */
export function managerUrl(): string {
	return process.env.RABID_LLAMA_MANAGER ?? "http://127.0.0.1:8090";
}

export function routerUrl(): string {
	return process.env.RABID_LLAMA_ROUTER ?? "http://127.0.0.1:8080";
}

function signalFor(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** True for a model whose weights are in VRAM and usable (a sleeping model wakes on request). */
export function isModelLoaded(model: LlamaManagerModel | undefined): boolean {
	return model?.status === "loaded" || model?.status === "sleeping";
}

/** True while the manager is loading a model (no actions until it settles). */
export function isModelLoading(model: LlamaManagerModel | undefined): boolean {
	return model?.status === "loading";
}

/** The model currently holding the V100, if any. */
export function activeModel(state: LlamaManagerState | undefined): LlamaManagerModel | undefined {
	if (!state) return undefined;
	return state.models.find(model => model.active) ?? state.models.find(model => model.id === state.active);
}

export async function fetchManagerState(signal?: AbortSignal): Promise<LlamaManagerState> {
	const response = await fetch(`${managerUrl()}/api/state`, { signal: signalFor(STATE_TIMEOUT_MS, signal) });
	if (!response.ok) throw new Error(`llama-manager state: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		throw new Error("llama-manager state: unexpected response");
	}
	// Older managers and test doubles may omit the server/GPU blocks; a state
	// with models is still useful, and a missing server block means "up".
	if (!isRecord(payload.server)) payload.server = { up: true, router_port: 8080, ui_port: 8090 };
	if (!isRecord(payload.gpu)) payload.gpu = {};
	return payload as unknown as LlamaManagerState;
}

export async function fetchManagerContexts(signal?: AbortSignal): Promise<LlamaManagerContexts> {
	const response = await fetch(`${managerUrl()}/api/contexts`, { signal: signalFor(STATE_TIMEOUT_MS, signal) });
	if (!response.ok) throw new Error(`llama-manager contexts: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.contexts)) {
		throw new Error("llama-manager contexts: unexpected response");
	}
	return payload as unknown as LlamaManagerContexts;
}

export async function fetchManagerSlm(signal?: AbortSignal): Promise<LlamaManagerSlm> {
	const response = await fetch(`${managerUrl()}/api/slm`, { signal: signalFor(STATE_TIMEOUT_MS, signal) });
	if (!response.ok) throw new Error(`llama-manager slm: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isRecord(payload)) throw new Error("llama-manager slm: unexpected response");
	return payload as unknown as LlamaManagerSlm;
}

/** The manager's log tail; `engine` selects the router, 1cat, stock, or SLM worker log. */
export async function fetchManagerLog(
	engine: "llama" | "1cat" | "stock" | "slm" = "llama",
	signal?: AbortSignal,
): Promise<string> {
	const response = await fetch(`${managerUrl()}/api/log?engine=${engine}`, {
		signal: signalFor(STATE_TIMEOUT_MS, signal),
	});
	if (!response.ok) throw new Error(`llama-manager log: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || typeof payload.log !== "string") {
		throw new Error("llama-manager log: unexpected response");
	}
	return payload.log;
}

/** Preset ids the *running router* knows (its preset file snapshot). */
export async function routerPresets(signal?: AbortSignal): Promise<Set<string>> {
	const response = await fetch(`${routerUrl()}/v1/models`, { signal: signalFor(STATE_TIMEOUT_MS, signal) });
	if (!response.ok) throw new Error(`llama router: HTTP ${response.status}`);
	const payload = (await response.json()) as { data?: Array<{ id?: string }> };
	return new Set((payload.data ?? []).flatMap(entry => (entry.id ? [entry.id] : [])));
}

async function postManager(
	route: string,
	body: object,
	timeoutMs = ACTION_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<{ ok?: boolean; detail?: string; error?: string; context?: unknown }> {
	const response = await fetch(`${managerUrl()}${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: signalFor(timeoutMs, signal),
	});
	const result = (await response.json().catch(() => ({}))) as {
		ok?: boolean;
		detail?: string;
		error?: string;
		context?: unknown;
	};
	if (!response.ok || result.ok === false) {
		throw new Error(result.error ?? `${route} failed (HTTP ${response.status})`);
	}
	return result;
}

/** Poll until `id` is loaded or failed; `onTick` receives elapsed seconds and the manager status. */
export async function waitUntilLoaded(
	id: string,
	onTick: (seconds: number, status: string) => void,
	signal?: AbortSignal,
): Promise<LlamaManagerModel> {
	const startedAt = Date.now();
	for (;;) {
		const state = await fetchManagerState(signal);
		const model = state.models.find(candidate => candidate.id === id);
		const elapsed = Math.round((Date.now() - startedAt) / 1000);
		if (!model) throw new Error(`llama-manager stopped reporting ${id}`);
		if (model.failed || model.status === "failed") throw new Error(`${id} failed to load`);
		if (isModelLoaded(model)) return model;
		if (Date.now() - startedAt > LOAD_TIMEOUT_MS) throw new Error(`timed out loading ${id} (${elapsed}s)`);
		onTick(elapsed, model.status);
		await Bun.sleep(POLL_MS);
	}
}

/**
 * Load a preset through the manager. Refuses a preset the *running* router was
 * not started with (a restarted router would evict the resident model) unless
 * the router is down, in which case the manager starts it and re-reads
 * `models.ini` itself.
 */
export async function loadPreset(
	id: string,
	onStatus: (text: string) => void,
	signal?: AbortSignal,
): Promise<ManagerResult> {
	const state = await fetchManagerState(signal);
	const preset = state.models.find(model => model.id === id);
	if (!preset) {
		throw new Error(`unknown preset "${id}"; models.ini has:\n${formatModelList(state.models)}`);
	}
	if (!preset.exists) throw new Error(`${id}: model file is missing from disk`);
	if (isModelLoaded(preset)) return { detail: `${id} is already loaded` };
	if (isModelLoading(preset)) {
		onStatus(`Waiting for ${id} to finish loading…`);
		await waitUntilLoaded(id, () => {}, signal);
		return { detail: `${id} is loaded` };
	}
	if (state.server.up && state.server.engine === "llama" && preset.engine === "llama") {
		const known = await routerPresets(signal);
		if (!known.has(id)) {
			throw new Error(
				`${id} is in models.ini but the running router was started before it was added. ` +
					"Restarting the router would unload the resident model from VRAM, so it was left resident; " +
					"run /llama restart (or /preset restart) when the card is free, then load it again.",
			);
		}
	}

	onStatus(`Loading ${id}…`);
	const result = await postManager("/api/load", { model: id }, ACTION_TIMEOUT_MS, signal);
	await waitUntilLoaded(
		id,
		(seconds, status) => {
			if (seconds % 5 === 0) onStatus(`Loading ${id}… ${seconds}s (${status})`);
		},
		signal,
	);
	return { detail: result.detail };
}

/** Unload a preset; the manager parks the context for a fast reload when it can. */
export async function unloadPreset(
	id: string,
	onStatus: (text: string) => void,
	signal?: AbortSignal,
): Promise<ManagerResult> {
	const state = await fetchManagerState(signal);
	const preset = state.models.find(model => model.id === id);
	if (!preset) {
		throw new Error(`unknown preset "${id}"; models.ini has:\n${formatModelList(state.models)}`);
	}
	if (!isModelLoaded(preset) && !isModelLoading(preset)) {
		onStatus(`${id} is not loaded.`);
		return { detail: `${id} is not loaded` };
	}
	onStatus(`Unloading ${id}…`);
	const result = await postManager("/api/unload", { model: id }, ACTION_TIMEOUT_MS, signal);
	const startedAt = Date.now();
	while (Date.now() - startedAt < SERVER_TIMEOUT_MS) {
		const current = (await fetchManagerState(signal)).models.find(model => model.id === id);
		if (!current || (!isModelLoaded(current) && !isModelLoading(current))) return { detail: result.detail };
		onStatus(`Unloading ${id}… ${Math.round((Date.now() - startedAt) / 1000)}s`);
		await Bun.sleep(POLL_MS);
	}
	throw new Error(`timed out unloading ${id}`);
}

/** Start or stop the router (and the alternate engines the manager owns). */
export async function setServerRunning(running: boolean, onStatus: (text: string) => void): Promise<ManagerResult> {
	onStatus(running ? "Starting the llama router…" : "Stopping the llama router…");
	const result = await postManager(`/api/server/${running ? "start" : "stop"}`, {}, SERVER_TIMEOUT_MS);
	const startedAt = Date.now();
	while (Date.now() - startedAt < SERVER_TIMEOUT_MS) {
		try {
			const state = await fetchManagerState();
			if (state.server.up === running) return { detail: result.detail };
		} catch {
			if (!running) return { detail: result.detail };
		}
		await Bun.sleep(500);
	}
	throw new Error(`router did not ${running ? "start" : "stop"} in time`);
}

/** The hammer: empty the V100 of every model engine, strays included. */
export async function forceClearVram(): Promise<ManagerResult> {
	const result = await postManager("/api/vram/force-clear", {}, SERVER_TIMEOUT_MS);
	return { detail: result.detail ?? "V100 cleared" };
}

/**
 * Restarts the router so it re-reads models.ini. This is the one operation that
 * deliberately evicts the resident model; callers must confirm it first.
 */
export async function restartRouter(onStatus: (text: string) => void): Promise<void> {
	onStatus("Stopping the llama router (the resident model will leave VRAM)…");
	await postManager("/api/server/stop", {});
	onStatus("Starting the llama router (re-reading models.ini)…");
	await postManager("/api/server/start", {}, SERVER_TIMEOUT_MS);
	const startedAt = Date.now();
	while (Date.now() - startedAt < SERVER_TIMEOUT_MS) {
		try {
			if ((await fetchManagerState()).server.up) return;
		} catch {
			// manager still restarting
		}
		await Bun.sleep(500);
	}
	throw new Error("router did not come back after restart");
}

export async function slmLoad(options: {
	model: string;
	device?: string;
	ctx?: number;
	gpuFreeMiB?: number;
	threads?: number;
}): Promise<ManagerResult> {
	const result = await postManager("/api/slm/load", {
		model: options.model,
		device: options.device ?? "cuda:1",
		ctx: options.ctx ?? 8192,
		gpuFreeMiB: options.gpuFreeMiB ?? 2048,
		threads: options.threads ?? 4,
	});
	return { detail: result.detail };
}

export async function slmUnload(): Promise<ManagerResult> {
	return { detail: (await postManager("/api/slm/unload", {})).detail };
}

export async function parkContext(model: string, name?: string, slot = 0): Promise<LlamaManagerContext> {
	const result = await postManager("/api/context/park", { model, name, slot });
	if (!isRecord(result.context)) throw new Error("llama-manager park: no context returned");
	return result.context as unknown as LlamaManagerContext;
}

export async function restoreContext(name: string, slot?: number): Promise<LlamaManagerContext> {
	const result = await postManager("/api/context/restore", { name, slot });
	if (!isRecord(result.context)) throw new Error("llama-manager restore: no context returned");
	return result.context as unknown as LlamaManagerContext;
}

export async function dropContext(name: string): Promise<ManagerResult> {
	return { detail: (await postManager("/api/context/drop", { name })).detail };
}

/** Refresh omp's local model list. Failures are logged; the caller still has the previous list. */
export async function refreshLocalProviders(session: AgentSession): Promise<string[]> {
	const refreshed: string[] = [];
	for (const provider of LOCAL_PROVIDERS) {
		try {
			await session.modelRegistry.refreshProvider(provider, "online-if-uncached");
			refreshed.push(provider);
		} catch (error) {
			logger.debug("llama-manager: provider refresh failed", { provider, error: errorMessage(error) });
		}
	}
	return refreshed;
}

/**
 * The harness model for a local preset. Prefers the session's current provider
 * (so the switch stays in the group the user was already using), then
 * `llama-rabid`, then `local-llama`; refreshes the local providers once when
 * the id is absent.
 */
export async function switchToLocalModel(
	session: AgentSession,
	id: string,
	preferredProvider?: string,
): Promise<{ provider: string; id: string }> {
	const find = () => {
		const all = session.modelRegistry.getAll("all");
		const current = session.model?.provider;
		const order = [...LOCAL_PROVIDERS];
		if (current && LOCAL_PROVIDERS.some(provider => provider === current)) order.unshift(current);
		// An explicit caller preference outranks the session's current provider.
		if (preferredProvider && LOCAL_PROVIDERS.some(provider => provider === preferredProvider)) {
			order.unshift(preferredProvider);
		}
		for (const provider of order) {
			const model = all.find(candidate => candidate.provider === provider && candidate.id === id);
			if (model) return model;
		}
		return undefined;
	};
	let model = find();
	if (!model) {
		await refreshLocalProviders(session);
		model = find();
	}
	if (!model) {
		throw new Error(
			`Loaded ${id}, but omp has no model named "${id}" under ${LOCAL_PROVIDERS.join(" or ")}. ` +
				`Add it under providers.llama-rabid.models in ${path.join(getAgentDir(), "models.yml")}, then run /llama reload.`,
		);
	}
	await session.setModel(model);
	return { provider: model.provider, id: model.id };
}

/** A compact text report for `/llama status` and `/preset list`. */
export function formatManagerStatus(
	state: LlamaManagerState,
	session?: Pick<AgentSession, "model">,
	contexts?: LlamaManagerContexts,
): string {
	const target = state.gpu.target;
	const gpu = target
		? `${target.name} ${formatMib(target.used_mib)}/${formatMib(target.total_mib)} (free ${formatMib(
				Math.max(0, target.total_mib - target.used_mib),
			)}) · ${target.util}% util`
		: state.gpu.error
			? `GPU unavailable: ${state.gpu.error}`
			: "GPU unavailable";
	const harness = session?.model;
	const harnessLine = harness ? `omp: ${harness.provider}/${harness.id}` : "omp: no model selected";
	const lines = [
		`V100 models (${managerUrl()})`,
		`  router :${state.server.router_port} ${state.server.up ? "up" : "down"} · ui :${state.server.ui_port}`,
		`  ${gpu}`,
		`  ${harnessLine}`,
		"",
	];
	for (const model of state.models) {
		const status = model.failed ? "failed" : model.status;
		const marker =
			model.id === harness?.id && LOCAL_PROVIDERS.some(provider => provider === harness.provider) ? " *" : "";
		const current = model.active ? " active" : "";
		const size = model.size_bytes ? formatBytes(model.size_bytes) : "—";
		const peak = model.vram_peak_mib ? `${formatMib(model.vram_peak_mib)} peak` : "peak unknown";
		const context = model.context ? `${model.context} ctx` : "";
		lines.push(
			`  ${model.id}${marker}  ${status}${current}  ${size}  ${peak}${context ? `  ${context}` : ""}  ${model.engine}`,
		);
		if (!model.exists) lines.push(`    missing: ${model.path ?? "unknown path"}`);
	}
	if (contexts && contexts.contexts.length > 0) {
		lines.push("", "Parked contexts:");
		for (const context of contexts.contexts.slice(0, 8)) {
			lines.push(
				`  ${context.name}  ${context.model}  ${context.tokens} tokens  ${formatBytes(context.disk_bytes)}  ${context.on_disk ? "on disk" : "missing"}`,
			);
		}
	}
	if (state.slm) {
		lines.push(
			"",
			`SLM worker: ${state.slm.loaded ? "ready" : state.slm.running ? "starting" : "stopped"}${state.slm.file ? ` · ${state.slm.file}` : ""}${state.slm.device ? ` · ${state.slm.device}` : ""}${state.slm.ctx ? ` · ${state.slm.ctx} ctx` : ""}`,
		);
	}
	return lines.join("\n");
}

export function formatModelList(models: readonly LlamaManagerModel[]): string {
	return models.length > 0
		? models.map(model => `  ${model.id} (${model.status}${model.exists ? "" : ", missing file"})`).join("\n")
		: "  (no presets)";
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatMib(mib: number | null | undefined): string {
	if (mib == null || !Number.isFinite(mib)) return "—";
	return `${(mib / 1024).toFixed(1)} GiB`;
}
