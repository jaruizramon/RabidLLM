# RabidAI

**A fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) tuned for local models on a 32 GB V100.**

- **Upstream:** `can1357/oh-my-pi`, MIT (© 2025 Mario Zechner, 2025–2026 Can Bölük, 2026 Stencil Labs, Inc.)
- **Fork:** <https://github.com/jaruizramon/RabidAI> (GitHub fork, parent link intact)
- **Fork point:** `eb74cf84d8` (`main`, source version 18.11.3); the installed binary on this box is `omp/18.2.6`
- **Branch:** `rabid`
- **Status:** scaffolding. The source is here; the first implementation tasks are in `NEXT-CHAT.md`.
- **Companion plans:** `docs/rabid/PLAN-presets-and-omp.md`, `docs/rabid/PLAN-dram-offload.md`

## Why this fork

The upstream agent assumes a cloud model or a fast local GPU with bandwidth to spare. This fork targets
the opposite box: one Volta V100, 60 GB DDR4, a PCIe gen3 ×8 link (~6.3 GB/s), and a 262K-token window
that is expensive to lose. The rules that follow are measured, not stylistic:

1. **Prefix stability is sacred.** The prompt prefix must be append-only between compactions. Any edit
   of an old message breaks llama.cpp's LCP reuse and re-prefills the suffix (2 min at 50K, 6–8 min at
   150K). No per-turn sliding windows, no retro-summaries, no in-place edits.
2. **Bytes read per token stay in VRAM.** HBM2 ~900 GB/s vs PCIe ~6.3 GB/s is ~143×. Host RAM and
   tmpfs are for per-turn state, compaction artifacts, and persistence — never for decode.
3. **No subagents on the local card.** A `task` tree on one slot serializes, destroys the parent's KV,
   and costs minutes per round. Enforcement belongs in the request/harness, not in a prompt.
4. **Spend host RAM before VRAM.** Prompt-state cache, context parking, thought archive, tool filter,
   compaction, aux-model routing. Keep the 32 GB card for weights + KV + the draft head.
5. **Presets are resources, not vibes.** `rabid-deep`, `rabid-balanced`, `rabid-fast` encode model,
   MTP depth, thinking budget, sampling, and the expected VRAM/throughput. See the preset plan.

## What is here

```
docs/rabid/RABIDAI.md           this file
docs/rabid/NEXT-CHAT.md         the first tasks for the implementation chat
docs/rabid/README.md           mechanism map + staged rename
docs/rabid/PLAN-presets-and-omp.md
docs/rabid/PLAN-dram-offload.md
```

## Build

The source is a Bun workspace (`packages/*`, plus `python/robomp/web`). Bun is **not installed** on
this box yet — the installed `omp` is a compiled release binary, not a build of this tree.

```bash
curl -fsSL https://bun.sh/install | bash
cd ~/Documents/RabidAI
bun install
bun test          # or the package-scoped tests in NEXT-CHAT.md
```

Do not overwrite `~/.local/bin/omp` until the fork builds and the relevant tests pass. The V100 rig
keeps running the installed binary meanwhile.

## Remotes and upstream

- `rabidllm` — <https://github.com/jaruizramon/RabidLLM.git> (standalone; the canonical home)
- `origin` — <https://github.com/jaruizramon/RabidAI.git> (the old GitHub fork, kept in sync)
- `upstream` — <https://github.com/can1357/oh-my-pi.git> (for merges)
- `upstream` — <https://github.com/can1357/oh-my-pi.git>
- `main` is the upstream copy; `rabid` is the working branch (pushed and tracking `origin/rabid`).

The local clone is `--filter=blob:none`; missing blobs are fetched on demand from the configured
remote. Sync: `git fetch upstream && git rebase upstream/main` on `rabid`. Keep fork changes modular
(settings, request mapping, compaction, tools) so rebases stay cheap.

## Staged rename

The directory and git branch are RabidAI now. Renaming the product is staged so the tree keeps
building:

| stage | change | gate |
|---|---|---|
| 1 | `RABIDAI.md`, docs, branch, `rabid` bin alias in `packages/coding-agent/package.json` | this commit |
| 2 | root `package.json` name `omp` → `rabidai`; regenerate `bun.lock` | Bun installed, `bun install` clean |
| 3 | CLI identity/help/version strings; optional `~/.omp` → `~/.rabid` with migration | tests + a real session |
| 4 | package scope `@oh-my-pi/*` → `@rabidai/*` (large, optional) | only if worth the churn |

The upstream license and notices stay; RabidAI is a fork, not a relicensing.

## Boundaries

- No changes to `~/.local/share/llama-v100` or the running router as part of source work.
- The local-LLM policy remains: `llama-toolfilter` strips `task` at 8101; the 24 GiB prompt cache,
  no idle sleep, 75% handoff compaction, and the tmpfs thought archive are rig-side.
- Any new per-token host↔device path is a regression until measured otherwise.
