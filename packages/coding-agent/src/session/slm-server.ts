/**
 * CPU llama-server supervisor for the background SLM handoff worker.
 *
 * The V100 router admits one resident model at a time, so the worker gets its
 * own stock `llama-server` process pinned to a fraction of the logical CPUs —
 * loading it through the router would evict the main GPU model. One process is
 * shared by every session; {@link SlmHandoffServer.ensure} serializes starts so
 * concurrent turns cannot double-spawn.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import { $which, isEnoent, logger } from "@oh-my-pi/pi-utils";

/** Where the worker's llama-server runs. */
export interface SlmDevice {
	kind: "cpu" | "cuda";
	/** `CUDA_VISIBLE_DEVICES` index; undefined lets the driver pick the first visible GPU. */
	index?: number;
}

/**
 * Parse `compaction.slmHandoff.device`. `cpu` blanks every GPU backend so the
 * worker cannot touch the inference or display card; `cuda` lets the driver pick;
 * `cuda:N` pins the Nth GPU under `CUDA_DEVICE_ORDER=PCI_BUS_ID` (the rig's
 * `llama-server` wrapper uses the same order, so N matches `nvidia-smi -L` here).
 */
export function parseSlmDevice(value: string): SlmDevice | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "cpu") return { kind: "cpu" };
	if (normalized === "cuda") return { kind: "cuda" };
	const pinned = /^cuda:(\d+)$/.exec(normalized);
	if (!pinned) return undefined;
	const index = Number(pinned[1]);
	return Number.isSafeInteger(index) ? { kind: "cuda", index } : undefined;
}

/** Everything the worker needs to serve one handoff run. */
export interface SlmServerConfig {
	serverPath: string;
	modelPath: string;
	ctxSize: number;
	threads: number;
	reasoningBudgetTokens: number;
	maxInputTokens: number;
	maxHandoffTokens: number;
	device: SlmDevice;
	gpuLayers: number;
	/** VRAM (MiB) to leave free on the worker's card; -1 offloads exactly `gpuLayers`. */
	gpuFreeMiB: number;
}

export interface SlmServerStatus {
	running: boolean;
	pid?: number;
	port?: number;
	modelPath?: string;
	ctxSize?: number;
	threads?: number;
	reasoningBudgetTokens?: number;
	/** `cpu`, `cuda`, or `cuda:N`. */
	device?: string;
	gpuLayers?: number;
	uptimeMs?: number;
}

export interface SlmCompletionResult {
	document: string;
	formatFallback: boolean;
	truncated: boolean;
	inputTokens: number;
	outputTokens: number;
}

/** Chat-completions body sent to the worker. Exported for the request seam. */
export interface SlmCompletionRequest {
	model: string;
	messages: { role: "system" | "user"; content: string }[];
	temperature: number;
	top_p: number;
	max_tokens: number;
	cache_prompt: boolean;
	stream: boolean;
	stop: string[];
	reasoning_budget_tokens: number;
	chat_template_kwargs: { enable_thinking: boolean };
}

/** Server alias for whichever GGUF the worker loaded; only spawn and request must agree. */
const SLM_MODEL_ALIAS = "slm-worker";
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 100;
const SPAWN_ATTEMPTS = 3;
const STOP_GRACE_MS = 3_000;
const COMPLETION_TIMEOUT_MS = 600_000;
const STDERR_TAIL_LIMIT = 64 * 1024;
const ERROR_BODY_LIMIT = 2_000;
/**
 * Floor for a usable weight file: enough to reject an empty or half-written
 * file, deliberately not enough to assume a model size — a 0.5B Q4 GGUF is
 * ~0.4 GB, so any larger floor would refuse a legitimate small model.
 */
const MIN_MODEL_BYTES = 1 << 20;
/** The one GGUF `/models-worker` can fetch by itself; any other path must be supplied. */
const DEFAULT_MODEL_FILE = "SmolLM3-Q4_K_M.gguf";
const DEFAULT_MODEL_REPO = "ggml-org/SmolLM3-3B-GGUF";
/** Prompt-token slack added on top of the thinking budget and handoff cap. */
const MAX_TOKENS_SLACK = 256;

/**
 * Free loopback port drawn from the kernel's ephemeral range. Never returns a
 * reserved port: 8080/8090 belong to the llama.cpp router and model manager,
 * 37900 to the Laya bridge.
 */
function allocateLoopbackPort(): number {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 204 }) });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("Could not allocate a loopback port for the SLM worker");
	return port;
}

/**
 * Physical-core siblings for the lowest cores, up to `threads` logical CPUs.
 *
 * SMT siblings share an execution core, so spreading a small worker over
 * physical cores instead of sibling threads buys more throughput per percent of
 * total CPU. Returns undefined when sysfs is unreadable (macOS, containers),
 * leaving `--threads` alone — that flag already caps total CPU.
 */
async function resolveCpuMask(threads: number): Promise<string | undefined> {
	const root = "/sys/devices/system/cpu";
	let entries: string[];
	try {
		entries = await fs.readdir(root);
	} catch {
		return undefined;
	}
	const groups: { core: number; ids: number[] }[] = [];
	for (const entry of entries) {
		const match = /^cpu(\d+)$/.exec(entry);
		if (!match) continue;
		let siblings: string;
		try {
			siblings = await fs.readFile(path.join(root, entry, "topology", "thread_siblings_list"), "utf8");
		} catch {
			return undefined;
		}
		const ids = siblings
			.trim()
			.split(",")
			.flatMap(range => {
				const [from, to] = range.split("-").map(Number);
				if (!Number.isFinite(from)) return [];
				if (to === undefined || !Number.isFinite(to)) return [from];
				const span: number[] = [];
				for (let value = from; value <= to; value++) span.push(value);
				return span;
			})
			.sort((a, b) => a - b);
		if (ids.length === 0) return undefined;
		const core = ids[0]!;
		const existing = groups.find(group => group.core === core);
		if (existing) continue;
		groups.push({ core, ids });
	}
	if (groups.length === 0) return undefined;
	groups.sort((a, b) => a.core - b.core);
	const selected: number[] = [];
	const cores = Math.max(1, Math.ceil(threads / 2));
	for (const group of groups.slice(0, cores)) {
		for (const id of group.ids) {
			if (selected.length < threads) selected.push(id);
		}
	}
	if (selected.length === 0) return undefined;
	let mask = 0n;
	for (const id of selected) mask |= 1n << BigInt(id);
	return `0x${mask.toString(16)}`;
}

/**
 * POST one chat completion to an already-running worker and normalize the
 * answer. Kept free of process state so tests can drive it against a fake
 * endpoint.
 */
export async function requestSlmCompletion(
	baseUrl: string,
	request: SlmCompletionRequest,
	signal: AbortSignal,
): Promise<SlmCompletionResult> {
	let result = await postCompletion(baseUrl, request, signal);
	if (result.document === "" && !signal.aborted) {
		// One deterministic retry: a sampler that emitted nothing usable once
		// usually does the same at temperature 0, and a second empty answer is a
		// hard failure the caller can fall back from.
		result = await postCompletion(baseUrl, { ...request, temperature: 0 }, signal);
	}
	if (result.document === "") throw new Error("SLM worker returned no handoff document");
	return result;
}

async function postCompletion(
	baseUrl: string,
	request: SlmCompletionRequest,
	signal: AbortSignal,
): Promise<SlmCompletionResult> {
	const response = await fetch(`${baseUrl}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
		signal,
	});
	if (!response.ok) {
		const body = (await response.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT);
		throw new Error(`SLM worker HTTP ${response.status}: ${body}`);
	}
	const payload = (await response.json()) as {
		choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
		usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
	};
	const choice = payload.choices?.[0];
	const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
	const usage = payload.usage;
	return {
		...normalizeSlmOutput(content),
		truncated: choice?.finish_reason === "length",
		inputTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0,
		outputTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0,
	};
}

/**
 * Normalize raw worker text into the handoff document.
 *
 * `reasoning_content` is ignored entirely: thinking is scratch space, and only
 * the answer after the last `</think>` is a document. Missing headings are
 * tolerated by wrapping the text, because a handoff with prose beats no handoff
 * at all; an empty result is the caller's signal to retry.
 */
export function normalizeSlmOutput(content: string): { document: string; formatFallback: boolean } {
	let text = content;
	const lastThinkClose = text.lastIndexOf("</think>");
	if (lastThinkClose !== -1) text = text.slice(lastThinkClose + "</think>".length);
	text = text.trim();
	const fence = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/;
	const fenced = fence.exec(text);
	if (fenced?.[1] !== undefined) text = fenced[1].trim();
	const heading = text.indexOf("## ");
	let formatFallback = false;
	if (heading > 0) text = text.slice(heading).trim();
	else if (heading === -1 && text !== "") {
		text = `## Handoff\n\n${text}`;
		formatFallback = true;
	}
	// A partially framed answer (prose, then a fence) leaves its closing marker
	// behind once the preamble is gone.
	if (text.endsWith("```")) text = text.slice(0, -3).trim();
	if (text === "") return { document: "", formatFallback: false };
	return { document: `${text.replace(/\s+$/, "")}\n`, formatFallback };
}

/**
 * Ensure the worker GGUF exists, downloading it once through the `hf` CLI.
 * Background runs never download; only `/models-worker` calls this.
 */
export async function ensureSlmModelDownloaded(modelPath: string, output?: (text: string) => void): Promise<void> {
	if (await isCompleteModelFile(modelPath)) return;
	const fileName = path.basename(modelPath);
	if (fileName !== DEFAULT_MODEL_FILE) {
		throw new Error(
			`Model file missing: ${modelPath}. Download it first (hf download <repo> ${fileName} --local-dir ${path.dirname(modelPath)}) and rerun /models-worker`,
		);
	}
	const hf = $which("hf");
	if (!hf) {
		throw new Error("hf CLI not found; install with pip install -U huggingface_hub, then rerun /models-worker");
	}
	output?.("Downloading SmolLM3-3B Q4_K_M (~1.9 GB)…");
	const child = Bun.spawn(
		[hf, "download", DEFAULT_MODEL_REPO, DEFAULT_MODEL_FILE, "--local-dir", path.dirname(modelPath), "--quiet"],
		{ stdout: "ignore", stderr: "pipe" },
	);
	// Read stderr while the child runs: a full pipe would block the download.
	const stderrText = new Response(child.stderr as ReadableStream<Uint8Array>).text().catch(() => "");
	const code = await child.exited;
	if (code !== 0) {
		const detail = (await stderrText).slice(-ERROR_BODY_LIMIT);
		throw new Error(`hf download failed (exit ${code}): ${detail.trim()}`);
	}
	await stderrText;
	if (!(await isCompleteModelFile(modelPath))) {
		throw new Error(`Model not found after download: ${modelPath}`);
	}
}

async function isCompleteModelFile(modelPath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(modelPath);
		return stat.size >= MIN_MODEL_BYTES;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/**
 * Offload flags for the worker.
 *
 * A GPU worker with a headroom budget lets llama.cpp pick the layer count that
 * keeps `gpuFreeMiB` VRAM free (`--fit`), instead of filling the card — on a
 * gaming rig, filling it evicts the compositor and the game. `--fit-ctx` pins
 * the context so a fit cannot silently shrink it. An explicit `gpuLayers` (>= 0)
 * and the CPU device keep exact control and skip fitting entirely.
 */
export function slmOffloadArgs(
	config: Pick<SlmServerConfig, "device" | "gpuLayers" | "gpuFreeMiB" | "ctxSize">,
): string[] {
	if (config.device.kind === "cpu" || config.gpuFreeMiB < 0) {
		return ["--n-gpu-layers", String(config.gpuLayers)];
	}
	return [
		"--n-gpu-layers",
		"auto",
		"--fit",
		"on",
		"--fit-target",
		String(config.gpuFreeMiB),
		"--fit-ctx",
		String(config.ctxSize),
	];
}

/** One supervised stock `llama-server` on the CPU. */
export class SlmHandoffServer {
	static #instance: SlmHandoffServer | undefined;

	static global(): SlmHandoffServer {
		return (SlmHandoffServer.#instance ??= new SlmHandoffServer());
	}

	#child: Bun.Subprocess | undefined;
	#config: SlmServerConfig | undefined;
	#port: number | undefined;
	#startedAt = 0;
	#stderrTail = "";
	#ensureChain: Promise<void> = Promise.resolve();
	/** Set by `/models-worker`: keep the process alive across idle turns. */
	#manualHold = false;
	#exitHookInstalled = false;

	status(): SlmServerStatus {
		const config = this.#config;
		if (!config || !this.#child || this.#child.exitCode !== null) return { running: false };
		return {
			running: true,
			pid: this.#child.pid,
			port: this.#port,
			modelPath: config.modelPath,
			ctxSize: config.ctxSize,
			threads: config.threads,
			reasoningBudgetTokens: config.reasoningBudgetTokens,
			device:
				config.device.index === undefined ? config.device.kind : `${config.device.kind}:${config.device.index}`,
			gpuLayers: config.gpuLayers,
			uptimeMs: this.#startedAt === 0 ? undefined : Date.now() - this.#startedAt,
		};
	}

	/** Start (or reuse) the worker and return its live status. Serialized. */
	async ensure(config: SlmServerConfig): Promise<SlmServerStatus> {
		const run = this.#ensureChain.then(
			() => this.#ensureLocked(config),
			() => this.#ensureLocked(config),
		);
		this.#ensureChain = run.then(
			() => {},
			() => {},
		);
		return await run;
	}

	/**
	 * `/models-worker` entry point: optionally download the GGUF, start the
	 * worker, and hold it against idle teardown.
	 */
	async preload(
		config: SlmServerConfig,
		options: { download?: boolean; output?: (text: string) => void } = {},
	): Promise<SlmServerStatus> {
		this.#manualHold = true;
		try {
			if (options.download !== false) await ensureSlmModelDownloaded(config.modelPath, options.output);
			return await this.ensure(config);
		} catch (error) {
			this.#manualHold = false;
			throw error;
		}
	}

	/** One handoff run against the worker, starting it on demand. */
	async complete(
		config: SlmServerConfig,
		system: string,
		user: string,
		signal?: AbortSignal,
	): Promise<SlmCompletionResult> {
		const status = await this.ensure(config);
		if (status.port === undefined) throw new Error("SLM worker has no port");
		const request: SlmCompletionRequest = {
			model: SLM_MODEL_ALIAS,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			temperature: 0.2,
			top_p: 0.95,
			max_tokens: config.reasoningBudgetTokens + config.maxHandoffTokens + MAX_TOKENS_SLACK,
			cache_prompt: false,
			stream: false,
			stop: ["<|im_end|>"],
			reasoning_budget_tokens: config.reasoningBudgetTokens,
			chat_template_kwargs: { enable_thinking: config.reasoningBudgetTokens > 0 },
		};
		const startedAt = Date.now();
		const timeout = AbortSignal.timeout(COMPLETION_TIMEOUT_MS);
		const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const result = await requestSlmCompletion(`http://127.0.0.1:${status.port}`, request, requestSignal);
		logger.debug("SLM handoff run complete", {
			port: status.port,
			durationMs: Date.now() - startedAt,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			truncated: result.truncated,
			formatFallback: result.formatFallback,
		});
		return result;
	}

	/** Drop the manual hold and release the process unless `/models-worker` holds it. */
	async release(): Promise<void> {
		if (this.#manualHold) return;
		await this.#stop();
	}

	/** `/models-worker unload`: drop the hold and stop the process unconditionally. */
	async unload(): Promise<void> {
		this.#manualHold = false;
		await this.#stop();
	}

	async #ensureLocked(config: SlmServerConfig): Promise<SlmServerStatus> {
		const current = this.#config;
		if (current && this.#child && this.#child.exitCode === null) {
			const reusable =
				current.modelPath === config.modelPath &&
				current.threads === config.threads &&
				current.reasoningBudgetTokens === config.reasoningBudgetTokens &&
				current.ctxSize >= config.ctxSize &&
				current.device.kind === config.device.kind &&
				current.device.index === config.device.index &&
				current.gpuLayers === config.gpuLayers &&
				current.gpuFreeMiB === config.gpuFreeMiB;
			if (reusable) {
				this.#config = { ...current, ...config, ctxSize: current.ctxSize };
				return this.status();
			}
			await this.#stop();
		}
		this.#installExitHook();
		let lastError: unknown;
		for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
			try {
				await this.#spawn(config);
				return this.status();
			} catch (error) {
				lastError = error;
				await this.#stop();
				logger.warn("SLM worker start attempt failed", {
					attempt: attempt + 1,
					attempts: SPAWN_ATTEMPTS,
					error: String(error),
				});
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	async #spawn(config: SlmServerConfig): Promise<void> {
		const port = allocateLoopbackPort();
		const onCpu = config.device.kind === "cpu";
		// Pin `--cpu-mask` only for CPU inference: on a GPU the affinity of aux
		// threads buys nothing and can slow sampling.
		const mask = onCpu && process.platform === "linux" ? await resolveCpuMask(config.threads) : undefined;
		const args = [
			config.serverPath,
			"--model",
			config.modelPath,
			"--alias",
			SLM_MODEL_ALIAS,
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--ctx-size",
			String(config.ctxSize),
			...slmOffloadArgs(config),
			"--threads",
			String(config.threads),
			"--threads-batch",
			String(config.threads),
			...(mask === undefined ? [] : ["--cpu-mask", mask, "--cpu-mask-batch", mask]),
			"--parallel",
			"1",
			"--cache-type-k",
			"q8_0",
			"--cache-type-v",
			"q8_0",
			// This build (b11026+) replaced `--no-mmap` with `--load-mode`; `none` keeps
			// the weights fully resident instead of paging them in on demand.
			"--load-mode",
			"none",
			"--jinja",
			"--no-webui",
			"--reasoning-format",
			"auto",
			"--reasoning-budget",
			String(config.reasoningBudgetTokens),
			"--log-colors",
			"off",
		];
		this.#stderrTail = "";
		// `CUDA_DEVICE_ORDER=PCI_BUS_ID` makes `cuda:N` match `nvidia-smi -L` order
		// and the rig's own llama-server wrapper. `cpu` blanks every GPU backend so
		// the worker can never take memory from the inference or display card.
		const child = Bun.spawn(args, {
			env: {
				...process.env,
				CUDA_DEVICE_ORDER: "PCI_BUS_ID",
				CUDA_VISIBLE_DEVICES: onCpu ? "" : String(config.device.index ?? 0),
				HIP_VISIBLE_DEVICES: "",
				ROCR_VISIBLE_DEVICES: "",
			},
			stdout: "ignore",
			stderr: "pipe",
			stdin: "ignore",
		});
		void this.#drainStderr(child.stderr as ReadableStream<Uint8Array>);
		// Own the process from the moment it exists, not from readiness: a session
		// that exits while the weights are still loading would otherwise leave this
		// child with no owner at all (measured: an orphaned worker holding 5.7 GB).
		this.#child = child;
		try {
			await this.#waitForReady(child, port);
		} catch (error) {
			child.kill("SIGKILL");
			this.#child = undefined;
			throw error;
		}
		this.#config = config;
		this.#port = port;
		this.#startedAt = Date.now();
		logger.info("SLM handoff worker ready", {
			port,
			pid: child.pid,
			ctxSize: config.ctxSize,
			threads: config.threads,
			modelPath: config.modelPath,
		});
	}

	async #waitForReady(child: Bun.Subprocess, port: number): Promise<void> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		for (;;) {
			if (child.exitCode !== null) {
				throw new Error(`llama-server exited before readiness: ${this.#stderrTail.trim()}`);
			}
			if (Date.now() > deadline) {
				throw new Error(
					`llama-server did not become ready within ${READY_TIMEOUT_MS}ms: ${this.#stderrTail.trim()}`,
				);
			}
			try {
				const response = await fetch(`http://127.0.0.1:${port}/health`);
				if (response.ok) return;
			} catch {
				// Still binding, or not listening yet.
			}
			await Bun.sleep(READY_POLL_MS);
		}
	}

	async #drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		try {
			for await (const line of readLines(stream)) {
				this.#stderrTail = `${this.#stderrTail}${new TextDecoder().decode(line)}\n`.slice(-STDERR_TAIL_LIMIT);
			}
		} catch {
			// The pipe closes when the process dies; the tail is already captured.
		}
	}

	async #stop(): Promise<void> {
		const child = this.#child;
		this.#child = undefined;
		this.#config = undefined;
		this.#port = undefined;
		this.#startedAt = 0;
		if (!child || child.exitCode !== null) return;
		child.kill("SIGINT");
		const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
		if (!exited && child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}

	#installExitHook(): void {
		if (this.#exitHookInstalled) return;
		this.#exitHookInstalled = true;
		process.once("exit", () => {
			const child = this.#child;
			if (child && child.exitCode === null) child.kill("SIGKILL");
		});
	}
}
