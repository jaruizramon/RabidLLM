/**
 * One-row readout mounted directly above the archive panel (just above the
 * input): the active RabidAI mode, a reasoning-budget gauge, a context gauge
 * with the compaction threshold marked, and the generation rate.
 *
 * The reasoning gauge counts streamed thinking characters (rough token
 * estimate) against the budget actually sent for the selected level. The
 * context gauge marks where automatic maintenance ("rummaging") will fire, so
 * the approach to the threshold is visible before the archive panel appears.
 */
import { type Component, padding, truncateToWidth } from "@oh-my-pi/pi-tui";
import { theme } from "@oh-my-pi/pi-tui/theme";

import { formatNumber } from "@oh-my-pi/pi-utils";

const NUMBER = new Intl.NumberFormat("en-US");
/** Cells in each gauge. */
const CELLS = 10;

/** Mode label + effective budget for the readout. */
export interface RabidModeReadout {
	name: string;
	budget?: number;
}

/** Reasoning tokens used against the request budget. */
export interface ReasoningReadout {
	tokens: number;
	budget: number;
}

/** Context occupancy, scaled to the compaction trigger when one is known. */
export interface ContextReadout {
	tokens: number;
	contextWindow: number;
	/** Token trigger that starts maintenance; the gauge's full scale. */
	thresholdTokens?: number;
}

/** What the row reads; the meter owns sampling and the caller owns gating. */
export interface TokenRatePanelHost {
	rate(): number | null;
	mode?(): RabidModeReadout | undefined;
	reasoning?(): ReasoningReadout | undefined;
	context?(): ContextReadout | undefined;
}

/** `█` filled, `░` empty, `┊` at the threshold cell (takes precedence). */
function gauge(fraction: number, thresholdFraction?: number): string {
	const filled = Math.max(0, Math.min(CELLS, Math.round(fraction * CELLS)));
	const marker = thresholdFraction === undefined ? -1 : Math.min(CELLS - 1, Math.floor(thresholdFraction * CELLS));
	let bar = "";
	for (let index = 0; index < CELLS; index++) {
		bar += index === marker ? "┊" : index < filled ? "█" : "░";
	}
	return bar;
}

export class TokenRatePanel implements Component {
	readonly #host: TokenRatePanelHost;

	constructor(host: TokenRatePanelHost) {
		this.#host = host;
	}

	render(width: number): readonly string[] {
		const mode = this.#host.mode?.();
		const reasoning = this.#host.reasoning?.();
		const context = this.#host.context?.();
		const rate = this.#host.rate();
		if (!mode && !reasoning && !context && rate === null) return [];

		const parts: string[] = [];
		if (mode) parts.push(theme.fg("accent", `${theme.icon.throughput} rabid-${mode.name}`));
		if (reasoning) {
			const fraction = reasoning.budget > 0 ? reasoning.tokens / reasoning.budget : 0;
			const over = fraction >= 1;
			parts.push(
				`${theme.fg("muted", `reasoning ${NUMBER.format(reasoning.tokens)}/${NUMBER.format(reasoning.budget)}`)} ${theme.fg(
					over ? "warning" : "accent",
					gauge(fraction),
				)}`,
			);
		} else if (mode?.budget !== undefined) {
			parts.push(theme.fg("muted", `${NUMBER.format(mode.budget)} budget`));
		}
		if (context) {
			const percent = context.contextWindow > 0 ? (context.tokens / context.contextWindow) * 100 : 0;
			const scale =
				context.thresholdTokens !== undefined && context.thresholdTokens > 0
					? context.thresholdTokens
					: context.contextWindow;
			const fraction = scale > 0 ? context.tokens / scale : 0;
			const due = context.thresholdTokens !== undefined && context.tokens >= context.thresholdTokens;
			const label =
				context.thresholdTokens !== undefined
					? `ctx ${percent.toFixed(0)}% · ${formatNumber(context.tokens)}/${formatNumber(context.thresholdTokens)}`
					: `ctx ${percent.toFixed(0)}%`;
			parts.push(`${theme.fg("muted", label)} ${theme.fg(due ? "warning" : "dim", gauge(fraction))}`);
		}
		if (rate !== null) parts.push(theme.fg("dim", `${rate.toFixed(1)} tok/s`));
		return [truncateToWidth(`${padding(1)}${parts.join(theme.fg("muted", " · "))}`, width)];
	}
}
