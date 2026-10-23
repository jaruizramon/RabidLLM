/**
 * Webpage thumbnails for the artifact gallery.
 *
 * A browser can render images and SVGs directly, but it cannot show a local
 * HTML file's rendered result inside the gallery without letting the page run
 * on the gallery's origin. Instead, the harness screenshots the page in the
 * same headless Chromium the browser tool uses and serves the PNG. The page is
 * loaded through a short-lived loopback server rooted at its own directory, so
 * relative CSS/JS/image references resolve (and snap-confined Chromium never
 * needs `file://` access).
 *
 * Screenshots are cached per content version under the agent directory;
 * `refresh` bypasses the cache.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { launchHeadlessBrowser, removeUserDataDir } from "../tools/browser/launch";
import type { VisualArtifact } from "./collect";

export type WebpagePreview =
	| { readonly status: "ready"; readonly png: Uint8Array; readonly cachePath: string }
	| { readonly status: "error"; readonly message: string };

const SCREENSHOT_WIDTH = 1280;
const SCREENSHOT_HEIGHT = 900;
const SCREENSHOT_TIMEOUT_MS = 20_000;
const PREVIEW_CACHE_DIR = "artifact-previews";

/** One screenshot at a time: each launch owns a browser process and profile. */
let screenshotQueue: Promise<unknown> = Promise.resolve();

function serializeScreenshot<T>(task: () => Promise<T>): Promise<T> {
	const next = screenshotQueue.then(task, task);
	screenshotQueue = next.catch(() => undefined);
	return next;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A loopback static server rooted at `root`, for the page and its relative assets. */
function serveArtifactDirectory(root: string): { readonly url: string; stop(): void } {
	const rootPath = path.resolve(root);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
			if (relative.length === 0) relative = "index.html";
			const target = path.resolve(rootPath, relative);
			if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
				return new Response("Forbidden", { status: 403 });
			}
			try {
				const real = await fs.realpath(target);
				if (real !== rootPath && !real.startsWith(`${rootPath}${path.sep}`)) {
					return new Response("Forbidden", { status: 403 });
				}
				const stat = await fs.stat(real);
				if (!stat.isFile()) return new Response("Not found", { status: 404 });
				return new Response(Bun.file(real));
			} catch {
				return new Response("Not found", { status: 404 });
			}
		},
	});
	return { url: server.url.href, stop: () => server.stop(true) };
}

/** Path of the cached screenshot for `htmlPath` at its current content version. */
async function previewCachePath(htmlPath: string, mtimeMs: number, size: number): Promise<string> {
	const key = Bun.hash(`${await fs.realpath(htmlPath)}:${mtimeMs}:${size}:${SCREENSHOT_WIDTH}x${SCREENSHOT_HEIGHT}`);
	return path.join(getAgentDir(), PREVIEW_CACHE_DIR, `${key.toString(36)}.png`);
}

/** Screenshot `htmlPath` through a loopback server, reusing the cached PNG when possible. */
export async function loadWebpagePreview(artifact: VisualArtifact, refresh = false): Promise<WebpagePreview> {
	try {
		const stat = await fs.stat(artifact.path);
		const cachePath = await previewCachePath(artifact.path, stat.mtimeMs, stat.size);
		if (!refresh) {
			try {
				const cached = await fs.readFile(cachePath);
				if (cached.length > 0) return { status: "ready", png: cached, cachePath };
			} catch {
				// missing cache: render below
			}
		}
		return await serializeScreenshot(async () => {
			const server = serveArtifactDirectory(path.dirname(artifact.path));
			const { browser, userDataDir } = await launchHeadlessBrowser({
				headless: true,
				viewport: { width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT, deviceScaleFactor: 1 },
			});
			try {
				const page = await browser.newPage();
				page.setDefaultTimeout(SCREENSHOT_TIMEOUT_MS);
				await page.goto(`${server.url}${encodeURIComponent(path.basename(artifact.path))}`, {
					waitUntil: "load",
					timeout: SCREENSHOT_TIMEOUT_MS,
				});
				// Wait for fonts, the main late-layout dependency after `load`.
				await page.evaluate("document.fonts.ready.then(() => true)");
				const png = await page.screenshot({ type: "png", fullPage: false });
				try {
					await Bun.write(cachePath, png);
				} catch {
					// A read-only cache still returns the screenshot.
				}
				return { status: "ready", png, cachePath };
			} finally {
				await browser.close().catch(() => undefined);
				if (userDataDir) await removeUserDataDir(userDataDir);
				server.stop();
			}
		});
	} catch (error) {
		return { status: "error", message: errorMessage(error) };
	}
}
