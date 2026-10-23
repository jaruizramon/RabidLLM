/**
 * Visual artifacts: files whose value is what they render, not their source
 * (images, sprites, SVGs, webpages). Shared by the write renderer (which hides
 * the source of a settled artifact write) and by the coding-agent's
 * `/artifacts` gallery.
 */

/** The kinds of file the artifact surfaces can show. */
export type VisualArtifactKind = "image" | "svg" | "webpage";

const IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"];
const SVG_EXTENSIONS: readonly string[] = ["svg"];
const WEBPAGE_EXTENSIONS: readonly string[] = ["html", "htm", "xhtml"];

/** How `filePath` renders, or `undefined` for a non-visual file. */
export function visualArtifactKind(filePath: string): VisualArtifactKind | undefined {
	const name = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1).toLowerCase();
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return undefined;
	const extension = name.slice(dot + 1);
	if (IMAGE_EXTENSIONS.includes(extension)) return "image";
	if (SVG_EXTENSIONS.includes(extension)) return "svg";
	if (WEBPAGE_EXTENSIONS.includes(extension)) return "webpage";
	return undefined;
}

/**
 * Whether settled tool writes of visual artifacts render as previews instead
 * of source. The `/artifacts` gallery stays available either way; this only
 * gates the transcript substitution.
 */
let previewsEnabled = true;

export function artifactPreviewsEnabled(): boolean {
	return previewsEnabled;
}

/** Set the transcript preview policy (the coding-agent setting effect). */
export function setArtifactPreviewsEnabled(enabled: boolean): void {
	previewsEnabled = enabled;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
		if (entity.startsWith("#")) {
			const hexadecimal = entity[1] === "x" || entity[1] === "X";
			const code = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
	});
}

function cleanMarkupText(text: string): string {
	return decodeEntities(text.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The title a webpage presents, for the transcript card and gallery list: its
 * `<title>`, else its first `<h1>`. Bounded source is fine; both tags appear
 * in the document head or near the top of the body.
 */
export function webpageTitle(source: string): string | undefined {
	const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source);
	const fromTitle = title ? cleanMarkupText(title[1] ?? "") : "";
	if (fromTitle.length > 0) return fromTitle;
	const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(source);
	const fromHeading = heading ? cleanMarkupText(heading[1] ?? "") : "";
	return fromHeading.length > 0 ? fromHeading : undefined;
}
