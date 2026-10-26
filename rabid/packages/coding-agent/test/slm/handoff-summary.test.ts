import { describe, expect, test } from "bun:test";
import { mergeHandoffDone } from "@oh-my-pi/pi-coding-agent/slm/handoff-summary";

const PREVIOUS = `## Goal
Audit the simulation layer.

## Progress
### Done
- Verified territory/expand/combat against PLAN.md.
- Confirmed economy income and market rules.
- Reviewed demil gates.
### In progress
- None.
### Pending
- None.

## Next steps
- Finish demil.`;

describe("mergeHandoffDone", () => {
	test("restores completed items and removes them from outstanding sections", () => {
		const current = `## Goal
Audit the simulation layer.

## Progress
### Done
- Confirmed economy income and market rules.
### In progress
- Reviewing territory/expand/combat against PLAN.md.
### Pending
- Reviewing demil gates.

## Next steps
- Finish demil.`;

		const merged = mergeHandoffDone(PREVIOUS, current);

		expect(merged).toContain("- Verified territory/expand/combat against PLAN.md.");
		expect(merged).toContain("- Confirmed economy income and market rules.");
		expect(merged).toContain("- Reviewed demil gates.");
		expect(merged).not.toContain("- Reviewing territory/expand/combat against PLAN.md.");
		expect(merged).not.toContain("- Reviewing demil gates.");
		expect(merged.match(/Confirmed economy income and market rules/g)).toHaveLength(1);
	});

	test("folds the same item when only the verification verb changed", () => {
		const current = `## Goal
Audit.

## Progress
### Done
- Reviewing demil gates.

## Next steps
- Finish.`;

		const merged = mergeHandoffDone(PREVIOUS, current);

		expect(merged.match(/demil gates/gi)).toHaveLength(1);
		expect(merged).toContain("- Verified territory/expand/combat against PLAN.md.");
		expect(merged).toContain("- Confirmed economy income and market rules.");
	});

	test("leaves the document unchanged without a previous ledger", () => {
		const current = "## Goal\nAudit.\n\n## Progress\n### Done\n- One.\n";
		expect(mergeHandoffDone(undefined, current)).toBe(current);
	});

	test("adds the previous ledger when the worker omitted the Done section", () => {
		const current = `## Goal
Audit.

## Progress
### In progress
- Reviewing territory/expand/combat against PLAN.md.

## Next steps
- Finish.`;

		const merged = mergeHandoffDone(PREVIOUS, current);

		expect(merged).toContain("### Done");
		expect(merged).toContain("- Verified territory/expand/combat against PLAN.md.");
		expect(merged).not.toContain("- Reviewing territory/expand/combat against PLAN.md.");
	});
});
