/**
 * `/llama`: a live V100 model-manager sheet inside the harness.
 *
 * It mirrors the useful half of the llama-manager UI (:8090) while keeping
 * omp's model selection in the same action: load a preset, wait for the
 * manager to put it in VRAM, then switch the session to that model. It also
 * unloads, starts/stops the router, force-clears VRAM, parks/restores/drops
 * router contexts, and opens the full manager UI when the browser is the
 * better tool (logs, SLM worker, drag-and-drop).
 */
import type { TspTone } from "@oh-my-pi/pi-wire";
import { type Component, matchesKey, theme, truncateToWidth } from "@oh-my-pi/pi-tui";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "@oh-my-pi/pi-tui/keybinding-matchers";
import { actionBar, actionButton, escCloseButton, selectList } from "@oh-my-pi/pi-tui/native/overlay";
import { col, compact, item, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { AgentSession } from "../session/agent-session";
import {
	activeModel,
	dropContext,
	fetchManagerContexts,
	fetchManagerState,
	forceClearVram,
	formatBytes,
	formatMib,
	isModelLoaded,
	isModelLoading,
	LOCAL_PROVIDERS,
	loadPreset,
	type LlamaManagerContext,
	type LlamaManagerContexts,
	type LlamaManagerModel,
	type LlamaManagerState,
	parkContext,
	restoreContext,
	setServerRunning,
	slmLoad,
	slmUnload,
	switchToLocalModel,
	unloadPreset,
} from "./llama-manager";

export interface LlamaManagerSheetHost {
	readonly session: AgentSession;
	readonly requestRender: () => void;
	readonly close: () => void;
	readonly showStatus: (text: string) => void;
	readonly showError: (text: string) => void;
	readonly confirm: (title: string, options: string[]) => Promise<string | undefined>;
	readonly openManagerUi: () => void;
}

const LIST_LINES = 12;
const ENGINE_LABEL: Record<string, string> = {
	llama: "llama.cpp",
	"1cat": "1Cat-vLLM",
	stock: "stock llama.cpp",
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function statusTone(model: LlamaManagerModel): TspTone {
	if (model.failed || model.status === "failed") return "error";
	if (model.status === "loading") return "pending";
	return isModelLoaded(model) ? "success" : "muted";
}

function statusWord(model: LlamaManagerModel): string {
	if (model.failed) return "failed";
	if (model.status === "loading") return "loading";
	return model.status || "unloaded";
}

/** Span style for a status word; item tones use {@link statusTone}. */
function statusStyle(model: LlamaManagerModel): string {
	if (model.failed || model.status === "failed") return "error";
	if (model.status === "loading") return "accent";
	return isModelLoaded(model) ? "success" : "muted";
}

function harnessMatches(host: LlamaManagerSheetHost, id: string): boolean {
	const model = host.session.model;
	return model?.id === id && LOCAL_PROVIDERS.some(provider => provider === model.provider);
}

function parkedFor(contexts: LlamaManagerContexts | undefined, modelId: string): LlamaManagerContext | undefined {
	return contexts?.contexts.find(context => context.model === modelId);
}

export class LlamaManagerSheet implements Component {
	readonly nativeOverlay = {
		role: "omp.overlay.llama",
		size: "lg",
		anchor: "center",
		head: "V100 models",
	} as const;

	readonly #host: LlamaManagerSheetHost;
	#state: LlamaManagerState | undefined;
	#contexts: LlamaManagerContexts | undefined;
	#error: string | undefined;
	#selectedId: string | undefined;
	#busy: string | undefined;
	#refreshing = false;
	#disposed = false;
	#ready: Promise<void>;
	#pending: Promise<void> = Promise.resolve();

	constructor(host: LlamaManagerSheetHost) {
		this.#host = host;
		this.#ready = this.refresh();
	}

	/** Resolves after the first manager snapshot (or its failure). */
	get ready(): Promise<void> {
		return this.#ready;
	}

	/** Resolves when every queued key/native action has settled. */
	get idle(): Promise<void> {
		return this.#pending;
	}

	/** Re-read the manager and the parked-context index. Safe to call on a timer. */
	async refresh(): Promise<void> {
		if (this.#refreshing || this.#disposed) return;
		this.#refreshing = true;
		try {
			const [state, contexts] = await Promise.all([
				fetchManagerState(),
				fetchManagerContexts().catch(() => undefined),
			]);
			if (this.#disposed) return;
			this.#state = state;
			this.#contexts = contexts;
			this.#error = undefined;
			if (!this.#selectedId || !state.models.some(model => model.id === this.#selectedId)) {
				this.#selectedId = state.active ?? state.models[0]?.id;
			}
		} catch (error) {
			if (!this.#disposed) this.#error = errorMessage(error);
		} finally {
			this.#refreshing = false;
			if (!this.#disposed) this.#host.requestRender();
		}
	}

	dispose(): void {
		this.#disposed = true;
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data) || matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
			this.#host.close();
			return;
		}
		if (matchesSelectUp(data) || data === "k") {
			this.#move(-1);
			return;
		}
		if (matchesSelectDown(data) || data === "j") {
			this.#move(1);
			return;
		}
		if (matchesKey(data, "enter") || data === "l") {
			this.#track(this.#loadSelected(true));
			return;
		}
		if (data === "s") {
			this.#track(this.#switchSelected());
			return;
		}
		if (data === "u") {
			this.#track(this.#unloadSelected());
			return;
		}
		if (data === "x") {
			this.#track(this.#toggleServer());
			return;
		}
		if (data === "f") {
			this.#track(this.#forceClear());
			return;
		}
		if (data === "r") {
			void this.refresh();
			return;
		}
		if (data === "o") {
			this.#host.openManagerUi();
			return;
		}
		if (data === "p") {
			this.#track(this.#parkSelected());
			return;
		}
		if (data === "d") {
			this.#track(this.#dropParked());
			return;
		}
		if (data === "R") {
			this.#track(this.#restoreParked());
			return;
		}
		if (data === "S") {
			this.#track(this.#toggleSlm());
		}
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "select") {
			this.#selectedId = event.item;
			this.#host.requestRender();
			return;
		}
		if (event.type === "activate") {
			this.#selectedId = event.item;
			this.#track(this.#loadSelected(true));
			return;
		}
		if (event.type !== "action") return;
		switch (event.act) {
			case "load":
				this.#track(this.#loadSelected(true));
				break;
			case "switch":
				this.#track(this.#switchSelected());
				break;
			case "unload":
				this.#track(this.#unloadSelected());
				break;
			case "server":
				this.#track(this.#toggleServer());
				break;
			case "clear":
				this.#track(this.#forceClear());
				break;
			case "refresh":
				void this.refresh();
				break;
			case "open":
				this.#host.openManagerUi();
				break;
			case "close":
				this.#host.close();
				break;
			case "park":
				this.#track(this.#parkSelected());
				break;
			case "drop":
				this.#track(this.#dropParked());
				break;
			case "restore":
				this.#track(this.#restoreParked());
				break;
			case "slm":
				this.#track(this.#toggleSlm());
				break;
		}
	}

	describe(_cx: DescribeContext): NativeNode {
		const state = this.#state;
		if (!state) {
			return col(
				[
					text([span("V100 models", "strong")]),
					text([span(this.#error ?? "Loading the model manager…", this.#error ? "error" : "muted")], {
						wrap: "word",
					}),
					actionBar([
						actionButton("Retry", "refresh", { keys: "r" }),
						actionButton("Manager UI", "open", { keys: "o" }),
						escCloseButton(),
					]),
				],
				{ gap: "sm" },
			);
		}

		const selected = this.#selected();
		const harness = this.#host.session.model;
		const target = state.gpu.target;
		const children: Array<NativeChild | undefined> = [
			row([
				text([span("V100 models", "strong")]),
				text([span(`router :${state.server.router_port}`, state.server.up ? "success" : "error")], {
					wrap: "none",
				}),
				text([span(`ui :${state.server.ui_port}`, "muted")], { wrap: "none" }),
				node("spacer", { grow: 1 }),
				text([span(harness ? `rabid ${harness.provider}/${harness.id}` : "rabid no model", "muted")], {
					wrap: "none",
					truncate: "end",
				}),
			]),
			text([
				span(target?.name ?? "V100", "muted"),
				span(
					target
						? ` ${formatMib(target.used_mib)}/${formatMib(target.total_mib)} (free ${formatMib(
								Math.max(0, target.total_mib - target.used_mib),
							)}) · ${target.util}% util`
						: ` unavailable${state.gpu.error ? `: ${state.gpu.error}` : ""}`,
					"muted",
				),
			]),
			this.#error ? text([span(this.#error, "error")], { wrap: "word" }) : undefined,
			this.#busy ? text([span(this.#busy, "accent")], { wrap: "word" }) : undefined,
			row([
				text([
					span(
						state.slm
							? `SLM worker ${state.slm.loaded ? "ready" : state.slm.running ? "starting" : "stopped"}${state.slm.file ? ` · ${state.slm.file}` : ""}${state.slm.device ? ` · ${state.slm.device}` : ""}`
							: "SLM worker unavailable",
						"muted",
					),
				]),
				node("spacer", { grow: 1 }),
				actionButton(state.slm?.loaded || state.slm?.running ? "Stop SLM" : "Start SLM", "slm"),
			]),
			describeModelList(state.models, selected?.id, model => harnessMatches(this.#host, model.id)),
			selected
				? describeDetail(selected, parkedFor(this.#contexts, selected.id), harnessMatches(this.#host, selected.id))
				: undefined,
			actionBar([
				actionButton("Load & switch", "load", { keys: "enter", tone: "accent" }),
				actionButton("Unload", "unload", { keys: "u", tone: "error" }),
				actionButton(state.server.up ? "Stop router" : "Start router", "server", { keys: "x" }),
				actionButton("Clear VRAM", "clear", { keys: "f", tone: "error" }),
				actionButton("Manager UI", "open", { keys: "o" }),
				actionButton("Refresh", "refresh", { keys: "r" }),
				escCloseButton(),
			]),
		];
		return col(compact(children), { gap: "sm" });
	}

	render(width: number): readonly string[] {
		const state = this.#state;
		const lines: string[] = [];
		if (!state) {
			lines.push(truncateToWidth(" V100 models", width));
			lines.push(truncateToWidth(` ${this.#error ?? "Loading the model manager…"}`, width));
			return lines;
		}
		const harness = this.#host.session.model;
		const target = state.gpu.target;
		lines.push(
			truncateToWidth(
				` V100 models · router :${state.server.router_port} ${state.server.up ? "up" : "down"} · ui :${state.server.ui_port} · omp ${harness ? `${harness.provider}/${harness.id}` : "no model"}`,
				width,
			),
		);
		lines.push(
			truncateToWidth(
				target
					? ` ${target.name} ${formatMib(target.used_mib)}/${formatMib(target.total_mib)} · free ${formatMib(Math.max(0, target.total_mib - target.used_mib))} · ${target.util}% util`
					: ` GPU unavailable${state.gpu.error ? `: ${state.gpu.error}` : ""}`,
				width,
			),
		);
		if (this.#error) lines.push(truncateToWidth(` ${this.#error}`, width));
		if (this.#busy) lines.push(truncateToWidth(` ${this.#busy}`, width));
		const slm = state.slm;
		if (slm) {
			lines.push(
				truncateToWidth(
					` SLM worker ${slm.loaded ? "ready" : slm.running ? "starting" : "stopped"}${slm.file ? ` · ${slm.file}` : ""}${slm.device ? ` · ${slm.device}` : ""}${slm.ctx ? ` · ${slm.ctx} ctx` : ""}  [S]`,
					width,
				),
			);
		}
		lines.push("");

		const selected = this.#selected();
		const models = state.models;
		const selectedIndex = Math.max(
			0,
			models.findIndex(model => model.id === selected?.id),
		);
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(LIST_LINES / 2), models.length - LIST_LINES));
		for (let index = start; index < Math.min(models.length, start + LIST_LINES); index++) {
			const model = models[index]!;
			const marker = model.id === selected?.id ? theme.fg("accent", ">") : " ";
			const harnessMark = harnessMatches(this.#host, model.id) ? " [omp]" : "";
			const line = `${marker} ${model.id}  ${statusWord(model)}${model.active ? " active" : ""}  ${
				model.size_bytes ? formatBytes(model.size_bytes) : "—"
			}  ${model.vram_peak_mib ? `${formatMib(model.vram_peak_mib)} peak` : "peak unknown"}  ${model.engine}${harnessMark}`;
			lines.push(truncateToWidth(line, width));
		}
		if (selected) {
			lines.push("");
			const facts = compact([
				`engine ${selected.engine}`,
				`status ${statusWord(selected)}`,
				selected.context ? `ctx ${selected.context}` : undefined,
				selected.tags?.length ? `tags ${selected.tags.join(",")}` : undefined,
				selected.mmproj ? "vision projector" : undefined,
				!selected.exists ? "file missing" : undefined,
			]);
			lines.push(truncateToWidth(` ${facts.join(" · ")}`, width));
			lines.push(truncateToWidth(` ${selected.path ?? selected.file ?? ""}`, width));
			const parked = parkedFor(this.#contexts, selected.id);
			if (parked) {
				lines.push(
					truncateToWidth(
						` parked ${parked.name}: ${parked.tokens} tokens (${formatBytes(parked.disk_bytes)}, ${parked.on_disk ? "on disk" : "missing"})`,
						width,
					),
				);
			}
		}
		lines.push(
			truncateToWidth(
				" enter load+switch · s switch · u unload · x server · f clear · p park · d drop · R restore · S slm · o manager · r refresh · esc close",
				width,
			),
		);
		return lines;
	}

	#track(task: Promise<void>): void {
		this.#pending = this.#pending.then(
			() => task,
			() => task,
		);
	}

	#selected(): LlamaManagerModel | undefined {
		return this.#state?.models.find(model => model.id === this.#selectedId);
	}

	#move(delta: number): void {
		const models = this.#state?.models;
		if (!models || models.length === 0) return;
		const index = Math.max(
			0,
			models.findIndex(model => model.id === this.#selectedId),
		);
		this.#selectedId = models[Math.max(0, Math.min(models.length - 1, index + delta))]?.id;
		this.#host.requestRender();
	}

	async #loadSelected(switchAfter: boolean): Promise<void> {
		const model = this.#selected();
		if (!model || this.#busy) return;
		if (!model.exists) {
			this.#host.showError(`${model.id}: model file is missing from disk`);
			return;
		}
		if (isModelLoading(model)) {
			this.#host.showStatus(`${model.id} is already loading.`);
			return;
		}
		if (isModelLoaded(model)) {
			if (switchAfter) await this.#switch(model);
			else this.#host.showStatus(`${model.id} is already loaded.`);
			return;
		}
		const resident = activeModel(this.#state);
		if (resident && resident.id !== model.id) {
			const choice = await this.#host.confirm(`Load ${model.id}?`, [`Load (unloads ${resident.id})`, "Cancel"]);
			if (choice !== `Load (unloads ${resident.id})`) return;
		}
		this.#busy = `Loading ${model.id}…`;
		this.#host.requestRender();
		try {
			await loadPreset(model.id, statusText => {
				this.#busy = statusText;
				this.#host.requestRender();
			});
			if (switchAfter) await this.#switch(model);
			else this.#host.showStatus(`Loaded ${model.id}.`);
		} catch (error) {
			this.#host.showError(`Load failed: ${errorMessage(error)}`);
		} finally {
			this.#busy = undefined;
			await this.refresh();
		}
	}

	async #switchSelected(): Promise<void> {
		const model = this.#selected();
		if (!model || this.#busy) return;
		if (!isModelLoaded(model)) {
			await this.#loadSelected(true);
			return;
		}
		await this.#switch(model);
	}

	async #switch(model: LlamaManagerModel): Promise<void> {
		try {
			const target = await switchToLocalModel(this.#host.session, model.id);
			this.#host.showStatus(`rabid is on ${target.provider}/${target.id}.`);
			this.#host.requestRender();
		} catch (error) {
			this.#host.showError(errorMessage(error));
		}
	}

	async #unloadSelected(): Promise<void> {
		const model = this.#selected();
		if (!model || this.#busy) return;
		if (!isModelLoaded(model) && !isModelLoading(model)) {
			this.#host.showStatus(`${model.id} is not loaded.`);
			return;
		}
		if (harnessMatches(this.#host, model.id)) {
			const choice = await this.#host.confirm(`Unload ${model.id}?`, [
				"Unload (the harness stays pointed at it; requests will fail until you load a model)",
				"Cancel",
			]);
			if (choice?.startsWith("Unload") !== true) return;
		}
		this.#busy = `Unloading ${model.id}…`;
		this.#host.requestRender();
		try {
			const result = await unloadPreset(model.id, statusText => {
				this.#busy = statusText;
				this.#host.requestRender();
			});
			this.#host.showStatus(`Unloaded ${model.id}${result.detail ? `; ${result.detail}` : ""}.`);
		} catch (error) {
			this.#host.showError(`Unload failed: ${errorMessage(error)}`);
		} finally {
			this.#busy = undefined;
			await this.refresh();
		}
	}

	async #toggleServer(): Promise<void> {
		const state = this.#state;
		if (!state || this.#busy) return;
		if (state.server.up) {
			const choice = await this.#host.confirm("Stop the llama router?", [
				"Stop server (unloads the resident model)",
				"Cancel",
			]);
			if (choice !== "Stop server (unloads the resident model)") return;
		}
		this.#busy = state.server.up ? "Stopping the router…" : "Starting the router…";
		this.#host.requestRender();
		try {
			const result = await setServerRunning(!state.server.up, statusText => {
				this.#busy = statusText;
				this.#host.requestRender();
			});
			this.#host.showStatus(result.detail ?? (state.server.up ? "Router stopped." : "Router started."));
		} catch (error) {
			this.#host.showError(`Server action failed: ${errorMessage(error)}`);
		} finally {
			this.#busy = undefined;
			await this.refresh();
		}
	}

	async #forceClear(): Promise<void> {
		if (this.#busy) return;
		const choice = await this.#host.confirm("Force-clear the V100?", [
			"Clear VRAM (kills every model engine, including strays)",
			"Cancel",
		]);
		if (choice !== "Clear VRAM (kills every model engine, including strays)") return;
		this.#busy = "Clearing the V100…";
		this.#host.requestRender();
		try {
			const result = await forceClearVram();
			this.#host.showStatus(result.detail ?? "V100 cleared.");
		} catch (error) {
			this.#host.showError(`Force clear failed: ${errorMessage(error)}`);
		} finally {
			this.#busy = undefined;
			await this.refresh();
		}
	}

	async #toggleSlm(): Promise<void> {
		const state = this.#state;
		if (!state || this.#busy) return;
		const slm = state.slm;
		if (slm?.running || slm?.loaded) {
			const choice = await this.#host.confirm("Stop the SLM worker?", ["Stop SLM worker", "Cancel"]);
			if (choice !== "Stop SLM worker") return;
			this.#busy = "Stopping the SLM worker…";
			this.#host.requestRender();
			try {
				this.#host.showStatus((await slmUnload()).detail ?? "SLM worker stopped.");
			} catch (error) {
				this.#host.showError(`SLM stop failed: ${errorMessage(error)}`);
			} finally {
				this.#busy = undefined;
				await this.refresh();
			}
			return;
		}
		const model = slm?.choices?.[0]?.id;
		if (!model) {
			this.#host.showError("No SLM model choices are configured.");
			return;
		}
		this.#busy = `Starting SLM worker ${model}…`;
		this.#host.requestRender();
		try {
			this.#host.showStatus((await slmLoad({ model })).detail ?? `Starting SLM worker ${model}.`);
		} catch (error) {
			this.#host.showError(`SLM start failed: ${errorMessage(error)}`);
		} finally {
			this.#busy = undefined;
			await this.refresh();
		}
	}

	async #parkSelected(): Promise<void> {
		const model = this.#selected();
		if (!model || this.#busy) return;
		if (!isModelLoaded(model)) {
			this.#host.showStatus(`${model.id} must be loaded before its context can be parked.`);
			return;
		}
		this.#busy = `Parking ${model.id} context…`;
		this.#host.requestRender();
		try {
			const context = await parkContext(model.id);
			this.#host.showStatus(`Parked ${context.tokens} tokens as ${context.name}.`);
		} catch (error) {
			this.#host.showError(`Park failed: ${errorMessage(error)}`);
		} finally {
			this.#busy = undefined;
			await this.refresh();
		}
	}

	async #restoreParked(): Promise<void> {
		const model = this.#selected();
		const parked = model ? parkedFor(this.#contexts, model.id) : undefined;
		if (!model || !parked || this.#busy) {
			this.#host.showStatus("No parked context for the selected model.");
			return;
		}
		if (!isModelLoaded(model)) {
			this.#host.showStatus(`${model.id} must be loaded before its context can be restored.`);
			return;
		}
		this.#busy = `Restoring ${parked.name}…`;
		this.#host.requestRender();
		try {
			const context = await restoreContext(parked.name);
			this.#host.showStatus(`Restored ${context.tokens} tokens from ${context.name}.`);
		} catch (error) {
			this.#host.showError(`Restore failed: ${errorMessage(error)}`);
		} finally {
			this.#busy = undefined;
			await this.refresh();
		}
	}

	async #dropParked(): Promise<void> {
		const model = this.#selected();
		const parked = model ? parkedFor(this.#contexts, model.id) : undefined;
		if (!model || !parked || this.#busy) {
			this.#host.showStatus("No parked context for the selected model.");
			return;
		}
		const choice = await this.#host.confirm(`Drop parked context ${parked.name}?`, [
			`Drop ${parked.tokens} tokens`,
			"Cancel",
		]);
		if (choice !== `Drop ${parked.tokens} tokens`) return;
		this.#busy = `Dropping ${parked.name}…`;
		this.#host.requestRender();
		try {
			await dropContext(parked.name);
			this.#host.showStatus(`Dropped parked context ${parked.name}.`);
		} catch (error) {
			this.#host.showError(`Drop failed: ${errorMessage(error)}`);
		} finally {
			this.#busy = undefined;
			await this.refresh();
		}
	}
}

/** The selectable model list, grouped by engine. */
function describeModelList(
	models: readonly LlamaManagerModel[],
	selectedId: string | undefined,
	harnessMatchesModel: (model: LlamaManagerModel) => boolean,
): NativeNode {
	const children: NativeChild[] = [];
	const engines = [...new Set(models.map(model => model.engine))];
	for (const engine of engines) {
		const group = models.filter(model => model.engine === engine);
		if (group.length === 0) continue;
		children.push(
			node(
				"text",
				{
					role: "omp.llama.group",
					spans: [span(ENGINE_LABEL[engine] ?? engine, "muted")],
					wrap: "none",
				},
				undefined,
				`engine-${engine}`,
			),
		);
		for (const model of group) {
			children.push(
				item(model.id, {
					label: compact([
						span(model.id, harnessMatchesModel(model) ? "strong" : undefined),
						span(` ${statusWord(model)}`, statusStyle(model)),
						model.active && span(" active", "success"),
					]),
					value: [
						span(model.size_bytes ? formatBytes(model.size_bytes) : "—", "mono"),
						span(model.vram_peak_mib ? ` ${formatMib(model.vram_peak_mib)} peak` : " peak unknown", "muted"),
					],
					icon: "model",
					tone: statusTone(model),
					title: `${model.id}\n${statusWord(model)} · ${model.engine}${model.active ? " · active" : ""}${harnessMatchesModel(model) ? " · omp model" : ""}`,
					aria: `${model.id}, ${statusWord(model)}${model.active ? ", loaded" : ""}`,
				}),
			);
		}
	}
	return selectList("llama-models", children, { selected: selectedId, max: { lines: LIST_LINES } });
}

/** The selected model's facts and parked context. */
function describeDetail(
	model: LlamaManagerModel,
	parked: LlamaManagerContext | undefined,
	harnessMatch: boolean,
): NativeNode {
	const facts = compact([
		{ k: "Engine", v: [span(model.engine, "mono")] },
		{ k: "Status", v: [span(statusWord(model), statusStyle(model))] },
		{ k: "File", v: [span(model.path ?? model.file ?? "—", "path")] },
		model.size_bytes ? { k: "Size", v: [span(formatBytes(model.size_bytes), "num")] } : undefined,
		model.vram_peak_mib ? { k: "VRAM peak", v: [span(formatMib(model.vram_peak_mib), "num")] } : undefined,
		model.context ? { k: "Context", v: [span(String(model.context), "num")] } : undefined,
		model.tags?.length ? { k: "Tags", v: [span(model.tags.join(", "), "muted")] } : undefined,
		model.mmproj ? { k: "Projector", v: [span(model.mmproj, "path")] } : undefined,
		harnessMatch ? { k: "Harness", v: [span("current model", "success")] } : undefined,
		parked
			? {
					k: "Parked",
					v: [span(`${parked.tokens} tokens · ${formatBytes(parked.disk_bytes)}`, "muted")],
				}
			: undefined,
	]);
	const children: NativeChild[] = [];
	if (facts.length > 0) children.push(node("kv", { items: facts, role: "omp.llama.facts" }));
	if (!model.exists)
		children.push(text([span(`missing file: ${model.path ?? "unknown"}`, "error")], { wrap: "word" }));
	return node("col", { role: "omp.llama.detail" }, children, "detail");
}
