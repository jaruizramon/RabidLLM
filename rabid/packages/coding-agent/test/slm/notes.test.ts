import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseSlmNotesFile,
	readSlmNotes,
	slmNotesFilePaths,
	writeSlmNotes,
} from "@oh-my-pi/pi-coding-agent/slm/handoff";

const metadata = {
	version: 1 as const,
	sessionId: "session-a",
	coveredLeafKey: "leaf-9",
	coveredAt: 1_700_000_000_000,
	turns: 3,
};

describe("SLM notes store", () => {
	it("round-trips through the envelope with its provenance", () => {
		const parsed = parseSlmNotesFile(
			`<!-- rabid-slm-notes\n${JSON.stringify(metadata)}\n-->\n\n- [THOUGHT] bounded input\n`,
		);

		expect(parsed?.text).toBe("- [THOUGHT] bounded input");
		expect(parsed?.metadata).toEqual(metadata);
	});

	it("refuses a file without the envelope and a session with no notes", async () => {
		expect(parseSlmNotesFile("- [THOUGHT] no header")).toBeUndefined();

		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "slm-notes-"));
		try {
			await writeSlmNotes(agentDir, "session-a", { text: "- [SAID] done", metadata });
			expect((await readSlmNotes(agentDir, "session-a"))?.text).toBe("- [SAID] done");
			expect(await readSlmNotes(agentDir, "session-b")).toBeUndefined();
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("names the notes beside the handoff document", () => {
		const paths = slmNotesFilePaths("/tmp/agent", "session-a");

		expect(paths.ram.endsWith(".notes.md")).toBe(true);
		expect(paths.disk.endsWith(".notes.md")).toBe(true);
		expect(paths.disk).toContain("/slm-handoffs/");
	});
});
