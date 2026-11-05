/**
 * `laya`: one forward pass of typed questions over a state, answered by the local
 * Laya decision model through its bridge daemon.
 *
 * Laya is not a chat model — it does not generate text. It reads a state plus a
 * question set and returns calibrated probabilities in ~25 ms, offline. That makes it
 * the right tool for a bounded judgement over text the session already holds (triage a
 * failure, guard a command, rank candidate causes) where a label and a probability beat
 * a paragraph, and the wrong tool for anything that needs to write or explain.
 *
 * The bridge is optional infrastructure: when it is down the tool reports the command
 * that starts it rather than pretending the capability does not exist.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";
import layaDescription from "../prompts/tools/laya.md" with { type: "text" };

/** Where the bridge listens. `LAYA_BRIDGE_URL` overrides the documented default. */
const BRIDGE_URL = process.env.LAYA_BRIDGE_URL ?? "http://127.0.0.1:37900";
const BRIDGE_TIMEOUT_MS = 20_000;
const START_HINT = "~/.local/share/laya-bridge/start.sh";

const questionSchema = type({
	id: type("string").describe("answer key, e.g. `class`"),
	type: type.enumerated("choice", "score").describe("choice → labelled probability; score → ordered level"),
	instructions: type("string").describe("what to judge from the state; the model sees only this and the state"),
	"criteria?": type("string")
		.array()
		.atLeastLength(2)
		.describe("choice: option labels; score: ordered levels, lowest first"),
	"descriptions?": type("string")
		.array()
		.describe("choice only: what each label means, one per label in the same order"),
});

const layaSchema = type({
	state: type("string").describe("the text or JSON object to judge"),
	"profile?": type
		.enumerated("triage", "guard", "email", "moderation", "router")
		.describe("run a shipped question set instead of supplying `questions`"),
	"questions?": questionSchema.array().atLeastLength(1).describe("custom question set"),
});

type LayaParams = typeof layaSchema.infer;

export interface LayaToolDetails {
	readonly profile?: string;
	readonly latencyMs?: number;
	readonly answers?: unknown;
}

interface BridgeAnswer {
	readonly choice?: string;
	readonly probabilities?: Record<string, number>;
	readonly score?: number;
	readonly legend?: readonly string[];
	/** Mass on "none of the listed options", for `noul` questions. */
	readonly noul?: number;
	readonly confidence?: number;
}

interface BridgeResponse {
	readonly answers?: Record<string, BridgeAnswer>;
	readonly latency_ms?: number;
	readonly profile?: string;
	readonly error?: string;
}

/** Translate the tool's question list into the bridge's id-keyed question record. */
export function buildQuestionSet(
	questions: readonly NonNullable<LayaParams["questions"]>[number][] | undefined,
): Record<string, unknown> | undefined {
	if (!questions || questions.length === 0) return undefined;
	const out: Record<string, unknown> = {};
	for (const question of questions) {
		if (question.type === "score") {
			if (!question.criteria) throw new Error(`question ${question.id}: score needs criteria levels`);
			out[question.id] = { type: "score", instructions: question.instructions, criteria: [...question.criteria] };
			continue;
		}
		const labels = question.criteria;
		if (!labels) throw new Error(`question ${question.id}: choice needs criteria labels`);
		if (question.descriptions && question.descriptions.length !== labels.length) {
			throw new Error(`question ${question.id}: descriptions must match criteria one-for-one`);
		}
		const criteria: Record<string, string> = {};
		labels.forEach((label, index) => {
			criteria[label] = question.descriptions?.[index] ?? label;
		});
		out[question.id] = { type: "choice", instructions: question.instructions, criteria };
	}
	return out;
}

function renderAnswers(answers: Record<string, BridgeAnswer> | undefined): string {
	if (!answers) return "(no answers)";
	const lines: string[] = [];
	for (const [id, answer] of Object.entries(answers)) {
		if (answer.choice !== undefined) {
			const probability = answer.probabilities?.[answer.choice];
			lines.push(
				probability === undefined
					? `${id}: ${answer.choice}`
					: `${id}: ${answer.choice} (p=${probability.toFixed(3)})`,
			);
			continue;
		}
		if (answer.score !== undefined) {
			const level = answer.legend?.[Math.round(answer.score)];
			lines.push(
				level === undefined ? `${id}: ${answer.score.toFixed(3)}` : `${id}: ${level} (${answer.score.toFixed(3)})`,
			);
			continue;
		}
		if (answer.noul !== undefined) {
			// `noul` is the model's mass on "none of the listed options"; report it as-is
			// rather than guessing which way a near-zero value points.
			const confidence = answer.confidence === undefined ? "" : ` (confidence ${answer.confidence.toFixed(4)})`;
			lines.push(`${id}: noul=${answer.noul.toFixed(4)}${confidence}`);
			continue;
		}
		lines.push(`${id}: ${JSON.stringify(answer)}`);
	}
	return lines.join("\n");
}

export class LayaTool implements AgentTool<typeof layaSchema, LayaToolDetails> {
	readonly name = "laya";
	readonly approval = "read" as const;
	readonly label = "Laya";
	readonly summary = "Local decision model: calibrated probabilities for typed questions over a state";
	readonly description: string;
	readonly parameters = layaSchema;
	readonly strict = true;
	readonly concurrency = "shared";
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(layaDescription);
	}

	async execute(
		_toolCallId: string,
		params: LayaParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<LayaToolDetails>> {
		try {
			if (!params.profile && !params.questions) {
				throw new Error("pass either `profile` (shipped question set) or `questions`");
			}
			const body: Record<string, unknown> = { state: params.state };
			if (params.profile) body.profile = params.profile;
			const questions = buildQuestionSet(params.questions);
			if (questions) body.questions = questions;

			const timeout = AbortSignal.timeout(BRIDGE_TIMEOUT_MS);
			const response = await fetch(`${BRIDGE_URL}/v1/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			const payload = (await response.json()) as BridgeResponse;
			if (!response.ok || payload.error) {
				throw new Error(payload.error ?? `bridge returned ${response.status}`);
			}

			const text = renderAnswers(payload.answers);
			return {
				content: [
					{
						type: "text",
						text:
							payload.latency_ms === undefined
								? text
								: `${text}\n\n(${payload.latency_ms.toFixed(1)} ms, ${payload.profile ?? "custom"})`,
					},
				],
				details: { profile: payload.profile, latencyMs: payload.latency_ms, answers: payload.answers },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const hint = /fetch failed|ECONNREFUSED|connect/i.test(message)
				? ` — the bridge is not running; start it with ${START_HINT}`
				: "";
			return {
				content: [{ type: "text", text: `laya: ${message}${hint}` }],
				details: { profile: params.profile },
				isError: true,
			};
		}
	}
}
