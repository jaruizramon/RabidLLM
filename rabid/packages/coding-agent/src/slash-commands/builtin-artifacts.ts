import { clearSubmittedText } from "./helpers/draft";
import type { SlashCommandSpec } from "./types";

/**
 * `/artifacts` opens the session's visual artifact gallery: images, sprites,
 * SVGs, and webpages the agent wrote, previewed rather than shown as source.
 */
export const BUILTIN_ARTIFACT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "artifacts",
		aliases: ["artifact"],
		icon: "eye",
		description: "Browse images, sprites, SVGs, and webpages this session created",
		handleTui: (_command, runtime) => {
			clearSubmittedText(runtime);
			runtime.ctx.openArtifactsWindow();
		},
	},
];
