import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolFailureTracker, toolCallFingerprint } from "@oh-my-pi/pi-coding-agent/session/tool-failure-tracker";

function errorContent(text: string): AgentToolResult<unknown>["content"] {
	return [{ type: "text", text }];
}

describe("ToolFailureTracker", () => {
	it("blocks a third call with identical arguments after two failures", () => {
		const tracker = new ToolFailureTracker();
		const args = { op: '"init"', task: "build" };
		tracker.recordOutcome("todo", args, true, errorContent('Invalid todo arguments (was "\\"init\\"")'));
		tracker.recordOutcome("todo", args, true, errorContent('Invalid todo arguments (was "\\"init\\"")'));

		const blocked = tracker.beforeCall("todo", args);
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("Repeated-failure guard");
	});

	it("does not block when the arguments changed", () => {
		const tracker = new ToolFailureTracker();
		tracker.recordOutcome("bash", { command: '"echo hello"' }, true, errorContent("command not found: echo hello"));
		tracker.recordOutcome("bash", { command: '"echo test"' }, true, errorContent("command not found: echo hello"));

		expect(tracker.beforeCall("bash", { command: "echo hello" })).toBeUndefined();
	});

	it("steers on the second occurrence of the same error class", () => {
		const tracker = new ToolFailureTracker();
		const first = tracker.recordOutcome("write", { path: '"/a/b"' }, true, errorContent("File not found: a/b"));
		expect(first).toBeUndefined();
		const second = tracker.recordOutcome("write", { path: '"/a/c"' }, true, errorContent("File not found: a/b"));
		expect(second?.additionalContext).toContain("Repeated tool failure (2×)");
		expect(second?.additionalContext).toContain("argument-shape problem");
	});

	it("clears the loop counter after a successful call", () => {
		const tracker = new ToolFailureTracker();
		const args = { path: "same" };
		tracker.recordOutcome("read", args, true, errorContent("not found"));
		tracker.recordOutcome("read", args, false, errorContent("contents"));
		tracker.recordOutcome("read", args, true, errorContent("not found"));

		expect(tracker.beforeCall("read", args)).toBeUndefined();
	});

	it("fingerprints arguments independent of key order", () => {
		expect(toolCallFingerprint("bash", { command: "ls", cwd: "/tmp" })).toBe(
			toolCallFingerprint("bash", { cwd: "/tmp", command: "ls" }),
		);
	});
});
