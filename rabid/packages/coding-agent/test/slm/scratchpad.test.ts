import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	boundScratchpad,
	countLogEchoes,
	renderScratchpad,
	stripLogEchoes,
} from "@oh-my-pi/pi-coding-agent/slm/scratchpad";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as unknown as AgentMessage;
}

function assistant(parts: unknown[], text = ""): AgentMessage {
	return {
		role: "assistant",
		content: [...(text === "" ? [] : [{ type: "text", text }]), ...parts],
		timestamp: 2,
	} as unknown as AgentMessage;
}

function result(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	} as unknown as AgentMessage;
}

describe("renderScratchpad", () => {
	it("reduces a turn to one line per event, including thoughts and reads", () => {
		const pad = renderScratchpad([
			user("Import the invasion helpers"),
			assistant([
				{ type: "thinking", thinking: "I should read the modal first.\nThen wire it." },
				{ type: "toolCall", name: "read", arguments: { path: "src/scene/Targeting.js", offset: 26, limit: 413 } },
			]),
			result("export function pickGlobePoint() { /* … */ }"),
			assistant([], "Wired the helpers into the modal."),
		]);

		expect(pad).toContain("USER: Import the invasion helpers");
		expect(pad).toContain("THOUGHT: I should read the modal first. Then wire it.");
		expect(pad).toContain("CALL read(src/scene/Targeting.js:26-438)");
		expect(pad).toContain("RESULT read:");
		expect(pad).toContain("CONCLUSION: Wired the helpers into the modal.");
	});

	it("caps a single oversized thought so one block cannot dominate the pad", () => {
		const pad = renderScratchpad([assistant([{ type: "thinking", thinking: "x".repeat(5_000) }])]);

		expect(pad.length).toBeLessThan(300);
		expect(pad).toContain("THOUGHT:");
	});
});

describe("boundScratchpad", () => {
	it("keeps the newest events and says how many were dropped", () => {
		const pad = Array.from({ length: 200 }, (_, index) => `CONCLUSION: event ${index}`).join("\n");
		const bounded = boundScratchpad(pad, 500);

		expect(bounded.length).toBeLessThanOrEqual(560);
		expect(bounded).toContain("earlier events omitted");
		expect(bounded).toContain("event 199");
		expect(bounded).not.toContain("event 0");
	});

	it("leaves a small pad untouched", () => {
		expect(boundScratchpad("USER: hi", 1_000)).toBe("USER: hi");
	});
});

describe("log transcription guard", () => {
	const transcribed = [
		"## Goal",
		"Import the invasion helpers",
		"## Progress",
		"THOUGHT: I should read the modal first.",
		"CALL read(src/scene/Targeting.js:26-438)",
		"RESULT read: export function pickGlobePoint() { … }",
	].join("\n");

	it("counts copied log lines and ignores prose that merely mentions the words", () => {
		expect(countLogEchoes(transcribed)).toBe(3);
		expect(countLogEchoes("Call the loader before mounting; results are cached.")).toBe(0);
	});

	it("counts copied note lines, which carry the note labels", () => {
		const notes = "- [THOUGHT] Wants the pad bounded.\n- [TOOL read] Targeting.js → 400 lines\n- [SAID] Done.";
		expect(countLogEchoes(notes)).toBe(3);
	});

	it("strips only the copied lines, keeping what the model selected", () => {
		const cleaned = stripLogEchoes(transcribed);

		expect(cleaned).toContain("## Goal");
		expect(cleaned).toContain("Import the invasion helpers");
		expect(cleaned).not.toContain("THOUGHT:");
		expect(cleaned).not.toContain("CALL read(");
		expect(cleaned).not.toContain("RESULT read:");
	});
});
