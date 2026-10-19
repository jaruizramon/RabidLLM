/**
 * Deterministic run-length compaction for pasted text.
 *
 * Only *consecutive* equal lines merge, so distinct messages and their relative
 * order survive. A run of more than `minRun` lines becomes one verbatim copy
 * plus a marker line `   [×N]`; blank lines are never collapsed because they are
 * structure, not noise.
 */

const MARKER_INDENT = "   ";

export interface CompactRepeatedLinesResult {
	/** The compacted body (no header). */
	text: string;
	/** Lines in the input, including the empty segment after a trailing newline. */
	beforeLines: number;
	/** Lines in the compacted body. */
	afterLines: number;
	/** Lines removed by collapsing (sum of `run - 1` over collapsed runs). */
	collapsedLines: number;
	/** Distinct input lines. */
	uniqueLines: number;
}

/**
 * Collapse consecutive identical lines. `minRun` is the longest run left
 * untouched (default 2, so a pair is preserved); runs longer than it become
 * `line\n   [×N]`.
 */
export function compactRepeatedLines(text: string, options: { minRun?: number } = {}): CompactRepeatedLinesResult {
	const minRun = Math.max(2, Math.floor(options.minRun ?? 2));
	const lines = text.split("\n");
	const output: string[] = [];
	const unique = new Set<string>();
	let collapsedLines = 0;

	for (let index = 0; index < lines.length;) {
		const line = lines[index]!;
		let end = index + 1;
		while (end < lines.length && lines[end] === line) end++;
		const run = end - index;
		unique.add(line);
		if (line !== "" && run > minRun) {
			output.push(line, `${MARKER_INDENT}[×${run}]`);
			collapsedLines += run - 1;
		} else {
			for (let copy = 0; copy < run; copy++) output.push(line);
		}
		index = end;
	}

	return {
		text: output.join("\n"),
		beforeLines: lines.length,
		afterLines: output.length,
		collapsedLines,
		uniqueLines: unique.size,
	};
}
