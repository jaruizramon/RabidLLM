/**
 * `calculate` — a deterministic parameter sweep the model drives without
 * writing code.
 *
 * The point is arithmetic the model cannot fumble: a formula plus named
 * sliders (`values`, or a `from`/`to`/`step` range) expands to a stable table,
 * with an optional `compare` expression and `delta`/`ratio` columns. There is
 * no I/O, no clock and no randomness, so two runs of the same call are
 * byte-identical — which is what makes it usable for timing-model comparisons
 * and for pinning down a race by replaying fixed inputs.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";

import calculateDescription from "../prompts/tools/calculate.md" with { type: "text" };

const MAX_ROWS = 5_000;
const MAX_SLIDERS = 8;
const MAX_POSITIONS = 1_000;
const MAX_EXPRESSION = 2_000;
const DEFAULT_PRECISION = 6;
const MAX_PRECISION = 12;

const SliderSchema = type({
	name: type("string").describe("variable name used in the formulas"),
	"values?": type("number").array().atLeastLength(1).atMostLength(MAX_POSITIONS).describe("explicit positions"),
	"from?": type("number").describe("range start"),
	"to?": type("number").describe("range end (inclusive)"),
	"step?": type("number").describe("range step, default 1"),
});

const calculateSchema = type({
	formula: type("string").describe("expression evaluated for every slider combination"),
	"sliders?": SliderSchema.array().atMostLength(MAX_SLIDERS),
	"compare?": type("string").describe("second expression; adds compare, delta and ratio columns"),
	"unit?": type("string").describe("result column label"),
	"precision?": type("number").describe(`decimal places, 0-${MAX_PRECISION} (default ${DEFAULT_PRECISION})`),
	"maxRows?": type("number").describe(`row cap (default 2000, hard ${MAX_ROWS})`),
});

type CalculateParams = typeof calculateSchema.infer;
type SliderParams = typeof SliderSchema.infer;

export interface CalculateToolDetails {
	readonly columns: readonly string[];
	readonly rows: readonly (readonly string[])[];
	readonly total: number;
}

// =============================================================================
// Expression evaluator
// =============================================================================

type Token = { kind: "number"; value: number } | { kind: "name"; value: string } | { kind: "op"; value: string };

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const FUNCTIONS: Record<string, { arity: number | number[]; fn: (args: number[]) => number }> = {
	abs: { arity: 1, fn: args => Math.abs(args[0]!) },
	ceil: { arity: 1, fn: args => Math.ceil(args[0]!) },
	exp: { arity: 1, fn: args => Math.exp(args[0]!) },
	floor: { arity: 1, fn: args => Math.floor(args[0]!) },
	log: { arity: 1, fn: args => Math.log(args[0]!) },
	round: { arity: 1, fn: args => Math.round(args[0]!) },
	sign: { arity: 1, fn: args => Math.sign(args[0]!) },
	sqrt: { arity: 1, fn: args => Math.sqrt(args[0]!) },
	max: { arity: [1, 2, 3, 4], fn: args => Math.max(...args) },
	min: { arity: [1, 2, 3, 4], fn: args => Math.min(...args) },
	pow: { arity: 2, fn: args => args[0]! ** args[1]! },
};

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	while (index < source.length) {
		const char = source[index]!;
		if (/\s/.test(char)) {
			index++;
			continue;
		}
		if (/[0-9.]/.test(char)) {
			const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(source.slice(index));
			if (!match) throw new Error(`invalid number at ${index}`);
			tokens.push({ kind: "number", value: Number(match[0]) });
			index += match[0].length;
			continue;
		}
		if (/[A-Za-z_]/.test(char)) {
			const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
			if (!match) throw new Error(`invalid name at ${index}`);
			tokens.push({ kind: "name", value: match[0] });
			index += match[0].length;
			continue;
		}
		if ("+-*/%^(),".includes(char)) {
			tokens.push({ kind: "op", value: char });
			index++;
			continue;
		}
		throw new Error(`unexpected character "${char}" at ${index}`);
	}
	return tokens;
}

class ExpressionParser {
	readonly #tokens: Token[];
	readonly #variables: Record<string, number>;
	#index = 0;

	constructor(source: string, variables: Record<string, number>) {
		this.#tokens = tokenize(source);
		this.#variables = variables;
		if (this.#tokens.length === 0) throw new Error("empty expression");
	}

	parse(): number {
		const value = this.#expression();
		const rest = this.#tokens[this.#index];
		if (rest !== undefined) throw new Error(`unexpected "${String(rest.value)}"`);
		return value;
	}

	#peekOp(op: string): boolean {
		const token = this.#tokens[this.#index];
		return token?.kind === "op" && token.value === op;
	}

	#takeOp(op: string): void {
		if (!this.#peekOp(op)) throw new Error(`expected "${op}"`);
		this.#index++;
	}

	#expression(): number {
		let value = this.#term();
		for (;;) {
			if (this.#peekOp("+")) {
				this.#index++;
				value += this.#term();
			} else if (this.#peekOp("-")) {
				this.#index++;
				value -= this.#term();
			} else {
				return value;
			}
		}
	}

	#term(): number {
		let value = this.#unary();
		for (;;) {
			if (this.#peekOp("*")) {
				this.#index++;
				value *= this.#unary();
			} else if (this.#peekOp("/")) {
				this.#index++;
				value /= this.#unary();
			} else if (this.#peekOp("%")) {
				this.#index++;
				value %= this.#unary();
			} else {
				return value;
			}
		}
	}

	#unary(): number {
		if (this.#peekOp("-")) {
			this.#index++;
			return -this.#unary();
		}
		if (this.#peekOp("+")) {
			this.#index++;
			return this.#unary();
		}
		return this.#power();
	}

	#power(): number {
		const base = this.#primary();
		if (this.#peekOp("^")) {
			this.#index++;
			// Right-associative, and the exponent may be signed: 2^-1, 2^3^2.
			return base ** this.#unary();
		}
		return base;
	}

	#primary(): number {
		const token = this.#tokens[this.#index];
		if (token === undefined) throw new Error("unexpected end of expression");
		this.#index++;
		if (token.kind === "number") return token.value;
		if (token.kind === "name") {
			const name = token.value;
			if (this.#peekOp("(")) {
				this.#index++;
				const args: number[] = [];
				if (!this.#peekOp(")")) {
					for (;;) {
						args.push(this.#expression());
						if (!this.#peekOp(",")) break;
						this.#index++;
					}
				}
				this.#takeOp(")");
				const fn = FUNCTIONS[name];
				if (!fn) throw new Error(`unknown function "${name}"`);
				const allowed = Array.isArray(fn.arity) ? fn.arity : [fn.arity];
				if (!allowed.includes(args.length)) {
					throw new Error(`"${name}" takes ${allowed.join(" or ")} argument(s), got ${args.length}`);
				}
				return fn.fn(args);
			}
			if (Object.hasOwn(this.#variables, name)) return this.#variables[name]!;
			if (Object.hasOwn(CONSTANTS, name)) return CONSTANTS[name]!;
			throw new Error(`unknown name "${name}" (add it as a slider)`);
		}
		if (token.value === "(") {
			const value = this.#expression();
			this.#takeOp(")");
			return value;
		}
		throw new Error(`unexpected "${token.value}"`);
	}
}

function evaluate(source: string, variables: Record<string, number>): number {
	if (source.length > MAX_EXPRESSION) throw new Error(`expression exceeds ${MAX_EXPRESSION} characters`);
	return new ExpressionParser(source, variables).parse();
}

// =============================================================================
// Sweep
// =============================================================================

interface Axis {
	readonly name: string;
	readonly values: readonly number[];
}

function resolveAxis(slider: SliderParams, index: number): Axis {
	const name = slider.name.trim();
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`slider ${index + 1}: "${name}" is not a valid name`);
	if (Object.hasOwn(CONSTANTS, name) || Object.hasOwn(FUNCTIONS, name)) {
		throw new Error(`slider ${index + 1}: "${name}" is reserved`);
	}
	if (slider.values !== undefined) {
		if (slider.values.length === 0) throw new Error(`slider "${name}": values is empty`);
		if (slider.values.length > MAX_POSITIONS) throw new Error(`slider "${name}": more than ${MAX_POSITIONS} values`);
		return { name, values: slider.values };
	}
	if (slider.from === undefined || slider.to === undefined) {
		throw new Error(`slider "${name}": needs values or from/to/step`);
	}
	const step = slider.step ?? 1;
	if (!(step > 0)) throw new Error(`slider "${name}": step must be positive`);
	if (slider.to < slider.from) throw new Error(`slider "${name}": to < from`);
	const count = Math.floor((slider.to - slider.from) / step + 1e-9) + 1;
	if (count > MAX_POSITIONS) throw new Error(`slider "${name}": more than ${MAX_POSITIONS} positions`);
	const values = Array.from({ length: count }, (_, position) => slider.from! + position * step);
	return { name, values };
}

function formatNumber(value: number, precision: number): string {
	if (!Number.isFinite(value)) return String(value);
	if (Number.isInteger(value) || Math.abs(value) >= 1e15) return String(value);
	const fixed = value.toFixed(precision).replace(/0+$/, "").replace(/\.$/, "");
	return fixed === "-0" ? "0" : fixed;
}

// =============================================================================
// Tool
// =============================================================================

export class CalculateTool implements AgentTool<typeof calculateSchema, CalculateToolDetails> {
	readonly name = "calculate";
	readonly approval = "read" as const;
	readonly label = "Calculate";
	readonly summary = "Deterministic parameter sweep over an arithmetic expression";
	readonly description: string;
	readonly parameters = calculateSchema;
	readonly strict = true;
	readonly concurrency = "shared";
	// Top-level, not an xd:// device: the model must reach for it mid-thought,
	// and xdev is on by default.
	readonly loadMode = "essential";

	constructor() {
		this.description = prompt.render(calculateDescription);
	}

	async execute(
		_toolCallId: string,
		params: CalculateParams,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<CalculateToolDetails>> {
		try {
			const precision = Math.min(MAX_PRECISION, Math.max(0, Math.trunc(params.precision ?? DEFAULT_PRECISION)));
			const maxRows = Math.min(MAX_ROWS, Math.max(1, Math.trunc(params.maxRows ?? 2_000)));
			const axes = (params.sliders ?? []).map(resolveAxis);
			const total = axes.reduce((count, axis) => count * axis.values.length, 1);
			if (total > maxRows) {
				throw new Error(`${total} rows exceeds the cap of ${maxRows}; narrow a slider or raise maxRows`);
			}

			const columns = [...axes.map(axis => axis.name), params.unit ?? "result"];
			if (params.compare !== undefined) columns.push("compare", "delta", "ratio");

			const rows: string[][] = [];
			const indices = axes.map(() => 0);
			for (let row = 0; row < total; row++) {
				const variables: Record<string, number> = {};
				for (let axisIndex = 0; axisIndex < axes.length; axisIndex++) {
					const axis = axes[axisIndex]!;
					variables[axis.name] = axis.values[indices[axisIndex]!]!;
				}
				const result = evaluate(params.formula, variables);
				const cells = axes.map(axis => formatNumber(variables[axis.name]!, precision));
				cells.push(formatNumber(result, precision));
				if (params.compare !== undefined) {
					const comparison = evaluate(params.compare, variables);
					cells.push(
						formatNumber(comparison, precision),
						formatNumber(result - comparison, precision),
						comparison === 0 ? "—" : formatNumber(result / comparison, precision),
					);
				}
				rows.push(cells);
				for (let axisIndex = axes.length - 1; axisIndex >= 0; axisIndex--) {
					indices[axisIndex]++;
					if (indices[axisIndex]! < axes[axisIndex]!.values.length) break;
					indices[axisIndex] = 0;
				}
			}

			const lines = [
				`# deterministic sweep · ${total} row${total === 1 ? "" : "s"} · precision ${precision}`,
				"",
				`| ${columns.join(" | ")} |`,
				`| ${columns.map(() => "---").join(" | ")} |`,
				...rows.map(cells => `| ${cells.join(" | ")} |`),
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { columns, rows, total },
			};
		} catch (error) {
			return {
				content: [{ type: "text", text: `calculate: ${error instanceof Error ? error.message : String(error)}` }],
				details: { columns: [], rows: [], total: 0 },
				isError: true,
			};
		}
	}
}
