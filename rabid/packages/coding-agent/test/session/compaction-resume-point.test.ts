import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { renderCompactionResumePoint } from "@oh-my-pi/pi-coding-agent/session/compaction-resume-point";

const assistant = { role: "assistant" } as unknown as AgentMessage;
const user = { role: "user" } as unknown as AgentMessage;

describe("renderCompactionResumePoint", () => {
	test("tells the successor to continue when the retained tail starts with an assistant tool call", () => {
		const text = renderCompactionResumePoint([assistant, user]);
		expect(text).toContain("## Resume point");
		expect(text).toContain("Do not restart checks that are already listed under `### Done`");
	});

	test("stays out of summaries whose tail starts with a user message", () => {
		expect(renderCompactionResumePoint([user, assistant])).toBe("");
	});

	test("stays out of an empty tail", () => {
		expect(renderCompactionResumePoint([])).toBe("");
	});
});
