import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { ToolCallLoopGuard } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("ToolCallLoopGuard", () => {
	test("detects the fifth consecutive identical tool call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: ["job", "irc"] });
		let detection = null;
		for (let index = 0; index < 5; index++) {
			const toolCallId = `call-${index}`;
			detection = guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pytest -q", timeout: 120 } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId,
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			});
		}

		expect(detection).toEqual({
			kind: "repeated_tool_call",
			toolName: "bash",
			count: 5,
			resultSummary: "1263 passed, 4 skipped",
			argumentsSummary: '{"command":"pytest -q","timeout":120}',
		});
	});

	test("canonicalizes argument key order and ignores harness intent fields", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "first", name: "read", arguments: { path: "a.ts", [INTENT_FIELD]: "first" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "second",
							name: "read",
							arguments: { [INTENT_FIELD]: "second", path: "a.ts" },
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toMatchObject({ toolName: "read", count: 2 });
	});

	test("resets the consecutive count on a different call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "first", name: "bash", arguments: { command: "pytest -q" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "second", name: "read", arguments: { path: "src/index.ts" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "third", name: "bash", arguments: { command: "pytest -q" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "third",
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});

	test("re-detects continued identical calls past the threshold (issue #12564)", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		const turn = (id: string) => ({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id, name: "todo", arguments: {} }],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			} satisfies AssistantMessage,
			toolResults: [],
		});
		expect(guard.recordTurn(turn("a"))).toBeNull();
		expect(guard.recordTurn(turn("b"))).toMatchObject({ toolName: "todo", count: 2 });
		expect(guard.recordTurn(turn("c"))).toMatchObject({ toolName: "todo", count: 3 });
		expect(guard.recordTurn(turn("d"))).toMatchObject({ toolName: "todo", count: 4 });
	});

	test("ignores exempt polling tools", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["job"] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "first", name: "job", arguments: { poll: ["abc"] } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "job",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "second", name: "job", arguments: { poll: ["abc"] } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "job",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});
});

describe("ToolCallLoopGuard multi-call turns", () => {
	let nextId = 0;

	function toolCall(name: string, args: Record<string, unknown>): ToolCall {
		return { type: "toolCall", id: `tc_${nextId++}`, name, arguments: args };
	}

	function turn(calls: ToolCall[], toolResults: ToolResultMessage[] = []) {
		const message = {
			role: "assistant",
			content: calls,
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage;
		return { message, toolResults };
	}

	test("counts consecutive identical multi-call batches toward the threshold", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		const batch = () => [toolCall("bash", { command: "echo a" }), toolCall("read", { path: "a.ts" })];
		expect(guard.recordTurn(turn(batch()))).toBeNull();
		expect(guard.recordTurn(turn(batch()))).toBeNull();
		expect(guard.recordTurn(turn(batch()))).toMatchObject({ toolName: "bash", count: 3 });
	});

	test("resets on a turn with no tool calls", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		const batch = () => [toolCall("bash", { command: "echo a" }), toolCall("read", { path: "a.ts" })];
		expect(guard.recordTurn(turn(batch()))).toBeNull();
		expect(guard.recordTurn(turn([]))).toBeNull();
		expect(guard.recordTurn(turn(batch()))).toBeNull();
	});

	test("resets when every call in a multi-call turn is exempt", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["read"] });
		const batch = () => [toolCall("bash", { command: "echo a" }), toolCall("read", { path: "a.ts" })];
		expect(guard.recordTurn(turn(batch()))).toBeNull();
		expect(
			guard.recordTurn(turn([toolCall("read", { path: "x.ts" }), toolCall("read", { path: "y.ts" })])),
		).toBeNull();
		expect(guard.recordTurn(turn(batch()))).toBeNull();
	});

	test("counts a mixed batch and reports the first non-exempt call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["read"] });
		const mixed = () => [toolCall("read", { path: "a.ts" }), toolCall("bash", { command: "echo a" })];
		expect(guard.recordTurn(turn(mixed()))).toBeNull();

		const repeated = mixed();
		expect(
			guard.recordTurn(
				turn(repeated, [
					{
						role: "toolResult",
						toolCallId: repeated[0]!.id,
						toolName: "read",
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: repeated[1]!.id,
						toolName: "bash",
						content: [{ type: "text", text: "command output" }],
						isError: false,
						timestamp: Date.now(),
					},
				]),
			),
		).toEqual({
			kind: "repeated_tool_call",
			toolName: "bash",
			count: 2,
			resultSummary: "command output",
			argumentsSummary: '{"command":"echo a"}',
		});
	});

	test("treats reordered parallel calls as the same batch", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(
			guard.recordTurn(turn([toolCall("bash", { command: "echo a" }), toolCall("read", { path: "a.ts" })])),
		).toBeNull();
		expect(
			guard.recordTurn(turn([toolCall("read", { path: "a.ts" }), toolCall("bash", { command: "echo a" })])),
		).toMatchObject({ count: 2 });
	});

	test("does not count alternating distinct batches", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		const a = () => [toolCall("bash", { command: "echo a" }), toolCall("read", { path: "a.ts" })];
		const b = () => [toolCall("bash", { command: "echo b" })];
		expect(guard.recordTurn(turn(a()))).toBeNull();
		expect(guard.recordTurn(turn(b()))).toBeNull();
		expect(guard.recordTurn(turn(a()))).toBeNull();
		expect(guard.recordTurn(turn(b()))).toBeNull();
	});
});

describe("ToolCallLoopGuard output digest", () => {
	let nextId = 0;

	function toolCall(name: string, args: Record<string, unknown>): ToolCall {
		return { type: "toolCall", id: `out_${nextId++}`, name, arguments: args };
	}

	const LONG_OUTPUT =
		"Probe: size=4096 entries=12 first=0x4d0a second=0x1f03 label=sample-x length=311 finetune=110 volume=116 checksum=snake padding=0123456789abcdef";

	function turn(calls: ToolCall[], output: string) {
		const message = {
			role: "assistant",
			content: calls,
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage;
		const toolResults = calls.map((call): ToolResultMessage => ({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: Date.now(),
		}));
		return { message, toolResults };
	}

	test("detects the same output fed back by different probes", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, resultThreshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn([toolCall("bash", { command: "xxd a.mod" })], LONG_OUTPUT))).toBeNull();
		expect(guard.recordTurn(turn([toolCall("bash", { command: "od -c a.mod" })], LONG_OUTPUT))).toEqual({
			kind: "repeated_tool_result",
			toolName: "bash",
			count: 2,
			resultSummary: expect.stringContaining("Probe: size=4096"),
			argumentsSummary: '{"command":"od -c a.mod"}',
		});
	});

	test("ignores repeated trivial output", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, resultThreshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn([toolCall("bash", { command: "true" })], "(no output)"))).toBeNull();
		expect(guard.recordTurn(turn([toolCall("bash", { command: "true" })], "(no output)"))).toBeNull();
	});

	test("resets the output count when the output changes", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, resultThreshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn([toolCall("bash", { command: "a" })], LONG_OUTPUT))).toBeNull();
		expect(guard.recordTurn(turn([toolCall("bash", { command: "b" })], `${LONG_OUTPUT}\nchanged`))).toBeNull();
		expect(guard.recordTurn(turn([toolCall("bash", { command: "c" })], LONG_OUTPUT))).toBeNull();
	});

	test("reports the argument repeat when both detectors trip", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, resultThreshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn([toolCall("bash", { command: "same" })], LONG_OUTPUT))).toBeNull();
		expect(guard.recordTurn(turn([toolCall("bash", { command: "same" })], LONG_OUTPUT))).toMatchObject({
			kind: "repeated_tool_call",
			count: 2,
		});
	});
});

describe("ToolCallLoopGuard output cycle", () => {
	let nextId = 0;

	function toolCall(name: string, args: Record<string, unknown>): ToolCall {
		return { type: "toolCall", id: `cycle_${nextId++}`, name, arguments: args };
	}

	const PROBE = (label: string, extra: string) => `${label}: size=4096 | first=0x4d0a | count=50 | ${extra}`;

	function turn(command: string, output: string) {
		const call = toolCall("bash", { command });
		const message = {
			role: "assistant",
			content: [call],
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage;
		return {
			message,
			toolResults: [
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: output }],
					isError: false,
					timestamp: Date.now(),
				},
			] satisfies ToolResultMessage[],
		};
	}

	const A = () => turn("analyze-header", PROBE("analyze", "name=sample-x len=311"));
	const B = () => turn("check-size", PROBE("size", "after=1000 expected=1020 diff=20"));
	const C = () => turn("parse-extra", PROBE("parse", "after=1020 record0=452"));

	test("detects a three-probe sequence repeated twice", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, resultThreshold: 2, exemptTools: [] });
		expect(guard.recordTurn(A())).toBeNull();
		expect(guard.recordTurn(B())).toBeNull();
		expect(guard.recordTurn(C())).toBeNull();
		expect(guard.recordTurn(A())).toBeNull();
		expect(guard.recordTurn(B())).toBeNull();
		expect(guard.recordTurn(C())).toMatchObject({
			kind: "repeated_tool_cycle",
			period: 3,
			count: 6,
			toolName: "bash",
		});
	});

	test("detects an alternating two-probe sequence", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, resultThreshold: 2, exemptTools: [] });
		expect(guard.recordTurn(A())).toBeNull();
		expect(guard.recordTurn(B())).toBeNull();
		expect(guard.recordTurn(A())).toBeNull();
		expect(guard.recordTurn(B())).toMatchObject({ kind: "repeated_tool_cycle", period: 2, count: 4 });
	});

	test("does not flag a cycle whose outputs keep changing", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, resultThreshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn("analyze-header", PROBE("analyze", "len=1")))).toBeNull();
		expect(guard.recordTurn(turn("check-size", PROBE("size", "diff=4")))).toBeNull();
		expect(guard.recordTurn(turn("analyze-header", PROBE("analyze", "len=2")))).toBeNull();
		expect(guard.recordTurn(turn("check-size", PROBE("size", "diff=8")))).toBeNull();
	});

	test("clears the cycle window on a turn with no tool calls", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, resultThreshold: 2, exemptTools: [] });
		expect(guard.recordTurn(A())).toBeNull();
		expect(guard.recordTurn(B())).toBeNull();
		expect(guard.recordTurn({ message: { ...A().message, content: [] }, toolResults: [] })).toBeNull();
		expect(guard.recordTurn(A())).toBeNull();
		expect(guard.recordTurn(B())).toBeNull();
	});
});
