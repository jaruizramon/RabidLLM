/**
 * `/preset` routes load/unload through llama-manager, refuses a preset the
 * running router does not know (so the resident model is never evicted behind
 * the user's back), and keeps `reload` to omp's model list only.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRabidMode } from "@oh-my-pi/pi-coding-agent/rabid/rabid-modes";
import { BUILTIN_LLAMA_PRESET_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/rabid/llama-preset-command";
import type {
	ParsedSlashCommand,
	SlashCommandRuntime,
	TuiSlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/types";

interface Preset {
	id: string;
	status: string;
	exists: boolean;
	engine: string;
}

let manager: ReturnType<typeof Bun.serve>;
let router: ReturnType<typeof Bun.serve>;
let presets: Preset[];
let loads: string[];
let unloads: string[];
let restarts: string[];
let routerIds: string[];
let output: string[];
let switched: string[];
let refreshed: string[];
let previousManager: string | undefined;
let previousRouter: string | undefined;

const command = BUILTIN_LLAMA_PRESET_SLASH_COMMANDS[0]!;

function runtime(): SlashCommandRuntime {
	return {
		session: {
			modelRegistry: {
				getAll: () => [{ provider: "llama-rabid", id: "rabid-deep" }],
				refreshProvider: async (provider: string) => {
					refreshed.push(provider);
				},
			},
			setModel: async (model: { provider: string; id: string }) => {
				switched.push(`${model.provider}/${model.id}`);
			},
		},
		settings: Settings.isolated(),
		output: (text: string) => {
			output.push(text);
		},
	} as unknown as SlashCommandRuntime;
}

function run(args: string) {
	return command.handle!({ name: "preset", args, text: `/preset ${args}` } as ParsedSlashCommand, runtime());
}

beforeEach(() => {
	presets = [{ id: "rabid-deep", status: "unloaded", exists: true, engine: "llama" }];
	loads = [];
	unloads = [];
	restarts = [];
	routerIds = ["rabid-deep"];
	output = [];
	switched = [];
	refreshed = [];
	manager = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/api/state") return Response.json({ models: presets });
			if (url.pathname === "/api/load") {
				const body = (await request.json()) as { model: string };
				loads.push(body.model);
				presets = presets.map(p => (p.id === body.model ? { ...p, status: "loaded" } : p));
				return Response.json({ ok: true });
			}
			if (url.pathname === "/api/server/stop" || url.pathname === "/api/server/start") {
				restarts.push(url.pathname);
				return Response.json({ ok: true });
			}
			if (url.pathname === "/api/unload") {
				const body = (await request.json()) as { model: string };
				unloads.push(body.model);
				presets = presets.map(p => (p.id === body.model ? { ...p, status: "unloaded" } : p));
				return Response.json({ ok: true });
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

describe("/preset", () => {
	it("loads through the manager once the router knows the preset, then switches omp", async () => {
		await run("load rabid-deep");
		expect(loads).toEqual(["rabid-deep"]);
		expect(switched).toEqual(["llama-rabid/rabid-deep"]);
		expect(output.join("\n")).toContain("Loaded rabid-deep");
	});

	it("refuses a preset the running router does not know instead of evicting the resident model", async () => {
		routerIds = [];
		await run("load rabid-deep");
		expect(loads).toEqual([]);
		expect(switched).toEqual([]);
		expect(output.join("\n")).toContain("left resident");
		expect(output.join("\n")).toContain("/preset restart");
	});

	it("unloads through the manager and parks the context", async () => {
		presets = [{ id: "rabid-deep", status: "loaded", exists: true, engine: "llama" }];
		await run("unload rabid-deep");
		expect(unloads).toEqual(["rabid-deep"]);
		expect(output.join("\n")).toContain("parked");
	});

	it("reloads only omp's model list, leaving the server and resident model untouched", async () => {
		await run("reload");
		expect(refreshed).toEqual(["llama-rabid"]);
		expect(loads).toEqual([]);
		expect(unloads).toEqual([]);
		expect(output.join("\n")).toContain("left resident");
	});

	it("restarts the router to re-read models.ini and refreshes omp's list", async () => {
		await run("restart");
		expect(restarts).toEqual(["/api/server/stop", "/api/server/start"]);
		expect(refreshed).toEqual(["llama-rabid"]);
		expect(output.join("\n")).toContain("Router restarted");
	});

	it("offers the three modes, then the local models without the rabid bundles", async () => {
		presets = [
			{ id: "qwen3.8-27b", status: "loaded", exists: true, engine: "llama" },
			{ id: "rabid-deep", status: "unloaded", exists: true, engine: "llama" },
			{ id: "rabid-balanced", status: "unloaded", exists: true, engine: "llama" },
			{ id: "rabid-fast", status: "unloaded", exists: true, engine: "llama" },
		];
		const offered: Array<{ title: string; labels: string[] }> = [];
		const tui = {
			ctx: {
				settings: Settings.isolated(),
				session: {
					modelRegistry: { getAll: () => [] },
					setModel: async () => {},
				},
				showHookSelector: async (title: string, labels: string[]) => {
					offered.push({ title, labels });
					return title === "Rabid mode" ? labels[0] : undefined;
				},
				showStatus: () => {},
				showError: (text: string) => output.push(text),
				statusLine: { invalidate: () => {} },
			},
		} as unknown as TuiSlashCommandRuntime;

		await command.handleTui!({ name: "preset", args: "", text: "/preset" }, tui);

		expect(offered[0]).toEqual({ title: "Rabid mode", labels: ["fast mode", "balanced mode", "deep mode"] });
		expect(offered[1]?.title).toBe("Apply fast to which model?");
		expect(offered[1]?.labels).toEqual(["qwen3.8-27b (loaded)"]);
	});

	it("applies the mode to the chosen loaded model after confirmation", async () => {
		presets = [
			{ id: "qwen3.8-27b", status: "loaded", exists: true, engine: "llama" },
			{ id: "rabid-deep", status: "unloaded", exists: true, engine: "llama" },
		];
		const picks: Array<string | undefined> = ["fast mode", "qwen3.8-27b (loaded)", "Apply (Enter)"];
		const statuses: string[] = [];
		const settings = Settings.isolated();
		const tui = {
			ctx: {
				settings,
				session: {
					modelRegistry: { getAll: () => [{ provider: "llama-rabid", id: "qwen3.8-27b" }] },
					setModel: async (model: { provider: string; id: string }) => {
						switched.push(`${model.provider}/${model.id}`);
					},
				},
				showHookSelector: async () => picks.shift(),
				showStatus: (text: string) => statuses.push(text),
				showError: (text: string) => output.push(text),
				statusLine: { invalidate: () => {} },
			},
		} as unknown as TuiSlashCommandRuntime;

		await command.handleTui!({ name: "preset", args: "", text: "/preset" }, tui);

		expect(picks).toHaveLength(0);
		expect(loads).toEqual([]);
		expect(switched).toEqual(["llama-rabid/qwen3.8-27b"]);
		expect(cfgRabidMode.get(settings)).toBe("fast");
		expect(statuses.join("\n")).toContain("Applied fast to qwen3.8-27b");
	});

	it("does not change the mode or model when confirmation is dismissed", async () => {
		presets = [{ id: "qwen3.8-27b", status: "loaded", exists: true, engine: "llama" }];
		const picks: Array<string | undefined> = ["balanced mode", "qwen3.8-27b (loaded)", undefined];
		const settings = Settings.isolated();
		const tui = {
			ctx: {
				settings,
				session: {
					modelRegistry: { getAll: () => [{ provider: "llama-rabid", id: "qwen3.8-27b" }] },
					setModel: async () => {
						switched.push("unexpected");
					},
				},
				showHookSelector: async () => picks.shift(),
				showStatus: () => {},
				showError: (text: string) => output.push(text),
				statusLine: { invalidate: () => {} },
			},
		} as unknown as TuiSlashCommandRuntime;

		await command.handleTui!({ name: "preset", args: "", text: "/preset" }, tui);

		expect(loads).toEqual([]);
		expect(switched).toEqual([]);
		expect(cfgRabidMode.get(settings)).toBe("off");
	});

	it("lists presets with their state", async () => {
		presets[0]!.status = "loaded";
		await run("list");
		expect(output.join("\n")).toContain("rabid-deep (loaded)");
	});
});
