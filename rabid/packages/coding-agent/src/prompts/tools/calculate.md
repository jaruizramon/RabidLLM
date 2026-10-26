Deterministic parameter sweep: set the sliders, read the table.

`formula` is evaluated once per combination of slider positions, in declaration order (first slider outermost). Arithmetic only: `+ - * / % ^`, parentheses, `min max abs floor ceil round sqrt log exp sign pow`, and the constants `pi` / `e`. No I/O, no clock, no randomness — the same input always prints the same bytes.

A slider is either explicit positions (`values`) or a range (`from`, `to`, `step`). `compare` adds a second expression plus `delta` and `ratio` columns, which is how two timing models are checked against each other.

Examples:
- row duration: `formula: "2.5 * speed / tempo"`, `sliders: [{name:"tempo", values:[100,125,150]}, {name:"speed", values:[3,6]}]`
- two models: `formula: "60 / tempo / speed"`, `compare: "2.5 * speed / tempo"`
- fixed schedule: give every slider a single `values` entry, then read the deterministic columns.

Limits: 8 sliders, 1,000 positions per slider, 5,000 rows, precision 0–12.
