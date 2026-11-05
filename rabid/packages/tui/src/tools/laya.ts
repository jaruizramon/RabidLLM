/**
 * `laya` call card: the full parameter set, not a one-line JSON summary.
 *
 * The generic fallback renders args through a 160-character budget, which for this
 * tool truncates both the state under test and the question list — the two things the
 * caller needs to see to judge whether the questions are worth asking. State and
 * questions are laid out structurally instead, and prose wraps to the card width, so a
 * long state stays readable without being cut.
 *
 * Only `renderCall` is implemented: the transcript falls back to the raw result text
 * for the answers, which is already the shape a reader wants there.
 */
import type { Component } from "../tui";
import { Markdown } from "../index";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import type { RenderResultOptions, ToolRenderer } from "./renderer";

interface LayaQuestion {
	id?: unknown;
	type?: unknown;
	instructions?: unknown;
	criteria?: unknown;
	descriptions?: unknown;
}

export type LayaRenderArgs = {
	state?: unknown;
	profile?: unknown;
	questions?: unknown;
};

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `criteria` is either a label list (choice/score) or a label → description record. */
function criteriaLines(question: LayaQuestion): string[] {
	const descriptions = Array.isArray(question.descriptions) ? question.descriptions : [];
	if (Array.isArray(question.criteria)) {
		return question.criteria.map((label, index) => {
			const description = text(descriptions[index]);
			return description ? `- **${String(label)}** — ${description}` : `- **${String(label)}**`;
		});
	}
	if (question.criteria && typeof question.criteria === "object") {
		return Object.entries(question.criteria as Record<string, unknown>).map(([label, description]) => {
			const meaning = text(description);
			return meaning && meaning !== label ? `- **${label}** — ${meaning}` : `- **${label}**`;
		});
	}
	return [];
}

function questionBlock(question: LayaQuestion, index: number): string[] {
	const id = text(question.id) ?? `question ${index + 1}`;
	const kind = text(question.type) ?? "choice";
	const instructions = text(question.instructions);
	const head = instructions ? `**${id}** · ${kind} — ${instructions}` : `**${id}** · ${kind}`;
	return [head, "", ...criteriaLines(question), ""];
}

/** The parameter card as Markdown; exported for the renderer test. */
export function formatLayaCall(args: LayaRenderArgs): string {
	if (!args || typeof args !== "object") return "**laya**";
	const state = text(args.state);
	const profile = text(args.profile);
	const questions = Array.isArray(args.questions) ? (args.questions as LayaQuestion[]) : [];

	const title = profile
		? `**laya** · profile \`${profile}\``
		: questions.length > 0
			? `**laya** · ${questions.length} question${questions.length === 1 ? "" : "s"}`
			: "**laya**";

	const lines: string[] = [title, ""];
	if (state) {
		// A blockquote wraps to the card width; a fenced block would let the terminal
		// clip a long single-line state at the right edge.
		lines.push("**state**", "");
		for (const line of state.split("\n")) {
			lines.push(line.length > 0 ? `> ${line}` : ">");
		}
		lines.push("");
	}
	if (questions.length > 0) {
		lines.push("**questions**", "");
		questions.forEach((question, index) => {
			lines.push(...questionBlock(question, index));
		});
	}
	if (!state && questions.length === 0 && !profile) {
		lines.push("_waiting for arguments…_");
	}
	return lines.join("\n").trimEnd();
}

export const layaToolRenderer = {
	renderCall(args: LayaRenderArgs, _options: RenderResultOptions, _theme: Theme): Component {
		return new Markdown(formatLayaCall(args ?? {}), 0, 0, getMarkdownTheme());
	},
	renderResult(): undefined {
		// Answers render as the tool's raw result text; a second card would only repeat it.
		return undefined;
	},
} satisfies ToolRenderer<LayaRenderArgs, unknown>;
