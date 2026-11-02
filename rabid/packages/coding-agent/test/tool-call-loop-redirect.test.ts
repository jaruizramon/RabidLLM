import { describe, expect, test } from "bun:test";
import { renderToolCallLoopRedirect } from "@oh-my-pi/pi-coding-agent/session/tool-call-loop-redirect";

/**
 * The corrective is the only thing the model sees after a loop, so the branch
 * and the interpolated signature are the contract: a wrong variable name
 * renders an empty signature and corrects nothing.
 */
describe("tool-call loop redirect", () => {
	test("names the recurring error for a repeated failure", () => {
		const text = renderToolCallLoopRedirect({
			kind: "repeated_tool_failure",
			toolName: "bash",
			count: 4,
			signature: "E0107: missing generics for struct `Next`",
			resultSummary: "error[E0107]: missing generics for struct `Next`",
			argumentsSummary: '{"command":"cd backend && cargo build --release"}',
		});
		expect(text).toContain("E0107: missing generics for struct `Next`");
		expect(text).toContain("4 consecutive times");
		expect(text).not.toContain("probe sequence");
	});

	test("keeps the identical-arguments corrective when no signature is involved", () => {
		const text = renderToolCallLoopRedirect({
			kind: "repeated_tool_call",
			toolName: "bash",
			count: 5,
			resultSummary: "(no output)",
			argumentsSummary: '{"command":"pytest -q"}',
		});
		expect(text).toContain("identical arguments");
		expect(text).not.toContain("consecutive times:");
	});
});
