import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { LlamaManagerSheet, type LlamaManagerSheetHost } from "@oh-my-pi/pi-coding-agent/rabid/llama-manager-sheet";
import type { LlamaManagerState } from "@oh-my-pi/pi-coding-agent/rabid/llama-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

let manager: ReturnType<typeof Bun.serve>;
let router: ReturnType<typeof Bun.serve>;
let state: LlamaManagerState;
let unloads: string[];
let setModel: ReturnType<typeof vi.fn>;
let previousManager: string | undefined;
let previousRouter: string | undefined;

const BASE_STATE: LlamaManagerState = {
	server: { up: true, engine: "llama", router_port: 8080, ui_port: 8090 },
	gpu: {
		target: { index: 0, name: "Tesla V100-SXM2-32GB", used_mib: 25_044, total_mib: 32_768, util: 0 },
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

const textOf = (rows: readonly string[]): string => Bun.stripANSI(rows.join("\n"));

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	state = structuredClone(BASE_STATE);
	unloads = [];
	setModel = vi.fn(async () => {});
	manager = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/api/state") return Response.json(state);
			if (url.pathname === "/api/contexts") {
				return Response.json({
					parking: { resume: true, park_on_idle: true, quiet_seconds: 120 },
					contexts: [],
				});
			}
			if (url.pathname === "/api/load") {
				const body = (await request.json()) as { model: string };
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
			if (url.pathname === "/api/unload") {
				const body = (await request.json()) as { model: string };
				unloads.push(body.model);
				state = {
					...state,
					active: undefined,
					models: state.models.map(model => ({ ...model, status: "unloaded", active: false })),
				};
				return Response.json({ ok: true, detail: `unloaded ${body.model}` });
			}
			return new Response("ok");
		},
	});
	router = Bun.serve({
		port: 0,
		fetch: () => Response.json({ data: [{ id: "alpha" }, { id: "beta" }] }),
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

function host(): { value: LlamaManagerSheetHost; closed: () => number; errors: string[] } {
	const errors: string[] = [];
	let closed = 0;
	const session = {
		model: { provider: "llama-rabid", id: "alpha" },
		modelRegistry: {
			getAll: () => [
				{ provider: "llama-rabid", id: "alpha" },
				{ provider: "llama-rabid", id: "beta" },
			],
			refreshProvider: async () => {},
		},
		setModel,
	} as unknown as AgentSession;
	return {
		value: {
			session,
			requestRender: () => {},
			close: () => {
				closed++;
			},
			showStatus: () => {},
			showError: text => errors.push(text),
			confirm: async (_title, options) => options[0],
			openManagerUi: () => {},
		},
		closed: () => closed,
		errors,
	};
}

describe("LlamaManagerSheet", () => {
	it("lists live models, switches the selection, loads and unloads", async () => {
		const h = host();
		const sheet = new LlamaManagerSheet(h.value);
		await sheet.ready;

		const initial = textOf(sheet.render(100));
		expect(initial).toContain("alpha");
		expect(initial).toContain("loaded");
		expect(initial).toContain("beta");
		expect(initial).toContain("unloaded");

		sheet.handleInput("j");
		expect(textOf(sheet.render(100))).toContain("> beta");

		sheet.handleInput("s");
		await sheet.idle;
		expect(setModel).toHaveBeenCalledWith({ provider: "llama-rabid", id: "beta" });

		sheet.handleInput("u");
		await sheet.idle;
		expect(unloads).toEqual(["beta"]);

		sheet.handleInput("q");
		expect(h.closed()).toBe(1);
		sheet.dispose();
	});

	it("shows a retry path when the manager is unreachable", async () => {
		manager.stop(true);
		const h = host();
		const sheet = new LlamaManagerSheet(h.value);
		await sheet.ready;
		const text = textOf(sheet.render(100));
		expect(text).toContain("V100 models");
		expect(text.length).toBeGreaterThan(0);
		sheet.dispose();
	});
});
