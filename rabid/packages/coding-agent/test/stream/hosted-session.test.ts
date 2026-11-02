import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { hostedScreenName, innerLaunchArgv } from "../../src/stream/hosted-session";

/**
 * The bash web wrapper (`~/.local/share/rabid-web/rabid-session`) attaches the
 * agent screen by `${prefix}${sha1(realpath) | cut -c1-10}`. If this drifts, the
 * phone opens a fresh shell instead of the hosted session.
 */
describe("hosted screen name", () => {
	test("matches the wrapper's sha1 prefix contract", () => {
		const dir = "/home/pipo/Documents/GolfAG";
		const expected = `rabid-${createHash("sha1").update(dir).digest("hex").slice(0, 10)}`;
		expect(hostedScreenName(dir)).toBe(expected);
	});

	test("is stable per directory and distinct across directories", () => {
		const first = hostedScreenName("/home/pipo/Documents/GolfAG");
		expect(hostedScreenName("/home/pipo/Documents/GolfAG")).toBe(first);
		expect(hostedScreenName("/home/pipo/Documents/RabidAI")).not.toBe(first);
	});
});

/**
 * The hosted process is the same CLI invocation minus the hosting flag; if the
 * flag leaked into the inner argv it would spawn a second screen inside the
 * first one.
 */
describe("hosted inner launch argv", () => {
	test("bare --resume-stream continues the latest session", () => {
		expect(innerLaunchArgv(["--resume-stream", "--no-title"])).toEqual(["--no-title", "--continue"]);
	});

	test("drops the hosting flag and keeps an explicit session selector", () => {
		expect(innerLaunchArgv(["--resume-stream", "--resume", "01a193", "--model", "qwen"])).toEqual([
			"--resume",
			"01a193",
			"--model",
			"qwen",
		]);
		expect(innerLaunchArgv(["--resume-stream=1", "--continue"])).toEqual(["--continue"]);
	});

	test("leaves an unrelated invocation untouched", () => {
		expect(innerLaunchArgv(["--continue", "fix the camera"])).toEqual(["--continue", "fix the camera"]);
	});
});
