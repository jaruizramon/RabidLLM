# RabidAI docs

- [FORK.md](FORK.md) — **what this fork changes in the harness**: added modules, rewired
  upstream modules, and the boundary kept for upstream merges.

- [PLAN-presets-and-omp.md](PLAN-presets-and-omp.md) — the three coherence presets, the CPU/VRAM
  discipline, and the OMP mechanism roadmap. **Read this first.**
- [PLAN-dram-offload.md](PLAN-dram-offload.md) — the DDR4/PCIe substrate, the per-token law, and the
  offload phases. The presets plan builds on it.

## Mechanism → code map (upstream 18.11.3)

| mechanism (plan ID) | where |
|---|---|
| Thinking budgets, effort → wire (OMP-5) | `packages/coding-agent/src/session/settings.ts` (`cfgThinkingBudgets*`), `packages/agent/src/agent.ts`, `packages/ai/src/stream.ts`, `packages/ai/src/providers/openai-shared.ts`, `packages/ai/src/types.ts` |
| Compaction settings / threshold (OMP-1, OMP-9) | `packages/coding-agent/src/session/context-settings.ts`, `packages/agent/src/compaction/compaction.ts`, `packages/coding-agent/src/session/compaction-methods.ts`, `packages/coding-agent/src/config/compaction-threshold.ts` |
| Auto-maintenance / handoff (OMP-2, OMP-9) | `packages/coding-agent/src/session/session-maintenance.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/agent/src/compaction/compaction.ts` |
| Task tool + agent policy (OMP-4) | `packages/coding-agent/src/task/` (settings: `cfgTaskDisabledAgents`, `cfgTaskEager`, `cfgTaskMaxConcurrency`), the tool registry under `packages/coding-agent/src/tools/` |
| Model profiles / model roles (OMP-1, OMP-8) | `packages/coding-agent/src/config/settings-schema.ts`, `packages/coding-agent/src/session/settings.ts`, `packages/coding-agent/src/providers/` and the models config |
| Prompt rebuild / prefix stability (OMP-6) | `packages/coding-agent/src/session/messages.ts`, `packages/coding-agent/src/session/agent-session.ts`, the compaction `prepareCompaction` path |
| Snapcompact (excluded on this rig) | `packages/snapcompact/src/snapcompact.ts` |
| Docs for the mechanisms | `docs/compaction.md`, `docs/local-models.md`, `docs/context-files.md`, `docs/settings.md` |

These paths are the starting points; `grep` the identifiers in the tree before editing.

## First implementation order

1. **OMP-4 — native `disabledTools` per model.** Smallest, highest-value: stop advertising `task` to
   local models so the system prompt matches the server-side filter. Settings live next to
   `cfgTaskDisabledAgents`; the tool registry should drop the names per model/provider.
2. **OMP-1 — per-model profiles.** A `profiles:` layer (or per-model `settings:`) that overrides
   `compaction.thresholdPercent`, `methodOrder`, `thinkingBudgets`, `disabledTools`, and sampler
   defaults. The rig currently has one global set; the three presets need distinct policies.
3. **OMP-5 — send llama.cpp's budget fields.** On the OpenAI-compatible path, map the thinking budget
   to `reasoning_budget_tokens` / `thinking_budget_tokens` (llama.cpp reads both) instead of only
   `reasoning.max_tokens` (OpenAI-style). This makes `thinkingBudgets` work per request on llama.cpp.
4. **OMP-3 — `recall_thought`.** A tool that greps an index and returns one block, so recall is
   prefix-safe and explicit.
5. **OMP-12 — host/VRAM budget guard.** Compute the ledger and refuse a load below the headroom floor;
   warn on swap. Pure CPU.
6. **OMP-6 — prefix-stability guard.** A lint/test that fails if a non-compaction path rewrites a
   historical message.

## Staged rename

See `RABIDAI.md` §Staged rename. Stage 1 (this commit) adds `RABIDAI.md`, the docs, the `rabid`
branch, and the `rabid` bin alias. Do not rename the root package or `bun.lock` until Bun is installed
and `bun install` is clean.

## Testing

- Find package scripts: `packages/*/package.json`; run the narrow package tests first.
- Compaction: `packages/agent/test/compaction-*.test.ts`, `packages/coding-agent/src/session/*test*`.
- Thinking budgets: `packages/coding-agent/test/sdk-live-provider-settings.test.ts`, `packages/ai/test/`.
- The rig's integration check is a real request through `127.0.0.1:8101`; ask the user before sending
  inference to the V100 (their standing rule).
