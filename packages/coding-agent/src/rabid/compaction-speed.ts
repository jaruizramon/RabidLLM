/**
 * Speed-floor compaction trigger ("needle tolerance").
 *
 * Token and percentage thresholds cannot see a model that has simply become
 * slow at moderate context. This tracks consecutive completed turns whose
 * measured generation rate sits below a floor and fires maintenance once the
 * streak is long enough — provided the context is large enough for compaction
 * to actually help (a slow server at 8K context is not a context problem) and
 * the post-compaction cooldown has expired.
 */

/** Immutable trigger configuration, resolved from settings per check. */
export interface SpeedTriggerConfig {
	/** Below this many tok/s a turn counts as slow. `0` disables the trigger. */
	floorTps: number;
	/** Consecutive slow turns required before compacting. */
	consecutive: number;
	/** Do not compact below this live context; the slowness is not contextual. */
	minContextTokens: number;
}

/** Mutable streak carried between turns. */
export interface SpeedTriggerState {
	slowTurns: number;
	/** Turns left before another speed compaction may fire. */
	cooldown: number;
}

export interface SpeedTriggerDecision extends SpeedTriggerState {
	trigger: boolean;
}

/**
 * Advance the streak with one completed turn.
 *
 * `rate` is the measured generation rate (null when the meter has no reading).
 * A fast turn resets the streak; a slow turn below the minimum context also
 * resets it, since compacting cannot fix a server that is slow on a small
 * prompt. A cooldown turn absorbs one reading after a compaction so the new,
 * shorter context has a chance to show its rate.
 */
export function advanceSpeedTrigger(
	state: SpeedTriggerState,
	config: SpeedTriggerConfig,
	rate: number | null,
	contextTokens: number,
): SpeedTriggerDecision {
	if (config.floorTps <= 0) return { ...state, trigger: false };
	if (state.cooldown > 0) return { slowTurns: 0, cooldown: state.cooldown - 1, trigger: false };
	if (rate === null || !Number.isFinite(rate) || rate >= config.floorTps) {
		return { slowTurns: 0, cooldown: 0, trigger: false };
	}
	if (contextTokens < config.minContextTokens) return { slowTurns: 0, cooldown: 0, trigger: false };
	const slowTurns = state.slowTurns + 1;
	if (slowTurns < config.consecutive) return { slowTurns, cooldown: 0, trigger: false };
	return { slowTurns: 0, cooldown: config.consecutive, trigger: true };
}
