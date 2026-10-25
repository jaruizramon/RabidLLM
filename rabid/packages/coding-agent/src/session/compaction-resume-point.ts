import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import resumePointPrompt from "../prompts/system/compaction-resume-point.md" with { type: "text" };

/**
 * A compaction may keep a tail that starts at an assistant message because that
 * message carries the tool call whose result follows. Without a note, the model
 * reads its own "Now I'll check X" as the latest instruction and restarts an
 * audit that the summary already marked Done. The resume point is deterministic:
 * it is added only when the retained tail actually starts that way.
 */
export function renderCompactionResumePoint(recentMessages: readonly AgentMessage[]): string {
	return recentMessages[0]?.role === "assistant" ? resumePointPrompt.trim() : "";
}
