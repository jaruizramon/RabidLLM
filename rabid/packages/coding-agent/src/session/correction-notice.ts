/**
 * Detect a user message that corrects the assistant's previous claim or method.
 *
 * This is deliberately narrower than "contains a negation": a prompt like
 * "do not use tabs" is a fresh constraint, not a correction of the last answer.
 * The patterns below target the shapes users actually type when an answer is
 * wrong ("it's not a cube", "stop going around circles", "still wrong"), so the
 * harness can inject the correction protocol without waiting for a loop guard.
 */
const CORRECTION_PATTERNS: readonly RegExp[] = [
	/^(?:no|nope|nah)\b/i,
	/^wrong\b/i,
	/^still\b/i,
	/^again\b/i,
	/^it['’]?s\s+not/i,
	/^that['’]?s\s+not/i,
	/^i\s+said\b/i,
	/^stop$/i,
	/^stop\s+(?:going|doing|making|reading|searching|guessing|it|that|this)\b/i,
	/\bstop\s+going\s+(?:around\s+)?(?:in\s+)?circles\b/i,
	/\bchill\s+(?:with|out)\b/i,
	/\bcalm\s+down\b/i,
];

export function isUserCorrection(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed === "") return false;
	return CORRECTION_PATTERNS.some(pattern => pattern.test(trimmed));
}
