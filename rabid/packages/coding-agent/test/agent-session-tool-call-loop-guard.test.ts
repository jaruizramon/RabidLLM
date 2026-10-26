import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession tool-call loop guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-tool-call-loop-guard-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("injects a hidden redirect before the next model call", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "1263 passed, 4 skipped" }] }),
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const toolCallTurn = callCount < 2;
				const toolCallId = `tc-${callCount}`;
				callCount++;
				const message: AssistantMessage = toolCallTurn
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pytest -q" } }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Stopped repeating." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolCallTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 2,
			"model.toolCallLoopGuard.exemptTools": ["wait"],
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		await session.prompt("run checks");
		await session.waitForIdle();

		expect(contexts).toHaveLength(3);
		expect(JSON.stringify(contexts[2]!.messages)).toContain("tool_call_loop_detected");
		expect(JSON.stringify(contexts[2]!.messages)).toContain("1263 passed, 4 skipped");
		const redirects = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "tool-call-loop-redirect",
		);
		expect(redirects).toHaveLength(1);
		expect(redirects[0]!.display).toBe(false);
	});

	it("steers when different probes keep returning the same output", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		let executions = 0;
		const output =
			"Probe: size=4096 | entries=12 | first=0x4d0a | count=50 | label=sample-x length=311 | finetune=110 | volume=116 checksum=snake";
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => {
				executions++;
				return { content: [{ type: "text" as const, text: output }] };
			},
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				callCount++;
				const probing = callCount <= 3;
				const message: AssistantMessage = probing
					? {
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: `tc-${callCount}`,
									name: "bash",
									arguments: { command: `probe-${callCount}` },
								},
							],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Changed approach." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: probing ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 5,
			"model.toolCallLoopGuard.resultThreshold": 2,
			"model.toolCallLoopGuard.exemptTools": ["wait"],
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		await session.prompt("inspect the fixture");
		await session.waitForIdle();

		// Probe 1 counts; probe 2 repeats the output and earns the steer; probe 3
		// ignores it, so the run stops.
		expect(executions).toBe(3);
		expect(JSON.stringify(contexts[2]!.messages)).toContain("tool_call_loop_detected");
		expect(JSON.stringify(contexts[2]!.messages)).toContain("You received the same");
		const aborted = session.agent.state.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "aborted",
		);
		expect(aborted?.errorMessage).toContain("kept returning identical output");
	});

	it("steers a probe sequence that repeats without consecutive duplicates", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const outputs = [
			"analyze: size=4096 | entries=12 | first=0x4d0a | count=50 | label=sample-x length=311",
			"check: after 1000 | expected 1020 | diff 20 | next 40 bytes: 0000000000000000000000000000000000000000c4b0",
			"parse: after 1020 | expected 1020 | record 0: len=452 loopStart=0 vol=48 fine=0 type=16 pan=128",
		];
		let executions = 0;
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => {
				const text = outputs[executions % outputs.length]!;
				executions++;
				return { content: [{ type: "text" as const, text }] };
			},
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				callCount++;
				const probing = callCount <= 7;
				const message: AssistantMessage = probing
					? {
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: `tc-${callCount}`,
									name: "bash",
									arguments: { command: `probe-${(callCount - 1) % 3}` },
								},
							],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Changed approach." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: probing ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 5,
			"model.toolCallLoopGuard.resultThreshold": 2,
			"model.toolCallLoopGuard.exemptTools": ["wait"],
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		await session.prompt("debug the reader");
		await session.waitForIdle();

		// Turns 1-6 are the same three probes twice, so turn 6 earns the steer;
		// turn 7 repeats it and the run stops before executing that call.
		expect(executions).toBe(7);
		expect(JSON.stringify(contexts[6]!.messages)).toContain("repeated the same 3-probe sequence");
		const aborted = session.agent.state.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "aborted",
		);
		expect(aborted?.errorMessage).toContain("kept repeating the same 3-call sequence");
	});

	it("aborts the run when the model ignores the loop redirect", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		let executions = 0;
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => {
				executions++;
				return { content: [{ type: "text" as const, text: "1263 passed, 4 skipped" }] };
			},
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				callCount++;
				const repeats = callCount <= 6;
				const message: AssistantMessage = repeats
					? {
							role: "assistant",
							content: [
								{ type: "toolCall", id: `tc-${callCount}`, name: "bash", arguments: { command: "pytest -q" } },
							],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Stopped repeating." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: repeats ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 2,
			"model.toolCallLoopGuard.exemptTools": ["wait"],
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		await session.prompt("run checks");
		await session.waitForIdle();

		// Call 1 counts, call 2 earns the redirect, call 3 is the ignored retry.
		// The abort lands at that turn's end; the already-dispatched next model
		// call is the aborted boundary and must not execute the tool again.
		expect(executions).toBe(3);
		expect(JSON.stringify(contexts[2]!.messages)).toContain("tool_call_loop_detected");
		const aborted = session.agent.state.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "aborted",
		);
		expect(aborted?.errorMessage).toContain("Stopped:");
		expect(aborted?.errorMessage).toContain("repeated with identical arguments");
	});

	it("keeps a blocked call blocked across a mid-turn steer", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		let executions = 0;
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock failing bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => {
				executions++;
				if (executions === 2) {
					await session!.sendUserMessage("you're looping", { deliverAs: "steer" });
				}
				throw new Error("boom");
			},
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				callCount++;
				const repeats = callCount <= 4;
				const message: AssistantMessage = repeats
					? {
							role: "assistant",
							content: [
								{ type: "toolCall", id: `tc-${callCount}`, name: "bash", arguments: { command: "pytest -q" } },
							],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Stopping." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: repeats ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		await session.prompt("run checks");
		await session.waitForIdle();

		// Two real failures; the third and fourth identical calls never reach the tool.
		expect(executions).toBe(2);
		expect(JSON.stringify(contexts[2]!.messages)).toContain("you're looping");
		const guardResult = session.agent.state.messages.find(
			message =>
				message.role === "toolResult" &&
				message.isError &&
				message.content.some(block => block.type === "text" && block.text.includes("Repeated-failure guard")),
		);
		expect(guardResult).toBeDefined();
	});
});
