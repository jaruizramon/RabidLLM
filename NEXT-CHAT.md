# NEXT CHAT — RabidAI implementation

Start a new omp chat with cwd **`/home/pipo/Documents/RabidAI`**, then paste:

> Read `RABIDAI.md`, `NEXT-CHAT.md`, `docs/rabid/README.md`, and
> `docs/rabid/PLAN-presets-and-omp.md`. We are on branch `rabid`. Continue with
> OMP-4, then OMP-1 and OMP-5. Do not touch the running V100 rig or the installed
> `~/.local/bin/omp`. Run the narrow package tests before claiming a step.

## Repo state at handoff

- Fork point `eb74cf84d8` of `can1357/oh-my-pi` (`main`, source 18.11.3), MIT.
- Branch `rabid`; `origin` still points at upstream. The clone is `--filter=blob:none`.
- Installed binary on the box is `omp/18.2.6`; behavior differences are expected.
- `RABIDAI.md`, `NEXT-CHAT.md`, `docs/rabid/` added; `rabid` bin alias added in
  `packages/coding-agent/package.json` (the `omp` alias stays).
- The root `package.json` name is still `omp`; `bun.lock` records it. Do not rename
  until Bun is installed and `bun install` regenerates cleanly (stage 2).

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
- Start at `packages/coding-agent/src/task/settings.ts` (`cfgTaskDisabledAgents`) and
  the tool registry under `packages/coding-agent/src/tools/`. Add a settings key that
  can be scoped per model/provider (a list of tool names), and filter the tool list
  before the system prompt and request are built.
- Acceptance: a session on a model with `disabledTools: [task]` sends no `task` entry
  in `tools[]` and does not mention it in the generated prompt; other tools unaffected.
- Test: the narrow tool/settings tests + a unit test that asserts the filtered schema.

### 2. OMP-1 — per-model profiles

- Goal: `rabid-deep` (75%, 4096, handoff/shake/soft, no subagents), `rabid-balanced`
  (75%, 4096), `rabid-fast` (60–65%, 2048, temp 0.7/0.8) without reloading the model.
- Start at `packages/coding-agent/src/session/context-settings.ts`,
  `packages/coding-agent/src/session/settings.ts`,
  `packages/coding-agent/src/config/settings-schema.ts`, and the model config shape.
- Prefer a `profiles:` record keyed by model id, resolved after model selection.
  Keep the global `compaction.*` keys as the fallback.
- Acceptance: switching model ids changes the resolved threshold, method order,
  thinking budget, and disabled tools; unknown models use the global defaults.

### 3. OMP-5 — thinking budget on the llama.cpp wire

- Goal: `thinkingBudgets` reaches llama.cpp as `reasoning_budget_tokens` (or
  `thinking_budget_tokens`) on the OpenAI-compatible chat/completions request.
- Start at `packages/ai/src/providers/openai-shared.ts` (the existing mapping to
  `reasoning.max_tokens` is OpenAI-style), `packages/ai/src/stream.ts`,
  `packages/ai/src/types.ts`, `packages/coding-agent/src/session/settings.ts`.
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
