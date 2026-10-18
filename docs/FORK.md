# The rabid harness

This repository's harness is built on **oh-my-pi** (MIT — attribution in
[`../../CREDITS.md`](../CREDITS.md)), and it is more than that harness plus a config
profile: compaction, maintenance, the token meter, the TUI, the provider layer and the model
catalog all carry changes. This file is the inventory — what was added, what was rewired, and
what stayed untouched — so a future merge with upstream has a boundary to check against.

Upstream README: [`../docs/upstream-readme.md`](../rabid/docs/upstream-readme.md). Sync:
`git fetch upstream && git merge upstream/main`.

## Modules this fork adds

| Path | What it is |
|---|---|
| `rabid/packages/coding-agent/src/slm/` | the background handoff: `handoff.ts` (coordinator, document format, isolation), `server.ts` (supervised worker), `worker-command.ts` (`/models-worker`) |
| `src/rabid/turn-cards.ts` | per-prompt episodic cards: prompt, files touched, 50-word summary per operation |
| `src/rabid/compaction-rummage.ts` | token reclamation over the discarded region (drop reads, supersede reads, drop useless) |
| `src/rabid/compaction-rummage-panel.ts` | TUI panel for the rummage ledger |
| `src/rabid/compaction-speed.ts` | speed-floor trigger: compact when decode stays under a floor for consecutive turns |
| `src/rabid/rabid-modes.ts` | fast / balanced / deep modes (thinking budgets, sampling, tool policy) |
| `src/rabid/model-profiles.ts` | per-model policy blocks (`profiles:` in settings) |
| `src/rabid/model-selectors.ts` | selector matching for those profiles |
| `src/rabid/model-profile-settings.ts` | session-side resolution of a model's profile |
| `src/rabid/token-rate-panel.ts` | token-rate / reasoning-budget panel |
| `src/rabid/llama-preset-command.ts` | `/preset` for the local llama.cpp router (fast/balanced/deep, load/unload) |
| `rabid/packages/utils/src/atomic-write.ts` | staged temp-file + rename publication |
| `src/prompts/system/{slm-handoff,slm-handoff-input,turn-card}.md` | prompts for the above |

Tests for these live in `rabid/packages/coding-agent/test/rabid/` and `test/slm/`.

## Upstream modules this fork materially rewires

| Path | Fork change |
|---|---|
| `session/session-maintenance.ts` | the maintenance brain: speed floor, rummage, turn-card scheduling, slm summary commit, method fallback chain, deterministic summary blocks (+650 lines) |
| `session/agent-session.ts` | token meter wiring, rabid modes, slm coordinator lifecycle, length-stop/retry interplay, provider-session id bookkeeping |
| `session/context-settings.ts` | every new setting: compaction method order, `slmHandoff.*`, speed floor, turn cards, profiles |
| `session/settings.ts`, `session/session-tools.ts`, `session/agent-session-types.ts` | settings + tool policy plumbing for the above |
| `config/compaction-threshold.ts`, `config/model-settings.ts`, `sdk.ts` | per-model thresholds, profile resolution, SDK surface |
| `modes/interactive-mode.ts`, `modes/controllers/input-controller.ts` | panels, mode switching, status segments |
| `rabid/packages/ai/src/providers/openai-{shared,completions}.ts`, `stream.ts` | llama.cpp reasoning budget (`reasoning_budget_tokens`, `chat_template_kwargs`) |
| `rabid/packages/catalog/src/compat/{axes,resolve,types}.ts`, `rules/providers/llama.cpp.kdl` | local-model policy expressed in KDL, per the repo's rule that model policy never lives in TypeScript |
| `rabid/packages/agent/src/compaction/messages.ts` | renders `handoff` / `slm` summaries as handoff context instead of a plain summary |

## Settings and commands that exist only here

`compaction.speedFloorTps`, `speedConsecutive`, `speedMinTokens`, `compaction.methodOrder`
including `slm`, the whole `compaction.slmHandoff.*` block, `compaction.rummage*`,
`turnCards.*`, `profiles.*`, rabid modes; commands `/models-worker`, `/preset`; the rummage
and token-rate panels. See [`../../docs/settings.md`](../rabid/docs/settings.md) and
[`../../docs/compaction.md`](../rabid/docs/compaction.md).

## What stays upstream

Everything not listed above. In particular the repository **root manifests** — `bunfig.toml`,
`package.json`, `tsconfig.*`, `Cargo.toml`, `rust-toolchain.toml`, `deny.toml`, `about.toml`,
`MODULE.bazel`, `.bazelrc`, `.bazelversion`, `flake.nix`, `Dockerfile*`, `.github/` — are
workspace anchors that tool discovery and CI resolve against. They are not moved into
component folders, because doing so breaks the build and turns every upstream merge into a
path-conflict. Fork-owned code is grouped instead: `rabid/` (rig + docs) at the repository
root, `src/slm/` and `src/rabid/` inside the harness.
