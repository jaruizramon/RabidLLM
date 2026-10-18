# SLM handoff — test log

Lab notebook for the `slm` compaction method, the CPU worker, and the deterministic
requirement block. **Append one entry per test run**; do not rewrite earlier entries
(measurements stay as measured, corrections go in a new entry that cites the old one).

Format: `## <date> — <short title>` then `Setup`, `Observed`, `Conclusion`. Record the
numbers that a later run would otherwise have to re-measure: worker model, context
size, thinking budget, tokens before/after, worker wall time, tok/s, RSS.

Rig used: V100-SXM2-32GB, i9-9900K (16 logical CPUs), 45 GB RAM, llama.cpp b11026.
Main model for the harness runs: `local-llama/qwen3.8-27b` (router preset `qwen3.8-27b`,
MTP depth 3), presented to the harness through an experiment profile.

---

## 2026-10-17 — Worker flag smoke test (stock llama-server)

**Setup.** `llama-server-stock`, `SmolLM3-Q4_K_M.gguf`, `--ctx-size 4096`,
`--n-gpu-layers 0 --threads 4 --threads-batch 4 --parallel 1 --cache-type-k/v q8_0`,
`--jinja --no-webui --reasoning-format auto --reasoning-budget 4096`, port from
`free-port --range 8400-8499`.

**Observed.** First launch died immediately: `error: invalid argument: --no-mmap`.
Build b11026 replaced that flag with `--load-mode {auto|none|mmap|mlock|dio}`. With
`--load-mode none`: ready in 25 s, `n_ctx = 4096`, `n_threads = 4`, generated a `## Goal`
document, 277 completion tokens, 375 % CPU (= 3.75 of 16 cores ≈ 23 %).

**Conclusion.** The worker argv is valid on this build only with `--load-mode none`.
`slm-server.ts` was changed accordingly; the plan's `--no-mmap` is not available here.

---

## 2026-10-17 — First full pipeline at the main model's window (262144)

**Setup.** `Settings.isolated({})` defaults; `/models-worker` handler driven directly;
one handoff run over a two-message transcript; `window = 262144`.

**Observed.** Load 6 s. Worker argv carried `--ctx-size 262144 --cpu-mask 0x303`
(CPUs 0,1,8,9 = two physical cores' siblings), `--threads 4`, RSS **12 509 MB**.
Handoff written in 18 s: `inputTokens 491`, `outputTokens 184`, `durationMs 17088`
(≈ 10.8 tok/s), both requirement lines preserved, RAM and disk copies byte-identical.
`/models-worker status` reported pid/port/budgets; `unload` stopped it.

**Conclusion.** End-to-end works, but a full-window worker copy costs 12.5 GB to read a
transcript of a few thousand tokens. This is what motivated the 16K default cap.

---

## 2026-10-17 — Qwen2.5-0.5B vs SmolLM3-3B, 8K window (threshold measured against the harness baseline — see the 2026-10-17 baseline entry)

**Setup.** Harness profile exposing `qwen3.8-27b` with `contextWindow: 8192`,
`maxTokens: 2048`; `compaction.methodOrder: [slm]`, `thresholdPercent: 25`,
`keepRecentTokens: 200`; worker = Qwen2.5-0.5B-Instruct Q4_K_M (491 400 032 B), then
SmolLM3-3B Q4_K_M. Same prompt: `MUST use port 8451 … NEVER touch 8080` + ~200 words.

**Observed.**

| Worker | budget | in | out | wall | tok/s |
|---|---|---|---|---|---|
| Qwen2.5-0.5B | 0 | 802 | 139 | 3.44 s | **40.4** |
| Qwen2.5-0.5B (2nd pass) | 0 | 590 | 139 | 3.25 s | 42.8 |
| SmolLM3-3B | 4096 | 777 | 388 | 38.13 s | **10.2** |
| main model, for scale | off | — | 493/497 | 13.8/13.7 s | 36 |

Both committed `method: "slm"` with the block. Qwen obeyed the heading spec on the
clean 200-word turn but degenerated into a repeat loop (`truncated: true`) on a
2500-word turn. SmolLM kept both requirements but invented sections
(`## New information`, `## Additional context`) and hallucinated progress.

**Conclusion.** A 0.5B class model is mechanically compatible and ~4× faster, but it
cannot hold requirement fidelity on long inputs; keep SmolLM3-3B as the default and
treat smaller workers as an experiment. **Caveat added later:** the 25 % threshold was
crossing on harness context, so this run did not exercise a saturated conversation.

---

## 2026-10-17 — `soft` compaction carries the deterministic block (no worker)

**Setup.** `methodOrder: [soft]`, `thresholdPercent: 25`, window 8192, no SLM in the
order (coordinator gate closed).

**Observed.** `method=soft before=2422 after=2536 chars=1084 hasBlock=true`; the summary
ended with `## User messages (verbatim; authoritative)` and the operator's exact text.
No CPU worker process existed during the run.

**Conclusion.** The fidelity guarantee no longer requires a worker: plain LLM compaction
on a CPU-starved box gets the same deterministic block.

---

## 2026-10-17 — New worker defaults (16K cap, 1024 thinking)

**Setup.** Window 163 840 (a second profile), `thresholdTokens: 1500`, defaults only for
`compaction.slmHandoff.{maxContextTokens,reasoningBudgetTokens}`.

**Observed.** `ctx=16384 budget=1024`; argv confirmed `--ctx-size 16384
--reasoning-budget 1024`; RSS **2 788 MB** (vs 12 509 MB at 262144). Worker run
42.6 s for 407 output tokens = 9.6 tok/s — **no faster than the 4096-budget run**
(38.1 s, 10.2 tok/s).

**Conclusion.** The 16K cap is a real RAM win (12.5 GB → 2.8 GB). The thinking budget is a
runaway guard, **not** a speed lever: the 3B self-limits to ≈400 tokens regardless.
Speed levers on this box are thread count and worker size only.

---

## 2026-10-17 — `/models-worker` ordering and unload round trip

**Setup.** `Settings.isolated({})` with `methodOrder` written through `set` (not an
override layer, which shadows writes), handler driven directly; worker preloaded and
unloaded.

**Observed.** First implementation left `["slm"]` unchanged — the guard
`!order.includes("slm") || order.indexOf("slm") !== 0` short-circuits on a slm-only
order, exactly the case the fallback exists for. After the fix:
`["slm"]` → load → `["slm","handoff"]` → unload → defaults.

**Conclusion.** Fallback is now a pure function (`withSlmFirst`) with tests, and `unload`
undoes the injected `handoff` instead of leaving a lone method the user never chose.

---

## 2026-10-17 — Harness baseline measurement (corrects the 8K entries)

**Setup.** Same profile and flags as the 8K runs, `compaction.enabled: false`,
prompt `Reply with exactly: ok` (22 characters).

**Observed.** `prompt_tokens = 1948` (input 62 + cacheRead 1886), `output 16`.

**Conclusion.** The harness itself spends **1 948 tokens — 24 % of an 8192 window** —
before any conversation. Every 8K run with `thresholdPercent: 25` (2 048) was therefore
compacting the system prompt, not a saturated conversation. From here on, thresholds for
8K experiments are expressed in absolute tokens above the baseline.

---

## 2026-10-17 — Corrected threshold, chained turns, instruction echo

**Setup.** Window 8192, `thresholdTokens: 2600`, `keepRecentTokens: 200`, SmolLM3
(budget 1024, cap default), two short turns: requirement + precedence, then syntax-error
recovery. Session 1 of the corrected series.

**Observed.** First turn's handoff carried the SLM's **own system-prompt rules** into
`## Constraints & preferences` ("Preserve every hard requirement …", "Address the
successor in the imperative …", "Keep the whole document under 2048 tokens") — the rule
list is chained into the document. Also invented `Listed project files for memory
convention` under `Done` (no tools were enabled, no such listing occurred). A 2500-word
turn hit `maxTokens`, produced `stopReason: length`, and the harness re-prompted; each
retry moved the live leaf so the handoff never covered it and compaction deferred.

**Conclusion.** Added two rules to `slm-handoff.md`: never copy the instruction list or
section list into the document; every `Progress` line must come from the transcript.
Re-verified in the next entry: no echo.

---

## 2026-10-17 — One-shot sessions abort the per-turn handoff

**Setup.** Same profile, two turns with `--thinking low` so both ended `stop` (no
retries), `thresholdTokens: 2600`.

**Observed.** Both turns finished in 18 s; no handoff file and no compaction. The
per-turn run is fire-and-forget; print mode exits, `dispose()` aborts the drain and
releases the server before the 3B finishes. In the earlier longer runs the handoff
finished only because `length` retries kept the process alive for minutes.

**Conclusion.** A one-shot `omp -p` session does not produce a warm handoff; only the
compaction path (which awaits up to `awaitMs`) guarantees a completed chain. Interactive
and autonomous sessions get the per-turn chain. Also observed: a SIGKILLed harness leaves
the worker resident — the `process.once("exit")` hook does not fire.

---

## 2026-10-17 — Clean chained run: summary-only re-distill and turn counter fixed

**Setup.** Same as above with `thresholdTokens: 2300` so compaction fires and awaits the
handoff. Two short turns, `--thinking low`.

**Observed before the fix.** After the compaction rewrite, the coordinator ran **again**
on the post-compaction batch — the agent-attributed summary message has
`role: "user"`, so it passed the "batch contains a user turn" gate — and rewrote the good
document from our own summary: 30.6 s wasted, `coveredUserTurns` reported 3 for two
operator turns.

**Observed after the fix.**

```
method=slm  before=4099  after=4399  worker 816 in / 229 out / 23.4 s (9.8 tok/s)
coveredUserTurns=2  hasBlock=true  ctxSize=8192  budget=1024
handoff written 23:02:01.699  →  compaction committed 23:02:01.702
```

Exactly one write per operator turn, none after the commit; the commit consumed the
record 3 ms after it was written; the leaf was turn 2's assistant.

**Conclusion.** `isOperatorTurn()` now gates `schedule()` and `prepareForCompaction`, and a
covered-leaf shortcut marks the live leaf covered without a model run. Remaining gap in
this run: the 3B **did not fold turn 2 into the document** (`## Next steps` still named
the precedence task, no recovery content) and still invented a `Done` line — a model
fidelity failure, covered by the deterministic block, not by the plumbing.

---

---

## 2026-10-17 — Dispose wait and region-derived refresh (fixes 1 and 2)

**Setup.** `dispose()` now waits up to 5 s for an in-flight run before aborting.
`prepareForCompaction({ region })` receives `messagesToSummarize + turnPrefixMessages`; when the
warm record does not cover the live leaf, it enqueues the **region** instead of the delta.

**Observed.** Types and the compaction suite stay green (`406 pass / 417`). The one-shot
abort case is now bounded: an exited session leaves the document that its last run had
already produced, instead of nothing. The region path replaces the delta only when a run
is genuinely needed — the fast path (record covers the leaf) is unchanged, so this does
not fix the chain4-class defect where a *covering* run still dropped turn 2; that is fix 3
(delta protocol) territory.

**Conclusion.** "Wait when needed" now waits for something worth waiting for. No model
change is implied, and the region is bounded by the same chunking (`maxInputTokens`) as
the per-turn path.

---

## 2026-10-17 — Worker on the RTX 3070 (`cuda:1`)

**Setup.** `Settings.isolated` with `compaction.slmHandoff.device: "cuda:1"`,
`modelPath: SmolLM3-Q4_K_M.gguf`, `maxContextTokens: 8192`, budget 0. Probe preloads,
prints argv/env, completes one handoff, unloads.

**Observed.**

```
resolved: {"device":{"kind":"cuda","index":1},"gpuLayers":999,"ctx":8192}
argv_ngl: 999
env: CUDA_VISIBLE_DEVICES=1 | CUDA_DEVICE_ORDER=PCI_BUS_ID
gpus: 0, Tesla V100-SXM2-32GB, 10 MiB       ← untouched
      1, NVIDIA GeForce RTX 3070, 7034 MiB  ← worker resident
completion: 1962 chars, 432 tokens     running after unload: false
```

**Conclusion.** Device selection works without touching the inference card or the router.
A 3B Q4 at 8K KV occupies ~7.0 GB of the 3070's 8 GB (CUDA context + weights + KV), so a
4B model needs either a partial `gpuLayers` count or a reduced window; `Spark-X2.5-4B` is
not in `~/models` and was not part of this run — the option is model-agnostic.

---

## 2026-10-17 — Spark-X2.5-4B Q4_0 on the 3070 with a VRAM headroom cap

**Setup.** `abenzerps/Spark-X2.5-4B-GGUF`, `Spark-X2.5-4B-Q4_0.gguf` (2 405 581 632 B) +
its separate `chat_template.jinja`; `device: cuda:1`, `gpuFreeMiB: 2048`,
`maxContextTokens: 8192`, budget 0. The spawn now emits
`--n-gpu-layers auto --fit on --fit-target 2048 --fit-ctx 8192`.

**Observed.**

```
argv_ngl: auto | fit: on | fit-target: 2048
gpus before: 0 Tesla V100 10 MiB | 1 RTX 3070 4637 MiB   (desktop already resident)
gpus loaded: 0 Tesla V100 10 MiB | 1 RTX 3070 5814 MiB   (+1177 MiB for the worker)
completion: 167 chars, 51 tokens      running after unload: false
```

The GGUF embeds its chat template (no `--chat-template-file` needed). Its template defaults
`enable_thinking` to true; our request sets it from the thinking budget, so budget 0
disables it. Output came back inside Spark's own `<handoff>` wrapper with a `## Handoff`
heading, which `normalizeSlmOutput` accepts.

**Conclusion.** Smallest published quant (Q4_0, 2.41 GB) plus `--fit-target 2048` keeps the
gaming card intact: the worker cost 1.2 GB and left ~2 GB free, spilling the rest to CPU.
No Q3/Q2 exists upstream, so anything smaller means self-quantizing the BF16 source.

---

## 2026-10-17 — Spark-X2.5-4B as the worker, end to end through the harness

**Setup.** Main model `local-llama/qwen3.8-27b` at an 8192 window (baseline 1 948);
`methodOrder: [slm]`, `thresholdTokens: 2300`, `keepRecentTokens: 200`; worker
`Spark-X2.5-4B-Q4_0.gguf` (2.41 GB), `device: cuda:1`, `gpuFreeMiB: 2048`,
`maxContextTokens: 8192`, budget 0. One turn: the port requirement plus a 120-word answer.

**Observed.**

```
worker argv: --ctx-size 8192 --n-gpu-layers auto --fit on --fit-target 2048 --fit-ctx 8192
VRAM during run: V100 23 906 MiB (main model) | 3070 5 809 MiB (worker, +1 177 over desktop)
method=slm  before=4317  after=4632  dur=25616ms  out=298  block=true
handoff writes: 1 (19:29:29) — no duplicate region run
```

Spark's document classified both requirements correctly and repeated them verbatim under
`## Hard requirements`; Progress was accurate; Next steps stayed imperative. The committed
summary carried the deterministic block with the exact user text.

**Two defects this run found, both fixed:**

1. A region-derived run stops at the summarized boundary, so the strict
   `coveredLeafKey === liveKey` check rejected a good document and compaction aborted with
   no fallback (`methodOrder: [slm]`). Replaced by `coversOperatorTurns()`: the document must
   cover every *operator turn*; trailing assistant/harness messages may follow it.
2. With thinking 0 the scheduled per-turn run finished in 26 s, but with the default 1024 it
   took 118 s — long enough that `prepareForCompaction` read a still-empty record and
   enqueued the region on top of the in-flight run, paying twice (observed: two writes,
   19:24 and 19:26, both ~118 s). Now guarded: a scheduled drain already targeting the live
   leaf suppresses the region enqueue.

**Conclusion.** Spark is a viable worker on a shared gaming card: 2.41 GB weights, +1.2 GB
VRAM with the cap, 25.6 s per handoff at budget 0 (11.6 tok/s at budget 1024). Requirement
fidelity was better than SmolLM3's on the same prompt.

**Correction to an earlier entry.** The "invented" `ls -la /tmp/…` line seen in this run's
first attempt was **not** a worker hallucination: the main model (Qwen3.8-27B) emitted a
tool-call XML block *as assistant text* despite `--no-tools`, the harness rendered it into
the transcript, and Spark summarized it faithfully. The same main-model artifact explains
SmolLM's earlier "Listed project files …" line. Attribution below updated.

---

## 2026-10-17 — File actions and "what just happened" in the summary

**Setup.** Main model at an 8192 window with `--tools write,read` (baseline grows with the
tool docs); `methodOrder: [slm]`, `thresholdTokens: 2300`; worker Spark-X2.5-4B Q4_0 on
`cuda:1`, `gpuFreeMiB: 2048`, budget 0. Prompt: the port requirement plus "use the write tool
to create notes.md with exactly one line".

**Observed.** The turn ended `stop=toolUse` and `notes.md` exists (17 bytes). Compaction
committed `method=slm before=3533` with both new sections:

```
## What just happened
- Learned: The test server MUST use port 8451; port 8080 is strictly off-limits …
- Implemented: `/tmp/sparktest/work/notes.md` was written with content `SLM handoff test` (17 bytes).
- Files: `/tmp/sparktest/work/notes.md`

## Recent file actions
- write `/tmp/sparktest/work/notes.md`

## User messages (verbatim; authoritative)
### User message 1
MUST use port 8451 … Use the write tool to create notes.md …
```

The byte count and the path both match the filesystem, and the deterministic block agrees
with the model's prose — the first run where file claims are checkable against a real action.

**Conclusion.** `## Recent file actions` is harness-extracted (tool calls → paths/commands,
newest 24, repeats collapsed) and `## What just happened` is model prose constrained to the
action log. Unit tests cover extraction (edit/write/read/grep/bash/unknown, dedupe, cap) and
an integration test asserts the block lands in a `soft` commit when the tool call sits inside
the summarized region. A tool call in the *kept* tail is deliberately not recorded — it is
not being discarded.

---

## 2026-10-17 — Detailed prose register (paths, commands, reasons)

**Setup.** Same 8192-window profile and Spark Q4_0 on `cuda:1` (`gpuFreeMiB 2048`, budget 0),
`compaction.slmHandoff.detail: detailed`, one turn that writes `config.json` with the write
tool and reads it back.

**Observed.**

```
method=slm  summary 2115 chars  worker out 546 tokens  dur 50 921 ms
previous (default register, same shape of turn): 1523 chars, 298 tokens, 25 616 ms
```

The document reads as explanatory prose rather than fragments: it names the exact file, the
tool used, the read-back verification, and why the on-disk file is the durable record —
and its claims match the harness-extracted `## Recent file actions`
(`write` + `read` of `/tmp/sparktest/work/config.json`).

**Conclusion.** Detail is a setting, not a prompt fork: one template carries three
registers (`concise` / `standard` / `detailed`) and exactly one branch renders. A unit test
asserts the registers are mutually exclusive and that `detailed` asks for paths, commands,
and reasons. Cost of the verbose register on this box: ~40 % more summary text, ~2× worker
output, ~2× wall time — still off the critical path, still bounded by `maxHandoffTokens`.

---

## 2026-10-17 — The 3070 is not slow; the VRAM cap was (correcting table B)

**Setup.** Spark-X2.5-4B Q4_0 on `cuda:1`, ctx 8192, budget 0, loaded through the manager.
Two variants of the same worker: `gpuFreeMiB: 2048` (the earlier row) and `gpuFreeMiB: 512`.
Two requests each; the second is the steady-state measurement (the first builds CUDA graphs).

**Observed.**

```
gpuFreeMiB 2048: 3070 4 637 -> 5 814 MiB (+1 177)   GPU util 2-6 %   worker CPU ~400 %   11.6 tok/s
gpuFreeMiB  512: 3070 4 652 -> 7 324 MiB (+2 672)   GPU util 50 %                     63.2 / 63.7 tok/s
```

The earlier 11.6 tok/s figure was not the card's speed — `--fit-target 2048` on a desktop
already holding 4.6 GB of an 8 GB card left llama.cpp ~1.2 GB, so it spilled most layers to
CPU (hence 400 % CPU and 2–6 % GPU). With 512 the whole model is resident and the same
worker is **5.4× faster**.

**Conclusion.** `gpuFreeMiB` is a throughput/headroom trade, not a device property. Default
lowered 2048 → 1024; 512–1024 for throughput, 2048+ when a game needs the card. README tables
now carry the headroom column so a capped row can never be read as the card's ceiling.

---

## 2026-10-18 — The headroom curve, and why the table lied (correcting the 3070 numbers)

**Setup.** Spark-X2.5-4B Q4_0, `cuda:1`, ctx 8192, budget 0, loaded through the manager.
Card idle at ~1 968 MiB of desktop, Laya **not** running. For each `gpuFreeMiB` value: load,
warm request, then measure the second request.

**Observed.**

| `gpuFreeMiB` | 3070 used | GPU layers | tok/s |
|---|---|---|---|
| `-1` | 4 658 MiB | all | 94.9 |
| `2048` | 4 658 MiB | all | **95.9** |
| `4096` | 3 744 MiB | partial | 21.0 |
| `5120` | 2 720 MiB | ~25 % | 11.6 |

**Correction.** The `11.6 tok/s` rows published earlier were measured while **Laya held
2.8 GB** of the card *and* the reservation was 2048 — leaving ~1.2 GB, so llama.cpp spilled
most layers to the CPU (GPU util 2–6 %, worker CPU ~400 %). The card does **95.9 tok/s** on
the same worker with an idle card at the same reservation. The earlier `63.2 tok/s` figure
was also contaminated: Laya was resident, so the model fit but contended for bandwidth —
co-residency costs ~34 % even with no spill.

**Conclusion.** `gpuFreeMiB` is a reservation, and it must leave ≈3.2 GB usable or the
worker stops being a GPU worker. Docs and the README now show the curve instead of a single
number, and the historic rows carry the crowded-card condition inline. Default stays 1024;
2048 is right on an idle 8 GB card.

---

## 2026-10-18 — The speed floor still counted prefill: providers that report no ttft

**Setup.** Live rabid session, Qwen3.8-27B local, context 29K/40K. Status bar showed
19.4 tok/s while the model answered normally; the speed floor (20) tripped after three turns
and auto-shake ran, then handoff.

**Observed.** `seed()` subtracted `assistant.ttft`, but only some providers populate that
field (cursor, gemini, azure); the llama.cpp path does not. With `ttft` undefined the meter
fell back to the whole request duration — prefill included — so a 29K prompt plus a few
hundred output tokens reads ~19 tok/s while decode is ~40.

**Fix.** The meter now measures prefill itself: `begin()` records the message start,
`push()` records the first visible delta, and `end()` stores the difference. `seed()` uses the
provider's ttft when present and the measured value otherwise. Two tests: a provider with no
ttft yields the decode rate (100 tok/s for 200 tokens in 2 s), and a reported ttft still wins.

**Conclusion.** The floor now measures what its name says. With this session's numbers the
context threshold (40K) is what should fire first; the floor should trip only where decode
actually decays — the ~88K the user expected, not 29K.

---

## 2026-10-18 — A 22K request against a 16K context: the chunk estimate was optimistic

**Setup.** Live rabid session at 54K/88K, mid-run compaction. The worker started
(`ctxSize 16384`) and immediately failed.

**Observed.**

```
SLM handoff run failed   Error: SLM worker HTTP 400: request (22141 tokens) exceeds the context
Background SLM handoff unavailable; trying next preferred compaction method   reason=threshold
```

The region was split with a 4-chars-per-token assumption; this transcript is code- and
JSON-dense (~2.5 chars/token), so a chunk sized at 13 824 estimated tokens went out as
22 141 real tokens and the server rejected it — and the whole compaction fell back to the
main model. Two workers were also resident on the 3070 at the time (one left over from the
manager panel), so both ran partially offloaded.

**Fix.**

- Chunk splitting now uses a conservative 2.5 chars/token (`CHUNK_CHARS_PER_TOKEN`), and the
  batch runs from a queue: on a context-overflow rejection the chunk is halved and both halves
  are retried with their own rendered prompt. The server's rejection is the authority; the
  estimate is only a hint.
- `maxContextTokens` raised to 32768 for 88K targets (one run needs prompt ≈16K + output
  budget, and the card holds a 4B Q4 + 32K KV with room to spare once only one worker runs).
- The stale manager worker was unloaded; the harness owns the worker.

**Conclusion.** This is why "it's taking a while": the fallback ran the 27B over the region.
With the queue and the larger context, the same compaction should stay on the worker.

---

## 2026-10-18 — Handoff was slow because a second worker stole the card

**Setup.** Live session at 87K/88K. `Auto-handoff` ran for minutes; the log had no SLM
failure, only `SLM handoff worker ready ctxSize 32768`.

**Observed.** Two workers on the 3070: the session's (pid 3137281, ppid = the session,
ctx 32768) and a manager-owned one (pid 3135168, ppid = manager.py, ctx 8192). Both fitted
into 8 GB only partially, so the session's region run crawled and `prepareForCompaction`
expired inside `awaitMs`, and the chain fell back to `handoff`.

**Fix.** The server now discovers a running `--alias slm-worker` process (`/proc` scan),
health-checks it, and **adopts** it when the model matches — even without `workerUrl`, and
even if its context is smaller (logged as a warning). Adoption never signals the process.
Verified live: adopted port 37921, no third worker spawned, `unload()` left it running.

**Conclusion.** "Load" in the manager panel during a session is now harmless to the session
(it adopts that worker) but its smaller context splits runs more. For full speed, let the
session own the card: unload the panel's worker and restart.

---

## 2026-10-18 — A single oversized message could still overflow a run

**Setup.** Review of the chunker after the 22 141-token rejection.

**Observed.** `chunkByRenderedLength` splits *between* messages, and the split-on-overflow
retry halves the message list. A single message that renders larger than one run's budget —
an assistant turn with dozens of tool calls, or a tool result the renderer could not shorten
below its own limit — becomes a one-message chunk that cannot be split, so the worker would
reject it and compaction would fall back again. Each rendered part is already capped at
1 500 chars, so this is a many-parts-per-message case, not a giant paste.

**Fix.** The transcript for a run is middle-clipped to the run budget: 60 % head, 40 % tail,
with `… [N chars omitted] …` where it cuts. Head keeps the task statement, tail keeps the
latest state. The worker therefore always receives a prompt that fits, and the split-retry
stays for multi-message chunks. Unit test: a 5 000-char transcript clipped to 1 000 keeps
both ends, reports the omission, and never exceeds the limit.

**Conclusion.** Two independent guarantees now: chunks fit by construction (middle clip), and
if the estimate still undershoots, the server's own rejection halves the chunk.

---

## 2026-10-18 — A killed worker cost the whole compaction (ECONNRESET)

**Setup.** Live session at 88 257 tokens; mid-run compaction started while the worker (ctx
32768) was up. The worker was then killed by hand while clearing a duplicate.

**Observed.**

```
21:49:43 SLM handoff worker ready            port 36155 ctxSize 32768
21:53:18 SLM handoff run failed              ECONNRESET: socket closed unexpectedly
21:53:18 Background SLM handoff unavailable; trying next preferred compaction method
21:53:18 Mid-run compaction ran between provider calls   contextTokens 88257
```

The compaction then ran on the 27B, and the session had no compaction entry yet — mid-run
compaction is staged and applied at the turn boundary, so the bar still read 80K while the
turn continued.

**Fix.** A worker call is retried once on a connection-level failure (ECONNRESET,
ECONNREFUSED, socket, fetch failed). Runs are stateless, so the retry is safe, and `ensure()`
respawns a dead process before the second attempt. Aborts and non-network errors still fail
immediately.

**Conclusion.** Killing a worker no longer fails a compaction; it costs one retry and a
respawn.

---

## 2026-10-18 — One turn can be 88K, so the worker reads a scratchpad

**Setup.** Per-thought, per-read, per-conclusion scratchpad, with the SLM reading that instead
of the raw turn.

**Observed (measured on the live session).**

```
messages 316 | raw content 355 691 chars ≈ 142 276 tokens
scratchpad 64 965 chars ≈ 25 986 tokens, 504 lines
bounded to 40 856 chars ≈ 16 342 tokens at a 16K input budget
```

One bounded line per event — `THOUGHT` 240, `CALL read(path:range)`, `CALL name(args)` 160,
`RESULT` 200, `CONCLUSION` 320, `USER` 600 — produced by clipping and extraction, never by a
model call. `boundScratchpad` keeps the newest lines that fit and marks how many were dropped.

**Conclusion.** Input size is independent of turn size: a 4-message turn and a 316-message one
produce the same bounded prompt, which is what keeps an 88K compaction on the worker. Chunking
and the middle-clip remain as guards, but no longer carry the load.

---

## 2026-10-18 — The prompt now asks for selection, not preservation

**Observed.** With the scratchpad in place the worker's job changed, but the prompt still said
"preserve every path", "carry forward all prior content" and "name every file touched" — an
instruction to transcribe. That fights both the compressed input and the deterministic blocks,
which already keep the exhaustive record.

**Change.** The system prompt now states the successor goal, the keep set (objective, decisions
with reasons, binding constraints, verified facts with commands, next step, files that matter)
and the drop set (reads that changed nothing, repeated output, abandoned approaches, superseded
items, irrelevant paths). Quoting stays exact; omission is explicitly allowed and paraphrase is
not. Progress is "what a successor would otherwise redo or miss", not every action.

**Conclusion.** The three layers now have distinct jobs: harness records exactly (requirements,
file actions), the pad compresses events, the model selects. No layer duplicates another.

## Defect attribution (rolling)

Which side owns each defect the runs above found. Update when a new one appears.

| Defect | Owner | Status |
|---|---|---|
| Requirement dropped / softened on long input (0.5B) | model | by design; covered by the deterministic block |
| Newest turn not folded into the document; stale `Next steps` (3B) | model | open; the block still carries the operator's words |
| Invented `Done` lines ("Listed project files …", "Executing `ls -la …`") | main model artifact, faithfully summarized | closed: the *main* model emitted tool-call XML as text under `--no-tools`; the prompt rule now also forbids restating non-transcript commands |
| Repeat loops, duplicated headings, empty `## Goal` | model | mitigated by model choice (3B over 0.5B) |
| Instruction list copied into `## Constraints & preferences` | model + prompt design | fixed: explicit prohibition in `slm-handoff.md`, re-verified |
| `--no-mmap` rejected by b11026 | harness | fixed: `--load-mode none` |
| 1 GB model-size floor refused a 0.5B GGUF | harness | fixed: 1 MiB floor |
| Missing custom model would download SmolLM3 over it | harness | fixed: clear error with the `hf` command |
| `slm`-only method order got no fallback | harness | fixed: `withSlmFirst`, tested |
| `unload` left the injected `handoff` behind | harness | fixed: restores defaults |
| Post-compaction run re-distilled our own summary | harness | fixed: `isOperatorTurn` gate + covered-leaf shortcut |
| `coveredUserTurns` counted the agent-attributed summary | harness | fixed: counts operator turns only |
| One-shot `omp -p` aborts the per-turn handoff | rabid/design | known; only the compaction path awaits |
| SIGKILLed harness leaks the worker | rabid/design | known; `unload`/SIGINT are clean |

Reading: **fidelity** failures are the model's, and the design assumes them — the
deterministic block, not the worker, is what makes a commit safe. **Waste, metadata, and
lost work** are the harness's: those are bugs, and each one above now has a fix or a test.

## Template for the next entry

```md
## <YYYY-MM-DD> — <short title>

**Setup.** <profile/window, threshold, worker model + quant, ctx cap, thinking budget, prompts>

**Observed.** <numbers: tokensBefore/After, worker in/out/wallMs/tok/s, RSS, commit + handoff timestamps, escape hatches hit>

**Conclusion.** <what it proves, what it invalidates, what changed as a result>
```
