import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { collectVisualArtifacts, scanWorkspaceVisualArtifacts } from "@oh-my-pi/pi-coding-agent/artifacts/collect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dirs: string[] = [];

async function workspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-artifact-gallery-"));
	dirs.push(dir);
	return dir;
}

async function file(dir: string, name: string, content = "x"): Promise<string> {
	const target = path.join(dir, name);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await Bun.write(target, content);
	return target;
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function assistant(id: string, name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "test",
		provider: "test",
		model: "test",
		timestamp: Date.now() - 60_000,
	} as unknown as AgentMessage;
}

function result(id: string, toolName: string, details: unknown, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [],
		details,
		isError,
		timestamp: Date.now() - 59_000,
	} as unknown as AgentMessage;
}

describe("visual artifact collection", () => {
	it("merges tool-reported writes with workspace-discovered visual files, newest first", async () => {
		const dir = await workspace();
		const now = Date.now();
		const since = now - 5 * 60_000;

		const sprite = await file(dir, "assets/sprite.png", "sprite");
		const page = await file(dir, "page.html", "<!doctype html><title>Page</title>");
		const old = await file(dir, "old.png", "old");
		const notes = await file(dir, "notes.txt", "notes");
		const failed = await file(await workspace(), "failed.png", "failed");
		const generated = await file(dir, "generated.webp", "generated");

		await fs.utimes(old, new Date(now - 60 * 60_000), new Date(now - 60 * 60_000));
		await fs.utimes(sprite, new Date(now - 2_000), new Date(now - 2_000));
		await fs.utimes(page, new Date(now - 1_000), new Date(now - 1_000));
		await fs.utimes(generated, new Date(now), new Date(now));

		const messages: AgentMessage[] = [
			{ role: "user", content: "make art", timestamp: since } as unknown as AgentMessage,
			assistant("w1", "write", { path: "assets/sprite.png", content: "sprite" }),
			result("w1", "write", { resolvedPath: sprite }),
			assistant("w2", "write", { path: "notes.txt", content: "notes" }),
			result("w2", "write", { resolvedPath: notes }),
			assistant("w3", "write", { path: "failed.png", content: "failed" }),
			result("w3", "write", { resolvedPath: failed }, true),
			assistant("g1", "generate_image", { prompt: "a sprite" }),
			result("g1", "generate_image", { imagePaths: [generated] }),
			assistant("e1", "edit", { path: "page.html" }),
			result("e1", "edit", { resolvedPath: page }),
		];

		const artifacts = await collectVisualArtifacts({ messages, cwd: dir, sinceMs: since });
		const byPath = new Map(artifacts.map(artifact => [artifact.path, artifact]));

		expect([...byPath.keys()].sort()).toEqual([page, sprite, generated].sort());
		expect(byPath.get(sprite)?.source).toBe("tool");
		expect(byPath.get(sprite)?.tool).toBe("write");
		expect(byPath.get(page)?.source).toBe("tool");
		expect(byPath.get(generated)?.source).toBe("tool");
		expect(byPath.has(old)).toBe(false);
		expect(byPath.has(notes)).toBe(false);
		expect(byPath.has(failed)).toBe(false);
		expect(artifacts.map(artifact => artifact.path)).toEqual([generated, page, sprite]);
	});

	it("scans only recent visual files and skips dependencies and hidden directories", async () => {
		const dir = await workspace();
		const now = Date.now();
		const recent = await file(dir, "images/hero.svg", "<svg></svg>");
		const old = await file(dir, "images/old.svg", "<svg></svg>");
		const dependency = await file(dir, "node_modules/pkg/icon.png", "png");
		const hidden = await file(dir, ".cache/icon.png", "png");
		await fs.utimes(old, new Date(now - 60 * 60_000), new Date(now - 60 * 60_000));

		const found = await scanWorkspaceVisualArtifacts(dir, now - 60_000);
		expect(found.map(artifact => artifact.path)).toEqual([recent]);
		expect(found.some(artifact => artifact.path === dependency)).toBe(false);
		expect(found.some(artifact => artifact.path === hidden)).toBe(false);
	});
});
