import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-tui/theme";
import { setArtifactPreviewsEnabled } from "@oh-my-pi/pi-tui/tools/artifacts";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";

const HTML =
	"<!doctype html><html><head><title>Sprite sheet</title></head><body><h1>Heroes</h1><p>Eight frames.</p></body></html>";
const SVG = "<svg viewBox='0 0 8 8'><rect width='8' height='8' fill='#f80'/></svg>";
const RESULT = { content: [{ type: "text", text: "Wrote" }], details: {} };
const originalImageProtocol = TERMINAL.imageProtocol;
let uiTheme: Theme;

const plain = (rows: readonly string[]): string => Bun.stripANSI(rows.join("\n"));

beforeAll(async () => {
	await initTheme(false);
	const theme = (await getThemeByName("dark")) ?? (await getThemeByName("light"));
	if (!theme) throw new Error("expected an initialized theme");
	uiTheme = theme;
});

afterEach(() => {
	setArtifactPreviewsEnabled(true);
	setTerminalImageProtocol(originalImageProtocol);
});

function renderWrite(path: string, content: string, expanded: boolean): readonly string[] {
	return writeToolRenderer.renderResult(RESULT, { expanded, isPartial: false }, uiTheme, { path, content }).render(80);
}

describe("write artifact previews", () => {
	it("replaces a settled webpage's source with its title and gallery hint", () => {
		const collapsed = plain(renderWrite("page.html", HTML, false));
		expect(collapsed).toContain("Webpage");
		expect(collapsed).toContain("Sprite sheet");
		expect(collapsed).toContain("/artifacts");
		expect(collapsed).not.toContain("<html");
		expect(collapsed).not.toContain("<h1");
		expect(plain(renderWrite("page.html", HTML, true))).toContain("<html");
	});

	it("keeps the source when previews are disabled", () => {
		setArtifactPreviewsEnabled(false);
		expect(plain(renderWrite("page.html", HTML, false))).toContain("<html");
	});

	it("hides an SVG's source once the terminal can draw it", () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const text = plain(renderWrite("hero.svg", SVG, false));
		expect(text).toContain("SVG");
		expect(text).toContain("/artifacts");
		expect(text).not.toContain("<svg");
	});

	it("describes the native result without the page source", () => {
		const view = writeToolRenderer.describeResult?.(
			RESULT,
			{ expanded: false, isPartial: false },
			{ path: "page.html", content: HTML },
		);
		const serialized = JSON.stringify(view);
		expect(serialized).toContain("Webpage");
		expect(serialized).not.toContain("<html");
	});
});
