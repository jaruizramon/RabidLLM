import { afterEach, describe, expect, it } from "bun:test";
import { setShimmerMode, shimmerEnabled } from "@oh-my-pi/pi-tui/theme/shimmer";

const originalColumns = process.stdout.columns;

function setColumns(columns: number | undefined): void {
	Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true, writable: true });
}

afterEach(() => {
	setColumns(originalColumns);
	delete process.env.RABID_NO_ANIMATIONS;
	setShimmerMode("classic");
});

describe("shimmer gate", () => {
	it("stays off on a phone-width terminal, where the sweep repaints a row the emulator appends", () => {
		setColumns(40);
		expect(shimmerEnabled()).toBe(false);
	});

	it("runs on a terminal wide enough to show the sweep", () => {
		setColumns(120);
		expect(shimmerEnabled()).toBe(true);
	});

	it("honours RABID_NO_ANIMATIONS for a host that cannot repaint in place", () => {
		setColumns(120);
		process.env.RABID_NO_ANIMATIONS = "1";
		expect(shimmerEnabled()).toBe(false);
		process.env.RABID_NO_ANIMATIONS = "0";
		expect(shimmerEnabled()).toBe(true);
	});

	it("keeps the historical behaviour when the width is unknown (pipes, tests)", () => {
		setColumns(undefined);
		expect(shimmerEnabled()).toBe(true);
	});

	it("still respects an explicit disabled mode", () => {
		setColumns(120);
		setShimmerMode("disabled");
		expect(shimmerEnabled()).toBe(false);
	});
});
