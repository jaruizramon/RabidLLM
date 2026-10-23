import { describe, expect, it } from "bun:test";
import { assertNoSourceTokenCorruption, findTokenCorruption } from "@oh-my-pi/pi-coding-agent/tools/source-integrity";

describe("source token corruption", () => {
	it("finds a CJK glyph spliced into an identifier", () => {
		const findings = findTokenCorruption("const z = THREE.M方Utils.clamp(z, -1, 1);\n", "game.js");
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ line: 1, char: "方" });
	});

	it("allows a stand-alone non-ASCII identifier but catches a splice", () => {
		expect(findTokenCorruption("const 变量 = 1;\nconst name = 2;\n", "game.js")).toEqual([]);
		expect(findTokenCorruption("const value = name方Other;\n", "game.js")).toHaveLength(1);
	});

	it("ignores CJK inside strings, templates, and comments", () => {
		const source = ['const label = "方";', "const template = `成`;", "// 振", "/* 成 */", "const ascii = 1;"].join(
			"\n",
		);
		expect(findTokenCorruption(source, "game.js")).toEqual([]);
	});

	it("ignores non-JavaScript files", () => {
		expect(findTokenCorruption("<p>方</p>", "index.html")).toEqual([]);
	});

	it("refuses the write and names the first occurrence", () => {
		expect(() => assertNoSourceTokenCorruption("const x = RO成;\n", "scene.js", "js/scene.js")).toThrow(
			/js\/scene\.js: line 1, column 13 contains "成"/,
		);
	});
});
