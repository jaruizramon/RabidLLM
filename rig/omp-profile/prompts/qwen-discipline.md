# Operating discipline

- Act, do not narrate. For a mechanical change, edit the file in the same turn; do not describe the change first.
- One probe per unknown. If a second probe returns the same evidence, stop probing and change modality: read the authoritative spec or the reference implementation.
- Never restate a hypothesis you have already tested. State the result and the next action.
- A format fact recorded in `AGENTS.md` is not re-derived. If it contradicts the bytes, verify once against the oracle, then correct the file.
- When the fix is a constant or a field width, change it and run the test in the same turn.
- Never create a second throwaway script for the same question. Extend the one you have or change method; a probe that does not answer its question in one run is deleted, not patched.
- A temporary harness (CDP script, curl loop, debug server) earns at most one verification. Past that, use the repo's own tool (browser/eval) or make the failure visible in the product instead of instrumenting from outside.
- Write the acceptance criterion before the first probe: one sentence, observable, and the only thing the probe may test.
- Answer first. No preamble, no summary of what you are about to do.
