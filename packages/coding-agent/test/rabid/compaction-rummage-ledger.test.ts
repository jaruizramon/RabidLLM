/**
 * Manual `/compact` opens the same archive ledger as automatic maintenance:
 * the status panel must show it without any `auto_compaction_*` event.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("manual compaction archive ledger", () => {
	let session: AgentSession;
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `omp-rummage-ledger-${Snowflake.next()}`);
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		removeSyncWithRetries(tempDir);
	});

	it("closes the ledger with the compaction result", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["## Summary\nKept the decisions."] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		for (let turn = 0; turn < 3; turn++) {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `question ${turn} ${"context ".repeat(400)}` }],
				timestamp: Date.now() - 2,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `answer ${turn} ${"detail ".repeat(400)}` }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 1_000,
					output: 200,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_200,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now() - 1,
			});
		}
		authStorage = await AuthStorage.create(":memory:");
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.keepRecentTokens": 1,
				"compaction.methodOrder": ["soft"],
				"compaction.autoContinue": false,
			}),
			modelRegistry: new ModelRegistry(authStorage),
			sideStreamFn: mock.stream,
		});

		const result = await session.compact();

		const rummage = session.getCompactionRummage();
		expect(rummage).toMatchObject({ action: "context-full", phase: "rewriting", skipped: false });
		expect(rummage?.endedAt).toBeNumber();
		expect(rummage?.tokensBefore).toBe(result.tokensBefore);
		expect(rummage?.tokensBefore).toBeGreaterThan(0);
	});
});
