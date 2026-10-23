import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import * as lsp from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

function makeSession(cwd: string, mode: "patch" | "hashline" = "patch"): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": mode }),
		getArtifactsDir: () => null,
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as ToolSession;
}

let tempDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-patch-unchanged-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(async () => {
	mock.restore();
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

describe("EditTool patch post-write verification", () => {
	test("returns the caller-facing path when a reported write leaves disk unchanged", async () => {
		const relPath = "deep/nested/foo.txt";
		await fs.mkdir(path.join(tempDir, "deep", "nested"), { recursive: true });
		await fs.writeFile(path.join(tempDir, relPath), "a\n");

		spyOn(lsp, "writethroughNoop").mockImplementation(async () => ({ finalContent: "" }));
		const result = await new EditTool(makeSession(tempDir), "patch").execute("unchanged", {
			path: relPath,
			edits: [{ op: "update", diff: "@@\n-a\n+b" }],
		});
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

		expect(result.isError).toBe(true);
		expect(text).toContain(`edit appeared successful but file content did not change on disk: ${relPath}`);
		expect(text).not.toContain(tempDir);
		expect(await Bun.file(path.join(tempDir, relPath)).text()).toBe("a\n");
	});

	test("returns an error with proof when the edit is a byte-identical no-op", async () => {
		await Bun.write(path.join(tempDir, "noop.txt"), "alpha\nbeta\n");
		const session = makeSession(tempDir, "hashline");
		const tool = new EditTool(session, "hashline");
		const header = textOutput(await new ReadTool(session).execute("read-noop", { path: "noop.txt" })).split("\n")[0];

		const first = await tool.execute("noop-first", { input: `${header}\nPUT 2-2:\n+BETA\n` });
		expect(first.isError).not.toBe(true);
		expect(await Bun.file(path.join(tempDir, "noop.txt")).text()).toBe("alpha\nBETA\n");

		// Re-read for the post-write tag: the body is identical, so the second
		// apply changes nothing.
		const headerAfter = textOutput(
			await new ReadTool(session).execute("read-noop-after", { path: "noop.txt" }),
		).split("\n")[0];
		const second = await tool.execute("noop-second", { input: `${headerAfter}\nPUT 2-2:\n+BETA\n` });
		const text = second.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(second.isError).toBe(true);
		expect(text).toContain("No file changed");
		expect(text).toContain("content-hash=");
		expect(text).toContain("Targeted rows: 2-2");
	});
});
