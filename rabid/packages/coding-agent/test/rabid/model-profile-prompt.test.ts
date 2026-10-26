/** `profiles.<selector>.systemPromptAppend`: one model's discipline block. */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadModelSystemPromptAppend } from "@oh-my-pi/pi-coding-agent/rabid/model-profile-settings";
import { normalizeModelProfiles } from "@oh-my-pi/pi-coding-agent/rabid/model-profiles";

const MODEL = { provider: "llama-rabid", id: "qwen3.8-27b" };
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-prompt-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("loadModelSystemPromptAppend", () => {
	it("reads the configured markdown for the matching model", async () => {
		const agentDir = await tempDir();
		await fs.mkdir(path.join(agentDir, "prompts"));
		await fs.writeFile(
			path.join(agentDir, "prompts", "qwen.md"),
			"Act first on mechanical changes. One probe per unknown.\n",
		);
		const settings = Settings.isolated({
			profiles: { "llama-rabid/qwen3.8-27b": { systemPromptAppend: "prompts/qwen.md" } },
		});

		expect(await loadModelSystemPromptAppend(settings, MODEL, agentDir)).toBe(
			"Act first on mechanical changes. One probe per unknown.",
		);
	});

	it("returns nothing for a model without a matching profile", async () => {
		const agentDir = await tempDir();
		const settings = Settings.isolated({
			profiles: { "llama-rabid/other-model": { systemPromptAppend: "prompts/qwen.md" } },
		});

		expect(await loadModelSystemPromptAppend(settings, MODEL, agentDir)).toBeUndefined();
	});

	it("skips a missing file instead of failing the rebuild", async () => {
		const agentDir = await tempDir();
		const settings = Settings.isolated({
			profiles: { "llama-rabid/qwen3.8-27b": { systemPromptAppend: "prompts/missing.md" } },
		});

		expect(await loadModelSystemPromptAppend(settings, MODEL, agentDir)).toBeUndefined();
	});

	it("rejects an empty path at validation", () => {
		expect(() => normalizeModelProfiles({ "llama-rabid/qwen3.8-27b": { systemPromptAppend: "   " } })).toThrow(
			/systemPromptAppend/,
		);
	});
});
