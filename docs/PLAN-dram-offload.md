# PLAN — Using the 64 GB DDR4 tier without losing context or decode speed

**Box:** `pipo-z390-aorus-pro-wifi` · i9-9900K (8c/16t, 1 socket) · 63.4 GiB DDR4 · Tesla V100-SXM2-32GB (sm_70) · RTX 3070 8GB (sm_86, desktop)
**Rig:** llama.cpp PrismML fork (`~/.local/opt/llama-prism`), router `:8080`, manager `:8090`, models in `~/.local/share/llama-v100/models.ini` · 1Cat-vLLM 1.5.0 (`~/.local/opt/1cat-vllm`)
**Written:** 2026-10-16
**Question this answers:** *"How do I offload to slow DRAM without losing context or token generation speed, and how do I make the 64 GB DDR4 useful?"*

---

## 0. The law

> **Bytes read per *token* must live in VRAM. Bytes read once per *turn* may live in DDR4.**

Everything else in this plan is a consequence. There is no cleverness that breaks it, because the penalty for breaking it is fixed by the bus:

$$\frac{\text{HBM2}}{\text{PCIe}} = \frac{900\ \text{GB/s}}{6.3\ \text{GB/s}} \approx \mathbf{143\times}$$

Any per-token read that leaves the card costs ~143× more than the same read from VRAM. Compression buys 2–4×; the gap is 143×. **Compression cannot rescue a per-token offload. Only not-needing-the-byte can.**

Corollary: DDR4 is a *capacity* tier and a *persistence* tier. It is never a decode tier.

---

## 1. Substrate — measured facts

| Resource | Value | Source |
|---|---|---|
| V100 HBM2 bandwidth | ~900 GB/s | spec |
| **PCIe link to V100** | **gen3 ×8 → 7.88 GB/s raw, ~6.3 GB/s usable** | `local-qwen-on-v100.md` §1 |
| V100 power cap | 180 W | §1 |
| DDR4 | 63.4 GiB total, ~43.8 GiB available, dual-channel | `/proc/meminfo` |
| Swap | 8 GiB | `free` |
| `/dev/shm` | **31 GiB** (default = half of RAM) | `df -h` |
| **`ulimit -l` (memlock)** | **8192 KB — 8 MB** | `ulimit -l` |
| NUMA | single node, no cross-socket cost | `lscpu` |

### Two findings that gate the whole plan

1. **The card is x16-capable but held at PCIe gen3 ×8** by the board's PEG bifurcation. Its own Link Cap says `max_link_width = 16`; the root port it sits on (`0000:00:01.0`, CPU PEG) reports `max_link_width = 8`. The RTX 3070 occupies the sibling CPU port (`00:01.1`, also ×8), and Gigabyte's manual is explicit: *"The PCIEX8 slot shares bandwidth with the PCIEX16 slot. When the PCIEX8 slot is populated, the PCIEX16 slot operates at up to x8 mode."* **Emptying the PCIEX8 slot restores ×16** (see §9). Every offload figure in this plan is therefore the *pessimistic* case; all of them roughly double if the 3070 leaves the CPU lanes. Use **6.3 GB/s** as the working number.
2. **`memlock` is 8 MB.** Any pinned / `cudaHostAlloc` / zero-copy host buffer larger than 8 MB fails by default. This blocks vLLM's `--kv-offloading-size` (pinned in full at boot) and any host-KV scheme outright — before any measurement is possible. **Fix first (P0).**

### Verified capability surface — `prism-b10709` (`llama-server --help`, this box)

Everything this plan proposes is a **configuration change**, not a port. Confirmed present:

| Flag | What it enables | Phase |
|---|---|---|
| `--slot-save-path PATH` | persist slot KV state to a file (DDR4) | **P1** |
| `-kvo` / `-nkvo`, `--kv-offload` / `--no-kv-offload` | KV in host RAM vs VRAM | P5 (control arm) |
| `-ctk` / `-ctv`, `--cache-type-k/v TYPE` | q8_0 → q4_0 KV | **P2** |
| `-ot`, `--override-tensor` | per-tensor buffer placement | P4 |
| `-cmoe` / `-ncmoe N`, `--cpu-moe` / `--n-cpu-moe N` | MoE experts on CPU | **P4** |
| `-devd`, `--device-draft` | **draft model on a different GPU (the 3070)** | **P3** |
| `--spec-draft-cpu-moe`, `-ncmoed`, `-otd` | same knobs for the draft | P4 |
| `-lm`, `--load-mode {auto,none,mmap,mmap+mlock,mlock}` | model residency policy (replaces `--mmap`/`--mlock`/`--direct-io`, now deprecated) | **P3** |
| `--swa-full`, `--ctx-checkpoints N`, `--context-shift` | context management / checkpointing | P1/P5 |
| `-fa`, `--flash-attn` | already `on` | — |

Note: `kv-mean-center` requires `--cache-type-k q4_0` — relevant if P2 moves the 27B to q4_0 KV.

### Measured model baselines on this box

| Model | ctx | KV type | VRAM | decode | prefill | needle |
|---|---|---|---:|---:|---:|---|
| Qwen3.8-27B UD-Q4_K_M (16.8 GB) | 262,144 | q8_0 | 25,250 MiB | 31.9 t/s | 239.5 t/s @236k | ✓ 109,165 tok |
| Qwen3.8-27B + MTP depth 3 | 262,144 | q8_0 | 28,042 MiB | 43.1 t/s short / 28.6 @50k | — | ✓ |
| Qwen3-Coder-30B-A3B UD-Q4_K_XL | 262,144 | q8_0 | 30,930 MiB | **109.2 t/s** | 683 t/s @51.9k | ✓ 51,889 tok |

KV cost per token (measured, this box, `local-qwen-on-v100.md` §3):

| Model | f16 | **q8_0** | q4_0 |
|---|---:|---:|---:|
| Qwen3.8-27B (16 of 64 layers carry KV) | 64 KiB | **34 KiB** | **18 KiB** |
| Qwen3-Coder-30B-A3B (48 of 48 layers) | 96 KiB | 51 KiB | 27 KiB |

Reference points that define the design space:
- **Depth is the dominant cost.** 27B no-draft: 28.4 t/s @1.6k live → 19.5 @50.4k. Speculation does not remove the slope.
- **Prefill is brutal at depth:** 239.5 t/s × 236k tokens ≈ **985 s ≈ 16 minutes.**
- Declared `ctx-size` costs VRAM, not speed (§5 of the speed doc).

---

## 2. Why the law bites — worked examples at 6.3 GB/s

All "host KV" figures = `live_tokens × KiB_per_token ÷ 6.3 GB/s`, added to the measured per-step time.

| Case | per-step from VRAM | per-step from DDR4 | result |
|---|---:|---:|---|
| 27B, 12,668 live, q8_0 (431 MB) | 38.9 ms (25.7 t/s) | +68 ms → 107 ms | **9.3 t/s — 2.8× loss** |
| 27B, 50,434 live, q8_0 (1.71 GB) | 51 ms (19.5 t/s) | +272 ms → 323 ms | **3.1 t/s — 6.3× loss** |
| 27B, 236k live, q8_0 (8.03 GB) | ~51 ms | +1274 ms | **0.78 t/s** |
| Coder 30B-A3B, 51.9k live, q8_0 (2.65 GB) | 9.2 ms (109 t/s) | +420 ms | **2.4 t/s — 46× loss** |

And the mirror-image case — **per-turn** reads, where DDR4 is not just fine but a 400× win:

| Operation | Cost |
|---|---:|
| Prefill a 236k prompt on the 27B | **~985 s** |
| Save/restore that KV state (8.03 GB) | **~4.4 s** at the measured **1.81 GB/s** serialization rate (§P1) |

**That asymmetry is the entire opportunity.** Stop trying to make DDR4 fast; make the things that are already slow happen to DDR4 instead of on the card.

---

## 3. The DDR4 budget — what 64 GB actually buys

Reserve: OS + desktop ≈ 4 GiB, active model page cache ≈ 17 GiB, Laya bridge + services ≈ 1 GiB. **Working budget for the tier: ~40 GiB** (and `/dev/shm` must be remounted above 31 GiB to use more than that in one file).

| Held in DDR4 | at q8_0 (34 KiB/tok) | at q4_0 (18 KiB/tok) |
|---|---:|---:|
| Full 262k context of the 27B | **8.9 GB** | 4.7 GB |
| → times it fits in 40 GiB | **4.5×** | **8.5×** |
| 1M-token YaRN context | 34.8 GB | 18.4 GB |

**The 64 GB is worth exactly this:** four to eight parked 262k-token conversations, or one million-token context, held at ~1.3 s retrieval — instead of one live conversation and sixteen-minute re-prefills.

---

## 4. Read-frequency decision table

Sort every candidate by how often it is read, then apply the law.

| Thing | Read | Verdict |
|---|---|---|
| Qwen dense weights (16.8 GB) | every token | **VRAM only** |
| GDN recurrent state (~150 MB/req fp32) | every token, read **and** written | **VRAM only** — worst possible offload candidate |
| Attention KV, *live* window | every token | **VRAM only** |
| Attention KV, *parked conversation* | once per turn | **DDR4 — Phase 1** |
| Prompt prefill result (KV state) | once per turn | **DDR4 — Phase 1** |
| MoE expert weights (routed) | every token | DDR4 only if the model otherwise can't run — Phase 4, **measured 14.5 t/s** on a 30B-A3B |
| Model weights, *inactive* model | once per swap | **DDR4 (page cache) — Phase 3** |
| Draft model (0.5–2 GB) | every token | VRAM — but the **3070's** VRAM, not the V100's — Phase 3 |
| Tokenizer / embeddings | per token, sparse rows | DDR4 via UVA — proven free (`EMBED_UVA` +15.7% pool, decode unchanged) |

---

## 5. Phases

Each phase: hypothesis → method → **gate** → kill criterion. Do them in order; P1 is worth more than P2–P5 combined.

### P0 — Make the substrate capable (½ day)

**Hypothesis:** the rig cannot currently host any pinned tier, so every host-side option is untestable.

1. Raise memlock. Add `/etc/security/limits.d/99-llm.conf`:
   ```
   pipo soft memlock unlimited
   pipo hard memlock unlimited
   ```
   and for the user systemd units (`llama-router.service`, `llama-proxy.service`) add `LimitMEMLOCK=infinity`. Verify: `ulimit -l` reports `unlimited` after re-login, and `systemctl --user show llama-router -p LimitMEMLOCK`.
2. Remount `/dev/shm` above the tier size if a 40 GiB file is needed: `sudo mount -o remount,size=48G /dev/shm` (make it persistent in `/etc/fstab`).
3. Freeze a baseline: run the existing needle sweep on both the 27B and the Coder at 4k / 16k / 50k live, record decode + VRAM + VRAM-free. Everything downstream is compared to this.
4. Add a `dram` section to the manager UI showing `MemAvailable`, `/dev/shm` usage, page-cache bytes for `~/models/*`.

**Gate:** `ulimit -l = unlimited`; baseline JSON committed next to `/tmp/1cat/needle_llama.py` output.
**Kill:** if memlock can't be raised on this distro, P5 is dead and P1–P4 proceed unchanged.

---

### P1 — KV state persistence to DDR4 — **SHIPPED 2026-10-16, but only works on pure-attention models**

**Hypothesis:** the 985 s prefill is paid repeatedly for the same document; persisting the KV state converts it into a multi-second restore at zero decode cost.

**Result: the mechanism is confirmed and shipped, but it does not apply to the model this plan was built around.** It works on the Coder (391× measured); on the 27B — the hybrid whose 236k contexts motivated P1 — it is **0×**. Read step 3 before relying on any of it.

Method: standalone `llama-server` (prism-b10709) on a freshly allocated port, `Qwen3-Coder-30B-A3B-UD-Q4_K_XL`, `-c 32768 -fa on -ctk q8_0 -ctv q8_0 --slot-save-path /tmp/slottest`. Needle (`QX-4471`) at the midpoint of a maintenance-log haystack, question last, greedy.

| depth | cold prefill | save | slot file | after restore | speedup |
|---:|---:|---:|---:|---:|---:|
| 6,154 tok | 6.88 s | 0.18 s | 322 MB (52.3 KiB/tok) | **0.20 s** (`prompt_n = 1`) | **34.8×** |
| 29,404 tok | 37.48 s | 0.85 s | 1,537 MB (51.0 KiB/tok) | **0.34 s** (`prompt_n = 1`) | **112×** |

- **The restore is exact** — the needle is retrieved in every arm including after restore, and `prompt_n = 1` proves the whole prefix came back from the file rather than being re-prefilled.
- **It is genuinely a cache**: after `/slots/{id}?action=erase`, the same prompt cost the full 37.13 s again.
- **Scaling is linear** and the byte/token (51.0 KiB) matches the independently measured KV cost — no hidden overhead.
- **Serialization throughput is a constant 1.81 GB/s** in both arms (322 MB / 0.178 s; 1,537 MB / 0.85 s) — *not storage-bound*, since `/tmp` is tmpfs (RAM) and still only reached 1.8 GB/s. The limit is llama.cpp's KV serialize path, so **putting the store on NVMe costs nothing**.

**Extrapolation to the target:** 236k × 34 KiB = 8.03 GB → **~4.4 s each way**, against a ~985 s cold prefill. **~220×.** The < 5 s gate is met.

**Also verified end-to-end through the router proxy** (throwaway router on a spare port, real `models.ini` copy + `slot-save-path`): cold 8.78 s / 8.77 s → save 419,227,196 B in 234 ms → restore 419,227,196 B in 170 ms → next request **0.20 s**. **43.8× through the production path**, needle correct in every arm. The spawned child carried `--slot-save-path` correctly.

**Router API shape (each endpoint wants the model in a different place — this will waste an hour otherwise):**

| call | where `model` goes |
|---|---|
| `GET /slots?model=<id>` | **query param** |
| `POST /slots/{id}?action=save\|restore\|erase` | **JSON body** |
| `POST /tokenize` | **JSON body** |
| `POST /v1/completions` etc. | JSON body (as usual) |

**`kv_unified = true`** — the KV/prompt cache is shared across slots, not per-slot. A "cold" control arm must `?action=erase` first, or it silently measures a cache hit (8.78 s vs the 0.48 s I first saw). This also means "slots" are not isolated conversations; parking a context means erasing the live cache and restoring it later.

**Measured byte/token: 52.2 KiB** (Coder, 8,025 tokens → 419.2 MB). Serialization rate 1.79 GB/s save / 2.46 GB/s restore, matching the direct-server measurement.

**Method to productionise:**
1. ✅ **DONE 2026-10-16.** `slot-save-path = /home/pipo/.local/share/llama-v100/slots` added to the `[*]` section of `models.ini` (backup: `models.ini.bak-preslot-20261016-0613`); router restarted via the manager (`POST /api/server/stop` then `/api/server/start`). **Verified live:** the spawned child carries `--slot-save-path …`, and `GET /slots?model=<id>` answers through the production router on :8080.
2. ✅ **DONE 2026-10-16 — the round trip and the policy are implemented in `manager.py`** (a new "context parking" section, ~200 lines):

   | piece | what it does |
   |---|---|
   | `park_context` / `restore_context` / `drop_context` / `contexts_listing` | the round trip, with the child's own reply as the receipt (`n_saved`, `save_ms`) |
   | `POST /api/context/park` · `/restore` · `/drop`, `GET /api/contexts` | the API; `parking` + `contexts` also ride along in `/api/state` for the page |
   | `_park_watcher` | a daemon thread: snapshots a model when its slot's token count has been unchanged for `quiet_seconds` and differs from the last snapshot |
   | `_resume_when_ready` | after `/api/load`, restores the model's snapshot once the child answers (off-thread — the load returns before the weights land) |
   | `unload_model` hook | snapshots before the weights go, and reports `parked N tokens` in its detail |
   | shutdown hook | `park_active()` on the way out, so Ctrl-C does not throw away a live prefill |
   | policy | `parking.json` — `{resume, park_on_idle, quiet_seconds}`; absent means defaults `{true, true, 120}`. **Not in models.ini**, because llama.cpp rejects a preset key it does not know |

   Parking is a **snapshot, never an erase** — the live slot keeps its cache, so a returning client still hits it; the file only matters once the weights are gone.

   **Measured, full production loop (Coder 30B-A3B, 6,781-token context):** unload → `parked 6781 tokens` → load → `parked context queued for resume` → restore in **114 ms** → same prompt **wall 0.13 s, `prompt_n=1`, `cache_n=6773`** — **391× against the 7,319 ms full re-prefill**, and the needle is still answered correctly.

3. ⚠️ **THE LIMIT — it only works for pure-attention models.** Measured in a controlled A/B (same standalone server, same flags, same slot directory, `--parallel 1`):

   | model | layers with KV | after restore |
   |---|---|---|
   | **Qwen3-Coder-30B-A3B** | 48 of 48 (pure attention) | **`prompt_n=1`, `cache_n=3983`** ✅ |
   | **Qwen3.8-27B** | 16 of 64 (48 Gated DeltaNet) | `prompt_n=3985`, `cache_n=0` ❌ |
   | **Qwopus3.5-9B-Coder** | 8 of 32 | `prompt_n=6775`, `cache_n=0` ❌ |

   The restore *succeeds* on all three (`n_restored` matches `n_saved`); on the hybrids the next request re-prefills the prompt anyway — llama.cpp cannot resume a recurrent state from a slot file, whatever it writes into it. **Speculative decoding is not the cause** (same model, `--spec-type none` vs `draft-mtp`, identical), nor is `--parallel`, nor the KV dtype.

   **Consequence for this plan: `resume` does not help the 27B, which was P1's whole premise.** On hybrids parking is harmless but pointless — the snapshot is written, read back, and the prefill happens regardless. `P1`'s ~220× applies to the Coder (and any pure-attention preset); for the 27B it is **0×**.

**Budget note:** a parked 236k conversation costs **~8 GB** of slot file on the 27B (34 KiB/token) and **~13 GB** on the Coder (51 KiB/token). So the §3 budget of ~40 GiB holds **~4 parked 262k conversations at q8_0** on the 27B — half that many on the Coder, or 8+ if P2 moves the 27B to q4_0 KV.

**Remaining risk:** none on correctness. The open question is whether restore survives a *router restart* and a model swap (i.e. is the file keyed to the checkpoint) — see §9.

---

### P2 — Reclaim VRAM by KV quantization, spend it on quality — ½ day

**Hypothesis:** q8_0 → q4_0 halves KV (34 → 18 KiB/token) with no measurable decode cost, because the note in §10 of the speed doc is right that KV bandwidth only matters at depth — so the freed ~4.2 GiB at 262k is nearly free money.

**Method:** `--cache-type-k q4_0 --cache-type-v q4_0` on the 27B preset only (the Coder's 51 KiB/token makes it the one that needs it more, but it also has only 1.8 GiB headroom — test both). Re-run the needle at 12k / 50k / 109k.

**Then spend the headroom**, in priority order:
1. **Draft on the 3070** — `-devd / --device-draft` is confirmed present; moves the MTP/draft model off the V100 entirely (and parallelises it with the target).
2. Larger weight quant (Q5_K_M / Q6_K) for the same context.
3. `parallel 2` for a second concurrent conversation.

**Gate:** needle still found at 109k on the 27B; decode within ±1 t/s of baseline at 12k and ≥ baseline at 50k; VRAM free increased ≥ 3.5 GiB.
**Kill:** if the 109k needle fails, revert to q8_0 and take the headroom from P3 instead.

---

### P3 — Weights residency and swap latency — 1 day

**Hypothesis:** with ~20 GGUFs on disk and 43 GiB free, the OS page cache is already a weights tier — but it is unmanaged, so a model swap can still hit disk for 16.8 GB.

**Method:**
1. Measure cold vs warm load for the 27B and the Coder (`time` around an unload/load cycle through `manager.py`).
2. Use `vmtouch` (or `posix_fadvise` via a small script) to check residency of the active GGUF and to explicitly evict models that will not be used.
3. Decide a **keep-hot set** of two models that must stay in page cache (27B + the A3B coder) and a policy to evict the rest.
4. `--load-mode {auto,none,mmap,mmap+mlock,mlock}` replaces the deprecated `--mmap`/`--mlock`/`--direct-io`. `mmap` is right (keeps the page cache in the loop); `--no-mmap`/`none` is *not* the answer — it forces a full read into anonymous memory and takes the page cache out of the loop. `mmap+mlock` is only for the small keep-hot set, and it costs memlock budget (P0).

**Gate:** second-and-later swap of a hot model < 5 s; a cold swap documented rather than accidental.
**Kill:** if page cache thrash is not observable, drop this phase and let the kernel do its job.

---

### P4 — MoE expert offload: the capacity ceiling, priced honestly — 1 day

**Hypothesis:** DDR4 lets you *run* models that do not fit. **Measured on this box — and the earlier estimate was wrong by 3× in the pessimistic direction.**

**Measured 2026-10-16.** `llama-bench`, `Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL` (30.53 B total, 3.3 B active, 128 experts / 8 per token, 48 layers, 16.45 GiB), 2 reps:

| config | pp256 t/s | tg64 t/s | CUDA0 model buffer |
|---|---:|---:|---:|
| `-ngl 99` (all on V100) | **723.8 ± 5.6** | **142.5 ± 4.1** | 16,674 MiB |
| `-ngl 99 -ncmoe 24` (half) | 168.6 ± 5.4 | **21.0 ± 1.0** | — |
| `-ngl 99 -ncmoe 48` (all experts CPU, default threads) | 101.8 ± 3.7 | 11.8 ± 0.4 | **810 MiB** |
| `-ngl 99 -ncmoe 48`, **`-t 5`** | — | **14.5 ± 0.2** | **810 MiB** |

**Thread sweep (tg64, `-ncmoe 48`)** — the optimum is a flat plateau at 4–5, and it is a bandwidth/cache effect, **not a clock effect**:

| `-t` | 1 | 2 | 3 | 4 | **5** | 6 | 8 | 16 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| tg64 t/s | 7.15 | 11.68 | 13.56 | 14.27 | **14.53** | 13.98 | 11.76 | pathological (killed) |
| package clock during run (MHz) | 4700 | 4700 | 4700 | 4700 | 4700 | 4700 | 4700 | 4700 |

Read it as: **below 4 cores you are starving the memory path; at 8 you oversubscribe it; 4–5 is the plateau.** 3 cores costs ~7%, 2 costs ~20%, 1 costs half.

**There is no single-core boost to capture.** A pure busy-loop test on this box tops out at **4700 MHz at 1, 2, 4, 8 and 16 threads alike** — the 9900K's 5.0 GHz single-core bin is not being delivered (board turbo configuration), so every thread count runs at the same clock. Throughput doubling from 1→4 threads at *identical* clock is the signature of a **memory-bandwidth-bound** path.

> **DECISION: pin `-t 5`.** It is the measured peak (14.53 t/s). `-t 4` is inside the run-to-run spread (14.27) and is an acceptable alternative if you want two cores left for the router/proxy/Laya bridge. **Nothing else:** never let it default to `nproc` (16 collapses), and do not go below 4 (3 costs 7%, 2 costs 20%, 1 costs half).

**Why it costs what it costs — the bottleneck is not PCIe:**

| component | per token | time |
|---|---:|---:|
| active expert weights read by the **CPU from DDR4** (~3.3 B × 8/128 of 16.2 GiB of experts) | **~1.0 GiB** | ~70 ms (≈15.5 GB/s effective, of ~45 GB/s peak) |
| PCIe traffic (48 layers × 4096 hidden × 2 B × 2 directions) | **786 KB** | **0.12 ms — 0.17% of the step** |
| total measured, `-t 5` | | 69 ms (**14.5 t/s**) |

Effective DDR4 rate is ~15.5 GB/s — a third of the link's peak — so the residual is **dequant instruction cost and access pattern**, not raw DRAM bandwidth. Do not expect a bigger model to be proportionally slower; do expect the per-token cost to stay pinned to the *active* parameter count.

So MoE offload is **DDR4-bandwidth- and CPU-bound, not PCIe-bound**. Corollary that matters more than the speed number: **cost scales with *active* parameters, not total.** An 80B-A3B has ~the same active params, therefore ~the same ~14.5 t/s, while `CPU_Mapped` grows to ~45 GiB. **This is a total-parameter lever, not a speed lever.**

**Freed VRAM: 16,674 → 810 MiB (≈15.5 GiB).** On the Coder (51 KiB/token q8_0) that is ~600k tokens of KV — more than the model's 262,144 window. An offloaded A3B gets its full context *and* leaves the card nearly empty.

**Method:** take a model that does not currently fit (an 80B-A3B at Q4 ≈ 45 GiB, or `Ornith-1.0-35B`) and offload the experts. Flags confirmed present: `-cmoe` (all), `-ncmoe N` (first N layers), `-ot "\.ffn_(up|down|gate)_exps\.=CPU"`; draft variants `-cmoed`, `-ncmoed`, `-otd`. **Set threads explicitly (`-t 4`–`5`).** Measure decode, prefill, VRAM, DDR4 use. Record it as a **capability row**, not a performance row.

**Gate:** model loads, answers correctly, ≥ 8 t/s (the 30B-A3B measured 14.5 at `-t 5`). Recorded in `models.ini` with the thread setting and a capability note in the preset name.
**Kill:** if < 4 t/s, mark the class unserviceable on this box and stop.

---

### P5 — Host KV / sparse indexer (research, gated) — only if P1–P4 miss the target

**Hypothesis:** a KV working set in VRAM with the cold remainder in DDR4, pulled per turn through an attention indexer, is viable. **Dense attention makes this impossible** (see §2); only sparse/selected attention makes it legal, because then you stream ~1k positions/step instead of 262k.

**Evidence it exists in the wild, on V100:** 1Cat-vLLM ships `qsa_host_kv` — authoritative history in pinned host E4M3 with per-vector FP32 scales, an 8192-token VRAM hot cache, and `qsa_host_indexer_history` for selection. It is **opt-in and not promoted**, measured at 9,216 context with ~99% hot-cache hit rate and still a −0.6 to −2.9 point acceptance loss.

**Method:** on the 1Cat side, with memlock raised (P0), enable the host-KV route at a context where it can plausibly win, and measure hit rate, C1/C4 ms/round, and acceptance. The decisive metric is the **miss rate** — if it is not ≪1%, PCIe dominates and the phase is over.

**Gate:** at ≥64k live, per-step time within 10% of resident, needle preserved, acceptance within 1 point.
**Kill:** any observed miss-driven PCIe term above ~20 ms/step. Revert.

---

## 6. Rejected — do not re-derive

| Idea | Why it fails here |
|---|---|
| CPU-side KV compression, async between turns | Needs a GPU→host→GPU round trip; break-even requires **~82× compression** at gen3 ×8, i.e. ~0.1 bits/element. |
| Host KV for live decode (`--no-kv-offload`) | 2.8× loss at 12k live, 6.3× at 50k, 46× on the Coder (§2). |
| KV compression below fp8 **for decode speed** | Ceiling is the *weight* read (13.5 GB/token → 15 ms → 65 t/s). KV bytes are already negligible at ≤50k live. Compression is a **capacity** lever only. |
| MoE expert offload **for decode speed** | Measured 142.5 → 14.5 t/s, a 10× loss. Do it for capacity/total parameters, not speed (P4). |
| 256 MB VRAM working set with host spill, dense attention | Buffer size does not change bytes/step. Crossover ≈ 8.9k (fp8) / 17.8k (int4) of context. |
| Treating DDR4 as a decode tier at any bit width | PCIe×8 = 6.3 GB/s vs HBM 900 GB/s. No compression ratio available closes 143×. |
| Offloading GDN recurrent state | Read *and* written every step; ~150 MB/req fp32. Worst possible candidate. |
| Smaller weight quant for speed | 16.8 GB streamed at ~28 t/s ≈ 470 GB/s ≈ 52% of the card — sub-linear, and costs accuracy. Already measured. |

---

## 7. Measurement protocol

- Harness: `/tmp/1cat/needle_llama.py` — needle at the midpoint, question last, `temperature 0`, ≥256 output tokens, judge the **final content channel**.
- Depth in **real tokens** via llama-server `/tokenize`, never character estimates.
- Decode rates are the **second, identical** call (prefix-cache hit), so prefill is excluded. Report the first call's wall time separately.
- Noise floor is **±1 t/s**. Anything smaller is not a result.
- Always record: model, quant, KV dtype, live tokens, VRAM peak, VRAM free, DDR4 used, `/dev/shm` used, decode, prefill, needle result.
- Two runs minimum; three if the delta is near the noise floor.
- **Presets are parsed at router start.** Editing `ctx-size` or `spec-*` does nothing until the router restarts, and `stop-timeout` can silently reuse the old child — restart the router, then load.

---

## 8. Success criteria for the whole plan

| # | Target | Measured by |
|---|---|---|
| 1 | 236k-token conversation resumes in < 5 s instead of ~985 s | **Shipped, but Coder-only** — 391× measured on the Coder; **27B (hybrid GDN) gets 0×**, see §P1 step 3 |
| 2 | Decode at 50k live stays ≥ 19.5 t/s (27B) / ≥ 109 t/s (Coder) | every phase |
| 3 | Full 262k context usable, needle recalled at ≥109k | every phase |
| 4 | ≥ 40 GiB of DDR4 under managed use, holding ≥ 4 parked 262k conversations | P1 + P3 |
| 5 | One model that does not currently fit runs at ≥ 8 t/s | P4 (30B-A3B measured 14.5) |
| 6 | No phase regresses the baseline in §1 by more than the ±1 t/s noise floor | P0 baseline |

## 9. Open questions

- **PCIe width — ANSWERED (2026-10-16).** The V100 is x16-capable (`max_link_width = 16`) but trains at **×8** because the RTX 3070 occupies the sibling CPU root port. Board: Gigabyte Z390 AORUS PRO WIFI. Layout: `00:01.0` (CPU PEG, ×8) → V100 = **PCIEX16**; `00:01.1` (CPU PEG, ×8) → 3070 = **PCIEX8**; `00:1b.0`/`00:1c.0` (PCH ×1) empty; `00:1d.0` (PCH ×4) → the Intel 660P NVMe. Manual: *"When the PCIEX8 slot is populated, the PCIEX16 slot operates at up to x8 mode."*

  **Do not move the V100 to the bottom slot** — the third long slot is PCIEX4 (chipset ×4), which would *halve* the budget the offload tiers depend on. The V100 is already in the correct slot. **To get ×16, empty PCIEX8:**

  | option | V100 | 3070 | cost |
  |---|---|---|---|
  | (a) desktop → iGPU, pull the 3070 | **×16** | removed | iGPU is **HDMI 1.4, 4096×2160@30 Hz** max — fine for a tailnet-reached server, poor as a daily 4K desktop |
  | (b) 3070 → PCIEX4 (chipset) | **×16** | ×4 gen3 (~3 GB/s) | verify PCIEX4 isn't sharing the port the 660P sits on; the 3070 shares DMI with SATA/USB/NVMe |
  | (c) leave it | ×8 | ×8 | nothing — **the plan already assumes this** |

  Verify after any move: `cat /sys/bus/pci/devices/0000:00:01.0/{max,current}_link_width` → `16`, and `nvidia-smi --query-gpu=pcie.link.width.current`. Also check the BIOS for an explicit PEG bifurcation setting; the manual implies auto-detection.
  **Worth it only for the offload tiers, and only two of them** — nothing in the resident decode path touches PCIe, so decode is unchanged. **P1** restore drops 1.3 s → 0.65 s, and **P5**'s crossover moves from ~9k to ~18k of context. **P4 is NOT in this list**: measured 2026-10-16, MoE expert offload moves only 786 KB/token over PCIe (0.14% of the step) — it is DDR4- and CPU-bound, so ×16 buys it nothing.
- Does `memlock` survive reboot and actually reach the user systemd units (`systemctl --user show llama-router -p LimitMEMLOCK`)?
- **Is there any way to make slot restore work on hybrids?** This is now the highest-value unknown in the plan, because the 27B is the preset that needs it. Untested candidates: `--ctx-checkpoints N` (context checkpoints — a different mechanism to the slot file), `--swa-full`, and whether llama.cpp upstream has recurrent-state slot support in a later build than prism-b10709. Worth a look before assuming it is impossible.
- **`--slot-save-path` round trip — ANSWERED (2026-10-16).** Verified end to end on 8400: save/restore/erase all work, the restore is exact (needle retrieved, `prompt_n = 1`), and the serialization rate is a flat 1.81 GB/s independent of storage. **Still open:** whether a slot file survives a *router restart*, and whether it is valid across a model or quant change — i.e. is the file keyed to the checkpoint? Test before relying on it for anything long-lived.

---

## 10. Non-goals

- No kernel work in llama.cpp. If the remaining ~48% gap to the bandwidth ceiling is to be closed, that is a separate project (`qwen3.8-27b-speed-and-context-on-v100.md` §12 already says so).
- No new inference engine. 1Cat-vLLM stays as the concurrency/checkpoint escape hatch, not the daily driver.
- No rewrite of `manager.py` beyond the context-park policy in P1.
