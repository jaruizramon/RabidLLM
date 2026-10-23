import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/**
 * Extensions where a CJK codepoint outside a string or comment is always a
 * generation defect. JSX/TSX is excluded: its text nodes legitimately contain
 * prose in any script.
 */
const ASCII_SOURCE_EXTENSIONS: Readonly<Record<string, true>> = {
	".js": true,
	".mjs": true,
	".cjs": true,
	".ts": true,
	".mts": true,
	".cts": true,
};

/** CJK blocks whose glyphs never belong in an ASCII-only JavaScript identifier. */
const CJK_CHAR = /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

export interface TokenCorruption {
	line: number;
	column: number;
	char: string;
}

/**
 * Find CJK characters emitted into JavaScript code outside strings and
 * comments. A 4B model occasionally splices a CJK glyph into an identifier or
 * numeric literal (`THREE.M方Utils`, `0x88a89振`); JavaScript accepts Unicode
 * identifiers, so the write succeeds and the defect only surfaces later as a
 * runtime error the model then "fixes" with a full rewrite.
 */
export function findTokenCorruption(content: string, filePath: string): TokenCorruption[] {
	if (!Object.hasOwn(ASCII_SOURCE_EXTENSIONS, path.extname(filePath).toLowerCase())) return [];

	const findings: TokenCorruption[] = [];
	let state: "code" | "lineComment" | "blockComment" | "single" | "double" | "template" = "code";
	for (let i = 0; i < content.length; i++) {
		const char = content[i]!;
		const next = content[i + 1];
		switch (state) {
			case "code":
				if (char === "/" && next === "/") {
					state = "lineComment";
					i++;
				} else if (char === "/" && next === "*") {
					state = "blockComment";
					i++;
				} else if (char === "'") {
					state = "single";
				} else if (char === '"') {
					state = "double";
				} else if (char === "`") {
					state = "template";
				} else if (CJK_CHAR.test(char) && (isAsciiIdentifierChar(content[i - 1]) || isAsciiIdentifierChar(next))) {
					// Only a CJK run spliced into an ASCII token is corruption: a
					// stand-alone Chinese identifier (`const 变量`) is valid JavaScript.
					findings.push({ ...lineColumnAt(content, i), char });
				}
				break;
			case "lineComment":
				if (char === "\n") state = "code";
				break;
			case "blockComment":
				if (char === "*" && next === "/") {
					state = "code";
					i++;
				}
				break;
			case "single":
				if (char === "\\") i++;
				else if (char === "'") state = "code";
				break;
			case "double":
				if (char === "\\") i++;
				else if (char === '"') state = "code";
				break;
			case "template":
				if (char === "\\") i++;
				else if (char === "`") state = "code";
				break;
		}
	}
	return findings;
}

/**
 * Refuse a write whose source text carries a CJK glyph in code position, with
 * the first occurrence named so the model can repair the exact identifier
 * instead of rewriting the file.
 */
export function assertNoSourceTokenCorruption(content: string, filePath: string, displayPath?: string): void {
	const findings = findTokenCorruption(content, filePath);
	if (findings.length === 0) return;
	const first = findings[0]!;
	const more = findings.length > 1 ? ` (+${findings.length - 1} more)` : "";
	throw new ToolError(
		`Refusing to write ${displayPath ?? filePath}: line ${first.line}, column ${first.column} contains "${first.char}" in JavaScript code${more}. ` +
			"This is token-generation corruption, not valid source. Re-read the surrounding identifier and write it again.",
	);
}

function isAsciiIdentifierChar(char: string | undefined): boolean {
	return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function lineColumnAt(content: string, index: number): { line: number; column: number } {
	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < index; i++) {
		if (content[i] === "\n") {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, column: index - lineStart + 1 };
}
