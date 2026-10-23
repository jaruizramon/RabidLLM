/**
 * The `/artifacts` viewer: a small loopback HTTP gallery opened in the
 * user's browser. A browser window renders sprites, images, and SVG natively
 * and shows webpages through a cached Chromium screenshot, so the terminal
 * never has to draw the artifact.
 *
 * Routes:
 * - `GET /` — the gallery page.
 * - `GET /api/artifacts[?refresh=1]` — the session's visual files.
 * - `GET /file?path=…` — raw raster/SVG bytes (current artifacts only).
 * - `GET /api/preview?path=…[&refresh=1]` — a webpage screenshot PNG.
 * - `POST /api/open` `{path}` — open the original file with the OS handler.
 *
 * The server binds an ephemeral loopback port and is stopped with the
 * session; it never listens beyond `127.0.0.1`.
 */
import * as path from "node:path";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { webpageTitle } from "@oh-my-pi/pi-tui/tools/artifacts";
import type { VisualArtifact } from "./collect";
import { loadWebpagePreview } from "./preview";
import viewerHtml from "./viewer.html.txt" with { type: "text" };

export interface ArtifactViewerOptions {
	/** Directory shown in the gallery header (read per response). */
	readonly cwd: () => string;
	/** Re-discover the current session's visual artifacts. */
	readonly collect: () => Promise<readonly VisualArtifact[]>;
	/** Hand a file to the platform's default handler. */
	readonly openPath: (filePath: string) => void;
	/** How long a list response is reused before re-scanning. Defaults to 3000ms. */
	readonly listTtlMs?: number;
}

export interface ArtifactViewer {
	/** The gallery URL, always on loopback. */
	readonly url: string;
	stop(): void;
}

interface ViewerArtifact {
	readonly path: string;
	readonly name: string;
	readonly displayPath: string;
	readonly kind: VisualArtifact["kind"];
	readonly size: number;
	readonly mtimeMs: number;
	readonly source: VisualArtifact["source"];
	readonly tool?: string;
	readonly title?: string;
}

const DEFAULT_LIST_TTL_MS = 3000;
const TITLE_READ_BYTES = 16 * 1024;

function jsonError(message: string, status: number): Response {
	return Response.json({ error: message }, { status });
}

/** Browser-facing shape of an artifact, including a webpage's `<title>` when it has one. */
async function describeArtifact(artifact: VisualArtifact): Promise<ViewerArtifact> {
	let title: string | undefined;
	if (artifact.kind === "webpage") {
		try {
			const head = await Bun.file(artifact.path).slice(0, TITLE_READ_BYTES).text();
			title = webpageTitle(head);
		} catch {
			title = undefined;
		}
	}
	return {
		path: artifact.path,
		name: path.basename(artifact.path),
		displayPath: artifact.displayPath,
		kind: artifact.kind,
		size: artifact.size,
		mtimeMs: artifact.mtimeMs,
		source: artifact.source,
		tool: artifact.tool,
		title,
	};
}

export function startArtifactViewer(options: ArtifactViewerOptions): ArtifactViewer {
	const ttl = options.listTtlMs ?? DEFAULT_LIST_TTL_MS;
	let cached: VisualArtifact[] = [];
	let cachedAt = 0;
	let refreshing: Promise<VisualArtifact[]> | undefined;

	async function list(force: boolean): Promise<VisualArtifact[]> {
		if (!force && Date.now() - cachedAt < ttl) return cached;
		// Coalesce concurrent polls into one scan rather than one per request.
		if (refreshing) return refreshing;
		refreshing = (async () => {
			const next = [...(await options.collect())];
			cached = next;
			cachedAt = Date.now();
			return next;
		})();
		try {
			return await refreshing;
		} finally {
			refreshing = undefined;
		}
	}

	async function findArtifact(absolutePath: string): Promise<VisualArtifact | undefined> {
		const fresh = await list(false);
		const found = fresh.find(artifact => artifact.path === absolutePath);
		if (found) return found;
		// A just-created file may postdate the cache window; rescan once.
		const rescan = await list(true);
		return rescan.find(artifact => artifact.path === absolutePath);
	}

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/" || url.pathname === "/index.html") {
			return new Response(viewerHtml, {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			});
		}
		if (url.pathname === "/api/artifacts") {
			try {
				const artifacts = await list(url.searchParams.get("refresh") === "1");
				const described = await Promise.all(artifacts.map(describeArtifact));
				return Response.json(
					{ cwd: options.cwd(), artifacts: described, generatedAt: Date.now() },
					{ headers: { "cache-control": "no-store" } },
				);
			} catch (error) {
				logger.warn("artifact viewer: scan failed", { error: String(error) });
				return jsonError("Could not scan artifacts", 500);
			}
		}
		if (url.pathname === "/file") {
			const requested = url.searchParams.get("path");
			if (!requested) return jsonError("path is required", 400);
			const artifact = await findArtifact(requested);
			if (!artifact) return jsonError("Unknown artifact", 404);
			if (artifact.kind === "webpage") return jsonError("Open the page instead of its source", 400);
			const file = Bun.file(artifact.path);
			if (!(await file.exists())) return jsonError("Artifact is gone", 404);
			const contentType = artifact.kind === "svg" ? "image/svg+xml" : file.type || "application/octet-stream";
			return new Response(file, {
				headers: {
					"content-type": contentType,
					"cache-control": "private, max-age=60",
				},
			});
		}
		if (url.pathname === "/api/preview") {
			const requested = url.searchParams.get("path");
			if (!requested) return jsonError("path is required", 400);
			const artifact = await findArtifact(requested);
			if (!artifact) return jsonError("Unknown artifact", 404);
			if (artifact.kind !== "webpage") return jsonError("Preview is only for webpages", 400);
			const preview = await loadWebpagePreview(artifact, url.searchParams.get("refresh") === "1");
			if (preview.status === "error") return jsonError(preview.message, 500);
			return new Response(preview.png, {
				headers: {
					"content-type": "image/png",
					"cache-control": "private, max-age=60",
				},
			});
		}
		if (url.pathname === "/api/open") {
			if (request.method !== "POST") return jsonError("POST required", 405);
			const body = await request.json().catch(() => undefined);
			if (!isRecord(body) || typeof body.path !== "string") return jsonError("path is required", 400);
			const artifact = await findArtifact(body.path);
			if (!artifact) return jsonError("Unknown artifact", 404);
			options.openPath(artifact.path);
			return Response.json({ ok: true });
		}
		return new Response("Not found", { status: 404 });
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 64 * 1024,
		fetch: request => handle(request),
	});
	return { url: server.url.href, stop: () => server.stop(true) };
}
