import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	extractSlmHandoffGoal,
	formatSlmHandoffFile,
	isSlmHandoffConfigured,
	parseSlmHandoffFile,
	readSlmHandoff,
	renderVerbatimUserRequirements,
	slmHandoffFilePaths,
	verbatimRequirementBodies,
	writeSlmHandoff,
	type SlmHandoffMetadata,
	type SlmHandoffRecord,
} from "@oh-my-pi/pi-coding-agent/session/slm-handoff";
import { normalizeSlmOutput } from "@oh-my-pi/pi-coding-agent/session/slm-server";
import slmHandoffSystemPrompt from "../src/prompts/system/slm-handoff.md" with { type: "text" };
import { prompt } from "@oh-my-pi/pi-utils";
import { extractFileActions, renderFileActions } from "@oh-my-pi/pi-coding-agent/session/turn-cards";

const TEMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "slm-handoff-test-"));
const SESSION_IDS: string[] = [];

function uniqueSessionId(): string {
	const sessionId = `test-${crypto.randomUUID()}`;
	SESSION_IDS.push(sessionId);
	return sessionId;
}

function metadata(overrides: Partial<SlmHandoffMetadata> = {}): SlmHandoffMetadata {
	return {
		version: 1,
		sessionId: "test",
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
		...overrides,
	};
}

function record(overrides: Partial<SlmHandoffMetadata> = {}, document = "## Goal\nShip it\n"): SlmHandoffRecord {
	return { document, metadata: metadata(overrides) };
}

function userMessage(text: string, extra: Record<string, unknown> = {}): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1, ...extra } as unknown as AgentMessage;
}

afterAll(async () => {
	for (const sessionId of SESSION_IDS) {
		const paths = slmHandoffFilePaths(TEMP_ROOT, sessionId);
		await fs.rm(paths.ram, { force: true });
		await fs.rm(paths.disk, { recursive: true, force: true });
	}
	await fs.rm(TEMP_ROOT, { recursive: true, force: true });
});

describe("SLM handoff file", () => {
	it("round-trips the document and its metadata through the comment envelope", () => {
		const original = record({ coveredAt: 42, coveredUserTurns: 3 }, "## Goal\nKeep the parser\n");
		const parsed = parseSlmHandoffFile(formatSlmHandoffFile(original));

		expect(parsed?.document).toBe("## Goal\nKeep the parser");
		expect(parsed?.metadata).toEqual(original.metadata);
	});

	it("keeps the document readable when the metadata comment is absent", () => {
		const parsed = parseSlmHandoffFile("# Hand-written handoff\n\n## Goal\nManual\n");

		expect(parsed).toEqual({ document: "# Hand-written handoff\n\n## Goal\nManual" });
		expect(parsed?.metadata).toBeUndefined();
	});

	it("keeps the document when the metadata comment is not valid JSON", () => {
		const raw = "<!-- rabid-slm-handoff\n{not json}\n-->\n\n## Goal\nSalvage me\n";
		const parsed = parseSlmHandoffFile(raw);

		expect(parsed?.document).toBe("## Goal\nSalvage me");
		expect(parsed?.metadata).toBeUndefined();
	});

	it("rejects an empty document", () => {
		expect(parseSlmHandoffFile("   \n\n")).toBeUndefined();
		expect(parseSlmHandoffFile("<!-- rabid-slm-handoff\n{}\n-->\n\n")).toBeUndefined();
	});
});

describe("normalizeSlmOutput", () => {
	it("keeps only the answer after the last think close", () => {
		const result = normalizeSlmOutput("<think>pondering</think>## Goal\nShip it");

		expect(result.document).toBe("## Goal\nShip it\n");
		expect(result.document).not.toContain("pondering");
		expect(result.formatFallback).toBe(false);
	});

	it("strips a Markdown fence and drops prose before the first heading", () => {
		const result = normalizeSlmOutput("Sure, here it is:\n\n```markdown\n## Goal\nShip it\n```\n");

		expect(result.document).toBe("## Goal\nShip it\n");
		expect(result.formatFallback).toBe(false);
	});

	it("wraps heading-less text as a handoff and flags the fallback", () => {
		const result = normalizeSlmOutput("The parser needs a rewrite.");

		expect(result.document).toBe("## Handoff\n\nThe parser needs a rewrite.\n");
		expect(result.formatFallback).toBe(true);
	});

	it("returns an empty document for empty output", () => {
		expect(normalizeSlmOutput("  \n").document).toBe("");
	});
});

describe("handoff detail register", () => {
	const render = (detail: "concise" | "standard" | "detailed") =>
		prompt.render(slmHandoffSystemPrompt, {
			maxHandoffTokens: 2048,
			detailConcise: detail === "concise",
			detailStandard: detail === "standard",
			detailDetailed: detail === "detailed",
		});

	it("emits exactly one register, so the worker never sees two instructions", () => {
		const detailed = render("detailed");
		expect(detailed).toContain("successor who has none of this context");
		expect(detailed).not.toContain("Bullets only");

		const concise = render("concise");
		expect(concise).toContain("Bullets only");
		expect(concise).not.toContain("successor who has none of this context");
	});

	it("asks the detailed register for paths, commands, and reasons", () => {
		const detailed = render("detailed");
		expect(detailed).toContain("exact path and symbol");
		expect(detailed).toContain("the exact command and its outcome");
		expect(detailed).toContain("Spell out abbreviations");
	});
});

describe("file actions", () => {
	const call = (name: string, args: Record<string, unknown>) =>
		({
			role: "assistant",
			content: [{ type: "toolCall", id: `${name}-1`, name, arguments: args }],
			timestamp: 1,
		}) as unknown as AgentMessage;

	it("reduces tool calls to the action they performed", () => {
		const actions = extractFileActions([
			call("edit", { path: "src/parser.ts" }),
			call("write", { path: "docs/parser.md" }),
			call("read", { path: "src/lexer.ts" }),
			call("grep", { pattern: "TODO", path: "src" }),
			call("bash", { command: "git status --short\nnpm test" }),
			call("task", { prompt: "explore" }),
		]);

		expect(actions).toEqual([
			{ kind: "edit", label: "src/parser.ts" },
			{ kind: "write", label: "docs/parser.md" },
			{ kind: "read", label: "src/lexer.ts" },
			{ kind: "search", label: "TODO in src" },
			{ kind: "bash", label: "git status --short" },
			{ kind: "other", label: "task" },
		]);
	});

	it("collapses consecutive repeats and keeps only the newest actions", () => {
		const repeated = renderFileActions([call("edit", { path: "a.ts" }), call("edit", { path: "a.ts" })]);
		expect(repeated).toBe("## Recent file actions\n\n- edit `a.ts` (×2)");

		const many = Array.from({ length: 30 }, (_, index) => call("read", { path: `f${index}.ts` }));
		const trimmed = renderFileActions(many, 3);
		expect(trimmed).toContain("f29.ts");
		expect(trimmed).not.toContain("f26.ts");
	});

	it("is empty when a turn made no tool calls", () => {
		expect(renderFileActions([userMessage("just talking")])).toBe("");
	});
});

describe("extractSlmHandoffGoal", () => {
	it("returns the first non-empty line under the Goal heading", () => {
		const goal = extractSlmHandoffGoal("## Goal\n\nRewrite the tokenizer\n\n## Progress\n### Done\n");

		expect(goal).toBe("Rewrite the tokenizer");
	});

	it("falls back when the document has no goal line", () => {
		expect(extractSlmHandoffGoal("## Progress\n### Done\n")).toBe("SLM handoff");
	});
});

describe("handoff isolation", () => {
	it("gives two ids that sanitize alike two different files", () => {
		const colon = slmHandoffFilePaths(TEMP_ROOT, "a:b");
		const space = slmHandoffFilePaths(TEMP_ROOT, "a b");
		const slash = slmHandoffFilePaths(TEMP_ROOT, "a/b");

		expect(colon.disk).not.toBe(space.disk);
		expect(space.disk).not.toBe(slash.disk);
		// Readability is preserved: the prefix is still visible.
		for (const p of [colon, space, slash]) expect(path.basename(p.disk).startsWith("a_")).toBe(true);
	});

	it("namespaces the RAM copy by agent dir, so profiles cannot shadow each other", () => {
		const a = slmHandoffFilePaths(TEMP_ROOT, "session-1");
		const b = slmHandoffFilePaths(path.join(TEMP_ROOT, "other-agent"), "session-1");

		expect(path.basename(a.ram)).toBe(path.basename(b.ram));
		expect(path.dirname(a.ram)).not.toBe(path.dirname(b.ram));
	});

	it("refuses a copy whose metadata names a different session", async () => {
		const sessionId = uniqueSessionId();
		const paths = slmHandoffFilePaths(TEMP_ROOT, sessionId);
		await fs.mkdir(path.dirname(paths.disk), { recursive: true });
		// A file that landed at this session's path but belongs to another transcript.
		await Bun.write(paths.disk, formatSlmHandoffFile(record({ sessionId: "someone-else" })));

		expect(await readSlmHandoff(TEMP_ROOT, sessionId)).toBeUndefined();
	});
});

describe("handoff storage", () => {
	it("writes the RAM and disk copies and reads the newest", async () => {
		const sessionId = uniqueSessionId();
		const first = record({ sessionId, coveredAt: 1_000, coveredLeafKey: "user:1" }, "## Goal\nFirst\n");
		await writeSlmHandoff(TEMP_ROOT, sessionId, first);

		const paths = slmHandoffFilePaths(TEMP_ROOT, sessionId);
		expect(await Bun.file(paths.ram).text()).toContain("First");
		expect(await Bun.file(paths.disk).text()).toContain("First");
		expect((await readSlmHandoff(TEMP_ROOT, sessionId))?.document).toBe("## Goal\nFirst");

		// Only the disk copy advances: the reader must prefer it by `coveredAt`.
		const second = record({ sessionId, coveredAt: 2_000, coveredLeafKey: "user:2" }, "## Goal\nSecond\n");
		await Bun.write(paths.disk, formatSlmHandoffFile(second));

		const newest = await readSlmHandoff(TEMP_ROOT, sessionId);
		expect(newest?.document).toBe("## Goal\nSecond");
		expect(newest?.metadata?.coveredLeafKey).toBe("user:2");
	});

	it("treats missing files as an absent handoff", async () => {
		expect(await readSlmHandoff(TEMP_ROOT, uniqueSessionId())).toBeUndefined();
	});
});

describe("renderVerbatimUserRequirements", () => {
	it("keeps user text verbatim and excludes non-operator messages", () => {
		const messages = [
			userMessage("MUST use port 8451 for the test server."),
			{
				role: "assistant",
				content: [{ type: "text", text: "assistant prose" }],
				timestamp: 2,
			} as unknown as AgentMessage,
			{
				role: "toolResult",
				content: [{ type: "text", text: "tool output" }],
				timestamp: 3,
			} as unknown as AgentMessage,
			userMessage("injected by the harness", { attribution: "agent" }),
			userMessage("auto continue", { synthetic: true }),
		];

		const rendered = renderVerbatimUserRequirements(messages, 4_096);

		expect(rendered).toContain("## User messages (verbatim; authoritative)");
		expect(rendered).toContain("MUST use port 8451 for the test server.");
		expect(rendered).not.toContain("assistant prose");
		expect(rendered).not.toContain("tool output");
		expect(rendered).not.toContain("injected by the harness");
		expect(rendered).not.toContain("auto continue");
	});

	it("returns nothing when no operator message survives the filter", () => {
		expect(renderVerbatimUserRequirements([userMessage("steer", { attribution: "agent" })], 4_096)).toBe("");
	});

	it("carries an earlier compaction's requirements forward when the pass has none of its own", () => {
		const previousSummary = [
			"## Goal",
			"Ship it",
			"",
			"## User messages (verbatim; authoritative)",
			"",
			"### User message 1",
			"MUST use port 8451 for the test server.",
			"",
			"### User message 2",
			"NEVER touch 8080.",
		].join("\n");
		// An auto-retry turn: the only "user" messages are harness-authored.
		const retryMessages = [userMessage("continue", { attribution: "agent", synthetic: true })];

		const rendered = renderVerbatimUserRequirements(retryMessages, 4_096, previousSummary);

		expect(verbatimRequirementBodies(rendered)).toEqual([
			"MUST use port 8451 for the test server.",
			"NEVER touch 8080.",
		]);
		expect(rendered.indexOf("port 8451")).toBeLessThan(rendered.indexOf("8080"));
	});

	it("does not duplicate a requirement the previous block already holds", () => {
		const requirement = "MUST use port 8451 for the test server.";
		const previousSummary = `## User messages (verbatim; authoritative)\n\n### User message 1\n${requirement}`;

		const rendered = renderVerbatimUserRequirements([userMessage(requirement)], 4_096, previousSummary);

		expect(verbatimRequirementBodies(rendered)).toEqual([requirement]);
	});

	it("middle-truncates while keeping the first and last messages", () => {
		const messages = Array.from({ length: 5 }, (_, index) =>
			userMessage(`requirement-${index + 1} ${"x".repeat(100)}`),
		);

		const rendered = renderVerbatimUserRequirements(messages, 10);

		expect(rendered).toContain("requirement-1");
		expect(rendered).toContain("… middle user messages omitted …");
		expect(rendered).toContain("requirement-5");
		expect(rendered).not.toContain("requirement-3");
	});
});

describe("isSlmHandoffConfigured", () => {
	it("is false when the model file is missing", () => {
		expect(
			isSlmHandoffConfigured({
				slmHandoffModelPath: path.join(TEMP_ROOT, "absent.gguf"),
				slmHandoffServerPath: "",
			}),
		).toBe(false);
	});

	it("is true when the model file and the server binary both resolve", async () => {
		const modelPath = path.join(TEMP_ROOT, "present.gguf");
		const serverPath = path.join(TEMP_ROOT, "fake-llama-server");
		await Bun.write(modelPath, "weights");
		await Bun.write(serverPath, "#!/bin/sh\nexit 0\n");
		await fs.chmod(serverPath, 0o755);

		expect(isSlmHandoffConfigured({ slmHandoffModelPath: modelPath, slmHandoffServerPath: serverPath })).toBe(true);
	});
});
