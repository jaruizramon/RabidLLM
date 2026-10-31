import { describe, expect, it } from "bun:test";
import { isUserCorrection } from "@oh-my-pi/pi-coding-agent/session/correction-notice";

describe("isUserCorrection", () => {
	it("recognizes corrections that invalidate the previous claim", () => {
		for (const text of [
			"no",
			"no, it's a square",
			"it's not a cube",
			"it’s not a cube",
			"it's nott a star shape",
			"that's not right",
			"stop going around circles",
			"stop going in circles",
			"stop reading the codebase",
			"wrong",
			"still wrong",
			"I said the square",
			"I killed the chrome processes chill with that please",
		]) {
			expect(isUserCorrection(text), text).toBe(true);
		}
	});

	it("does not treat a fresh negation or an unrelated stop as a correction", () => {
		for (const text of [
			"do not use tabs",
			"there is no file",
			"stop the server",
			"remove the square",
			"the square is not a cube",
		]) {
			expect(isUserCorrection(text), text).toBe(false);
		}
	});
});
