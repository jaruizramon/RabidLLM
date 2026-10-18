# Credits

RabidLLM is my own repository (the setup inside is called RabidAI): the rig duplicator, the background compaction handoff, and the
harness those live in. **The harness is built on [oh-my-pi](https://github.com/can1357/oh-my-pi)
and that debt is the largest one here.** The license is unchanged.

## Upstream — oh-my-pi

- Source: <https://github.com/can1357/oh-my-pi> · MIT License
- Copyright (c) 2025 Mario Zechner
- Copyright (c) 2025–2026 Can Bölük
- Copyright (c) 2026 Stencil Labs, Inc.
- oh-my-pi is itself a fork of [Pi](https://github.com/badlogic/pi-mono) by
  [@mariozechner](https://github.com/mariozechner)

The complete MIT text with those notices is in [`LICENSE`](LICENSE), unmodified. The upstream
README is preserved verbatim at [`docs/upstream-readme.md`](rabid/docs/upstream-readme.md).

What this repository changed is inventoried file by file in
[`docs/FORK.md`](docs/FORK.md). **Everything not listed there is upstream work,
and upstream's documentation in `docs/` applies to it.** The changes are kept at upstream
paths on purpose, so `git fetch upstream && git merge upstream/main` stays reviewable.

## Work that is this repository's own

- **Rig** — `rig/`: `manager.py`, `index.html` (including the SLM worker panel and the
  CPU/GPU load meters), `proxy.py`, `toolfilter.py`, the `models*.ini` presets, the five
  `bin/` wrappers, `install.sh`, `models.list`.
- **Mechanism** — `rabid/packages/coding-agent/src/slm/`: coordinator, supervised worker,
  `/models-worker`, and the handoff prompts under `src/prompts/system/slm-handoff*.md`.
- **Harness changes** — `rabid/packages/coding-agent/src/rabid/` plus the rewired upstream modules
  listed in `FORK.md`.
- **Docs** — `docs/` (charter, plans, this repository's fork inventory, the test
  notebook) and the root README.

## Third-party software used, not redistributed

| Piece | License / source |
|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp), stock build and the PrismML fork | MIT; installed as external binaries under `~/.local/opt`, not vendored here |
| [huggingface_hub](https://github.com/huggingface/huggingface_hub) CLI (`hf`) | Apache-2.0 |
| Bun, TypeScript, Rust toolchains | their respective licenses |
| Cronet/WebAssembly grammars, npm dependencies | see `THIRD-PARTY-NOTICES.txt` and each package's lockfile |

## Model weights

None are distributed in this repository. `rig/models.list` names the files the presets
expect and the Hub repository for each; fetch them yourself and check the license on the
model's own page — the Spark, SmolLM, Qwen, Nemotron and Ornith cards each carry their own
terms, which this repository cannot restate for you.
