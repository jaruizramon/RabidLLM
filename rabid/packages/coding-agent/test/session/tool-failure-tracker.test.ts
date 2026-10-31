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

	it("steers a repeated edit header failure to the current content tag", () => {
		const tracker = new ToolFailureTracker();
		const error = 'Input header must be [PATH] or [PATH#TAG] with a 4-hex content-hash tag; got "[index.html#131]".';
		tracker.recordOutcome("edit", { input: "[index.html#131]\nPUT <132:" }, true, errorContent(error));
		const second = tracker.recordOutcome("edit", { input: "[index.html#131]\nPUT <133:" }, true, errorContent(error));

		expect(second?.additionalContext).toContain("4-hex content hash");
		expect(second?.additionalContext).toContain("Re-read the target file");
		expect(second?.additionalContext).not.toContain("argument-shape problem");
	});

	it("steers a repeated edit range failure to range replacement", () => {
		const tracker = new ToolFailureTracker();
		const error =
			"`PUT 266.=352:` rejected: the body ends by restating the 42 line(s) just below the range, but is too short";
		tracker.recordOutcome("edit", { input: "a" }, true, errorContent(error));
		const second = tracker.recordOutcome("edit", { input: "b" }, true, errorContent(error));

		expect(second?.additionalContext).toContain("PUT N.=M:");
		expect(second?.additionalContext).toContain("complete final content");
	});

	it("steers a missing edit header to a bracketed path/hash", () => {
		const tracker = new ToolFailureTracker();
		const error =
			'edit input must begin with "[PATH#HASH]" on the first non-blank line for anchored edits; got: "PUT 52-58:".';
		tracker.recordOutcome("edit", { input: "PUT 52-58:\n+x" }, true, errorContent(error));
		const second = tracker.recordOutcome("edit", { input: "PUT 56-61:\n+x" }, true, errorContent(error));

		expect(second?.additionalContext).toContain("[PATH#HASH]");
		expect(second?.additionalContext).toContain("keep `i` short");
	});

	it("steers a stale edit tag to the current hash", () => {
		const tracker = new ToolFailureTracker();
		const error =
			"Edit rejected for js/camera.js: file changed between read and edit. Section is bound to #AD6C, but the current file hashes to #1045.";
		tracker.recordOutcome("edit", { input: "[js/camera.js#AD6C]\nPUT 1-2:\n+x" }, true, errorContent(error));
		const second = tracker.recordOutcome(
			"edit",
			{ input: "[js/camera.js#AD6C]\nPUT 3-4:\n+y" },
			true,
			errorContent(error),
		);

		expect(second?.additionalContext).toContain("[path#newhash]");
		expect(second?.additionalContext).toContain("do not reuse the old tag");
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
