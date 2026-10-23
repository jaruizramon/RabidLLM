/**
 * `/llama` — the V100 model manager, without leaving the harness.
 *
 * Bare `/llama` opens the live manager sheet. Subcommands mirror the manager
 * UI (:8090) for scripting and ACP hosts: status, load/switch/unload, router
 * start/stop, force-clear VRAM, restart, SLM worker, logs, parked contexts,
 * and model-list reload. Loading a model also switches this session to it.
 */
import { Text } from "@oh-my-pi/pi-tui";
import { commandConsumed, errorMessage, usage } from "../slash-commands/helpers/parse";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "../slash-commands/types";
import {
	activeModel,
	fetchManagerContexts,
	fetchManagerLog,
	fetchManagerSlm,
	fetchManagerState,
	formatManagerStatus,
	LOCAL_PROVIDERS,
	forceClearVram,
	isModelLoaded,
	loadPreset,
	managerUrl,
	refreshLocalProviders,
	restartRouter,
	setServerRunning,
	slmLoad,
	slmUnload,
	switchToLocalModel,
	unloadPreset,
} from "../rabid/llama-manager";

type LlamaAction =
	| "sheet"
	| "status"
	| "load"
	| "unload"
	| "server-start"
	| "server-stop"
	| "clear"
	| "restart"
	| "reload"
	| "slm-status"
	| "slm-load"
	| "slm-stop"
	| "log"
	| "contexts"
	| "open"
	| "help";

interface ParsedLlamaCommand {
	readonly action: LlamaAction;
	readonly id?: string;
	readonly arg?: string;
}

/** Parse the command line; a bare preset id is a load shorthand. */
function parseLlamaCommand(args: string): ParsedLlamaCommand {
	const text = args.trim();
	if (text === "") return { action: "sheet" };
	const [verb, rest] = text.split(/\s+/, 2);
	switch (verb) {
		case "status":
		case "list":
			return { action: "status" };
		case "load":
			return { action: "load", id: rest };
		case "switch":
		case "use":
			return { action: "load", id: rest };
		case "unload":
			return { action: "unload", id: rest };
		case "server":
			if (rest === "start") return { action: "server-start" };
			if (rest === "stop") return { action: "server-stop" };
			return { action: "help" };
		case "clear":
		case "force-clear":
			return { action: "clear" };
		case "restart":
			return { action: "restart" };
		case "reload":
			return { action: "reload" };
		case "slm":
			if (rest === "load") return { action: "slm-load", arg: rest };
			if (rest === "stop" || rest === "unload") return { action: "slm-stop" };
			return { action: "slm-status" };
		case "log":
			return { action: "log", arg: rest };
		case "contexts":
		case "parked":
			return { action: "contexts" };
		case "open":
		case "ui":
			return { action: "open" };
		case "help":
			return { action: "help" };
		default:
			return { action: "load", id: text };
	}
}

const HELP = `llama manager (${managerUrl()})
  /llama                     open the live manager sheet
  /llama status              models, GPU, router, parked contexts
  /llama load <id>           load a preset and switch omp to it
  /llama switch <id>         same as load (loads it first when needed)
  /llama unload [id]         unload a preset (default: the loaded one)
  /llama server start|stop   start or stop the router
  /llama clear               force-clear the V100 (kills every engine)
  /llama restart             restart the router to re-read models.ini
  /llama reload              re-read omp's local model list
  /llama slm [load|stop]     inspect or control the SLM handoff worker
  /llama log [llama|1cat|stock|slm]
  /llama contexts            parked router contexts
  /llama open                open the browser manager UI`;

async function resolveId(id: string | undefined): Promise<string> {
	if (id) return id;
	const state = await fetchManagerState();
	const active = activeModel(state);
	if (active) return active.id;
	throw new Error("no model is loaded; name one, e.g. /llama load qwen3.8-27b");
}

async function statusText(session?: SlashCommandRuntime["session"]): Promise<string> {
	const [state, contexts] = await Promise.all([fetchManagerState(), fetchManagerContexts().catch(() => undefined)]);
	return formatManagerStatus(state, session, contexts);
}

async function contextsText(): Promise<string> {
	const contexts = await fetchManagerContexts();
	if (contexts.contexts.length === 0) return "No parked contexts.";
	const lines = ["Parked router contexts:"];
	for (const context of contexts.contexts) {
		lines.push(
			`  ${context.name}  ${context.model}  slot ${context.slot}  ${context.tokens} tokens  ${
				context.on_disk ? `${Math.round(context.disk_bytes / 1024 / 1024)} MiB on disk` : "missing file"
			}`,
		);
	}
	return lines.join("\n");
}

async function slmStatusText(): Promise<string> {
	const slm = await fetchManagerSlm();
	const choices = slm.choices?.map(choice => choice.id).join(", ") ?? "";
	return [
		`SLM worker: ${slm.loaded ? "ready" : slm.running ? "starting" : "stopped"}`,
		slm.file ? `  model ${slm.file}` : undefined,
		slm.device ? `  device ${slm.device}` : undefined,
		slm.ctx ? `  context ${slm.ctx}` : undefined,
		slm.port ? `  port ${slm.port}` : undefined,
		slm.uptime_s ? `  uptime ${Math.round(slm.uptime_s)}s` : undefined,
		choices ? `  choices ${choices}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

async function runText(action: ParsedLlamaCommand, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const output = runtime.output;
	const progress = (): void => {};
	switch (action.action) {
		case "sheet":
		case "status":
			await output(await statusText(runtime.session));
			return commandConsumed();
		case "load":
			if (!action.id) return usage("Usage: /llama load <preset>", runtime);
			await loadPreset(action.id, progress);
			{
				const target = await switchToLocalModel(runtime.session, action.id);
				await output(`Loaded ${action.id}; omp is on ${target.provider}/${target.id}.`);
			}
			return commandConsumed();
		case "unload": {
			const id = await resolveId(action.id);
			const result = await unloadPreset(id, progress);
			await output(`Unloaded ${id}${result.detail ? `; ${result.detail}` : ""}.`);
			return commandConsumed();
		}
		case "server-start":
			await output((await setServerRunning(true, progress)).detail ?? "Router started.");
			return commandConsumed();
		case "server-stop":
			await output((await setServerRunning(false, progress)).detail ?? "Router stopped.");
			return commandConsumed();
		case "clear":
			await output((await forceClearVram()).detail ?? "V100 cleared.");
			return commandConsumed();
		case "restart":
			await restartRouter(progress);
			await refreshLocalProviders(runtime.session);
			await output("Router restarted and models.ini re-read.");
			return commandConsumed();
		case "reload": {
			const providers = await refreshLocalProviders(runtime.session);
			await output(`Refreshed ${providers.join(", ") || "no providers"}.`);
			return commandConsumed();
		}
		case "slm-status":
			await output(await slmStatusText());
			return commandConsumed();
		case "slm-load": {
			const slm = await fetchManagerSlm();
			const model = slm.choices?.[0]?.id;
			if (!model) throw new Error("no SLM model choices are configured");
			await output((await slmLoad({ model })).detail ?? `Starting SLM worker ${model}.`);
			return commandConsumed();
		}
		case "slm-stop":
			await output((await slmUnload()).detail ?? "SLM worker stopped.");
			return commandConsumed();
		case "log": {
			const engine = (action.arg as "llama" | "1cat" | "stock" | "slm" | undefined) ?? "llama";
			await output(await fetchManagerLog(engine));
			return commandConsumed();
		}
		case "contexts":
			await output(await contextsText());
			return commandConsumed();
		case "open":
			await output(`Manager UI: ${managerUrl()}`);
			return commandConsumed();
		case "help":
			await output(HELP);
			return commandConsumed();
	}
}

async function runTui(action: ParsedLlamaCommand, runtime: TuiSlashCommandRuntime): Promise<SlashCommandResult> {
	const ctx = runtime.ctx;
	const output = (text: string) => ctx.showStatus(text);
	const confirm = (title: string, options: string[]) => ctx.showHookSelector(title, options);
	try {
		switch (action.action) {
			case "sheet":
				ctx.showLlamaManager();
				return commandConsumed();
			case "status":
				ctx.showStatus(await statusText(ctx.session));
				return commandConsumed();
			case "load": {
				if (!action.id) {
					ctx.showError("Usage: /llama load <preset>");
					return commandConsumed();
				}
				await loadPreset(action.id, output);
				const target = await switchToLocalModel(ctx.session, action.id);
				ctx.statusLine.invalidate();
				ctx.showStatus(`Loaded ${action.id}; omp is on ${target.provider}/${target.id}.`);
				return commandConsumed();
			}
			case "unload": {
				const id = await resolveId(action.id);
				const state = await fetchManagerState();
				const model = state.models.find(candidate => candidate.id === id);
				if (
					model &&
					isModelLoaded(model) &&
					ctx.session.model?.id === id &&
					LOCAL_PROVIDERS.some(provider => provider === ctx.session.model?.provider)
				) {
					const choice = await confirm(`Unload ${id}?`, [
						"Unload (the harness stays pointed at it; requests will fail until you load a model)",
						"Cancel",
					]);
					if (choice?.startsWith("Unload") !== true) return commandConsumed();
				}
				const result = await unloadPreset(id, output);
				ctx.showStatus(`Unloaded ${id}${result.detail ? `; ${result.detail}` : ""}.`);
				return commandConsumed();
			}
			case "server-start":
				ctx.showStatus((await setServerRunning(true, output)).detail ?? "Router started.");
				return commandConsumed();
			case "server-stop": {
				const choice = await confirm("Stop the llama router?", [
					"Stop server (unloads the resident model)",
					"Cancel",
				]);
				if (choice !== "Stop server (unloads the resident model)") return commandConsumed();
				ctx.showStatus((await setServerRunning(false, output)).detail ?? "Router stopped.");
				return commandConsumed();
			}
			case "clear": {
				const choice = await confirm("Force-clear the V100?", [
					"Clear VRAM (kills every model engine, including strays)",
					"Cancel",
				]);
				if (choice !== "Clear VRAM (kills every model engine, including strays)") return commandConsumed();
				ctx.showStatus((await forceClearVram()).detail ?? "V100 cleared.");
				return commandConsumed();
			}
			case "restart": {
				const choice = await confirm("Restart the llama router?", [
					"Restart router (unloads the resident model)",
					"Cancel",
				]);
				if (choice !== "Restart router (unloads the resident model)") return commandConsumed();
				await restartRouter(output);
				await refreshLocalProviders(ctx.session);
				ctx.statusLine.invalidate();
				ctx.showStatus("Router restarted and models.ini re-read; model list refreshed.");
				return commandConsumed();
			}
			case "reload": {
				const providers = await refreshLocalProviders(ctx.session);
				ctx.statusLine.invalidate();
				ctx.showStatus(`Refreshed ${providers.join(", ") || "no providers"}.`);
				return commandConsumed();
			}
			case "slm-status":
				ctx.showStatus(await slmStatusText());
				return commandConsumed();
			case "slm-load": {
				const slm = await fetchManagerSlm();
				const model = slm.choices?.[0]?.id;
				if (!model) throw new Error("no SLM model choices are configured");
				ctx.showStatus((await slmLoad({ model })).detail ?? `Starting SLM worker ${model}.`);
				return commandConsumed();
			}
			case "slm-stop":
				ctx.showStatus((await slmUnload()).detail ?? "SLM worker stopped.");
				return commandConsumed();
			case "log": {
				const engine = (action.arg as "llama" | "1cat" | "stock" | "slm" | undefined) ?? "llama";
				ctx.showCommandReport({
					title: `llama log · ${engine}`,
					body: new Text(await fetchManagerLog(engine), 0, 0),
				});
				return commandConsumed();
			}
			case "contexts":
				ctx.showStatus(await contextsText());
				return commandConsumed();
			case "open":
				ctx.openInBrowser(managerUrl());
				ctx.showStatus(`Manager UI: ${managerUrl()}`);
				return commandConsumed();
			case "help":
				ctx.showStatus(HELP);
				return commandConsumed();
		}
		return commandConsumed();
	} catch (error) {
		ctx.showError(`llama: ${errorMessage(error)}`);
		return commandConsumed();
	}
}

export const BUILTIN_LLAMA_MANAGER_SLASH_COMMANDS: SlashCommandSpec[] = [
	{
		name: "llama",
		aliases: ["v100", "model-manager"],
		icon: "computer",
		description:
			"Manage V100 models through llama-manager: load/unload/switch, router, VRAM, parked contexts, SLM worker",
		allowArgs: true,
		inlineHint:
			"[status|load <id>|unload [id]|switch <id>|server start|stop|clear|restart|reload|slm load|stop|log|contexts|open]",
		subcommands: [
			{ name: "status", description: "Models, GPU, router, and parked contexts" },
			{ name: "load", description: "Load a preset and switch omp to it" },
			{ name: "switch", description: "Load the preset when needed and switch omp to it" },
			{ name: "unload", description: "Unload a preset (default: the loaded one)" },
			{ name: "server", description: "Start or stop the router" },
			{ name: "clear", description: "Force-clear the V100 (kills every model engine)" },
			{ name: "restart", description: "Restart the router to re-read models.ini" },
			{ name: "reload", description: "Re-read omp's local model list" },
			{ name: "slm", description: "Inspect or control the SLM handoff worker" },
			{ name: "log", description: "Show the router, 1cat, stock, or SLM log tail" },
			{ name: "contexts", description: "List parked router contexts" },
			{ name: "open", description: "Open the browser manager UI" },
		],
		async handle(command, runtime): Promise<SlashCommandResult> {
			try {
				return await runText(parseLlamaCommand(command.args), runtime);
			} catch (error) {
				await runtime.output(`llama: ${errorMessage(error)}`);
				return commandConsumed();
			}
		},
		async handleTui(command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): Promise<SlashCommandResult> {
			return await runTui(parseLlamaCommand(command.args), runtime);
		},
	},
];
