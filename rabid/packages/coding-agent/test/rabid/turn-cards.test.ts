/** Turn cards: transcript rendering, tolerant JSON parsing, the 1024-token cap, and archive files. */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import {
	estimateCardTokens,
	parseTurnCard,
	renderOpenFailures,
	renderTodoLedger,
	renderTurnTranscript,
	readTurnCardChain,
	trimTurnCard,
	turnCardChainCoversRegion,
	writeTurnCard,
	type TurnCard,
} from "@oh-my-pi/pi-coding-agent/rabid/turn-cards";
import { TempDir } from "@oh-my-pi/pi-utils";

function turnMessages(): AgentMessage[] {
	return [
		{
			role: "user",
			content: [{ type: "text", text: "Fix the parser in foo.ts" }],
			timestamp: 1,
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Reading the relevant range." },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/foo.ts", offset: 40, limit: 80 } },
			],
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "export function parse() { /* body */ }" }],
			isError: false,
			timestamp: 3,
		},
	] as unknown as AgentMessage[];
}

describe("turn cards", () => {
	it("renders the turn's prompt, tool call and result", () => {
		const text = renderTurnTranscript(turnMessages());
		expect(text).toContain("USER:\nFix the parser in foo.ts");
		expect(text).toContain('CALL read({"path":"/tmp/foo.ts","offset":40,"limit":80})');
		expect(text).toContain("RESULT read:");
		expect(text).toContain("export function parse()");
		expect(text).not.toContain("ASSISTANT:\n\n");
	});

	it("reports a repeated failing call in the deterministic summary block", () => {
		const messages: AgentMessage[] = [];
		for (let index = 0; index < 3; index++) {
			const id = `call-${index}`;
			messages.push({
				role: "assistant",
				content: [{ type: "toolCall", id, name: "edit", arguments: { input: "[a.ts]\nPUT 1:\n+same" } }],
				timestamp: index * 2,
			} as unknown as AgentMessage);
			messages.push({
				role: "toolResult",
				toolCallId: id,
				toolName: "edit",
				content: [{ type: "text", text: "STOP. byte-identical no-op" }],
				isError: true,
				timestamp: index * 2 + 1,
			} as unknown as AgentMessage);
		}
		const block = renderOpenFailures(messages);
		expect(block).toContain("## Open failures");
		expect(block).toContain("`edit` repeated 3× with identical arguments");
		expect(block).toContain("byte-identical no-op");
		expect(block).toContain("do not record their targets as Done");
	});

	it("drops a failure a later call to the same tool resolved", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "fail", name: "bash", arguments: { command: "bun test" } }],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "fail",
				toolName: "bash",
				content: [{ type: "text", text: "1 failing" }],
				isError: true,
				timestamp: 2,
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "pass", name: "bash", arguments: { command: "bun test" } }],
				timestamp: 3,
			},
			{
				role: "toolResult",
				toolCallId: "pass",
				toolName: "bash",
				content: [{ type: "text", text: "all passed" }],
				isError: false,
				timestamp: 4,
			},
		] as unknown as AgentMessage[];
		expect(renderOpenFailures(messages)).toBe("");
	});

	it("parses strict or fenced JSON and rejects garbage", () => {
		const card = parseTurnCard(
			'```json\n{"prompt":"Fix foo","files":["/tmp/foo.ts"],"operations":[{"kind":"edit","path":"/tmp/foo.ts","detail":"@@ -40,2 +40,3","summary":"Moved the guard"}]}\n```',
		);
		expect(card).toEqual({
			prompt: "Fix foo",
			files: ["/tmp/foo.ts"],
			operations: [{ kind: "edit", path: "/tmp/foo.ts", detail: "@@ -40,2 +40,3", summary: "Moved the guard" }],
		});
		expect(parseTurnCard("not json")).toBeUndefined();
		expect(parseTurnCard('{"operations":[]}')).toBeUndefined();
	});

	it("enforces the token cap by shortening and dropping operations", () => {
		const operations = Array.from({ length: 12 }, (_, index) => ({
			kind: "read" as const,
			path: `/tmp/file-${index}.ts`,
			detail: `${index * 100}-${index * 100 + 80}`,
			summary: "word ".repeat(60).trim(),
		}));
		const card: TurnCard = { prompt: "Do the thing", files: ["/tmp/a", "/tmp/b"], operations };
		const trimmed = trimTurnCard(card, 300);
		expect(estimateCardTokens(trimmed)).toBeLessThanOrEqual(300);
		expect(trimmed.operations.length).toBeLessThan(operations.length);
		expect(trimmed.operations.every(operation => operation.summary.split(/\s+/).length <= 60)).toBe(true);
	});

	it("appends a JSONL record and a Markdown block under turn-cards/", async () => {
		using tempDir = TempDir.createSync("@pi-turn-cards-");
		const card: TurnCard = {
			prompt: "Fix foo",
			files: ["/tmp/foo.ts"],
			operations: [{ kind: "edit", path: "/tmp/foo.ts", detail: "@@ -1,2 +1,3", summary: "Added a guard" }],
		};

		await writeTurnCard(tempDir.path(), "session-1", card);
		await writeTurnCard(tempDir.path(), "session-1", card);

		const directory = path.join(tempDir.path(), "turn-cards");
		const jsonl = await fs.readFile(path.join(directory, "session-1.jsonl"), "utf8");
		const markdown = await fs.readFile(path.join(directory, "session-1.md"), "utf8");
		expect(jsonl.trim().split("\n")).toHaveLength(2);
		expect(JSON.parse(jsonl.trim().split("\n")[0]!)).toMatchObject({ prompt: "Fix foo", files: ["/tmp/foo.ts"] });
		expect(markdown).toContain("## [");
		expect(markdown).toContain("**edit** `/tmp/foo.ts @@ -1,2 +1,3`: Added a guard");
		const chain = await fs.readFile(path.join(directory, "session-1.chain.md"), "utf8");
		expect(chain).toBe(markdown);
	});

	it("reads the chain newest-last and tails it to the token budget", async () => {
		using tempDir = TempDir.createSync("@pi-turn-cards-chain-");
		for (const [index, prompt] of ["first", "second", "third"].entries()) {
			await writeTurnCard(tempDir.path(), "s", {
				prompt,
				files: [],
				operations: [
					{
						kind: "read",
						path: `/tmp/${index}.ts`,
						detail: `${index}`,
						summary: "word ".repeat(30).trim(),
					},
				],
			});
		}

		const full = await readTurnCardChain(tempDir.path(), "s", 10_000);
		expect(full.blocks).toBe(3);
		expect(full.truncated).toBe(false);
		expect(typeof full.newestTimestamp).toBe("number");
		expect(full.text.indexOf("first")).toBeLessThan(full.text.indexOf("third"));

		const tail = await readTurnCardChain(tempDir.path(), "s", 40);
		expect(tail.blocks).toBe(3);
		expect(tail.truncated).toBe(true);
		expect(tail.text).toContain("older cards omitted");
		expect(tail.text).toContain("third");
		expect(tail.text).not.toContain("first");
		expect(tail.newestTimestamp).toBe(full.newestTimestamp);
	});
});

describe("turn-card chain coverage", () => {
	const user = (timestamp: number) => ({ role: "user", content: [], timestamp }) as unknown as AgentMessage;
	const assistant = (timestamp: number) => ({ role: "assistant", content: [], timestamp }) as unknown as AgentMessage;

	it("rejects a chain whose newest card predates the summarized messages", () => {
		const messages = [user(1_000), assistant(2_000)];

		expect(turnCardChainCoversRegion(messages, 1, 1_500)).toBe(false);
		expect(turnCardChainCoversRegion(messages, 1, 2_000)).toBe(true);
	});

	it("rejects a chain with fewer cards than user turns", () => {
		expect(turnCardChainCoversRegion([user(1_000), user(2_000)], 1, 3_000)).toBe(false);
	});

	it("requires a timestamp and at least one message", () => {
		expect(turnCardChainCoversRegion([user(1_000)], 1, undefined)).toBe(false);
		expect(turnCardChainCoversRegion([], 0, 1_000)).toBe(false);
	});

	it("rejects a chain that stops at the previous turn when the current turn is mid-flight", () => {
		expect(turnCardChainCoversRegion([assistant(2_000)], 3, 1_000)).toBe(false);
		expect(turnCardChainCoversRegion([assistant(2_000)], 3, 2_500)).toBe(true);
	});
});

describe("todo ledger", () => {
	it("renders only open items with their phase and status", () => {
		const phases: TodoPhase[] = [
			{
				name: "Sprint 4 closeout",
				tasks: [
					{ content: "Check architecture.md", status: "in_progress" },
					{ content: "Commit Sprint 4", status: "pending" },
					{ content: "Add .gitignore entry", status: "completed" },
					{ content: "Old approach", status: "abandoned" },
				],
			},
			{
				name: "Sprint 5",
				tasks: [{ content: "Vendor chiptune2", status: "blocked", blocker: "license unconfirmed" }],
			},
		];

		const rendered = renderTodoLedger(phases);

		expect(rendered).toContain("## Todo (live)");
		expect(rendered).toContain("2/5 done, 3 open");
		expect(rendered).toContain("- Sprint 4 closeout");
		expect(rendered).toContain("  - [in_progress] Check architecture.md");
		expect(rendered).toContain("  - [pending] Commit Sprint 4");
		expect(rendered).not.toContain("Add .gitignore entry");
		expect(rendered).not.toContain("Old approach");
		expect(rendered).toContain("  - [blocked] Vendor chiptune2 — license unconfirmed");
	});

	it("renders nothing when every task is closed", () => {
		const phases: TodoPhase[] = [{ name: "Done", tasks: [{ content: "Ship it", status: "completed" }] }];

		expect(renderTodoLedger(phases)).toBe("");
	});
});
