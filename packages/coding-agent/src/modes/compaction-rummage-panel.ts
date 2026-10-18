/**
 * Two-row panel above the composer's status bar: the live archive/offload
 * ledger for context maintenance. The headline carries the phase, method and
 * context percentage; the detail row carries counters, path and elapsed time.
 *
 * While a pass runs it shows the phase, scanned entries, regions, offloaded
 * tokens/bytes and the context percentage it started from. Once the pass ends
 * it lingers for a few seconds with the before → after percentage pair and the
 * tokens reclaimed, then disappears. The archive label says `ramdisk` when the
 * recovery artifact lives on tmpfs (`/dev/shm`), `archive` otherwise.
 */
import { type Component, padding, truncateToWidth } from "@oh-my-pi/pi-tui";
import { replaceTabs, shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { CompactionRummageStatus } from "@oh-my-pi/pi-tui/status-line/types";
import { getSymbolTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { formatBytes, formatNumber } from "@oh-my-pi/pi-utils";

/** How long the finished ledger stays on screen after maintenance ends. */
const RETAIN_COMPLETED_MS = 8_000;
/** Repaint cadence while the ledger is visible (matches the loader's feel). */
const TICK_MS = 120;
const SEPARATOR = " · ";

/** What the panel reads; the session owns the ledger. */
export interface CompactionRummagePanelHost {
	status(): CompactionRummageStatus | undefined;
	requestRender(): void;
}

function percentOf(tokens: number | undefined, window: number | undefined): number | undefined {
	if (tokens === undefined || window === undefined || window <= 0) return undefined;
	return Math.round((tokens / window) * 100);
}

function elapsedLabel(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function archiveLabel(status: CompactionRummageStatus): "ramdisk" | "archive" {
	return status.archivePath?.startsWith("/dev/shm/") ? "ramdisk" : "archive";
}

export class CompactionRummagePanel implements Component {
	readonly #host: CompactionRummagePanelHost;
	#timer: ReturnType<typeof setInterval> | undefined;
	/** Last rendered key; a tick repaints only when the visible line changes. */
	#lastKey = "";

	constructor(host: CompactionRummagePanelHost) {
		this.#host = host;
		this.#timer = setInterval(() => {
			if (this.#key(Date.now()) !== this.#lastKey) this.#host.requestRender();
		}, TICK_MS);
		this.#timer.unref?.();
	}

	render(width: number): readonly string[] {
		const status = this.#host.status();
		const now = Date.now();
		if (!status) {
			this.#lastKey = "";
			return [];
		}
		const live = status.endedAt === undefined;
		if (!live && now - (status.endedAt ?? now) > RETAIN_COMPLETED_MS) {
			this.#lastKey = "";
			return [];
		}
		this.#lastKey = this.#key(now);
		return this.#rows(status, now).map(row => truncateToWidth(row, width));
	}

	dispose(): void {
		if (this.#timer === undefined) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	/** Repaint key: spinner phase while live, stable once finished. */
	#key(now: number): string {
		const status = this.#host.status();
		if (!status) return "";
		const live = status.endedAt === undefined;
		const visible = live || now - (status.endedAt ?? now) <= RETAIN_COMPLETED_MS;
		if (!visible) return "";
		const frame = live ? String(Math.floor(now / TICK_MS) % 8) : "";
		return [
			frame,
			status.action,
			status.phase,
			status.endedAt ?? "",
			status.scannedEntries ?? "",
			status.regions ?? "",
			status.archivedTokens ?? "",
			status.archivedBytes ?? "",
			status.tokensBefore ?? "",
			status.tokensAfter ?? "",
			status.tokensFreed ?? "",
			status.skipped ?? "",
			status.aborted ?? "",
			status.error ?? "",
		].join("|");
	}

	/**
	 * Two rows: the state headline (phase, method, context percentage) and the
	 * offload detail (counters, artifact path, elapsed). The detail row is
	 * omitted only when the headline is all there is to say.
	 */
	#rows(status: CompactionRummageStatus, now: number): string[] {
		const live = status.endedAt === undefined;
		const where = archiveLabel(status);
		const sep = theme.fg("muted", SEPARATOR);
		const indent = padding(1);
		let head: string;
		if (live) {
			const frame = getSymbolTheme().spinnerFrames;
			const glyph = frame[Math.floor(now / TICK_MS) % frame.length] ?? "·";
			const label =
				status.phase === "summarizing"
					? "summarizing context"
					: status.phase === "rewriting"
						? "rewriting context"
						: `rummaging ${where}`;
			head = `${theme.fg("accent", glyph)} ${theme.fg("accent", label)}`;
		} else if (status.error) {
			head = theme.fg("error", `${theme.status.error} ${where} failed`);
		} else if (status.aborted) {
			head = theme.fg("warning", `${theme.status.warning} ${where} interrupted`);
		} else if (status.skipped) {
			head = theme.fg("warning", `${theme.status.warning} ${where} skipped`);
		} else {
			head = theme.fg("success", `${theme.status.success} ${where}`);
		}

		const headline: string[] = [theme.fg("muted", status.action)];
		const before = percentOf(status.tokensBefore, status.contextWindow);
		const after = percentOf(status.tokensAfter, status.contextWindow);
		if (live) {
			if (before !== undefined) {
				headline.push(`${theme.fg("statusLineContext", `${before}%`)}${theme.fg("muted", " → …")}`);
			}
		} else if (before !== undefined && after !== undefined) {
			const delta = before - after;
			headline.push(
				`${theme.fg("muted", `${before}% → `)}${theme.fg(
					delta > 0 ? "success" : "muted",
					`${after}%`,
				)}${delta > 0 ? theme.fg("muted", ` (−${delta} pts)`) : ""}`,
			);
			if (delta <= 0 && !status.skipped) headline.push(theme.fg("warning", "no reduction"));
		}
		const rows = [`${indent}${head}${sep}${headline.join(sep)}`];

		const detail: string[] = [];
		if (live) {
			if (status.scannedEntries !== undefined) {
				detail.push(theme.fg("muted", `${formatNumber(status.scannedEntries)} entries`));
			}
			if (status.regions !== undefined) {
				detail.push(theme.fg("muted", `${formatNumber(status.regions)} regions`));
			}
			if (status.archivedTokens !== undefined && status.archivedTokens > 0) {
				detail.push(theme.fg("muted", `${formatNumber(status.archivedTokens)} tok`));
			}
			if (status.archivedBytes !== undefined && status.archivedBytes > 0) {
				detail.push(theme.fg("muted", formatBytes(status.archivedBytes)));
			}
		} else {
			const freed =
				status.tokensFreed ??
				(status.tokensBefore !== undefined && status.tokensAfter !== undefined
					? Math.max(0, status.tokensBefore - status.tokensAfter)
					: undefined);
			if (freed !== undefined && freed > 0) {
				detail.push(theme.fg("muted", `${formatNumber(freed)} tok reclaimed`));
			}
			if (status.error) {
				const message = replaceTabs(status.error).replace(/\r?\n/g, " ");
				detail.push(theme.fg("error", truncateToWidth(message, 80)));
			}
		}
		if (status.archivePath && !status.error) {
			detail.push(theme.fg("muted", shortenPath(status.archivePath)));
		}
		detail.push(theme.fg("muted", elapsedLabel((status.endedAt ?? now) - status.startedAt)));
		if (detail.length > 0) rows.push(`${indent}  ${detail.join(sep)}`);
		return rows;
	}
}
