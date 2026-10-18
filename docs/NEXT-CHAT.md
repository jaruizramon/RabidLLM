# NEXT CHAT — RabidAI implementation

Start a new omp chat with cwd **`/home/pipo/Documents/RabidAI`**, then paste:

> Read `RABIDAI.md`, `NEXT-CHAT.md`, `docs/rabid/README.md`, and
> `docs/rabid/PLAN-presets-and-omp.md`. We are on branch `rabid`. Continue with
> OMP-4, then OMP-1 and OMP-5. Do not touch the running V100 rig or the installed
> `~/.local/bin/omp`. Run the narrow package tests before claiming a step.

## Repo state at handoff

- Fork point `eb74cf84d8` of `can1357/oh-my-pi` (`main`, source 18.11.3), MIT.
- Branch `rabid`; `origin` = `jaruizramon/RabidAI` (the fork), `upstream` = `can1357/oh-my-pi`.
  The clone is `--filter=blob:none`; `rabid` is pushed and tracking `origin/rabid`.
- Installed binary on the box is `omp/18.2.6`; behavior differences are expected.
- `RABIDAI.md`, `NEXT-CHAT.md`, `docs/rabid/` added; `rabid` bin alias added in
  `rabid/packages/coding-agent/package.json` (the `omp` alias stays).
- The root `package.json` name is still `omp`; `bun.lock` records it. Do not rename
  until Bun is installed and `bun install` regenerates cleanly (stage 2).

## Progress on `rabid` (2026-10-17)

- Bun 1.4.3 installed; `bun install` clean; natives built with `bun --cwd=rabid/packages/natives run build`
  (needs `ninja` on PATH — fetched to `~/.local/bin/ninja` here).
- **OMP-4 done:** `tools.disabled` (array) + `profiles` tool lists. Hidden tools leave the request
  and the system prompt, stay on the session slate, and return when the model no longer disables them
  (model switch or settings edit). Files: `src/tools/settings.ts`,
  `src/session/session-tools.ts`, `src/sdk.ts`, `src/session/agent-session.ts`.
- **OMP-1 done:** `profiles` record keyed by `provider/model-id` or a `…*` prefix (`src/config/model-profiles.ts`,
  `src/config/model-settings.ts`). Per model: `compaction.thresholdPercent|thresholdTokens|methodOrder`,
  `thinkingBudgets`, `tools.disabled`, `sampling.*`. Wider prefixes layer first; the exact key wins
  field by field; unmatched models keep the globals. Resolution seams: `session/model-profile-settings.ts`,
  `session/model-compaction-threshold.ts`, `session/agent-session.ts` (sampling re-apply).
- **OMP-5 done:** `reasoning-budget-field` compat axis + `llama.cpp` KDL rule; local OpenAI-compatible
  hosts resolve `reasoning_budget_tokens` and `thinkingBudgets` is now forwarded through
  `mapOptionsForApi` (`src/stream.ts`) and written in `applyChatCompletionsReasoningParams`.
- **Archive panel:** a two-row panel above the status bar (`modes/compaction-rummage-panel.ts`, mounted in
  `interactive-mode.ts`) reads `AgentSession.getCompactionRummage()`. Headline: phase/outcome + method + context
  percentage (`75% → …` live, `75% → 21% (−54 pts)` done). Detail row: entries/regions/tokens/bytes and the archive
  path (`ramdisk` under `/dev/shm`), or tokens reclaimed and elapsed. Fades after 8 s. The ledger is written
  centrally in `SessionMaintenance.#emitLifecycleEvent` (auto passes), instrumented inside `shake()`, and
  opened/closed around the owning frame of manual `compact()`.
- **Generation rate row:** `modes/token-rate-panel.ts`, mounted in `rummageContainer` above the archive panel and before
  the input; gated by `composer.tokenRate` (enabled in `~/.rabid/agent/config.yml`). The working-row/idle-HUD t/s copy was
  removed so there is one readout; the native composer bar keeps its own.
- **Preset routing:** `/preset` (source) talks to llama-manager `:8090` — mode (`fast`/`balanced`/`deep`) then model,
  confirm, apply; unload; `reload` re-reads omp's models.yml only (resident model stays in VRAM); `restart` re-reads
  models.ini (confirmed; the only path that evicts the model). The `rabid-*` server sections were added to
  `~/.local/share/llama-v100/models.ini` (balanced/fast use the Q5 text-only P0-B fallback); the running router
  predates them, so `/preset restart` is needed once before they can load.
- **Separate harness root:** `~/.local/bin/rabid` exports `PI_CONFIG_DIR=.rabid`, so the fork's config, models,
  sessions, logs, skills, and credentials live under `~/.rabid` — nothing under `~/.omp`/`~/.pi` is read or written.
  `~/.rabid/agent` has the fork `config.yml` (`composer.tokenRate`, preset `profiles`, `llama-rabid` default role),
  `models.yml` (`local-llama` + `llama-rabid` + preset ids), copied `AGENTS.md`/`skills`/`mcp.json`, and a serialized
  copy of `agent.db` for auth. The old `~/.omp/profiles/rabid` is a stale pre-migration copy (safe to delete after
  the running pane restarts).
- **Turn cards:** `turnCards.enabled: true` (max 1024 tokens, 50 words/op). After each completed prompt the
  compaction model (deepseek-flash via `compactionModel`) distills prompt + files + pointers into
  `~/.rabid/agent/turn-cards/<session>.jsonl|.md`. Archive-only, not injected. Pure helpers in
  `session/turn-cards.ts`; hook at `agent_end` (aborted turns included; the next prompt awaits the in-flight card). `compaction.turnCardChain: true` makes handoff/soft use the
  cumulative `<session>.chain.md` as a deterministic summary (coverage-checked; LLM fallback).
- **Speed floor:** `compaction.speedFloorTps: 20`, `speedConsecutive: 3`, `speedMinTokens: 20000` in the fork config.
  After a sustained sub-20 t/s streak at contextual size, the normal maintenance order runs; summaries currently use
  `compactionModel: deepseek/deepseek-flash` (the SLM swap hook is still pending).
- **Modes vs models:** `/preset`/`Alt+Q` now picks `fast`/`balanced`/`deep` (request-side budgets + sampling + task
  hiding, `rabid.mode` setting) and then the local model to apply it to; applying a mode does not unload anything.
- Fork config lives in `~/.rabid/agent/`: `models.yml` has `local-llama` + `llama-rabid` (8101 tool filter) and the
  three preset ids; `config.yml` has `composer.tokenRate` + the preset `profiles`; the old test overlay is
  `config.rabid-test.yml`. The shared `~/.omp/agent` and `~/.pi/agent` are pre-fork and untouched.
- Tests added: `coding-agent/test/disabled-tools.test.ts`, `coding-agent/test/model-profiles.test.ts`,
  `coding-agent/test/compaction-rummage-panel.test.ts`, `ai/test/llama-cpp-reasoning-budget.test.ts`;
  ledger assertions in `test/shake.test.ts`. Narrow suites green (coding-agent 279, ai 83,
  catalog 183, plus compaction panel/shake). Rig and installed binary untouched.

## Prerequisite: Bun

Bun is not installed. The installed `omp` is a compiled binary, not a build of this tree.

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
cd ~/Documents/RabidAI
bun install
```

Then identify the test commands from the workspace `package.json` files and run the
narrow suites for the package you touch.

## Ordered tasks

### 1. OMP-4 — native `disabledTools` per model

- Goal: OMP stops advertising `task` to local llama.cpp models, so the system prompt
  and tool schema match the 8101 filter.
- Start at `rabid/packages/coding-agent/src/task/settings.ts` (`cfgTaskDisabledAgents`) and
  the tool registry under `rabid/packages/coding-agent/src/tools/`. Add a settings key that
  can be scoped per model/provider (a list of tool names), and filter the tool list
  before the system prompt and request are built.
- Acceptance: a session on a model with `disabledTools: [task]` sends no `task` entry
  in `tools[]` and does not mention it in the generated prompt; other tools unaffected.
- Test: the narrow tool/settings tests + a unit test that asserts the filtered schema.

### 2. OMP-1 — per-model profiles

- Goal: `rabid-deep` (75%, 4096, handoff/shake/soft, no subagents), `rabid-balanced`
  (75%, 4096), `rabid-fast` (60–65%, 2048, temp 0.7/0.8) without reloading the model.
- Start at `rabid/packages/coding-agent/src/session/context-settings.ts`,
  `rabid/packages/coding-agent/src/session/settings.ts`,
  `rabid/packages/coding-agent/src/config/settings-schema.ts`, and the model config shape.
- Prefer a `profiles:` record keyed by model id, resolved after model selection.
  Keep the global `compaction.*` keys as the fallback.
- Acceptance: switching model ids changes the resolved threshold, method order,
  thinking budget, and disabled tools; unknown models use the global defaults.

### 3. OMP-5 — thinking budget on the llama.cpp wire

- Goal: `thinkingBudgets` reaches llama.cpp as `reasoning_budget_tokens` (or
  `thinking_budget_tokens`) on the OpenAI-compatible chat/completions request.
- Start at `rabid/packages/ai/src/providers/openai-shared.ts` (the existing mapping to
  `reasoning.max_tokens` is OpenAI-style), `rabid/packages/ai/src/stream.ts`,
  `rabid/packages/ai/src/types.ts`, `rabid/packages/coding-agent/src/session/settings.ts`.
- Gate it on the provider/model (llama.cpp / local-llama), not on all OpenAI-compatible
  endpoints. Keep the OpenAI behavior unchanged elsewhere.
- Acceptance: a request built for `local-llama` with a low budget contains
  `reasoning_budget_tokens`, and the server's budget sampler caps the thought.

### 4. OMP-3 — `recall_thought`

- Goal: a first-class tool that greps `/dev/shm/qwen-thoughts/THOUGHTS.index.md` and
  returns one block from `THOUGHTS.md`, so recall is explicit and prefix-safe (tool
  result at the tail).
- Keep it optional and local-model-only; it is worthless on cloud models.
- Acceptance: the tool returns the anchored block and line range, refuses unknown
  queries, and never reads the whole archive.

### 5. OMP-12 — host/VRAM budget guard

- Compute `weights + KV(ctx) + draft + projector + compute` for a preset; refuse a
  load below a headroom floor; warn when `cache-ram` + page cache would swap.
- Pure CPU; surface the ledger in the model picker.

## Constraints

- **Prefix stability:** never rewrite historical messages outside a compaction entry.
  Add the guard (OMP-6) before adding any feature that could.
- **No per-token host traffic:** do not add `-nkvo`, CPU MoE, or 3070 draft paths for
  speed. See `docs/rabid/PLAN-presets-and-omp.md` §2.4.
- **No subagents on the V100**, even after OMP-4 — the 8101 filter stays the backstop.
- **Do not touch** `~/.local/share/llama-v100`, the running router, or the installed
  binary. The source fork is independent.
- **Inference:** do not send requests to the V100 without asking; the user's standing
  rule is no LLM testing while the rig is in use.
- Small commits on `rabid`; keep upstream-facing changes modular for rebases.

## Done when

- OMP-4 and OMP-1 pass their unit tests and produce the expected tool/schema/profile
  resolution; OMP-5 builds a request with the llama.cpp budget field; the `rabid` bin
  alias resolves after `bun install`; `bun test` for the touched packages is green.
