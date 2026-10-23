import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	fetchManagerState,
	formatManagerStatus,
	forceClearVram,
	loadPreset,
	setServerRunning,
	switchToLocalModel,
} from "@oh-my-pi/pi-coding-agent/rabid/llama-manager";
import type { LlamaManagerState } from "@oh-my-pi/pi-coding-agent/rabid/llama-manager";

let manager: ReturnType<typeof Bun.serve>;
let router: ReturnType<typeof Bun.serve>;
let state: LlamaManagerState;
let loads: string[];
let routerIds: string[];
let minimalState: boolean;
let previousManager: string | undefined;
let previousRouter: string | undefined;

const BASE_STATE: LlamaManagerState = {
	server: { up: true, engine: "llama", router_port: 8080, ui_port: 8090 },
	gpu: {
		target: { index: 0, name: "Tesla V100-SXM2-32GB", used_mib: 25_044, total_mib: 32_768, util: 0 },
		devices: [],
	},
	models: [
		{
			id: "alpha",
			engine: "llama",
			status: "loaded",
			active: true,
			failed: false,
			exists: true,
			size_bytes: 16_000_000_000,
			vram_peak_mib: 28_000,
			context: 163_840,
			tags: ["dense"],
		},
		{
			id: "beta",
			engine: "llama",
			status: "unloaded",
			active: false,
			failed: false,
			exists: true,
			size_bytes: 8_000_000_000,
			vram_peak_mib: 12_000,
		},
	],
	active: "alpha",
};

beforeEach(() => {
	state = structuredClone(BASE_STATE);
	loads = [];
	routerIds = ["alpha", "beta"];
	minimalState = false;
	manager = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/api/state") {
				if (minimalState) return Response.json({ models: state.models });
				return Response.json(state);
			}
			if (url.pathname === "/api/load") {
				const body = (await request.json()) as { model: string };
				loads.push(body.model);
				state = {
					...state,
					active: body.model,
					models: state.models.map(model => ({
						...model,
						status: model.id === body.model ? "loaded" : "unloaded",
						active: model.id === body.model,
					})),
				};
				return Response.json({ ok: true, detail: `loading ${body.model}` });
			}
			if (url.pathname === "/api/server/start" || url.pathname === "/api/server/stop") {
				state = { ...state, server: { ...state.server, up: url.pathname.endsWith("start") } };
				return Response.json({ ok: true, detail: url.pathname.endsWith("start") ? "started" : "stopped" });
			}
			if (url.pathname === "/api/vram/force-clear") {
				return Response.json({ ok: true, detail: "cleared 25 GiB" });
			}
			return new Response("not found", { status: 404 });
		},
	});
	router = Bun.serve({
		port: 0,
		fetch: () => Response.json({ data: routerIds.map(id => ({ id })) }),
	});
	previousManager = process.env.RABID_LLAMA_MANAGER;
	previousRouter = process.env.RABID_LLAMA_ROUTER;
	process.env.RABID_LLAMA_MANAGER = `http://127.0.0.1:${manager.port}`;
	process.env.RABID_LLAMA_ROUTER = `http://127.0.0.1:${router.port}`;
});

afterEach(() => {
	manager.stop(true);
	router.stop(true);
	if (previousManager === undefined) delete process.env.RABID_LLAMA_MANAGER;
	else process.env.RABID_LLAMA_MANAGER = previousManager;
	if (previousRouter === undefined) delete process.env.RABID_LLAMA_ROUTER;
	else process.env.RABID_LLAMA_ROUTER = previousRouter;
});

function fakeSession(options?: {
	provider?: string;
	models?: Array<{ provider: string; id: string }>;
	refresh?: (provider: string) => void;
}) {
	const models = options?.models ?? [];
	const setModel = vi.fn(async () => {});
	const session = {
		model: options?.provider ? { provider: options.provider, id: "alpha" } : undefined,
		modelRegistry: {
			getAll: () => models,
			refreshProvider: async (provider: string) => {
				options?.refresh?.(provider);
			},
		},
		setModel,
	} as unknown as AgentSession;
	return { session, setModel, models };
}

describe("llama manager client", () => {
	it("loads a preset when the router is down, letting the manager start it", async () => {
		state = { ...state, server: { ...state.server, up: false } };
		routerIds = [];
		await loadPreset("beta", () => {});
		expect(loads).toEqual(["beta"]);
	});

	it("loads a non-llama engine even when the running router does not list it", async () => {
		state = {
			...state,
			server: { ...state.server, engine: "1cat" },
			models: [
				...state.models,
				{
					id: "vllm",
					engine: "1cat",
					status: "unloaded",
					active: false,
					failed: false,
					exists: true,
				},
			],
		};
		routerIds = ["alpha"];
		await loadPreset("vllm", () => {});
		expect(loads).toEqual(["vllm"]);
	});

	it("refuses a newly added preset while the running router predates it", async () => {
		routerIds = ["alpha"];
		await expect(loadPreset("beta", () => {})).rejects.toThrow("left resident");
		expect(loads).toEqual([]);
	});

	it("starts and stops the router through the manager", async () => {
		expect((await setServerRunning(false, () => {})).detail).toBe("stopped");
		expect(state.server.up).toBe(false);
		expect((await setServerRunning(true, () => {})).detail).toBe("started");
		expect(state.server.up).toBe(true);
	});

	it("force-clears VRAM and reports the manager detail", async () => {
		expect((await forceClearVram()).detail).toBe("cleared 25 GiB");
	});

	it("fills in a missing server block from an older manager", async () => {
		minimalState = true;
		const fetched = await fetchManagerState();
		expect(fetched.server.up).toBe(true);
		expect(fetched.gpu).toEqual({});
	});

	it("prefers the session's current local provider when switching", async () => {
		const models = [
			{ provider: "llama-rabid", id: "alpha" },
			{ provider: "local-llama", id: "alpha" },
		];
		const { session, setModel } = fakeSession({ provider: "local-llama", models });
		const target = await switchToLocalModel(session, "alpha");
		expect(target).toEqual({ provider: "local-llama", id: "alpha" });
		expect(setModel).toHaveBeenCalledWith(models[1]);
	});

	it("honors an explicit provider preference over the session's current provider", async () => {
		const models = [
			{ provider: "local-llama", id: "alpha" },
			{ provider: "llama-rabid", id: "alpha" },
		];
		const { session, setModel } = fakeSession({ provider: "local-llama", models });
		const target = await switchToLocalModel(session, "alpha", "llama-rabid");
		expect(target).toEqual({ provider: "llama-rabid", id: "alpha" });
		expect(setModel).toHaveBeenCalledWith(models[1]);
	});

	it("refreshes local providers once when the model is not in omp's list", async () => {
		const models: Array<{ provider: string; id: string }> = [];
		let refreshes = 0;
		const { session, setModel } = fakeSession({
			models,
			refresh: provider => {
				refreshes++;
				models.push({ provider, id: "beta" });
			},
		});
		const target = await switchToLocalModel(session, "beta");
		expect(refreshes).toBe(2);
		expect(target).toEqual({ provider: "llama-rabid", id: "beta" });
		expect(setModel).toHaveBeenCalledWith(models[0]);
	});

	it("reports the loaded model, GPU, harness model, and parked contexts", () => {
		const report = formatManagerStatus(state, { model: { provider: "llama-rabid", id: "alpha" } } as AgentSession, {
			parking: { resume: true, park_on_idle: true, quiet_seconds: 120 },
			contexts: [
				{
					model: "alpha",
					name: "alpha.auto",
					slot: 0,
					tokens: 8307,
					bytes: 446_310_664,
					disk_bytes: 446_310_664,
					on_disk: true,
				},
			],
		});
		expect(report).toContain("Tesla V100-SXM2-32GB");
		expect(report).toContain("omp: llama-rabid/alpha");
		expect(report).toContain("alpha *  loaded active");
		expect(report).toContain("alpha.auto");
	});
});
