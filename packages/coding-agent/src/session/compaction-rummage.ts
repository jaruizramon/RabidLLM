/**
 * Live ledger for one context-maintenance pass: what the archive/offload step
 * is doing, how much it scanned, and the context percentage it left behind.
 *
 * Written by `SessionMaintenance` (context-full/handoff/shake/snapcompact) and
 * read by the status panel. Pure state — no I/O, no timers.
 */

/** Maintenance method currently rummaging. */
export type CompactionRummageAction = "context-full" | "remote" | "handoff" | "shake" | "snapcompact";

/** Where the pass is in its archive → rewrite pipeline. */
export type CompactionRummagePhase = "scanning" | "offloading" | "summarizing" | "rewriting";

/** Snapshot of the current (or last completed) maintenance pass. */
export interface CompactionRummageState {
	action: CompactionRummageAction;
	phase: CompactionRummagePhase;
	/** Epoch ms when the pass started. */
	startedAt: number;
	/** Epoch ms when the pass finished; unset while it runs. */
	endedAt?: number;
	/** Session entries inspected for reclaimable content. */
	scannedEntries?: number;
	/** Eligible regions found (tool results, blocks, image/thinking groups). */
	regions?: number;
	/** Estimated tokens moved out of the live prompt into the archive. */
	archivedTokens?: number;
	/** Bytes written to the recovery artifact. */
	archivedBytes?: number;
	/** Recovery artifact holding the offloaded originals (tmpfs or disk). */
	archivePath?: string;
	/** Context tokens before the pass, when known. */
	tokensBefore?: number;
	/** Context tokens after the pass, when known. */
	tokensAfter?: number;
	/** Context window used for the percentage pair. */
	contextWindow?: number;
	/** Estimated context tokens the pass actually reclaimed. */
	tokensFreed?: number;
	aborted?: boolean;
	skipped?: boolean;
	error?: string;
}

/** Mutable state holder shared by the maintenance pass and the status panel. */
export class CompactionRummageTracker {
	#state: CompactionRummageState | undefined;

	/** Starts a pass, replacing any previous (including a lingering finished) one. */
	begin(
		action: CompactionRummageAction,
		phase: CompactionRummagePhase,
		usage?: { tokens: number; contextWindow: number },
	): void {
		this.#state = {
			action,
			phase,
			startedAt: Date.now(),
			...(usage ? { tokensBefore: usage.tokens, contextWindow: usage.contextWindow } : {}),
		};
	}

	/** Applies defined fields to the running pass; a no-op when no pass is active. */
	update(patch: Partial<CompactionRummageState>): void {
		const state = this.#state;
		if (!state || state.endedAt !== undefined) return;
		if (patch.action !== undefined) state.action = patch.action;
		if (patch.phase !== undefined) state.phase = patch.phase;
		if (patch.scannedEntries !== undefined) state.scannedEntries = patch.scannedEntries;
		if (patch.regions !== undefined) state.regions = patch.regions;
		if (patch.archivedTokens !== undefined) state.archivedTokens = patch.archivedTokens;
		if (patch.archivedBytes !== undefined) state.archivedBytes = patch.archivedBytes;
		if (patch.archivePath !== undefined) state.archivePath = patch.archivePath;
		if (patch.tokensBefore !== undefined) state.tokensBefore = patch.tokensBefore;
		if (patch.tokensAfter !== undefined) state.tokensAfter = patch.tokensAfter;
		if (patch.contextWindow !== undefined) state.contextWindow = patch.contextWindow;
		if (patch.tokensFreed !== undefined) state.tokensFreed = patch.tokensFreed;
		if (patch.aborted !== undefined) state.aborted = patch.aborted;
		if (patch.skipped !== undefined) state.skipped = patch.skipped;
		if (patch.error !== undefined) state.error = patch.error;
	}

	/** Finishes the running pass; a no-op when none is active. */
	end(patch: Partial<CompactionRummageState> = {}): void {
		const state = this.#state;
		if (!state || state.endedAt !== undefined) return;
		this.update(patch);
		state.endedAt = Date.now();
	}

	/** The current snapshot, or undefined before the first pass. */
	get(): Readonly<CompactionRummageState> | undefined {
		return this.#state;
	}

	/** Whether a pass is still running. */
	get active(): boolean {
		return this.#state !== undefined && this.#state.endedAt === undefined;
	}

	/** Drops the snapshot (session reset/tests). */
	reset(): void {
		this.#state = undefined;
	}
}
