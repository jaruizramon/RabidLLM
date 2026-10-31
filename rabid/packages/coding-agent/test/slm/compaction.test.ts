import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context, Message, Model, UserMessage } from "@oh-my-pi/pi-ai";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CompactionMethod, withSlmFirst } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { writeTurnCard } from "@oh-my-pi/pi-coding-agent/rabid/turn-cards";
import { coversOperatorTurns, type SlmHandoffRecord } from "@oh-my-pi/pi-coding-agent/slm/handoff";
import { parseSlmDevice, slmOffloadArgs } from "@oh-my-pi/pi-coding-agent/slm/server";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

const CONTEXT_WINDOW = 100_000;
const THRESHOLD = 50_000;

const HANDOFF: SlmHandoffRecord = {
	document: "## Goal\nShip it\n\n## Hard requirements\n- MUST keep X",
	metadata: {
		version: 1,
		sessionId: "test-session",
		coveredLeafKey: "user:1",
		coveredAt: 1_000,
		coveredUserTurns: 1,
		modelPath: "/models/smollm3.gguf",
		ctxSize: 4_096,
		reasoningBudgetTokens: 512,
		inputTokens: 100,
		outputTokens: 50,
		durationMs: 1_200,
		truncated: false,
		formatFallback: false,
	},
};

let workerModelPath = "";
let workerServerPath = "";

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(text: string, model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 10_000,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10_100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("parseSlmDevice", () => {
	it("keeps the CPU device free of every GPU backend", () => {
		expect(parseSlmDevice("cpu")).toEqual({ kind: "cpu" });
	});

	it("lets the driver pick for a bare cuda and pins an explicit index", () => {
		expect(parseSlmDevice("cuda")).toEqual({ kind: "cuda" });
		expect(parseSlmDevice("cuda:1")).toEqual({ kind: "cuda", index: 1 });
	});

	it("rejects anything that is not a device llama.cpp can serve", () => {
		expect(parseSlmDevice("metal")).toBeUndefined();
		expect(parseSlmDevice("cuda:")).toBeUndefined();
		expect(parseSlmDevice("cuda:-1")).toBeUndefined();
	});
});

describe("coversOperatorTurns", () => {
	const user = (text: string, extra: Record<string, unknown> = {}) =>
		({ role: "user", content: [{ type: "text", text }], timestamp: 1, ...extra }) as unknown as AgentMessage;
	const assistant = (timestamp: number) =>
		({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			timestamp,
			stopReason: "stop",
		}) as unknown as AgentMessage;

	it("accepts a document whose covered leaf is followed only by assistant output", () => {
		const messages = [user("do it", { timestamp: 1 }), assistant(2), assistant(3)];
		expect(coversOperatorTurns(messages, "user:1:")).toBe(true);
	});

	it("rejects a document that leaves a later operator turn uncovered", () => {
		const first = user("first", { timestamp: 1 });
		const second = user("second", { timestamp: 3 });
		const messages = [first, assistant(2), second, assistant(4)];
		expect(coversOperatorTurns(messages, "user:1:")).toBe(false);
		expect(coversOperatorTurns(messages, "user:3:")).toBe(true);
	});

	it("rejects a key that is no longer in the transcript", () => {
		expect(coversOperatorTurns([user("x", { timestamp: 1 })], "user:99:")).toBe(false);
		expect(coversOperatorTurns([user("x", { timestamp: 1 })], undefined)).toBe(false);
	});
});

describe("slmOffloadArgs", () => {
	it("keeps a CPU worker free of GPU layers and fitting", () => {
		expect(slmOffloadArgs({ device: { kind: "cpu" }, gpuLayers: 0, gpuFreeMiB: 2048, ctxSize: 8192 })).toEqual([
			"--n-gpu-layers",
			"0",
		]);
	});

	it("caps a GPU worker by leaving the configured VRAM free and pinning the context", () => {
		expect(
			slmOffloadArgs({ device: { kind: "cuda", index: 1 }, gpuLayers: 999, gpuFreeMiB: 2048, ctxSize: 8192 }),
		).toEqual(["--n-gpu-layers", "auto", "--fit", "on", "--fit-target", "2048", "--fit-ctx", "8192"]);
	});

	it("honours an explicit layer count instead of fitting", () => {
		expect(
			slmOffloadArgs({ device: { kind: "cuda", index: 1 }, gpuLayers: 12, gpuFreeMiB: -1, ctxSize: 8192 }),
		).toEqual(["--n-gpu-layers", "12"]);
	});
});

describe("withSlmFirst", () => {
	it("appends a fallback when slm would be the only method", () => {
		expect(withSlmFirst(["slm"])).toEqual(["slm", "handoff"]);
	});

	it("moves slm to the front without dropping the existing order", () => {
		expect(withSlmFirst(["soft", "slm", "remote"])).toEqual(["slm", "soft", "remote"]);
	});

	it("leaves an order that already ends in other methods untouched apart from the prefix", () => {
		expect(withSlmFirst(["soft"])).toEqual(["slm", "soft"]);
	});
});

describe("slm compaction method", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let sessionManager: SessionManager;
	let maintenance: SessionMaintenance;
	let agent: Agent;
	let prepareCalls: { signal?: AbortSignal; awaitMs: number }[];

	beforeAll(async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slm-compaction-test-"));
		workerModelPath = path.join(dir, "smollm3.gguf");
		workerServerPath = path.join(dir, "llama-server-fake");
		await Bun.write(workerModelPath, "weights");
		await Bun.write(workerServerPath, "#!/bin/sh\nexit 0\n");
		await fs.chmod(workerServerPath, 0o755);

		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in model");
		model = { ...bundled, contextWindow: CONTEXT_WINDOW };
	});

	beforeEach(() => {
		sessionManager = SessionManager.inMemory();
		prepareCalls = [];
		const text = "conversation ".repeat(8_000);
		sessionManager.appendMessage(userMessage(text));
		sessionManager.appendMessage(assistantMessage("response ".repeat(8_000), model));
		sessionManager.appendMessage(userMessage("MUST keep X"));
		sessionManager.appendMessage(assistantMessage("final response", model));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		authStorage.close();
		await fs.rm(path.dirname(workerModelPath), { recursive: true, force: true });
	});

	function createMaintenance(options: {
		methodOrder: CompactionMethod[];
		prepareSlmHandoff: () => Promise<SlmHandoffRecord | undefined>;
		asyncEnabled?: boolean;
		turnCardChain?: boolean;
		todoPhases?: TodoPhase[];
	}): SessionMaintenance {
		agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": options.asyncEnabled ?? false,
			"compaction.methodOrder": options.methodOrder,
			"compaction.thresholdPercent": 50,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			"compaction.turnCardChain": options.turnCardChain ?? false,
			"compaction.slmHandoff.modelPath": workerModelPath,
			"compaction.slmHandoff.serverPath": workerServerPath,
			"compaction.slmHandoff.awaitMs": 50,
		});
		const host = {
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: undefined,
			sideStreamFn: async () => {
				throw new Error("The compact seam should be used instead of the side stream");
			},
			providerSessionState: new Map(),
			preferWebsockets: () => undefined,
			model: () => model,
			thinkingLevel: () => undefined,
			isDisposed: () => false,
			isStreaming: () => false,
			isGeneratingHandoff: () => false,
			promptGeneration: () => 0,
			hasExperimentalContextRolloverTools: () => false,
			queueExperimentalContextNotesReminder: () => {},
			sessionId: () => sessionManager.getSessionId(),
			messages: () => agent.state.messages,
			baseSystemPrompt: () => ["Test"],
			goalModeState: () => undefined,
			planReferencePath: () => "",
			nonMessageTokenSource: () => ({}),
			memoryBackendSession: () => undefined,
			emitSessionEvent: async () => {},
			emitNotice: () => {},
			scheduleAgentContinue: () => {},
			scheduleCompactionContinuation: () => false,
			persistTurnMessagesForMidRunCompaction: async () => false,
			findLastAssistantMessage: () => undefined,
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			drainStrandedQueuedMessages: () => {},
			buildDisplaySessionContext: () => sessionManager.buildSessionContext(),
			persistEvalStateContext: () => {},
			convertToLlmForSideRequest: (messages: AgentMessage[]) => messages as never,
			buildLiveProviderContext: async (): Promise<Context> => ({ messages: [] }),
			obfuscateTextForProvider: (text: string | undefined) => text,
			obfuscatePreparationForProvider: <T>(preparation: T) => preparation,
			closeCodexProviderSessionsForHistoryRewrite: () => {},
			resetCodexProviderAfterCompaction: () => {},
			resetPlanReference: () => {},
			syncTodoPhasesFromBranch: () => {},
			getTodoPhases: () => options.todoPhases ?? [],
			resetAdvisorRuntimes: () => {},
			rebaseAfterCompaction: () => {},
			recordAnchoredHistoryRewrite: () => {},
			getContextBreakdown: () => undefined,
			getContextUsage: () => undefined,
			shake: async () => ({ modified: false, tokensRemoved: 0 }),
			dropImages: async () => ({ removed: 0 }),
			generateHandoffDocument: async () => {
				throw new Error("The main model must not generate a handoff for the slm method");
			},
			prepareSlmHandoff: async (prepareOptions: { signal?: AbortSignal; awaitMs: number }) => {
				prepareCalls.push(prepareOptions);
				return await options.prepareSlmHandoff();
			},
			removeAssistantMessageFromActiveContext: () => {},
			dropPersistedAssistantTurn: async () => undefined,
			runRecoveryCompactionWithRollback: async () => ({ continuationScheduled: false }),
			parseRetryAfterFromError: () => undefined,
			setModelTemporary: async () => {},
			abort: async () => {},
			abortHandoff: () => {},
		} as unknown as SessionMaintenanceHost;
		return new SessionMaintenance(host);
	}

	function latestCompaction() {
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		if (entry?.type !== "compaction") throw new Error("Expected a committed compaction entry");
		return entry;
	}

	it("commits the ready handoff without any model or network call", async () => {
		maintenance = createMaintenance({ methodOrder: ["slm"], prepareSlmHandoff: async () => HANDOFF });
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(new Error("the main model must not summarize for slm"));
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network for slm"));

		await maintenance.runAutoCompaction("threshold", false, { triggerContextTokens: THRESHOLD });

		const entry = latestCompaction();
		expect(entry.method).toBe("slm");
		expect(entry.summary).toContain("## Goal");
		expect(entry.summary).toContain("MUST keep X");
		expect(entry.summary).toContain("## User messages (verbatim; authoritative)");
		expect(entry.details).toEqual({ slmHandoff: HANDOFF.metadata });
		expect(prepareCalls).toHaveLength(1);
		expect(compactSpy).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("keeps the deterministic ledger when the turn-card chain supplies the summary", async () => {
		const originalAgentDir = getAgentDir();
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "turn-card-chain-"));
		try {
			setAgentDir(agentDir);
			const sessionId = sessionManager.getSessionId();
			// A developer directive inside the summarized region: the cards never
			// carry it, so only the deterministic block can keep it.
			sessionManager.appendMessage(userMessage("continue"));
			const directive: Message = {
				role: "developer",
				content: [{ type: "text", text: "Plan approved. Implement the parser before the renderer." }],
				timestamp: Date.now(),
			};
			sessionManager.appendMessage(directive);
			sessionManager.appendMessage(assistantMessage("working", model));
			// Cards are written at agent_end, after the turn they cover.
			for (const promptText of ["inspect the repo", "copy the fixtures", "keep X"]) {
				await writeTurnCard(agentDir, sessionId, { prompt: promptText, files: [], operations: [] });
			}

			maintenance = createMaintenance({
				methodOrder: ["soft"],
				turnCardChain: true,
				prepareSlmHandoff: async () => undefined,
				todoPhases: [
					{
						name: "Sprint 4 closeout",
						tasks: [
							{ content: "Check architecture.md", status: "in_progress" },
							{ content: "Commit Sprint 4", status: "pending" },
						],
					},
				],
			});
			const compactSpy = vi
				.spyOn(compactionModule, "compact")
				.mockRejectedValue(new Error("the turn-card chain must win over the LLM"));

			await maintenance.runAutoCompaction("threshold", false, { triggerContextTokens: THRESHOLD });

			const entry = latestCompaction();
			expect(entry.summary).toContain("## Turn cards");
			expect(entry.summary).toContain("## Standing directives (verbatim; authoritative)");
			expect(entry.summary).toContain("Implement the parser before the renderer.");
			expect(entry.summary).toContain("## User messages (verbatim; authoritative)");
			expect(entry.summary).toContain("MUST keep X");
			expect(entry.summary).toContain("## Todo (live)");
			expect(entry.summary).toContain("[in_progress] Check architecture.md");
			expect(compactSpy).not.toHaveBeenCalled();
		} finally {
			setAgentDir(originalAgentDir);
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("falls back to the LLM when the turn-card chain predates the summarized region", async () => {
		const originalAgentDir = getAgentDir();
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "turn-card-stale-"));
		try {
			setAgentDir(agentDir);
			const chainDir = path.join(agentDir, "turn-cards");
			await fs.mkdir(chainDir, { recursive: true });
			// Three cards satisfy the user-turn count, but all predate the messages
			// this compaction summarizes: a mid-turn compaction has no card for the
			// work that triggered it.
			const stale = ["first", "second", "third"]
				.map(
					prompt =>
						`## [2020-01-01T00:00:0${prompt.length}.000Z] ${prompt}\n<!-- session:${sessionManager.getSessionId()} -->\n\nFiles: \`game.js\`\n`,
				)
				.join("\n");
			await fs.writeFile(path.join(chainDir, `${sessionManager.getSessionId()}.chain.md`), stale);

			maintenance = createMaintenance({
				methodOrder: ["soft"],
				turnCardChain: true,
				prepareSlmHandoff: async () => undefined,
			});
			const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "fresh summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));

			await maintenance.runAutoCompaction("threshold", false, { triggerContextTokens: THRESHOLD });

			const entry = latestCompaction();
			expect(entry.summary).not.toContain("## Turn cards");
			expect(entry.summary).toContain("fresh summary");
			expect(compactSpy).toHaveBeenCalledTimes(1);
		} finally {
			setAgentDir(originalAgentDir);
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("never speculates an LLM summary while slm owns the background work", () => {
		maintenance = createMaintenance({
			methodOrder: ["slm"],
			prepareSlmHandoff: async () => HANDOFF,
			asyncEnabled: true,
		});
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(new Error("slm must not speculate an LLM summary"));

		maintenance.maybeStartSpeculativeCompaction(THRESHOLD - 100, CONTEXT_WINDOW);

		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("records the turn's file actions in the committed summary", async () => {
		// The tool call must sit inside the summarized region, not the kept tail.
		sessionManager = SessionManager.inMemory();
		const bulk = "conversation ".repeat(8_000);
		sessionManager.appendMessage(userMessage(bulk));
		sessionManager.appendMessage(assistantMessage("response ".repeat(8_000), model));
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: { path: "src/parser.ts" } }],
			timestamp: Date.now(),
		} as unknown as AssistantMessage);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "edit",
			content: [{ type: "text", text: "edited" }],
			isError: false,
			timestamp: Date.now(),
		} as unknown as AssistantMessage);
		sessionManager.appendMessage(userMessage("MUST keep X"));
		sessionManager.appendMessage(assistantMessage("final response", model));
		maintenance = createMaintenance({ methodOrder: ["soft"], prepareSlmHandoff: async () => undefined });
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		await maintenance.runAutoCompaction("threshold", false, { triggerContextTokens: THRESHOLD });

		const entry = latestCompaction();
		expect(entry.summary).toContain("## Recent file actions");
		expect(entry.summary).toContain("edit `src/parser.ts`");
	});

	it("falls back to the next method when the handoff is not ready", async () => {
		maintenance = createMaintenance({ methodOrder: ["slm", "soft"], prepareSlmHandoff: async () => undefined });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "soft summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		await maintenance.runAutoCompaction("threshold", false, { triggerContextTokens: THRESHOLD });

		const entry = latestCompaction();
		expect(entry.method).toBe("soft");
		// Every text compaction now carries the deterministic requirement block.
		expect(entry.summary).toContain("soft summary");
		expect(entry.summary).toContain("## User messages (verbatim; authoritative)");
		expect(entry.summary).toContain("MUST keep X");
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("commits a ready handoff on manual compaction", async () => {
		maintenance = createMaintenance({ methodOrder: ["slm"], prepareSlmHandoff: async () => HANDOFF });
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(new Error("the main model must not summarize for slm"));

		await maintenance.compact();

		const entry = latestCompaction();
		expect(entry.method).toBe("slm");
		expect(entry.summary).toContain("MUST keep X");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("skips slm for focus instructions, which a precomputed handoff cannot honor", async () => {
		maintenance = createMaintenance({ methodOrder: ["slm", "soft"], prepareSlmHandoff: async () => HANDOFF });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "focused summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		await maintenance.compact("focus on the parser");

		const entry = latestCompaction();
		expect(entry.method).toBe("soft");
		expect(entry.summary).toContain("focused summary");
		expect(entry.summary).toContain("## User messages (verbatim; authoritative)");
		expect(prepareCalls).toHaveLength(0);
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});
});
