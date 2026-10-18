/**
 * `tools.disabled` hides a tool from the request and the system prompt while
 * keeping it on the session slate, so lifting the policy restores it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Api, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgToolsDisabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

describe("tools.disabled", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		clearCustomApis();
	});

	function newSession(disabled: string[]) {
		const read = tool("read");
		const task = tool("task");
		const toolRegistry = new Map<string, AgentTool>([
			["read", read],
			["task", task],
		]);
		const promptToolNames: string[][] = [];
		const settings = Settings.isolated({ "compaction.enabled": false, "tools.disabled": disabled });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
				systemPrompt: ["sys"],
				tools: [read],
			},
			convertToLlm,
			streamFn: createMockModel({ handler: () => ({ content: ["ok"] }) }).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			toolRegistry,
			builtInToolNames: ["read", "task"],
			// The SDK hands the unfiltered selection so a hidden tool stays restorable.
			selectedToolNames: ["read", "task"],
			rebuildSystemPrompt: async toolNames => {
				promptToolNames.push(toolNames);
				return { systemPrompt: ["sys"] };
			},
		});
		sessions.push(session);
		return { session, settings, promptToolNames };
	}

	it("keeps a hidden tool out of the request while preserving it on the slate", async () => {
		const { session, settings, promptToolNames } = newSession(["task"]);

		expect(session.getEnabledToolNames()).toEqual(["read"]);
		await session.setActiveToolsByName(["read", "task"]);
		expect(session.agent.state.tools.map(candidate => candidate.name)).toEqual(["read"]);
		// The prompt builder receives the filtered names, so its tool-conditional
		// guidance (including the delegation block) omits `task`.
		expect(promptToolNames.at(-1)).toEqual(["read"]);

		cfgToolsDisabled.override(settings, []);
		await session.reconcileDisabledTools();

		expect(session.getEnabledToolNames()).toEqual(["read", "task"]);
		expect(session.agent.state.tools.map(candidate => candidate.name)).toEqual(["read", "task"]);
		expect(promptToolNames.at(-1)).toEqual(["read", "task"]);
	});
});

describe("tools.disabled through the SDK", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		clearCustomApis();
	});

	it("omits a profile-disabled tool from the request's tools[]", async () => {
		using tempDir = TempDir.createSync("@pi-disabled-tools-");
		const api = "test-disabled-tools" as Api;
		const requests: Array<{ context: Context; thinkingBudgets?: Partial<Record<string, number>> }> = [];
		registerCustomApi(api, (_model, context, options) => {
			requests.push({ context, thinkingBudgets: options?.thinkingBudgets });
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const build = (id: string) =>
			buildModel({
				id,
				name: id,
				api,
				provider: "local-llama",
				baseUrl: "http://127.0.0.1:8101/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262_144,
				maxTokens: 32_768,
			} as ModelSpec<Api>) as Model<Api>;
		const model = build("qwen3.8-27b");
		const other = build("qwen3.8-27b-uncensored");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");

		const disabled = Settings.isolated({
			"compaction.enabled": false,
			temperature: 0.2,
			"thinkingBudgets.medium": 8192,
			profiles: {
				"local-llama/qwen3.8-27b": {
					tools: { disabled: ["task"] },
					sampling: { temperature: 0.7 },
					thinkingBudgets: { medium: 1024 },
				},
			},
		});
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: disabled,
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			agentId: "DisabledToolProbe",
		});
		sessions.push(session);
		await session.sendUserMessage("hello");

		const request = requests.at(-1);
		const names = (request?.context.tools ?? []).map(candidate => (candidate as { name: string }).name);
		expect(names).toContain("read");
		expect(names).not.toContain("task");
		expect(session.agent.temperature).toBe(0.7);
		expect(request?.thinkingBudgets?.medium).toBe(1024);

		// A model without a profile restores the hidden tool and the global sampling.
		await session.setModel(other);
		await session.sendUserMessage("again");
		const switched = requests.at(-1);
		const switchedNames = (switched?.context.tools ?? []).map(candidate => (candidate as { name: string }).name);
		expect(switchedNames).toContain("task");
		expect(session.agent.temperature).toBe(0.2);
		expect(switched?.thinkingBudgets?.medium).toBe(8192);
	});
});
