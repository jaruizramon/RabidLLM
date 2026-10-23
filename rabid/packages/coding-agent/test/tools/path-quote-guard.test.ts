import { describe, expect, it } from "bun:test";
import { resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

describe("quoted tool paths", () => {
	it("strips one JSON string-literal wrapper from an absolute path", () => {
		expect(resolveToCwd('"/home/pipo/Documents/sampleGame2/index.html"', "/tmp")).toBe(
			"/home/pipo/Documents/sampleGame2/index.html",
		);
	});

	it("rejects a path whose segment is a literal quote", () => {
		expect(() =>
			resolveToCwd('"/home/pipo/Documents/sampleGame2/"/home/pipo/Documents/sampleGame2/index.html"', "/tmp"),
		).toThrow(/quote character in a path segment/);
	});

	it("rejects an unterminated wrapper instead of resolving it relative to the cwd", () => {
		expect(() => resolveToCwd('"unterminated/index.html', "/tmp")).toThrow(/quote character in a path segment/);
	});
});
