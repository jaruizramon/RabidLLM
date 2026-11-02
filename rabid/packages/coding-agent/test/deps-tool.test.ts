import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { DepsTool, type DepsToolDetails, majorOf, parseCargoLock, parsePackageLock } from "../src/tools/deps";

function createTestSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function resultText(result: AgentToolResult<DepsToolDetails>): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

const CARGO_LOCK = `version = 3

[[package]]
name = "axum"
version = "0.6.20"

[[package]]
name = "http"
version = "0.2.12"

[[package]]
name = "http"
version = "1.5.0"

[[package]]
name = "tower"
version = "0.4.13"

[[package]]
name = "tower"
version = "0.5.3"
`;

const CARGO_TOML = `[package]
name = "fixture"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = { version = "0.6", features = ["json"] }
`;

const PACKAGE_LOCK = JSON.stringify({
	lockfileVersion: 3,
	packages: {
		"": { name: "fixture", dependencies: { "make-thing": "^1.0.0" } },
		"node_modules/make-thing": { version: "1.2.0" },
	},
});

describe("deps helpers", () => {
	it("buckets 0.x minor versions as breaking majors", () => {
		expect(majorOf("0.4.13")).toBe("0.4");
		expect(majorOf("0.6.20")).toBe("0.6");
		expect(majorOf("1.5.0")).toBe("1");
		expect(majorOf("v2.0.1-rc1")).toBe("2");
	});

	it("parses cargo and npm lockfiles", () => {
		expect(parseCargoLock(CARGO_LOCK)).toEqual([
			{ name: "axum", version: "0.6.20" },
			{ name: "http", version: "0.2.12" },
			{ name: "http", version: "1.5.0" },
			{ name: "tower", version: "0.4.13" },
			{ name: "tower", version: "0.5.3" },
		]);
		expect(parsePackageLock(PACKAGE_LOCK)).toEqual([{ name: "make-thing", version: "1.2.0" }]);
	});
});

describe("deps tool", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@deps-tool-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("reports duplicate majors and declared-to-resolved direct dependencies", async () => {
		const project = tempDir.path();
		await Bun.write(path.join(project, "Cargo.toml"), CARGO_TOML);
		await Bun.write(path.join(project, "Cargo.lock"), CARGO_LOCK);
		const tool = new DepsTool(createTestSession(project));

		const text = resultText(await tool.execute("call-1", { op: "resolve" }));

		expect(text).toContain("duplicate majors");
		expect(text).toContain("http");
		expect(text).toContain("0.2.12, 1.5.0");
		expect(text).toContain("tower");
		expect(text).toContain("0.6 → 0.6.20");
	});

	it("finds a symbol in the installed version's vendored source", async () => {
		const project = tempDir.path();
		await Bun.write(path.join(project, "Cargo.toml"), CARGO_TOML);
		await Bun.write(path.join(project, "Cargo.lock"), CARGO_LOCK);
		await Bun.write(
			path.join(project, "vendor", "axum", "src", "middleware", "from_fn.rs"),
			"/// Runs the rest of the stack.\npub struct Next<B> {\n    inner: Box<B>,\n}\n\npub struct NextUnrelated;\n",
		);
		const tool = new DepsTool(createTestSession(project));

		const text = resultText(await tool.execute("call-2", { op: "api", package: "axum", symbol: "Next" }));

		expect(text).toContain("axum 0.6.20");
		expect(text).toContain("pub struct Next<B>");
		expect(text).not.toContain("NextUnrelated");
	});

	it("answers that a symbol does not exist in the pinned version", async () => {
		const project = tempDir.path();
		await Bun.write(path.join(project, "Cargo.toml"), CARGO_TOML);
		await Bun.write(path.join(project, "Cargo.lock"), CARGO_LOCK);
		await Bun.write(path.join(project, "vendor", "axum", "src", "lib.rs"), "pub struct Next<B>;\n");
		const tool = new DepsTool(createTestSession(project));

		const text = resultText(await tool.execute("call-3", { op: "api", package: "axum", symbol: "serve" }));

		expect(text).toContain('no definition of "serve"');
		expect(text).toContain("axum 0.6.20");
	});

	it("resolves an npm package from package-lock and its node_modules types", async () => {
		const project = tempDir.path();
		await Bun.write(
			path.join(project, "package.json"),
			JSON.stringify({ name: "fixture", dependencies: { "make-thing": "^1.0.0" } }),
		);
		await Bun.write(path.join(project, "package-lock.json"), PACKAGE_LOCK);
		await Bun.write(
			path.join(project, "node_modules", "make-thing", "package.json"),
			JSON.stringify({ name: "make-thing", version: "1.2.0", types: "index.d.ts" }),
		);
		await Bun.write(
			path.join(project, "node_modules", "make-thing", "index.d.ts"),
			"export declare function makeThing(seed: number): string;\n",
		);
		const tool = new DepsTool(createTestSession(project));

		const resolveText = resultText(await tool.execute("call-4", { op: "resolve" }));
		expect(resolveText).toContain("make-thing");
		expect(resolveText).toContain("^1.0.0 → 1.2.0");

		const apiText = resultText(
			await tool.execute("call-5", { op: "api", package: "make-thing", symbol: "makeThing" }),
		);
		expect(apiText).toContain("make-thing 1.2.0");
		expect(apiText).toContain("function makeThing");
	});
});
