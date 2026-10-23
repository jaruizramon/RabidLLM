import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { BUILTIN_LLAMA_MANAGER_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-llama-manager";
import type { LlamaManagerState } from "@oh-my-pi/pi-coding-agent/rabid/llama-manager";

let manager: ReturnType<typeof Bun.serve>;
let router: ReturnType<typeof Bun.serve>;
let state: LlamaManagerState;
let loads: string[];
let unloads: string[];
let switched: string[];
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
			vram_peak_mib: 28_000,
		},
		{
			id: "beta",
			engine: "llama",
			status: "unloaded",
			active: false,
			failed: false,
			exists: true,
			vram_peak_mib: 12_000,
		},
	],
	active: "alpha",
};

function runtime(output: string[]): {
	session: AgentSession;
	settings: ReturnType<typeof Settings.isolated>;
	output: (text: string) => void;
	refreshCommands: () => void;
	reloadPlugins: () => Promise<void>;
} {
	return {
		session: session(),
		settings: Settings.isolated(),
		output: (text: string) => {
			output.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
}

const command = BUILTIN_LLAMA_MANAGER_SLASH_COMMANDS[0]!;

function session(): AgentSession {
	return {
		model: { provider: "local-llama", id: "alpha" },
		modelRegistry: {
			getAll: () => [
				{ provider: "local-llama", id: "alpha" },
				{ provider: "local-llama", id: "beta" },
				{ provider: "llama-rabid", id: "beta" },
			],
			refreshProvider: async () => {},
		},
		setModel: async (model: { provider: string; id: string }) => {
			switched.push(`${model.provider}/${model.id}`);
		},
	} as unknown as AgentSession;
}

beforeEach(() => {
	state = structuredClone(BASE_STATE);
	loads = [];
	unloads = [];
	switched = [];
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

describe("/llama", () => {
	it("opens the manager sheet from the TUI", async () => {
		const showLlamaManager = vi.fn();
		const ctx = { showLlamaManager } as unknown as InteractiveModeContext;
		expect(await executeBuiltinSlashCommand("/llama", { ctx })).toBe(true);
		expect(showLlamaManager).toHaveBeenCalledTimes(1);
	});

	it("loads a preset and switches the session to the current provider's model", async () => {
		const output: string[] = [];
		await command.handle!({ name: "llama", args: "load beta", text: "/llama load beta" }, runtime(output) as never);
		expect(loads).toEqual(["beta"]);
		expect(switched).toEqual(["local-llama/beta"]);
		expect(output.join("\n")).toContain("omp is on local-llama/beta");
	});

	it("unloads the active model when no id is named", async () => {
		const output: string[] = [];
		await command.handle!({ name: "llama", args: "unload", text: "/llama unload" }, runtime(output) as never);
		expect(unloads).toEqual(["alpha"]);
		expect(output.join("\n")).toContain("Unloaded alpha");
	});

	it("reports model state through the text host", async () => {
		const output: string[] = [];
		await command.handle!({ name: "llama", args: "status", text: "/llama status" }, runtime(output) as never);
		const report = output.join("\n");
		expect(report).toContain("alpha");
		expect(report).toContain("beta");
		expect(report).toContain("omp: local-llama/alpha");
	});
});
