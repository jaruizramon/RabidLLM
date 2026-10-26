# calculate

> Deterministic parameter sweep: evaluates one arithmetic formula over every combination of named slider positions and prints a table.

## Source
- Entry: `packages/coding-agent/src/tools/calculate.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/calculate.md`
- Registration: `packages/coding-agent/src/tools/index.ts` (`BUILTIN_TOOLS`) and `tools/builtin-names.ts`.

## Inputs

| Field | Required | Meaning |
| --- | --- | --- |
| `formula` | yes | Expression evaluated for each combination. |
| `sliders` | no | Up to 8 axes; each is `{ name, values }` or `{ name, from, to, step }`. The first slider is the outermost axis. |
| `compare` | no | Second expression; adds `compare`, `delta` and `ratio` columns. |
| `unit` | no | Label for the result column (default `result`). |
| `precision` | no | Decimal places, 0–12 (default 6). |
| `maxRows` | no | Row cap, default 2,000, hard limit 5,000. |

Expression grammar: `+ - * / % ^`, parentheses, the functions `abs ceil exp floor log max min pow round sign sqrt`, and the constants `pi` / `e`. `^` is right-associative and binds tighter than unary minus, so `-2^2 = -4`.

## Behaviour

- Axes expand in declaration order; rows are emitted as a mixed-radix product, so output order is stable and reproducible.
- Missing `step` defaults to 1. Ranges are inclusive and computed with a 1e-9 tolerance so `0 to 1 step 0.1` yields exactly 11 positions.
- A name that is neither a slider nor a constant is an error, never silently `NaN`.
- No file, network, clock or randomness access. The same call always renders byte-identical text, which is what makes the tool usable for timing-model comparisons and fixed race schedules.

## Errors

Returned as `isError` text: invalid syntax, unknown name/function, wrong arity, empty or oversized slider, `to < from`, non-positive step, and a sweep wider than the cap.
