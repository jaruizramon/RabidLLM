# PLAN — Coherence presets for the V100 + OMP mechanisms

**Written:** 2026-10-17
**Box:** `pipo-z390-aorus-pro-wifi` · i9-9900K · 63.4 GiB DDR4 · Tesla V100-SXM2-32GB (sm_70) · RTX 3070 8GB
**Rig:** llama.cpp PrismML fork (`prism-b10709`), router `:8080`, manager `:8090`,
`~/.local/share/llama-v100/models.ini`; harness wiring `~/.omp/agent/models.yml`, `~/.pi/agent/models.json`
**Companion:** [PLAN-dram-offload.md](PLAN-dram-offload.md) — the DDR4 tier, PCIe law, and P0–P5 offload phases.
This plan does not repeat it; it uses its law.

**Status:** proposed. "Already live" items below were applied during the conversation that produced this file.

---

## 0. Decisions in one page

| Preset | Model | Role | Decode | VRAM |
|---|---|---|---:|---:|
| **`rabid-deep`** | Qwen3.8-27B **UD-Q4_K_M** + inline MTP depth 3 | high slow coherence: planning, hard debugging, handoff, needle | 27–43 t/s | 27.4–27.8 GiB |
| **`rabid-balanced`** | Qwen3.6-35B-A3B **UD-Q4_K_XL** + F16 projector + MTP n-max 2 | balanced: mixed coding/analysis, vision | **138.8 t/s** | 28.2 GiB |
| **`rabid-fast`** | same 35B-A3B Q4 + projector + MTP n-max 2 | fast regular coherence: mechanical edits/tests, brief reasoning | **138.8 t/s** | 28.2 GiB |

The three differ in *model class and thinking budget*, not in KV or context:

- all inherit `[*]`: `ctx-size 262144`, `q8_0` K/V, Flash Attention on, `parallel 1`, `cache-ram 24576`,
  `sleep-idle-seconds -1`, `n-gpu-layers 99`;
- deep has **no** reasoning budget (full xhigh deliberation, MTP 3);
- balanced has `reasoning-budget = 4096`, model-default sampling;
- fast has `reasoning-budget = 2048`, coding sampling (temp 0.7 / top_p 0.8 / top_k 20).

No subagents on any preset. `llama-toolfilter` on `127.0.0.1:8101` removes `task` from every request.

### 0.1 Recommendations checklist

| recommendation | status |
|---|---|
| No subagents: strip `task` at the request boundary (`llama-toolfilter`, 8101) | **live** |
| Harness provider `baseUrl` → 8101 (omp + pi) | **live** |
| `cache-ram = 24576` (was 8192; the 8 GiB cliff) | **live** |
| `sleep-idle-seconds = -1` (was 600) | **live** |
| `reasoning-preserve = off` on both 3.8 sections | **live** |
| Compaction 75%, `["handoff","shake","soft"]`, async off, keepRecent 20k, handoff save | **live** |
| `omp-thoughts` archive → `/dev/shm/qwen-thoughts` + user `AGENTS.md` note | **live** |
| Aux roles (`smol`/`slow`/`tiny`) → deepseek, off the V100 | **live** |
| MTP depth 3 on the 27B; depth 2 on the 35B-A3B | in presets |
| `q8_0` K/V, Flash Attention, `parallel 1`, `ngl 99` | **live** |
| Three coherence presets (`rabid-deep`, `rabid-balanced`, `rabid-fast`) | proposed (§2) |
| Fetch 35B Q4_K_XL + F16 projector + MTP Q8_0 | **pending** (§3) |
| Fix the Q5 card's missing `mmproj` (fetch or remove the line) | **pending** (§3) |
| Reasoning budgets 4,096 / 2,048 | in presets |
| CPU mechanisms: prompt cache, parking, archive, filter, shake, aux routing | **live / proposed** (§2.4) |
| Avoid per-token CPU traffic: `-nkvo`, CPU MoE, 3070 draft, per-thought swaps | policy (§2.4) |
| Prefix-stability guard; no per-prompt 8-block window | policy (§1, OMP-2) |
| `metrics = on` + `kv-watch` + host budget guard | proposed (OMP-7/12) |
| Model-file doctor (missing projector/MTP) | proposed (OMP-11) |
| Leave the 220 W power cap unless the PSU allows 300 W | policy (§6.8) |

---

## 1. The design law (from this conversation)

> **The prompt prefix must be append-only between compactions.**
> Any rewrite of an old message breaks llama.cpp's longest-common-prefix reuse and re-prefills the
> entire suffix. With one slot and no prompt cache, that is the difference between a 2-second restore
> and a 2–12-minute freeze.

Consequences used throughout:

- `reasoning-preserve = off` is the stable baseline: every past assistant turn renders identically on
  every request (content only), so only the new turn prefills. It also removed ~one third of the
  prompt (thinking was 181,668 chars vs 178,184 of answer text in the measured session).
- A per-turn "keep the last 8 thought blocks" window is **forbidden**: dropping the 9th changes an old
  message and breaks the prefix every turn. The 8-block window belongs at **compaction boundaries**
  only (see §7, OMP-2).
- Pull, don't push: retrieve a relevant old thought with `grep` + `read` (a tool result appended at the
  tail), not by carrying history.
- Bytes read **per token** must stay in VRAM (HBM2 ~900 GB/s vs PCIe gen3 ×8 ~6.3 GB/s usable,
  ~143×). DDR4/tmpfs is a **capacity and persistence** tier: whole-state copies, never per-token reads.

---

## 2. The three presets — exact configuration

### 2.1 `models.ini`

```ini
; =====================================================================
; RabidAI coherence profiles. One slot; only one loads at a time.
; [*] supplies ctx 262144, q8_0 KV, FA on, ngl 99, parallel 1,
; cache-ram 24576, sleep-idle-seconds -1.
; =====================================================================

[rabid-deep]
model = /home/pipo/models/Qwen3.8-27B-UD-Q4_K_M.gguf
spec-type = draft-mtp
spec-draft-n-max = 3
; No reasoning budget: full xhigh deliberation. Samplers travel in the GGUF
; (temp 1.0 / top_p 0.95 / top_k 20). Prior thinking is not carried
; (reasoning-preserve = off on the 3.8 sections).
tags = rabid,deep,coherence,27B,dense,MTP

[rabid-balanced]
model = /home/pipo/models/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf
mmproj = /home/pipo/models/mmproj-Qwen3.6-35B-A3B-F16.gguf
spec-type = draft-mtp
spec-draft-model = /home/pipo/models/mtp-Qwen3.6-35B-A3B-Q8_0.gguf
spec-draft-n-max = 2
reasoning-budget = 4096
min-p = 0
tags = rabid,balanced,35B-A3B,MoE,vision,MTP

[rabid-fast]
model = /home/pipo/models/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf
mmproj = /home/pipo/models/mmproj-Qwen3.6-35B-A3B-F16.gguf
spec-type = draft-mtp
spec-draft-model = /home/pipo/models/mtp-Qwen3.6-35B-A3B-Q8_0.gguf
spec-draft-n-max = 2
reasoning-budget = 2048
temperature = 0.7
top-p = 0.8
top-k = 20
min-p = 0
tags = rabid,fast,regular,35B-A3B,MoE,vision,MTP
```

Notes:

- **Q4_K_XL, not Q5_K_M.** On Q5 the measured law is "vision **or** a draft, never both" (§22.2):
  Q5 + projector = 30,172 MiB / 96.6 t/s, Q5 + MTP without projector = 30,990 MiB / 136.0 t/s,
  Q5 + projector + draft does not fit. Q4_K_XL + projector + MTP n-max 2 = **28,232 MiB / 138.8 t/s**
  with 4.4 GiB free. Use Q4 for both balanced and fast.
- **MTP n-max 2** for the 35B-A3B: the published depth for this trunk; depth 3 costs acceptance
  (81% → 70%) for no speed gain (§22.3). Alias: `--spec-draft-n-max 2`.
- **Deep uses the UD 27B**, whose `blk.64.nextn.eh_proj` is Q6_K. The currently loaded file is the
  `MTP-Q4_K_M` pack (Q4_K projection); the UD file is the measured baseline. Keep both ids if you
  want an A/B, but `rabid-deep` should start from the measured one.
- **`reasoning-budget` works with the prefilled `<think>`**: `init_sampler()` feeds the prompt tokens
  to the sampler (`tools/server/server-context.cpp`), so the budget enters COUNTING inside the block.
  Verify on the 3.6 template during P1 — if its generation prompt does not prefill `<think>`, the
  budget is a no-op and the fast/balanced difference must come from sampling only.
- `reasoning-effort` is deliberately not set for the 3.6 profiles (its template has no
  `reasoning_effort` branch). For the 27B, the template default is `xhigh`; do not send
  `minimal`/`max` (the template raises 400).

### 2.2 `~/.omp/agent/models.yml` (and `~/.pi/agent/models.json`)

```yaml
      - id: rabid-deep
        name: Rabid Deep — Qwen3.8-27B (local, 256K, full reasoning)
        reasoning: true
        input: [text]
        contextWindow: 262144
        maxTokens: 32768
        tokenizer: qwen3
        compat:
          supportsDeveloperRole: false
          supportsReasoningEffort: false
          maxTokensField: max_tokens

      - id: rabid-balanced
        name: Rabid Balanced — Qwen3.6-35B-A3B Q4 + vision + MTP (local, 256K)
        reasoning: true
        input: [text, image]
        contextWindow: 262144
        maxTokens: 32768
        tokenizer: qwen3
        compat:
          supportsDeveloperRole: false
          supportsReasoningEffort: false
          maxTokensField: max_tokens

      - id: rabid-fast
        name: Rabid Fast — Qwen3.6-35B-A3B Q4 + vision + MTP, brief reasoning (local, 256K)
        reasoning: true
        input: [text, image]
        contextWindow: 262144
        maxTokens: 32768
        tokenizer: qwen3
        compat:
          supportsDeveloperRole: false
          supportsReasoningEffort: false
          maxTokensField: max_tokens
```

The provider `baseUrl` stays `http://127.0.0.1:8101/v1` (the tool filter). One slot, one model.

### 2.3 Expected behaviour

| | deep | balanced | fast |
|---|---|---|---|
| decode 20K | 53.8 t/s (measured, high acceptance) | 138.8 t/s (published) | 138.8 t/s |
| decode 50K | 28.6 t/s | ~99 t/s at 64K (measured Q4+MTP) | same |
| decode 196K | 19–23 t/s [INFERENCE] | TBD | TBD |
| prefill | 240–373 t/s | 627.5 t/s @64K (measured) | same |
| thinking | unlimited, xhigh | ≤4,096 tokens | ≤2,048, temp 0.7/0.8 |
| vision | no (no projector wired) | yes | yes |
| best for | handoff, architecture, hard debugging, needle | mixed work, long docs, vision | routine edits/tests |

---

### 2.4 CPU-bound mechanisms — spend host RAM, not VRAM

The V100 has one expensive resource (VRAM) and one cheap one (host RAM + CPU). Every mechanism that
lives **per turn** belongs on the host; every byte read **per token** must stay in VRAM
(PLAN-dram-offload.md §0). The 5–6.3 GB/s PCIe link is ~143× slower than HBM2, so moving a per-token
read to the CPU is never an optimisation — it is the one thing that must not happen.

**Use — out-of-band, zero or marginal VRAM:**

| mechanism | where it runs | VRAM cost | why it pays |
|---|---|---:|---|
| `cache-ram = 24576` prompt-state cache | host RAM + PCIe on restore | 0 | a 140–155K state is 8.3–8.9 GiB measured; restore is ~1–4 s vs an 8–12 min re-prefill |
| `POST /api/context/park` + restore | DDR4/disk + PCIe | 0 | profile switching without losing the context; ~4.4 s each way at 236K |
| `omp-thoughts` archive | tmpfs, CPU | 0 | reasoning out of the prompt; on-demand recall; 3.2 MB for 37 blocks |
| `llama-toolfilter` | CPU JSON rewrite | 0 | removes `task` from prompt **and** grammar; smaller context |
| compaction: `handoff` + `shake` | CPU orchestration | ~0 marginal | handoff reuses the warm prefix; shake replaces old tool results with artifacts; post-context ~50K |
| `modelRoles.smol/slow/tiny → deepseek` | CPU/network | 0 | titles, auto-thinking, memory never touch the V100 |
| `reasoning-preserve = off` | CPU/template | 0 | removed ~1/3 of the prompt in the measured session (181,668 chars of thinking vs 178,184 of answer) |
| `q8_0` K/V | GPU | 8.5 GiB @262K (vs 17 GiB f16) | near-lossless; the quality floor |
| `ubatch-size` / `batch-size` | GPU scratch | lower peak | leave at defaults; if a prefill ever runs out of scratch, lower `ubatch-size` before lowering the context |
| `metrics = on` + `kv-watch` | CPU | 0 | observability without touching the model |

**Avoid — per-token host traffic or VRAM churn:**

| trap | why |
|---|---|
| `-nkvo` / KV in host RAM | every attention read crosses PCIe → ~143× slower decode |
| `-cmoe` / CPU MoE experts | frees weights, but expert reads become per-token PCIe traffic; capacity only, the DRAM plan P4 prices it |
| draft model on the 3070 (`-devd`) | draft/target hidden states cross PCIe every step; no NVLink |
| per-thought KV swap | the KV is one contiguous sequence; there is no "keep 8 blocks, evict 9" operation |
| per-prompt 8-thought sliding window | rewrites an old message → prefix break → full suffix re-prefill every turn |
| `q4_0` KV for a needle-critical profile | frees ~4.3 GiB @262K but costs retrieval quality; optional only when headroom is the binding constraint |
| raising `ctx-size` above 262,144 | +34 KiB/token q8_0; the native window is the verified good maximum |

**Host RAM budget (measured now):**

```
60 GiB total · 45 GiB available · 14 GiB used
cache-ram     24 GiB   (a limit, not a reservation)
page cache   ~38 GiB   (GGUF mmap; reclaimable)
thoughts     3.2 MiB   (tmpfs)
swap          7 GiB    (5 GiB used — avoid growing it)
```

Do not raise `cache-ram` above ~28 GiB without watching `free -g` and swap. `ulimit -l` is 8 MB on
this box: any pinned / `cudaHostAlloc` buffer larger than that fails by default (PLAN-dram-offload P0
raises it). The current prompt cache is pageable, so it works; pinned buffers would only improve the
copy rate, not the architecture.

**VRAM ledger (why this does not go overboard):**

| piece | `rabid-deep` | `rabid-balanced` / `rabid-fast` |
|---|---:|---:|
| weights | 15.3 GiB (Q4_K_M dense) | 20.8 GiB (Q4_K_XL MoE) |
| KV q8_0 @262,144 | 8.5 GiB (34 KiB/token, 16 KV layers) | 2.7 GiB (10.6 KiB/token, 10 KV layers) |
| MTP | ~2.1 GiB inline | 1.85 GiB sidecar |
| projector | — | 0.84 GiB |
| compute / scratch | ~1.3 GiB | ~2 GiB |
| **total / free** | **27.4–27.8 / ~5 GiB** | **28.2 / 4.4 GiB** |

The 35B-A3B is *cheaper in KV* than the dense 27B despite being the larger model: 10 attention layers
vs 16. That is the efficiency argument for the MoE on long projects — not just its 3B active params.

**The other engines:** the 1Cat-vLLM cards are 8K/32K windows (`qwen2.5-0.5b-1cat`, `qwen3-8b-1cat`,
`qwen3.8-27b-*-1cat`). They are useful for small/aux tasks, not for a 262K project chat. The 3070 is
the desktop/Laya bridge; do not put per-token inference work there.

---

## 3. Prerequisites: the 35B Q4 pack is not on disk

`~/models` currently has the Q5 main file but **not** the Q4_K_XL file, the F16 projector, or the MTP
Q8_0 sidecar. The existing `[qwen3.6-35b-a3b-q5-k-m]` section points at a **missing** `mmproj`, so it
would fail to load as written. Two paths:

### P0-A — fetch the Q4 pack (recommended; disk 576 GiB free)

| file | size |
|---|---:|
| `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` | 20.82 GiB (22,360,456,160 B) |
| `mmproj-Qwen3.6-35B-A3B-F16.gguf` | 0.84 GiB (899,283,680 B) |
| `mtp-Qwen3.6-35B-A3B-Q8_0.gguf` | 1.85 GiB (1,990,649,632 B) |

~23.5 GiB total. Same sources and verification as §22: unsloth's UD ladder for the trunk, the Qwen3.6
repo for the projector/MTP; check sizes and hashes before serving.

### P0-B — no-download fallbacks (until P0-A)

| profile | model | VRAM | decode | caveat |
|---|---|---:|---:|---|
| balanced | `qwen3.6-35b-a3b-q5-k-m`, **remove the missing `mmproj` line** (text-only), no draft | ~29.3 GiB | 96.6 t/s | no vision |
| balanced | same Q5 + keep projector, no draft | 30,172 MiB | 96.6 t/s | no draft |
| fast | same Q5 text-only + `reasoning-budget 2048`, temp 0.7 | ~29.3 GiB | 96.6 t/s | no vision/MTP |
| fast | `Ornith-1.0-35B-Q6_K` + budget 2048 | 31,128 MiB | 91.6 t/s | 1.3 GiB headroom |
| fast | `nemotron-3-nano-30b` + budget 2048 | 28,132 MiB | 109.8 t/s | different tokenizer/tool semantics |

The Q5 card as written today is broken (missing projector) — either fetch it or drop the line before
loading.

---

## 4. Profile switching

One V100, one model. Switching is a sequence, not an ambient feature:

```bash
# park the current slot's state (DDR4, ~4.4 s each way for a 236K 27B context)
curl -s -X POST http://127.0.0.1:8090/api/context/park \
  -H 'Content-Type: application/json' -d '{"model":"rabid-deep","name":"deep-main"}'

curl -s -X POST http://127.0.0.1:8090/api/unload -d '{"model":"rabid-deep"}'
curl -s -X POST http://127.0.0.1:8090/api/load   -d '{"model":"rabid-balanced"}'
# later:
curl -s -X POST http://127.0.0.1:8090/api/load   -d '{"model":"rabid-deep"}'
curl -s -X POST http://127.0.0.1:8090/api/context/restore \
  -H 'Content-Type: application/json' -d '{"name":"deep-main"}'
```

Guidance:

- Park only at a **turn boundary**; a parked state is model-specific.
- A load is 40–60 s; a restore is seconds. Do not switch mid-task for a small win.
- `cache-ram 24576` is host RAM, not a reservation; the restore path is the 5–6.3 GB/s link.
- Never load two models; never add a second slot.

---

## 5. Already live after this conversation

| piece | state |
|---|---|
| Tool filter | `llama-toolfilter` on `127.0.0.1:8101` → router; strips `task` from `tools[]` (prompt **and** grammar). Both harnesses point at 8101. |
| Prompt cache | `cache-ram = 24576` in `[*]`; the old 8192 could not hold >~105–148K states (8,354–8,913 MiB measured) |
| Idle | `sleep-idle-seconds = -1` (was 600; a 10-min pause dropped the KV and paid a cold reload) |
| Reasoning | `reasoning-preserve = off` in both 3.8 sections; prior thinking is not carried |
| Compaction | omp `thresholdPercent 75` (196,608), `methodOrder ["handoff","shake","soft"]`, `asyncEnabled false`, `keepRecentTokens 20000`, `handoffSaveToDisk true`, `midTurnEnabled true`, `autoContinue true` |
| Thought archive | `omp-thoughts` (detached) → `/dev/shm/qwen-thoughts/THOUGHTS.index.md` + `THOUGHTS.md`; user note in `~/.omp/agent/AGENTS.md`; filter follows `local-llama` ids; current pointer = newest top-level local session |
| Aux models | `modelRoles.smol/slow/tiny = deepseek/deepseek-flash` (titles/classifier/memory off the V100); `default` was rewritten to deepseek by the live session |
| Loaded now | `Qwen3.8-27B-MTP-Q4_K_M.gguf`, `n_ctx_slot 262144`, 27,736 / 32,768 MiB, 4,759 free |

Optional harness-side consistency: launch with
`--tools=read,bash,edit,write,grep,glob,lsp,python,notebook,browser,todo,web_search,ask` so OMP's own
system prompt also stops listing `task`. The 8101 filter remains the hard backstop for every client
and every subagent.

`POST /slots/0?action=erase` frees the slot's token occupancy, **not** VRAM: the KV allocation is
preallocated. It is a compaction/cleanup aid, not a capacity lever.

---

## 6. Conversation key points (measured; append future findings below)

### 6.1 The 8 GiB prompt-state cliff

- Default `--cache-ram 8192`; state sizes measured: **8,913 MiB @140,028 tok**, **8,354 @154,594**,
  **8,641 @112,989**, **8,512 @137,581**. The crossing was ~43–56% of the 262K window, depending on
  checkpoint/draft composition; exactly the "56% then it stops thinking" report.
- The refusal is a policy check, not OOM: `server_prompt_cache::alloc` returns `nullptr` when
  `state_size_new > limit_size`; the message was
  `prompt state size … exceeds cache size limit 8192.000 MiB, skipping`.
- Consequence: a ~300-token title request recycled slot 0; the 137K state was unrecoverable; the next
  turn re-prefilled 154,696 tokens in **498 s (310 t/s)**, and the client aborted at the 10-minute mark
  with only 46 chars of thinking streamed. Raising `cache-ram` to 24 GiB is the fix; a full 262K state
  is ~17–20 GiB.
- VRAM never spilled: the KV is resident; the 27,796 MiB process was flat. The 8 GiB is host RAM.

### 6.2 Subagents on one slot

- One `task` call spawned `SceneNetBuild`, `ServerAlign`, `UiCssBuild`. Each turn: ~20.1–20.6K prompt,
  **32.6–33.6 s full re-prefill**, 135–199 generated tokens at 48–55 t/s. No sibling prefix reuse.
- Parent states 126,593 → 137,581 were skipped at 8,512 MiB; the next parent turn cold-prefilled
  154,696 tokens (498 s). The fan-out made the parent slower and evicted its KV.
- Hard rule: no subagents on the V100. Enforced by the request filter, not by prompting.

### 6.3 Acceptance vs context (27B, MTP 3)

| live ctx | acceptance | mean len | decode |
|---:|---:|---:|---:|
| ~20K | 0.874 | 3.62 | 53.8 t/s |
| ~31K | 0.820 | 3.46 | 47.8 t/s |
| ~80K | 0.715 | 3.15 | 29.2 t/s |
| ~113K | 0.566 | 2.70 | 25.9 t/s |
| ~126K | 0.715 | 3.15 | 29.2 t/s |
| ~131K | 0.502 | 2.51 | ~20 t/s |
| ~140K | 0.612 | 2.84 | 24.6 t/s |

Content/acceptance dominates the context term. Depth 3 is the measured knee (2 → 37.5, 3 → 43.1,
4 → 39.5 t/s at ~1.6K); at 50K, depth 3 gives 28.6 t/s. Lower temp for coding raises acceptance.

### 6.4 Reasoning budget (the real token lever)

Measured distribution of 37 thinking blocks: total 49,444 tokens, median 423, mean 1,336, p90 4,098,
max 10,769.

| cap | binds | thinking saved |
|---:|---:|---:|
| 1,024 | 13/37 | 61.6% |
| 2,048 | 7/37 | 40.6% |
| 3,072 | 4/37 | 28.3% |
| **4,096** | **4/37** | **20.0%** |
| 8,192 | 1/37 | 5.2% |

**4,096** is the recommended default (p90); **2,048** is the fast profile. The budget is per
completion, not per user turn. `reasoning-budget-message` can nudge the forced end.

### 6.5 Language experiments (not levers)

- ASCII-only thinking: tokenized the 179,500-char corpus at 49,446 tokens; ASCII-normalised =
  49,392, **−54 tokens (−0.11%)**. Non-ASCII was 0.63% of chars, mostly single-token glyphs.
- Chinese thinking then English answer: measured 97 EN vs 89 ZH tokens on five technical pairs,
  **−8.2%** (range 0.76–1.26 per sentence). Prompt-rule only; prefix-stable; archive becomes Chinese.
  Not worth a profile; the budget is 2–5× larger.

### 6.6 Host↔device and the DRAM law

- PCIe gen3 ×8, ~6.3 GB/s usable (this box; `PLAN-dram-offload.md`), ~5 GB/s observed in state copies;
  HBM2 ~900 GB/s → ~143× penalty for any per-token host read.
- State copy at 5 GB/s: 100K ctx ~1–1.6 s; 200K ~2–3 s; 236K 27B park ~4.4 s each way. A cold 150K
  prefill is 6–8 min. The prompt cache is the right use of the link; per-thought KV swaps are not.
- The KV allocation is preallocated; clearing a slot does not return VRAM. Only a smaller `ctx-size`
  and reload (262K → ~8.5 GiB; 131K → ~4.3 GiB) or unload does.

### 6.7 Prefix-stability and the 8-block window

- `reasoning-preserve=off` is stable and cheap. A per-turn last-8 window rewrites an old message and
  re-prefills the suffix every turn (2 min at 50K, 6–8 min at 150K). The window is a **compaction
  policy**, not a per-prompt one.
- Retrieval should be `grep THOUGHTS.index.md` → `read THOUGHTS.md:<range>`, appended as a tool
  result at the tail. That is prefix-safe and costs 1–3K tokens once.

### 6.8 Hardware notes

- V100 power limit **220 W** (default/max 300 W), idle 1290 MHz, max 1530 MHz, 47 °C, no thermal
  issue. Raising the limit needs root and PSU headroom; a few percent at most.
- Live new chat after the restart: **46,809 / 262,144 = 17.9%** occupancy, idle.

---

## 7. OMP mechanisms roadmap

OMP is the right home for these; the rig-side pieces are already in place.

**OMP-1 — per-model profiles.** A settings layer keyed by model id:
`{compaction.thresholdPercent, methodOrder, reasoningBudget, disabledTools, archive, sampler}`.
Today `compaction.*` is global; `rabid-fast` wants 60–65%, `rabid-deep` 75%. Implement as a
`profiles:` record or per-model `settings:` in `models.yml`.

**OMP-2 — compaction-boundary thought window.** At 75% (or every N turns), build a handoff that
includes the last 8 thought summaries, then rewrite the context once. Never per prompt. Full blocks
stay in `THOUGHTS.md`; the handoff carries summaries.

**OMP-3 — `recall_thought` tool.** First-class tool: `recall_thought(query, n=1)` → grep the index,
return the best block(s) and their anchors. Replaces ad-hoc `grep`/`read` and keeps the retrieval
prefix-safe (tool result at the tail). Optional auto-recall: inject the index only when the task
mentions a path/decision that appears in it.

**OMP-4 — native per-model tool policy.** `disabledTools: [task]` for local models, with the server
filter as the backstop. This also removes the `task` entry from the system prompt so the model does
not try a call it cannot make.

**OMP-5 — thinking budget on the wire.** Map `thinkingBudgets` to llama.cpp's
`reasoning_budget_tokens` / `thinking_budget_tokens` request fields (the server reads both). Today the
harness does not send them; the preset flag is the only control. Per-turn budgets then work without
reloading a model.

**OMP-6 — prefix-stability guard.** A lint that refuses to rewrite historical messages outside a
compaction entry; warn if a feature (sliding window, retro-summary, edit-in-place) would move the
prefix. This is the guard for OMP-2.

**OMP-7 — observability.** Enable `metrics = on` in `[*]`; ship a `kv-watch` that polls `/slots`
(`n_prompt_tokens / n_ctx`, `n_prompt_tokens_cache`, `n_decoded`) and logs a CSV with the router's
`state size` and `draft acceptance` lines. Plots: KV gauge, context redshift, phase diagram at
`cache-ram`.

**OMP-8 — preset switcher.** In the model picker: park → unload → load → restore, with the expected
seconds. Show which preset is loaded and its VRAM/headroom.

**OMP-9 — compaction defaults per preset.** `handoff` first, `shake` second (tool-result offload),
`soft` last, `asyncEnabled=false` on one slot. `keepRecentTokens` 20K. `autoContinue=true`.

**OMP-10 — thought archive hardening.** Retention (per session/per project), an index per session,
`current` by cwd as well as newest, optional `toolResults` archive (shake already uses artifacts),
and a `--prune` command.

**OMP-11 — model-file provenance.** A `doctor` check that verifies every `models.ini` `model`/`mmproj`/
`spec-draft-model` path exists and matches the expected size; fail before load. This would have caught
the missing 35B projector.

**OMP-12 — host/VRAM budget guard.** Before a load, compute `weights + KV(ctx) + draft + projector +
compute` and refuse a preset whose headroom is below a floor; warn when `cache-ram` plus page cache
would push host RAM into swap. Show the ledger from §2.4 in the model picker. This is the "do not go
overboard" guard, and it is pure CPU.

**OMP-13 — per-profile resource knobs.** Let a profile override `ctx-size`, `cache-type-k/v`, `ubatch`,
and `cache-ram`, not only samplers and thinking budget. `rabid-fast` can run 131K/q8_0 if a job does
not need the full window; `rabid-deep` keeps 262K. The presets in §2 are the 262K defaults.

**OMP-14 — restore/snapshot accounting.** Record the serialized state size per turn next to the
`cache-ram` limit, and surface the 8 GiB/24 GiB phase boundary in the UI. The measured numbers to
show: 8,354–8,913 MiB at 140–155K; ~17–20 GiB at 262K; restore seconds vs prefill minutes.

---

## 8. Verification protocol

For each preset, in order:

1. `POST /api/load`; check `llama-manager status`, `/props` (`n_ctx 262144`), `nvidia-smi`
   (VRAM/headroom).
2. Send one real prompt; **discard it as warm-up**. Send the same prompt again; record `tg`,
   `draft acceptance`, `mean len` from `router.log`.
3. Tool check: one `read` + one `bash` call; confirm the `task` tool is absent from `tools` and the
   model cannot emit it.
4. Needle at ~100K and ~200K (thinking off for the probe); confirm recall on the balanced/fast and
   deep profiles.
5. Grow to 75%; confirm compaction uses `handoff`, `asyncEnabled=false`, post-context ~45–55K, and
   the next turn prefills ~2 min, not 8.
6. Park/restore once; confirm the ~seconds, not minutes.
7. Host side: `free -g` (available, swap), no growth into swap; `cache-ram` state sizes in the log
   stay below the limit; `/dev/shm` archive size stable; no `exceeds cache size limit` line.
8. Record the results in §6 (append).

Acceptance criteria for the plan:

- no `exceeds cache size limit` at any context up to 262K (the 24 GiB fix);
- no cold re-prefill >2.5 min during normal work;
- `draft acceptance` ≥0.70 at 20–50K on code, ≥0.55 at 126K;
- compaction ≤10 min, post-compaction context ≤60K;
- no subagent calls.

---

## 9. Risks, rollback, open questions

| risk | mitigation |
|---|---|
| Q5 + vision + draft doesn't fit | use Q4_K_XL (§22 law); or choose vision **or** draft |
| Missing 35B projector/MTP | P0-A download, or P0-B fallback; add a doctor check (OMP-11) |
| Q5 card references a missing `mmproj` | fetch it or remove the line before loading (§3) |
| `reasoning-budget` inactive on the 3.6 template | verify it prefills `<think>`; otherwise use sampling only |
| 24 GiB `cache-ram` + page cache | 45 GiB host available; monitor `free -g`; lower to 20480 if needed |
| host RAM / swap pressure | cache-ram is a limit, not a reservation; `free -g` + swap in §8; thoughts are 3.2 MB |
| Model path drift (UD vs MTP pack) | pin each preset's `model` explicitly; document it |
| Preset edits not taking effect | the router reads `models.ini` once at startup — `POST /api/server/stop` + `start` after edits |
| `snapcompact` selected by mistake | it needs a vision-capable current model; the 27B has no projector, and the 35B only when its F16 projector is present. `methodOrder` is `["handoff","shake","soft"]` for exactly this reason |
| per-prompt 8-block window | forbidden: prefix break; use the compaction boundary (OMP-2) |
| tempted by CPU KV / CPU MoE / 3070 draft | per-token PCIe is ~143× slower; §2.4 lists the traps |
| expecting slot erase to free VRAM | it frees occupancy only; reload with a smaller `ctx-size` or unload |
| Power cap 220 W | leave it; raising to 300 W needs root/PSU, few % |
| `modelRoles.default` rewritten by live sessions | set after sessions exit, or use explicit model ids |

Rollback: remove the three sections, restore `models.yml`/`models.json`, `POST /api/server/stop` +
`start`. The tool filter, cache-ram, sleep, archive and compaction settings are independent.

Open questions:

- Does the Qwen3.6 template prefill `<think>`? (gates the budget on balanced/fast)
- Is 138.8 t/s reproducible at 262K with the 24 GiB cache and MTP n-max 2 on this box?
- Does keeping 8 thought summaries in the handoff improve continuity without hurting acceptance?
- Can OMP send `reasoning_budget_tokens` per request (OMP-5) without a provider schema change?

---

## 10. Next actions

1. **P0-A** — download the 35B Q4_K_XL pack + F16 projector + MTP Q8_0 sidecar (~23.5 GiB); verify
   sizes/hashes.
2. Add `rabid-deep`, `rabid-balanced`, `rabid-fast` to `models.ini`; add the three ids to both harness
   configs.
3. Restart the router, load `rabid-balanced`, and run the §8 protocol. Then `rabid-deep` and
   `rabid-fast` on the same ~60K task; write the numbers into §6.
4. Fix or retire the Q5 card (missing `mmproj`).
5. Enable `metrics = on`; start the `/slots` gauge (`kv-watch`) and the host-budget check.
6. OMP order: **OMP-1** per-model profiles → **OMP-4** `disabledTools` → **OMP-5** budget on the wire
   → **OMP-2** compaction-boundary 8-block → **OMP-3** `recall_thought` → **OMP-12** budget guard.
7. Keep the policy: no per-token host traffic; no per-prompt window rewrites; spend host RAM and CPU
   on per-turn state, never on decode.

---

## Appendix — paths and log signatures

```
models.ini        ~/.local/share/llama-v100/models.ini
harness           ~/.omp/agent/models.yml, ~/.pi/agent/models.json
tool filter       ~/.local/share/llama-v100/toolfilter.py  (127.0.0.1:8101 -> 8080)
thoughts          ~/.local/share/omp-thoughts/thoughts.py  -> /dev/shm/qwen-thoughts
user context      ~/.omp/agent/AGENTS.md
router log        ~/.local/share/llama-v100/logs/router.log
filter log        ~/.local/share/llama-v100/logs/toolfilter.log
```

Signatures worth grepping:

```
prompt state size .* exceeds cache size limit
making room for prompt cache entry, removing oldest entry
slot context shift
selected slot by LCP similarity, f_sim_best =
draft acceptance =
n_ctx_slot = 262144
```

— end of plan —
