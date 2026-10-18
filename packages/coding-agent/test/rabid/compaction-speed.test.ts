/** The speed floor compacts only on a sustained sub-20 t/s streak at contextual size. */
import { describe, expect, it } from "bun:test";
import {
	advanceSpeedTrigger,
	type SpeedTriggerConfig,
	type SpeedTriggerState,
} from "@oh-my-pi/pi-coding-agent/rabid/compaction-speed";

const CONFIG: SpeedTriggerConfig = { floorTps: 20, consecutive: 2, minContextTokens: 20_000 };
const IDLE: SpeedTriggerState = { slowTurns: 0, cooldown: 0 };

describe("advanceSpeedTrigger", () => {
	it("never fires when disabled, even at zero t/s", () => {
		const decision = advanceSpeedTrigger(IDLE, { ...CONFIG, floorTps: 0 }, 1, 100_000);
		expect(decision.trigger).toBe(false);
	});

	it("fires after the configured streak and then absorbs the cooldown", () => {
		const first = advanceSpeedTrigger(IDLE, CONFIG, 18, 80_000);
		expect(first).toMatchObject({ slowTurns: 1, cooldown: 0, trigger: false });

		const second = advanceSpeedTrigger(first, CONFIG, 19, 82_000);
		expect(second).toMatchObject({ slowTurns: 0, cooldown: 2, trigger: true });

		// Two turns of grace: the shorter context gets to show its rate.
		const cooldown1 = advanceSpeedTrigger(second, CONFIG, 18, 30_000);
		const cooldown2 = advanceSpeedTrigger(cooldown1, CONFIG, 18, 30_000);
		expect(cooldown1.trigger).toBe(false);
		expect(cooldown2.trigger).toBe(false);
		expect(cooldown2.cooldown).toBe(0);
	});

	it("resets the streak on a fast turn or a missing sample", () => {
		const slow = advanceSpeedTrigger(IDLE, CONFIG, 18, 80_000);
		expect(slow.slowTurns).toBe(1);
		expect(advanceSpeedTrigger(slow, CONFIG, 25, 80_000).slowTurns).toBe(0);
		expect(advanceSpeedTrigger(slow, CONFIG, null, 80_000).slowTurns).toBe(0);
	});

	it("ignores slowness below the minimum context", () => {
		const slowSmall = advanceSpeedTrigger(IDLE, CONFIG, 10, 8_000);
		expect(slowSmall).toMatchObject({ slowTurns: 0, trigger: false });
	});
});
