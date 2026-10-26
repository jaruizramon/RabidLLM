/**
 * Deterministic post-processing for SLM handoff documents.
 *
 * The worker is instructed to keep `### Done` as a cumulative ledger, but it is
 * also told to shrink older detail and is capped by `maxHandoffTokens`. When the
 * cap is hit, completed audit items fall out of the ledger while the retained
 * tail still begins with the assistant's "now check X" step. The successor then
 * redoes X, then the next item, then the next — a loop that has no new input.
 *
 * Merge the previous ledger back in and remove any item that is already Done
 * from `In progress`/`Pending`. This is deliberately outside the model: the
 * worker can regress on a long document, but a completed check must never be
 * reported as outstanding.
 */

const DONE = "### Done";
const IN_PROGRESS = "### In progress";
const PENDING = "### Pending";

interface SectionRange {
	heading: number;
	end: number;
}

function findSection(lines: string[], heading: string): SectionRange | null {
	const headingIndex = lines.findIndex(line => line.trim() === heading);
	if (headingIndex < 0) return null;
	let end = headingIndex + 1;
	while (end < lines.length && !/^#{2,3}\s/.test(lines[end])) end++;
	return { heading: headingIndex, end };
}

function bulletText(line: string): string | null {
	const match = line.match(/^\s*[-*]\s+(.+?)\s*$/);
	return match ? match[1] : null;
}

/** Same item across reworded ledger lines: case, whitespace, trailing punctuation, and leading verification verbs. */
function ledgerKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/^(reviewed|reviewing|verified|verifying|confirmed|confirming|checked|checking)\s+/, "")
		.replace(/[.;:,]+$/, "")
		.trim();
}

function sectionBullets(text: string, heading: string): string[] {
	const lines = text.split("\n");
	const range = findSection(lines, heading);
	if (!range) return [];
	const bullets: string[] = [];
	for (let i = range.heading + 1; i < range.end; i++) {
		const bullet = bulletText(lines[i]);
		if (bullet) bullets.push(bullet);
	}
	return bullets;
}

function replaceSection(lines: string[], heading: string, bullets: string[]): string[] {
	const range = findSection(lines, heading);
	const body = bullets.map(bullet => `- ${bullet}`);
	if (range) {
		const before = lines.slice(0, range.heading + 1);
		const after = lines.slice(range.end);
		const next = [...before, ...body];
		if (after.length > 0 && next[next.length - 1] !== "") next.push("");
		return [...next, ...after];
	}
	// No Done section: put the ledger before the next progress section, or at the end.
	const insertAt = [IN_PROGRESS, PENDING]
		.map(candidate => lines.findIndex(line => line.trim() === candidate))
		.filter(index => index >= 0)
		.sort((a, b) => a - b)[0];
	const section = ["", heading, ...body];
	if (insertAt === undefined) return [...lines, ...section];
	return [...lines.slice(0, insertAt), ...section, "", ...lines.slice(insertAt)];
}

function dropDoneFromSection(lines: string[], heading: string, done: Set<string>): string[] {
	const range = findSection(lines, heading);
	if (!range) return lines;
	const kept: string[] = [];
	for (let i = range.heading + 1; i < range.end; i++) {
		const bullet = bulletText(lines[i]);
		if (bullet && done.has(ledgerKey(bullet))) continue;
		kept.push(lines[i]);
	}
	return [...lines.slice(0, range.heading + 1), ...kept, ...lines.slice(range.end)];
}

/**
 * Return `current` with the union of `previous` and `current` Done items, and
 * without any Done item repeated under `In progress` or `Pending`.
 */
export function mergeHandoffDone(previous: string | undefined, current: string): string {
	if (!previous) return current;
	const previousDone = sectionBullets(previous, DONE);
	if (previousDone.length === 0) return current;

	const merged: string[] = [];
	const done = new Set<string>();
	for (const bullet of [...previousDone, ...sectionBullets(current, DONE)]) {
		const key = ledgerKey(bullet);
		if (key === "" || done.has(key)) continue;
		done.add(key);
		merged.push(bullet);
	}

	let lines = current.split("\n");
	lines = replaceSection(lines, DONE, merged);
	lines = dropDoneFromSection(lines, IN_PROGRESS, done);
	lines = dropDoneFromSection(lines, PENDING, done);
	return lines.join("\n");
}
