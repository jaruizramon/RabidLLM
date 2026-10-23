import { afterEach, describe, expect, it, vi } from "bun:test";
import { startArtifactViewer } from "@oh-my-pi/pi-coding-agent/artifacts/viewer";
import type { VisualArtifact } from "@oh-my-pi/pi-coding-agent/artifacts/collect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);
const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function fixture(): Promise<{ dir: string; artifacts: VisualArtifact[] }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-artifact-viewer-"));
	dirs.push(dir);
	const sprite = path.join(dir, "sprite.png");
	const page = path.join(dir, "page.html");
	await Bun.write(sprite, PNG);
	await Bun.write(page, "<!doctype html><title>Sprite sheet</title><h1>Heroes</h1>");
	const artifacts: VisualArtifact[] = [
		{
			path: page,
			displayPath: "page.html",
			kind: "webpage",
			size: 54,
			mtimeMs: Date.now(),
			source: "tool",
			tool: "write",
		},
		{
			path: sprite,
			displayPath: "sprite.png",
			kind: "image",
			size: PNG.length,
			mtimeMs: Date.now() - 1000,
			source: "workspace",
		},
	];
	return { dir, artifacts };
}

describe("artifact viewer", () => {
	it("lists artifacts, serves raw images, and opens files through the host", async () => {
		const { dir, artifacts } = await fixture();
		const opened: string[] = [];
		const viewer = startArtifactViewer({
			cwd: () => dir,
			collect: async () => artifacts,
			openPath: filePath => opened.push(filePath),
		});
		try {
			const listed = (await (await fetch(`${viewer.url}api/artifacts`)).json()) as {
				cwd: string;
				artifacts: Array<{ name: string; title?: string }>;
			};
			expect(listed.cwd).toBe(dir);
			expect(listed.artifacts.map(artifact => artifact.name)).toEqual(["page.html", "sprite.png"]);
			expect(listed.artifacts[0].title).toBe("Sprite sheet");

			const image = await fetch(`${viewer.url}file?path=${encodeURIComponent(artifacts[1]!.path)}`);
			expect(image.status).toBe(200);
			expect(image.headers.get("content-type")).toBe("image/png");
			expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);

			const pageSource = await fetch(`${viewer.url}file?path=${encodeURIComponent(artifacts[0]!.path)}`);
			expect(pageSource.status).toBe(400);

			const openResponse = await fetch(`${viewer.url}api/open`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: artifacts[1]!.path }),
			});
			expect(openResponse.status).toBe(200);
			expect(opened).toEqual([artifacts[1]!.path]);

			const unknown = await fetch(`${viewer.url}api/open`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: "/etc/passwd" }),
			});
			expect(unknown.status).toBe(404);
			expect(opened).toEqual([artifacts[1]!.path]);
		} finally {
			viewer.stop();
		}
	});

	it("reuses a list response inside its cache window", async () => {
		const { dir, artifacts } = await fixture();
		const collect = vi.fn(async () => artifacts);
		const viewer = startArtifactViewer({ cwd: () => dir, collect, openPath: () => {} });
		try {
			await fetch(`${viewer.url}api/artifacts`);
			await fetch(`${viewer.url}api/artifacts`);
			expect(collect).toHaveBeenCalledTimes(1);
			await fetch(`${viewer.url}api/artifacts?refresh=1`);
			expect(collect).toHaveBeenCalledTimes(2);
		} finally {
			viewer.stop();
		}
	});
});
