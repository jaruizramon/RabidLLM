import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/artifacts slash command", () => {
	it("opens the gallery and clears the editor draft", async () => {
		const openArtifactsWindow = vi.fn();
		const setText = vi.fn();
		const ctx = { openArtifactsWindow, editor: { setText } } as unknown as InteractiveModeContext;

		expect(await executeBuiltinSlashCommand("/artifacts", { ctx })).toBe(true);
		expect(openArtifactsWindow).toHaveBeenCalledTimes(1);
		expect(setText).toHaveBeenCalledWith("");
	});
});
