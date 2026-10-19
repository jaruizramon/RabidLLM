# Compaction and Branch Summaries

Compaction and branch summaries are the two mechanisms that keep long sessions usable without losing prior work context.

- **Compaction** rewrites old history into a summary on the current branch.
- **Branch summary** captures abandoned branch context during `/tree` navigation.

Both are persisted as session entries and converted back into user-context messages when rebuilding LLM input.

## Key implementation files

- `packages/agent/src/compaction/compaction.ts` (context-full summarization and handoff generation)
- `packages/snapcompact/src/snapcompact.ts` (snapcompact strategy: history archived as dense bitmap images)
- `packages/agent/src/compaction/branch-summarization.ts`
- `packages/agent/src/compaction/pruning.ts`
- `packages/agent/src/compaction/compaction-v2-streaming.ts` (provider-native streaming compaction)
- `packages/agent/src/compaction/shake.ts` (mechanical content elision)
- `packages/agent/src/compaction/utils.ts`
- `packages/agent/src/compaction/openai.ts`
- `packages/agent/src/compaction/messages.ts` (shared LLM conversion and summary wrappers)
- `packages/coding-agent/src/session/session-context.ts` (context and transcript assembly)
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/session-maintenance.ts` (automatic maintenance orchestration)
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/extensibility/hooks/types.ts`
- `packages/coding-agent/src/session/context-settings.ts` (`compaction.*`, `snapcompact.*`, `branchSummary.*` definitions)

## Session entry model

Compaction and branch summaries are first-class session entries, not plain assistant/user messages.

- `CompactionEntry`
   - `type: "compaction"`
   - `summary`, optional `shortSummary`
   - `firstKeptEntryId` (compaction boundary)
   - `tokensBefore`
   - optional `details`, `preserveData`, `fromExtension`
   - optional `method`, `tokensAfter`, `warning` (maintenance/display metadata)
   - optional `providerReplayThroughEntryId` (last entry covered by a native replay snapshot)
- `BranchSummaryEntry`
   - `type: "branch_summary"`
   - `fromId`, `summary`
   - optional `details`, `fromExtension`

When context is rebuilt (`buildSessionContext`):

1. Latest compaction on the active path is converted to one `compactionSummary` message.
2. Kept entries from `firstKeptEntryId` to the compaction point are re-included.
3. Later entries on the path are appended.
4. `branch_summary` entries are converted to `branchSummary` messages.
5. `custom_message` entries are converted to `custom` messages.

Those custom roles are then transformed into LLM-facing messages in `convertToLlm()`: `compactionSummary` and `branchSummary` become user messages rendered through the static templates

- `packages/agent/src/compaction/prompts/compaction-summary-context.md`
- `packages/agent/src/compaction/prompts/branch-summary-context.md`
- `packages/agent/src/compaction/prompts/handoff-summary-context.md` (when `method === "handoff"`)

Snapcompact summaries with ordered archive blocks bypass these wrappers and send the lead-in plus archive blocks directly. `custom` messages normally pass through as developer messages with their raw content (no summary template).

Native replay also requires a matching provider and a Responses-family API on the active model. A separate native compaction endpoint does not give a Chat Completions or Anthropic encoder the ability to consume its output.

Disabling future native compaction does not disable normal replay of an existing payload. Compaction preparation has a separate, stricter reuse policy: local summarization must re-expand the original messages rather than treat an opaque placeholder as a readable summary.

## Compaction pipeline

### Triggers

Compaction/context maintenance can run in six ways:

1. **Manual context compaction**: `/compact [instructions]` calls `AgentSession.compact(...)`.
2. **Automatic overflow recovery**: after a same-model assistant error that matches context overflow.
3. **Automatic incomplete-output recovery**: after a same-model assistant message ends with `stopReason === "length"` (including OpenAI/Codex `response.incomplete` and Anthropic output/context limits), subject to the output-cap checks below.
4. **Automatic threshold maintenance**: after a successful turn when context exceeds the resolved threshold.
5. **Mid-turn threshold maintenance**: before the next provider request when a tool-loop turn crosses the threshold and `compaction.midTurnEnabled !== false`. Subagent sessions always run this check: `createSubagentSettings` pins `compaction.midTurnEnabled` on for the child because a whole assignment is one turn, so post-turn maintenance would only fire after the run already ended.
6. **Idle maintenance**: `runIdleCompaction()` can invoke the same auto-maintenance path with reason `"idle"`.

### Compaction shape (visual)

```text
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9      10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

### Archive progress panel

While automatic maintenance (or a manual `/compact` / `/shake`) runs, a two-row panel sits above the status bar. It
reads the session's compaction ledger (`AgentSession.getCompactionRummage`), not logs:

```text
 ⠼ rummaging ramdisk · shake · 75% → …
   412 entries · 37 regions · 18K tok · 2.1MB · /dev/shm/… · 1.3s

 ✔ archive · handoff · 75% → 21% (−54 pts)
   143K tok reclaimed · ~/.omp/sessions/artifacts/8.shake.log · 3.2s
```

- The headline row carries the state (phase or outcome), the method, and the context percentage: `before% → …`
  while running, `before% → after% (−N pts)` when finished.
- The detail row carries the offload numbers: entries scanned, eligible regions, offloaded tokens/bytes (live), or
  tokens reclaimed, the recovery-artifact path, and elapsed time (finished).
- `shake` reports the entries it scanned, eligible regions, offloaded tokens, artifact bytes and the recovery
  artifact path. The label is `ramdisk` when that path is under `/dev/shm`, `archive` otherwise.
- `handoff`/`context-full`/`snapcompact` report the summarizing/rewriting phase and the context percentage they
  started from.
- The finished panel fades after eight seconds. A skipped or failed pass says so instead of inventing a reduction.

The panel only observes the existing maintenance pass; it does not change compaction policy, method order, or the
content kept, so acceptance and answer quality are unaffected.

### Turn cards (episodic archive)

`turnCards.enabled` distills each completed prompt on the local SLM worker
(`compaction.slmHandoff`) into a card of at most `turnCards.maxTokens` (default 1024):

- one-sentence restatement of the prompt,
- the unique files touched,
- one entry per read/edit/write/bash/grep call with a pointer (line range, edit hunk, or command) and a
  `turnCards.summaryWords`-word summary, written in pidgin English (real words, primitive grammar: drop articles,
  copulas and filler; keep paths/identifiers verbatim) to buy density without losing the pointer.

Cards are written to `<agent dir>/turn-cards/<session>.jsonl` (machine), `<session>.md` (readable) and
`<session>.chain.md` (the cumulative chain compaction reads). They are archive/recall material only: the live
transcript is untouched, and nothing is injected into future prompts.

Cards are summarization, so they never fall back to the live model or a network provider: with no configured
worker the card is skipped, and the main inference card is never asked to distill it.

The distillation runs after `agent_end`, off the turn; failures are logged without affecting the answer. **A
cancelled turn is still carded** — its reads and edits happened — and the next prompt awaits the in-flight
distillation before it is admitted, so a prompt submitted right after `Esc` cannot overtake the card. Only a
provider error skips the card.

Point `omp-thoughts` (or any archiver) at `~/.rabid/agent/turn-cards/` to fold cards into the rig's thoughts
archive; the fork never writes the script-owned `THOUGHTS.md`.

#### Deterministic chain compaction

`compaction.turnCardChain: true` removes the summary model call: the handoff/soft preparation reads
`<session>.chain.md` (every card appended in turn order), tails it to an 8K-token budget, and uses it as the
compaction summary. If the 8K tail dropped older cards, the previous summary is prepended so older history is not lost. Coverage is checked first — the chain must hold at least as
many cards as the summarized user prompts, or a previous summary must exist; otherwise the LLM path runs. The
result is marked `details.turnCardChain = true`. `shake` still runs first; the chain only replaces the prose
summarizer, so compaction is deterministic whenever the cards cover the range.

### Speed-floor trigger

Token and percentage thresholds cannot see a model that has simply become slow at moderate context. Set:

```yaml
compaction:
  speedFloorTps: 20      # 0 disables
  speedConsecutive: 3    # completed assistant messages below the floor
  speedMinTokens: 20000  # smaller contexts are ignored: not a context problem
```

When the measured generation rate (the same decayed meter as the tok/s row) stays below the floor for the
configured streak and the live context is large enough, maintenance runs through the normal method order — shake
first, then the configured `compactionModel` for summaries. A cooldown equal to the streak follows a trigger, so the
post-compaction context gets a chance to show its new rate before firing again. Error, aborted, and `length` stops do
not participate; those keep their own recovery paths.

### Overflow/incomplete recovery vs threshold/idle maintenance

The automatic paths are intentionally different:

- **Overflow recovery**
   - Trigger: current-model assistant error is detected as context overflow and the error is not older than the latest compaction.
   - The failing assistant error message is removed from active agent state before retry.
   - Context promotion is tried first; if a configured larger model is available, the agent switches model and retries without compacting.
   - If promotion is unavailable and compaction is enabled, automatic maintenance walks `compaction.methodOrder` with `reason: "overflow"` and `willRetry: true`; handoff is skipped because its request would reuse the overflowing input.
   - On success, `agent.continue()` is scheduled to retry the turn.

- **Incomplete-output recovery**
   - Trigger: same-model assistant message ends with `stopReason === "length"` and the message is not older than the latest compaction.
   - When the window is below the compaction threshold and the turn delivered text or a tool call, the truncated turn is retained and an output-limit warning is shown; compaction cannot raise the output cap.
   - Otherwise the incomplete assistant is removed from active state, and context promotion is tried first.
   - With maintenance enabled, no-output turns below threshold retry without compaction; a reasoning-only output-cap stop also receives a developer reminder to act in smaller steps.
   - Above threshold (or with an unknown window), auto maintenance walks `compaction.methodOrder` with `reason: "incomplete"` and `willRetry: true`. Unlike overflow, a reachable `handoff` may run because the input remains usable.
   - Consecutive recoveries without text or a tool call are capped at three; new user input or actionable output resets the counter. The terminal cap blocks automatic continuation and reports an actionable failure.
   - Successful recovery schedules continuation.

- **Threshold maintenance**
   - Trigger: successful, non-error assistant message whose adjusted context tokens exceed `resolveThresholdTokens(...)`. The measured count comes from `calculateContextTokens(...)`, which subtracts provider-side orchestration tokens (billable, but never replayed into the conversation prefix) so auto-compaction and context-promotion thresholds are not inflated by them.
   - Mid-turn maintenance also checks safe tool-loop boundaries before the next provider request when `compaction.midTurnEnabled !== false`.
   - The initial trigger uses adjusted provider usage floored by the stored-conversation estimate; pruning does not retroactively reduce the just-billed prompt. Reclaimed tokens affect the subsequent maintenance target. Usage predating the latest compaction is ignored in favor of the live stored estimate.
   - Context promotion is tried before post-turn compaction.
   - If promotion is unavailable, auto maintenance walks `compaction.methodOrder` with `reason: "threshold"` and `willRetry: false`.
   - Every method, `handoff` included, runs inline: post-turn maintenance generates the handoff document and commits it as a compaction entry before the run's `agent_end` settles, so the settle's `willContinue`/`yielded` reflects whether a continuation was actually scheduled.
   - On success, if `compaction.autoContinue !== false`, post-turn maintenance schedules an agent-authored developer auto-continue prompt from `prompts/system/auto-continue.md`; mid-turn maintenance never schedules a separate continuation because the core loop already owns the next provider request.

- **Idle maintenance**
   - Trigger: `runIdleCompaction()` when not streaming or already compacting.
   - Uses `reason: "idle"` and does not auto-continue afterward.

### Payload-rejection guard

HTTP 413 / payload rejections are not automatically treated as token overflow. A known window with at least 10% locally estimated headroom and provider input usage within that window, or explicit image-limit evidence without usage-backed overflow, blocks automatic continuation and emits a payload-budget warning rather than promoting or compacting.

When provider usage proves token overflow, maintenance can still shrink context. Snapcompact is excluded for byte/media-shaped rejections unless usage proves a token overflow without explicit media-limit evidence. With an unknown window, maintenance may attempt a runnable overflow method; an unavailable or no-progress recovery blocks automatic continuation rather than resubmitting unchanged history.

### Experimental notes-backed context windows

Enable **Notes-backed context windows (experimental)** in `/settings`; the running session gains the tools immediately. The equivalent configuration is:

```yaml
compaction:
   experimentalContextManagement: true
```

This opt-in mode replaces automatic summary recompression with local context-window
boundaries. It also applies to `/compact` without an explicit mode or focus text.
Explicit compaction modes and focused instructions retain their existing behavior.

- `context_notes` reads the current notebook when `text` is omitted, replaces it
  when `text` is supplied, and clears it with `text: ""`.
- Notebook revisions are journal entries on the active branch. Only the latest
  visible revision is injected into model context, including after resume or fork.
  A context reset clears the visible notebook. Each replacement is limited to
  **16,384 UTF-8 bytes**; oversized writes fail without replacing the notes.
- `new_context` requests rollover at the next safe tool-loop boundary. Rollover
  retains complete recent tool-call/result units and the notebook without calling
  a summarization model. Near the automatic threshold, the model receives a
  once-per-window reminder to save its working state.
- `read` and `grep` can recover original messages and tool outputs through
  `history://current/full`. The text includes stable entry IDs and window
  boundaries. Shared selectors work, for example
  `history://current/full:1-200` and `history://current/full:raw:1-200`.
  Queries, fragments, trailing slashes, and additional path components are rejected.
- The full-history route is bound to the calling session's current branch. It
  never falls back to another registered agent or an on-disk session search.
  Existing `history://<id>` routes retain their concise transcript behavior.

Experimental rollover requires the effective tool set to contain `context_notes`,
`new_context`, `read`, and `grep`. Restricted sessions without all four retain
legacy maintenance. Disabling the setting restores legacy compaction and disables
the experimental tools and full-history route; existing notes remain in the journal
and provider context.

The default is `false`. This is an independent implementation of persistent notes
and searchable history, with the existing session journal as its only transcript
store.[^experimental-context-history]

[^experimental-context-history]:
    Earlier pruning or explicit destructive history
    operations cannot be undone by enabling the setting. Text history represents
    images as markers. Notebook quality and timely updates remain the model's
    responsibility; the mode does not automatically generate missing notes.

### Shake method

Including `shake` in `compaction.methodOrder` performs an inline, local reduction instead of calling a summarization model. It replaces eligible tool results and large fenced/XML blocks with recoverable `artifact://` references, using a protected recent-token window and minimum-savings threshold. Automatic shake emits the normal auto-compaction events with `action: "shake"`.

Threshold, incomplete-output, and overflow recovery advance to the next configured method when shake cannot reclaim enough context to get below the recovery band; this prevents repeated no-op shake loops. Idle shake does not use that fallback because the idle timer rechecks usage before running again. Manual `/shake` is a separate, more aggressive command that can target all eligible history.

### Snapcompact method

Including `snapcompact` in `compaction.methodOrder` replaces the LLM summarization call with a local, deterministic archival pass (`compact` from `@oh-my-pi/snapcompact`):

- The discarded history is serialized, whitespace-collapsed, and printed onto model-aware PNG frames (frame width fixed per shape; frame height hugs the rows actually printed) using bundled public-domain pixel fonts. The shape — and frame size — resolve from the **model id** when the model line was measured: Claude reads X.org `8x13` glyphs on an 11px advance (extra letter-spacing, black ink — `11on16-bw`; high-res lines — Opus 4.7+, Fable, Mythos — get 1932px frames under Anthropic's 4,784 visual-token cap, older lines stay at 1568px), Gemini reads `8x13` glyphs on a 22px pitch (extra leading, black ink — `8on22-bw` at 2048px, since Gemini 3.x bills a fixed 1,120-token budget per image at any pixel size), GPT/Codex read the same `8on22-bw` shape at 1568px (patch billing is area-proportional, so larger frames cannot improve chars per token), and Kimi/GLM read `8x13` glyphs on a 16px pitch (`8on16-bw` at 1568px — kimi's processor downscales past 1792px). A Claude routed through Vertex or OpenRouter keeps its Claude shape. Auto selection is also font-aware (`resolveShapeForText`): when the model-default font cannot safely render the transcript, or wide CJK glyphs dominate it and the `silver16-bw` grid can render it safely, auto switches to `silver16-bw`; forced variants are never overridden. Unmeasured models fall back to their wire API family (Anthropic-family/unknown → `11on16-bw`, Google → `8on22-bw`, OpenAI-compatible → `8on22-bw`); the per-frame token estimate follows the reading model's lineage, from its catalog `image-tokenization` rule (a Claude behind Vertex or OpenRouter is priced as Claude, and Opus/Sonnet/Haiku before 4.7 under the standard 1,568-token tier), falling back to the catalog rule for the wire API carrying the request when the lineage has none, computed for the resolved frame size. OpenAI-compatible wires also get the `detail: "original"` hint. The `snapcompact.shape` setting (default `auto`) forces one of the research-eval variants instead: square grids (`8x8r`/`8x8u`/`6x6u`/`5x8` × sentence-hue/black ink) or the per-model eval winners (`6x12-dim`, `8x13-bw`, `8on16-bw`, `8on22-bw`, `11on16-bw`, `silver16-bw` — the embedded Silver TrueType font on a 16px grid for CJK and other non-Latin text — and the two-column word-wrapped `doc-8on16-bw`/`-sent`/`-sent-dim`, where `dim` prints stopwords in gray). A forced variant keeps its geometry but is re-priced for the reading model's image billing. A host that downscales images before the model reads them (catalog `image-max-edge`; Cursor fits Claude and GPT images into 1024×1024) gets frames no wider than that edge, forced variants included. The same setting governs inline system-prompt/tool-result imaging (`snapcompact.systemPrompt`, `snapcompact.toolResults`).
- Serialization keeps the archive conversation-dense: tool results are truncated head+tail (default 2,000 chars at a 0.6 head ratio), tool-call argument values are capped per value (500) and per call (2,000), and tool output is printed in dim gray ink so conversation reads louder than tool noise. All budgets and the dimming are configurable via `SerializeOptions` (`toolResultMaxChars`, `toolArgMaxChars`, `toolCallMaxChars`, `truncateHeadRatio`, `dimToolResults`).
- The snapcompact archive persists under `CompactionEntry.preserveData.snapcompact` as bounded source text plus rendered frames. On each context rebuild it is reconstructed into ordered compaction blocks: plain text at the oldest edge, an imaged middle, then plain text at the newest edge. The entry's `summary` is just the short resume lead-in plus the usual file-operation list.
- Later compactions re-render from that bounded source text (`Archive.text`), not by carrying old PNGs forward blindly. `maxFrames` now defaults to `MAX_FRAMES_DEFAULT` (80) and acts only as an upper limit; when the imaged middle is large it foveates internally (HQ/LQ/HQ), while both chronological edges stay verbatim text.
- No model, API key, or network is involved, so snapcompact is also safe for overflow recovery. It requires a vision-capable current model (`model.input` includes `"image"`); otherwise automatic maintenance skips it and advances to the next configured method. Manual `/compact` honors the method order unless custom instructions are given (those imply a directed LLM summary).
- Rationale: the shape table comes from the snapcompact 200k-token evals in `packages/snapcompact`, where bitmap frames preserved QA recall at lower billed-token cost than raw text for vision-capable models.

The archive is sized from the room under the compaction trigger, not from the window. The plan gives the frames half of what the resolved threshold (the active model's `compaction.modelThresholds` entry applied) leaves after the system prompt, tools, kept recent turns (counted as the trigger counts them, without opaque reasoning replay signatures), the archive's text and, for a pre-prompt pass, the pending prompt, keeps the whole compacted context plus that prompt within 60% of the threshold, and never goes past what fits the window; it always allows at least one frame (a text-only archive when the discarded text fits the text edges), so when even that leaves no room it only logs a warning and renders one frame. Each frame is charged the shape's own price for the active model when the model's catalog `image-tokenization` rule is `verified` against provider billing, and otherwise that price or `FRAME_TOKEN_ESTIMATE` (5,024), whichever is higher. The 80-frame default, the deployment's catalog `image-count-budget`, and the frame payload budget (`frameDataBytesBudget`: half the deployment's catalog `inline-image-byte-budget`, 12 MB on the official Anthropic and Codex endpoints, else 3,000,000 bytes; sized from a per-shape frame estimate) cap the result whatever the room. Every context rebuild attaches the archive at the active model's frame payload budget, and every request drops the oldest archive frames past the request model's budget, so a model switch to a host with a smaller budget never sends the larger archive. 60% is a sizing target, not a guarantee: a render that lands above it or over the frame payload budget is re-rendered with the oldest frames dropped, at most twice, at the frame count estimated to fit both (`frames × budget / payload` for bytes), and a one-frame archive cannot shrink further. The result is then judged by the path that asked for it: a render still over the byte budget or the window is rejected/skipped rather than committed as an unusable prompt; a threshold pass whose result (plus its pending prompt) is above the 80% recovery band moves to the next configured method with a warning notice, or, when no later method other than `shake` can run, keeps that result with a warning notice as long as it still fits the window with the pending prompt; overflow and incomplete recovery retry the turn and need only the window fit, and manual `/compact` keeps only its reduction and window-fit checks.

### Background SLM handoff method

Including `slm` in `compaction.methodOrder` commits a handoff document that a CPU worker keeps current, so compaction sends nothing to the main model:

- **The loop.** `#runBatch` writes the turn's notes and then, when `contractEveryTurns` (default 1) is due, the contract for that turn — so the document is current when the next prompt starts and `prepareForCompaction`'s fast path returns it with no worker call. Set it to `0` to defer the judgment step to compaction.
- **Two stages.** `#runBatch` writes **notes** per turn (`slm-notes.md`: one line per statement, thought and tool outcome, statements transcribed rather than paraphrased) into `<session>.notes.md` beside the document. `prepareForCompaction` then runs the **contract** (`slm-handoff.md`) over those notes plus `<recent_actions>` and writes the document. Only the contract is a judgment call; notes are recording, and compaction is the only place the document is written.
- **Transcription is detected.** A small model asked to summarise a log will copy it, and a token cap only compresses the copy — so the coordinator counts lines that echo `THOUGHT`/`CALL`/`RESULT`; three or more triggers one retry with a stricter instruction, and if it persists the copied lines are stripped. Requirements and file actions are in the harness blocks regardless, so a stripped document loses detail, never the contract.
- **The document is a selection, not a record.** The worker is asked to keep what changes what the successor does next (objective, decisions and reasons, binding constraints, verified facts, next step, the files that matter) and to drop routine reads, repeated output and superseded plans. Selectivity is safe because the exhaustive record lives outside the document: the user's messages verbatim and the turn's file actions, both written by the harness. The rule is "quote exactly when you quote; omit rather than paraphrase".
- The worker reads a **scratchpad**, not the turn, and the pad speaks the notes' own vocabulary (`- [USER]`, `- [SAID]`, `- [THOUGHT]`, `- [TOOL name] target → outcome`). Measured: with `CALL`/`RESULT` labels the model mirrored them and invented its own note format; aligned labels removed the translation step. Runs are chunked by note lines (≈16 per run), because a run cut off at its cap loses the *end* of the turn — the newest work.
- The worker reads a **scratchpad**, not the turn. Every event — user line, thought block, tool call with its target, tool result, assistant conclusion — is reduced to one bounded line (`THOUGHT` 240 chars, `CALL read(path:range)`, `CALL name(args)` 160, `RESULT` 200, `CONCLUSION` 320, `USER` 600), and the pad keeps the newest lines that fit the run budget. Deterministic: no model writes it. Measured on a 316-message session, 142 K tokens of raw content became a 26 K-token pad, bounded to 16.3 K — so an 88 K turn cannot overflow the worker.
- `SlmHandoffCoordinator` (`packages/coding-agent/src/slm/handoff.ts`) runs one stateless request per completed turn: the previous document plus only the turns since the last covered one, with a fresh two-message context per request so the worker never reads its own earlier answers. When the covered message no longer exists (compaction, branch change, resume), it re-seeds from the live context.
- The document is keyed by the **transcript id** (`sessionManager.getSessionId()`: minted per transcript, fresh on fork, stable across provider-id rotation), digested with SHA-256 so two ids that differ only in punctuation cannot share a file; the RAM directory is namespaced by agent dir so profiles cannot shadow each other. A copy whose metadata names a different session is refused rather than merged.
- The document is published to `/dev/shm/rabid-slm-handoff/<agent>/<session>.md` first — the copy maintenance reads — and mirrored to `<agent dir>/slm-handoffs/<session>.md`. Metadata (covered leaf key, `coveredAt`, budgets, token counts) rides in an `<!-- rabid-slm-handoff … -->` comment so the `.md` stays hand-editable.
- The worker is a separate stock `llama-server` process pinned to `--n-gpu-layers 0`, at most `compaction.slmHandoff.threads` threads (default: a quarter of the logical CPUs, spread over physical cores via `--cpu-mask`), q8_0 KV cache, `--ctx-size` copied from the active model's window (capped by `compaction.slmHandoff.maxContextTokens`), and up to `compaction.slmHandoff.reasoningBudgetTokens` thinking tokens per run (default 1024: a full 4096 spent ~38 s on a 200-word merge). `--ctx-size` is the smaller of the model window and `compaction.slmHandoff.maxContextTokens` (default 16K, not the window: one run only sees the turns since the last handoff, so a bigger copy buys nothing and costs RAM plus prefill). It never goes through the V100 router, which admits one resident model at a time and would evict the main model. A worker already running anywhere on the box (`--alias slm-worker`, e.g. one loaded from the manager page) is discovered and adopted rather than duplicated — two Spark workers cannot both be resident on an 8 GB gaming card, and the spilled one runs slower than the fallback it was meant to avoid.
- A worker the harness did not spawn (`compaction.slmHandoff.workerUrl`, or one discovered by its `--alias slm-worker`) can serve less context than the configured ceiling. Its `--ctx-size` then caps `ctxSize` and the derived `maxInputTokens`, so chunks are sized for the window the process actually has instead of overflowing it and paying a rejection-plus-split on every run.
- At the compaction trigger the committed summary is the ready document plus a verbatim `## User messages (verbatim; authoritative)` block, so a requirement the 3B model paraphrased or dropped is still recorded in the user's own words. No summarization request is made — which is why `slm` is usable for `overflow` as well as threshold/incomplete/idle reasons.
- If the document does not cover the live leaf, maintenance waits up to `compaction.slmHandoff.awaitMs` for the in-flight run and then advances to the next configured method. A missing GGUF or server binary makes the method unavailable, so the fallback chain runs unchanged. Background runs never download; only `/models-worker` does.
- Manual `/compact` selects `slm` only without focus instructions: a precomputed document cannot honor new direction.
- Memory on a shared or gaming card is capped by construction: with `compaction.slmHandoff.gpuFreeMiB` (default 1024) the worker runs `--n-gpu-layers auto --fit on --fit-target <MiB> --fit-ctx <window>`, so llama.cpp offloads only the layers that still leave that much VRAM free. Measured on an idle 8 GB card with a 4B Q4 at 8K context (≈2.7 GB resident): 2048 → 95.9 tok/s (fully resident), 4096 → 21.0 (partial), 5120 → 11.6 (~25 % on the card). The reservation must leave ≈3.2 GB usable; a co-resident 2.8 GB service costs another ~34 % even when both fit (63.2 tok/s).
- `compaction.slmHandoff.detail` selects the prose register the worker writes in (`concise`, `standard`, `detailed`). The default `detailed` asks for the exact path and symbol, the exact command and its outcome, and one clause of why per item — enough that a successor with no context cannot misread it. It is not padding: measured on the same turn, `detailed` produced 2 115 summary chars / 546 worker tokens / 50.9 s against 1 523 / 298 / 25.6 s for the shorter register, and every file claim matched the harness-extracted action block.
- The quant is the knob that decides the weight footprint: `Spark-X2.5-4B` publishes Q4_0 2.41 GB, Q4_K_M 2.60 GB, Q5_K_M 2.98 GB, Q6_K 3.38 GB, and Q8_0 4.38 GB (`abenzerps/Spark-X2.5-4B-GGUF`); nothing smaller is published, so go below Q4_0 only by quantizing the BF16 source with `llama-quantize`. Point `compaction.slmHandoff.modelPath` at the file; the headroom cap above then decides how much of it lands on the card.
- The worker's device is configurable: `compaction.slmHandoff.device` accepts `cpu` (default — every GPU backend is blanked so the worker can never take memory from the inference or display card), `cuda` (driver picks), or `cuda:N` (pinned under `CUDA_DEVICE_ORDER=PCI_BUS_ID`, matching `nvidia-smi -L`). `compaction.slmHandoff.gpuLayers` defaults to all layers on a GPU and none on the CPU. On a small card, pin a lower layer count rather than raising the window.
- Two durability rules: `dispose` lets an in-flight run finish (5 s) before aborting, so a one-shot session does not always lose its turn's work; and when compaction must wait, it re-derives the document from the region it is about to discard (`messagesToSummarize` + `turnPrefixMessages`) instead of trusting a chain that may have drifted.
- `/models-worker` also guarantees a fallback: it puts `slm` first and, if that would leave no other method, appends `handoff`, so a worker that cannot cover the live leaf degrades to a document the main model writes instead of leaving the context uncompacted. `unload` undoes both: it drops `slm` and, when `handoff` is all that remains, restores the default order.
- `/models-worker` downloads the GGUF when missing, starts the worker, holds it against idle teardown, and prepends `slm` to `compaction.methodOrder`. `/models-worker status` reports the running process and configured budgets; `/models-worker unload` stops it and removes `slm` from the order. Subagent sessions never schedule handoff runs.
- Any GGUF can be the worker: `/models-worker ~/models/<file>.gguf` sets `compaction.slmHandoff.modelPath`, and only the default SmolLM3 filename is auto-downloaded (a missing custom path reports the `hf download` command instead). Set `compaction.slmHandoff.reasoningBudgetTokens: 0` for a model without a thinking mode.
- Measured on this 16-thread box with the same two-turn input (`MUST use port 8451 … NEVER touch 8080`) at `--ctx-size 262144`, 4 threads: SmolLM3-3B Q4_K_M took 17.1 s, 12.5 GB RSS, and kept both requirements verbatim under the right headings; Qwen2.5-0.5B-Instruct Q4_K_M took 2.0 s, 2.8 GB RSS, but dropped the port requirement and repeated one line under five headings. A 0.5B model is mechanically compatible and far cheaper, yet it does not hold the requirement-preservation contract that makes the handoff safe — keep SmolLM3-3B as the default and treat smaller models as an experiment, with the verbatim user-message appendix as the only backstop.

### Deterministic requirement block

Every text compaction — `slm`, `handoff`, and each LLM method including provider-native `remote` — ends its committed summary with two harness-authored blocks plus the model's prose:

- `## Recent file actions` — extracted from the tool calls in the summarized region (`edit`/`write`/`read`/`search`/`bash`, newest 24, consecutive repeats collapsed). The summarizer never writes these paths, so a file named in the summary is a file the session touched.
- `## What just happened` — written by the summarizer from the action log: `Learned:`, `Implemented:`, `Files:`. The prompt supplies `<recent_actions>` and forbids naming a path that is not in it, so "learned this / implemented that" is grounded rather than invented.

Then `## User messages (verbatim; authoritative)`: the operator's own messages, rendered by this process from the summarized window, never by a model. A summarizer that paraphrases, truncates, or invents cannot alter it, and each pass carries the previous block forward (deduplicated, order-preserving), so a summary chain cannot erode a requirement that an earlier pass recorded.

The block is bounded at 5 % of the live window, clamped to 1K–8K tokens: small windows must not spend their summary on verbatim text, and large ones gain nothing past 8K. Snapcompact and extension-supplied compactions keep their own shape — snapcompact's summary is a lead-in to rendered frames, and a hook-owned summary belongs to the extension.

This is what makes a weak worker safe: in testing, a 0.5B worker degenerated into a repeat loop on a long turn and a 3B worker invented sections, while both committed summaries still contained the exact requirement lines.

### Maintenance progress guard

Automatic maintenance checks that the rewritten context creates real headroom (normally at or below 80% of the resolved threshold) before scheduling continuation. No-progress passes can try local rescue: re-render an existing snapcompact archive with a smaller frame budget, elide heavy blocks to recoverable artifacts, or drop attached images. Archive rescue can truncate the oldest carried source text; image dropping is destructive. If maintenance still cannot create headroom, it emits a warning and blocks automatic continuation instead of looping on the same oversized context.

### Display transcript

Compaction no longer visually restarts the conversation. The TUI renders the **display transcript** (`buildSessionContext({ transcript: true })` / `AgentSession.buildTranscriptSessionContext()`): every path entry in chronological order, with each compaction shown inline as a slim divider — `── 📷 compacted · ctrl+o ──` — at the point it fired. Expanding (ctrl+o) reveals the summary. Only the LLM context resets at the compaction boundary; the scrollback above the divider stays intact, including across session resume.

### Pre-compaction pruning

Before compaction checks, tool-result pruning may run (`pruneToolOutputs`).

Default prune policy:

- Protect newest `40_000` tool-output tokens.
- Require at least `20_000` total estimated savings.
- Never blank a result below `50` tokens (`MIN_PRUNE_TOKENS`): the `[Output truncated - N tokens]` placeholder costs ~8 tokens, so pruning a sub-floor result would grow the context and churn the prompt cache for nothing. (Superseded and useless results keep their own rules — the useless collector already drops no-savings candidates; superseded reads prune for correctness regardless of size.)
- Never prune `skill` tool results, `read` results of `skill://` paths, or reads of the active plan reference file (added via `AgentSession`'s plan protection).

Pruned tool results are replaced with:

- `[Output truncated - N tokens]`

If pruning changes entries, session storage is rewritten and agent message state is refreshed before compaction decisions.

### Useless-result elision

Tools can flag a finished result as contextually useless — a search with zero matches or a `wait` safety cap that returned only still-running work. The flag originates on the tool result (`AgentToolResult.useless`, set via `ToolResultBuilder.useless()` or directly on the returned object), is copied by the agent loop onto the persisted `ToolResultMessage` (never together with `isError` — errors always win), and is consumed in three places:

- **Per-turn stale-result pass** (`pruneSupersededToolResults`, gated by `compaction.dropUseless`, default on): flagged results are blanked to the exact placeholder `[Uneventful result elided]` (`USELESS_NOTICE`) with the same cache-aware timing as superseded reads — only when the suffix after the candidate is small (≤ ~8k tokens) and, for models with a known prompt-cache lookback (catalog `prompt-cache-lookback`; Claude: 20 positions), sits within a conservative bound on it, or the session has idled past the provider prompt-cache lifetime. The bound projects the candidate's issuing assistant turn, its tool-result batch and everything after it through the session's `convertToLlm` (so file mentions, command output with images and custom-message image splits count as sent) and counts positions the way Anthropic does (a run of consecutive `tool_use` or `tool_result` blocks is one position; images hoisted out of error results and padding turns count). It allows at most the lookback minus 6, keeping 6 positions for the next request's input and for request projections it does not count (orphan-result notes, replayed compaction file metadata, tool-change controls). An input or projection larger than that margin can still cost one cache rebuild. Models without a known lookback skip the bound. The threshold prune's warm-cache guard applies the same limit. Results smaller than the notice itself are never blanked (no savings), and protected tools are exempt.
- **Threshold prune** (`pruneToolOutputs`): flagged results bypass the protect-recent window, same as superseded reads, and receive `USELESS_NOTICE` instead of the token-count placeholder.
- **Summary serialization**: `serializeConversation` (agent and snapcompact) drops the whole tool call/result pair from summarizer/archive input — the source region is discarded after summarization anyway, so the exclusion costs no cache.

The flag never reaches provider wire formats, and flagged pairs are never removed from history (only blanked in place), so tool-call/result pairing and provider-native history replay stay intact.

### Boundary and cut-point logic

`prepareCompaction()` builds one effective message sequence for estimation, cut-point selection, and the history-summary, turn-prefix, and retained-message regions.

1. Find the latest compaction whose summary or provider-native history is reusable by the active model.
2. Honor the latest `/clear` `reset_boundary`: a newer reset discards the previous summary, and an older reset remains the lower bound for recovering retained messages.
3. For a local summary, recover the original entries from `firstKeptEntryId` up to the previous compaction record, then append entries after that record.
4. For reusable provider-native history, start after `providerReplayThroughEntryId` when it identifies an older snapshot, without crossing the latest reset boundary. This recovers the uncovered snapshot-to-commit interval, not the original messages already covered by native replay. A trailing native compaction record does not make that interval already compacted.
5. Exclude compaction records and other non-message metadata. Pass the previous summary separately through `previousSummary`; retain message-bearing `custom_message` and `branch_summary` entries.
6. Adapt `keepRecentTokens` using the measured usage ratio, then run `findCutPoint()` and partition that same sequence into `messagesToSummarize`, `turnPrefixMessages`, and `recentMessages`.

When updating a local summary, every effective original message belongs to exactly one of those three regions. For example, after `summary(A) + B` grows to `summary(A) + B + C`, the next preparation distributes both B and C, not just C. The new `firstKeptEntryId` refers to an original entry; preparation does not move, duplicate, or rewrite journal entries. This is a local-summary preparation guarantee, not an end-to-end guarantee for provider-native or speculative native replay.

Valid cut points include:

- message entries with roles: `user`, `assistant`, `bashExecution`, `hookMessage`, `branchSummary`, `compactionSummary`
- `custom_message` entries
- `branch_summary` entries

Hard rule: never cut at `toolResult`.

Preparation filters out pure metadata (`model_change`, `thinking_level_change`, labels, etc.) before selecting the retained-message boundary. Those records remain in the journal but are not conversation input.

### Split-turn handling

If cut point is not at a user-turn start, compaction treats it as a split turn.

Turn start detection treats these as user-turn boundaries:

- `message.role === "user"`
- `message.role === "bashExecution"`
- `custom_message` entry
- `branch_summary` entry

Split-turn compaction generates two summaries:

1. History summary (`messagesToSummarize`)
2. Turn-prefix summary (`turnPrefixMessages`)

Final stored summary is merged as:

```markdown
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

### Summary generation

`compact(...)` builds summaries from serialized conversation text:

1. Convert messages via `convertToLlm()`.
2. Serialize with `serializeConversationForSummary()` using the target model's preferred dialect.
3. Wrap in `<conversation>...</conversation>`.
4. Optionally include `<previous-summary>...</previous-summary>`.
5. Optionally inject extension hook context and active memory-backend compaction context as `<additional-context>` entries.
6. Execute summarization prompt with `SUMMARIZATION_SYSTEM_PROMPT`.

Oversized local-summary input is folded through budgeted conversation windows, carrying each summary into the next update. Provider context-overflow rejections halve and re-plan the rejected window down to a minimum input budget; other failures surface normally.

Prompt selection:

- first compaction: `compaction-summary.md`
- iterative compaction with prior summary: `compaction-update-summary.md`
- split-turn second pass: `compaction-turn-prefix.md`
- short UI summary: `compaction-short-summary.md`
- handoff document: `handoff-document.md` (used by `generateHandoff(...)`, not serialized compaction)

Remote summarization modes, consulted in order (each stage falls back to the next while one is available):

- **V2 streaming Responses compaction** (tried first, on by default via `compaction.remoteStreamingV2Enabled`): for eligible models — `shouldUseCompactionV2Streaming(...)`: `openai-responses`, `azure-openai-responses`, or `openai-codex-responses` APIs with `remoteCompaction.v2StreamingEnabled` (on by default for Amazon Bedrock's OpenAI routes, see below) and a resolvable Responses endpoint — compaction forwards the full conversation, including provider-native tool-call history replay, to the model's normal Responses streaming endpoint with a trailing `compaction_trigger` input item, and requires exactly one streamed `compaction` output item. The request carries session routing and prompt-cache identifiers (routing/session-id headers plus `prompt_cache_key`) and resolves the model's reasoning effort the same way a normal turn does. Replacement history is Codex-style: retained real user messages within the `compaction.v2RetainedMessageBudget` (default `64000` tokens, clamped to that ceiling) followed by the compaction item, stored in `preserveData.openaiRemoteCompaction` (version `"v2"`). Transient stream errors retry up to `V2_COMPACTION_MAX_RETRIES` (`2`) times with exponential backoff under a five-minute timeout (`V2_COMPACTION_TIMEOUT_MS`, same as V1); user aborts are never retried.
- **V1 native `/responses/compact`**: for OpenAI models, OpenAI Codex models with an explicit compatible `remoteCompaction.endpoint`, and `openai-responses` models on Amazon Bedrock's OpenAI routes (`shouldUseOpenAiRemoteCompaction`), when remote compaction is enabled and V2 did not run (ineligible or failed), compaction tries the provider-native `/responses/compact` endpoint. It preserves provider replacement history in `preserveData.openaiRemoteCompaction`. A native failure surfaces its transport error instead of silently switching to generic summarization — unless `compaction.remoteEndpoint` is set, in which case summary generation falls through to that endpoint/local summarization.
- **Anthropic on-demand compaction** (`compact-2026-09-04` beta): for model lines the beta supports (`compat.supportsServerCompaction`, a catalog rule: Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5+ on the `anthropic`, `google-vertex`, `amazon-bedrock`, and `bedrock-mantle` providers) whose effective endpoint implements it (`shouldUseAnthropicNativeCompaction`: the Claude API, Vertex, Foundry, Claude Platform on AWS, and Amazon Bedrock's `/anthropic` routes; another provider reaching one of the first four needs `remoteCompaction.enabled`, and unknown gateway URLs stay excluded), when remote compaction is enabled and no OpenAI lane applies. Compaction sends the history to summarize with the live conversation's system prompt, tools, and thinking settings, plus a top-level `compaction: { type: "summarize", instructions }` parameter carrying the harness summary prompt. The API answers with one signed `compaction` block (`stop_reason: "compaction"`), surfaced as an `anthropicCompaction` payload. Its plain-text summary becomes the entry `summary` (plus the file-operation list) **and** `preserveData.anthropicCompaction`; later requests on a compaction-capable endpoint send the block back unchanged as the first block, while every other provider reads the summary text. The retained tail after the cut point is replayed from session entries like a local summary. A response without a signed summary, such as a refusal, an output limit, or a tool call during summarization, is a native failure, like the OpenAI lanes. Blocks written by the older `compact-2026-01-12` threshold beta (`encryptedContent`) are replay-only.
   - On Amazon Bedrock, use `https://bedrock-runtime.<region>.amazonaws.com/anthropic` or `https://bedrock-mantle.<region>.api.aws/anthropic` ([setup](./models.md#claude-on-bedrocks-anthropic-messages-api-anthropic)); the FIPS and PrivateLink hostnames listed below for the OpenAI routes count too. The gate reads `compat.bedrockMessagesApi`, detected from such a `baseUrl`; set it in `models.yml` to opt a proxy or an `ANTHROPIC_BASE_URL` reroute in, or `false` to opt a Bedrock route out. Converse and InvokeModel (`/model/...`) requests never compact natively; Converse rejects the beta ([AWS compaction guide](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-compaction.html)).
- **Custom remote endpoint**: if `compaction.remoteEndpoint` is set and remote compaction is enabled, local summary generation POSTs one of two wire formats:
   - custom omp summarizer endpoints receive `{ systemPrompt, prompt, maxTokens }` and must return JSON containing at least `{ summary }`.
   - OpenAI-compatible endpoints whose path ends in `/chat/completions` receive `{ model, messages, stream: false, max_tokens }`, where `messages` contains one system prompt and one user prompt. The summary is read from `choices[0].message.content`, which lets self-hosted servers such as llama.cpp and vLLM act as remote compactors without a separate summarizer shim.

Amazon Bedrock's OpenAI routes get both OpenAI lanes without an opt-in. The route is detected from the model `baseUrl` (`isBedrockOpenAIUrl` in `packages/catalog/src/hosts.ts`), for any provider id with `api: openai-responses`: an HTTPS `/openai/…` path on a `bedrock-runtime` or `bedrock-mantle` endpoint, or Mantle's documented `/v1` base. Endpoint hostnames are the public ones (`bedrock-runtime.<region>.amazonaws.com`, FIPS `bedrock-runtime-fips.<region>.amazonaws.com`, `bedrock-mantle.<region>.api.aws`, including the bundled `bedrock-mantle` provider's `{region}` template) and AWS PrivateLink endpoint-specific names (`<vpce-id>[-<az>].bedrock-runtime[-fips].<region>.vpce.amazonaws.com` or `….bedrock-mantle.<region>.vpce.amazonaws.com`); a VPC endpoint with private DNS answers on the public names ([Endpoints supported by Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html), [Bedrock service endpoints](https://docs.aws.amazon.com/general/latest/gr/bedrock.html), [Bedrock VPC endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html), [PrivateLink DNS names](https://docs.aws.amazon.com/vpc/latest/privatelink/privatelink-access-aws-services.html)). Other Bedrock paths, such as `/anthropic`, `/v1` on bedrock-runtime, or the Converse root, do not count. On these Bedrock routes only, both compaction requests are shaped like a normal Bedrock turn by `prepareBedrockCompactionRequest` (`packages/agent/src/compaction/bedrock.ts`): configured headers are resolved, the transport fetch applies (provider proxy, extra CA, User-Agent, request recording), and the provider's own request hooks run. So the bundled `bedrock-mantle` provider fills in `{region}` and uses its bearer token or SigV4 signing. Other providers' compaction requests keep their own transport. To turn the default off for a model or provider in `models.yml`, set `remoteCompaction.enabled: false` (both lanes) or `remoteCompaction.v2StreamingEnabled: false` (V1 only). AWS documents the Responses API on both endpoints ([Responses API](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html)), and OpenAI lists Bedrock's feature coverage ([OpenAI models in Amazon Bedrock](https://developers.openai.com/api/docs/guides/amazon-bedrock)). None of these pages mention compaction. Support was verified live instead, on 2026-09-25 with a Bedrock API key (not SigV4) on the public `/openai/v1` bases: in `us-east-1`, V1 `POST {base}/responses/compact` returned `object: "response.compaction"` and V2 streamed a `compaction` output item on `bedrock-runtime` (`us.openai.gpt-6-astra`, `-sol`, `-luna`) and on `bedrock-mantle` (`openai.gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.5`, `gpt-5.4`). FIPS, PrivateLink, and Mantle `/v1` bases reach the same services but were not verified live. `openai.gpt-oss-120b` on Mantle does not support the Responses API.

When a native remote compaction (V2, V1, or Anthropic) succeeds, local LLM summarization is skipped entirely. For the OpenAI lanes the durable history lives in the provider replay payload and the stored `summary` is a placeholder lead-in plus the file-operation list; the Anthropic lane stores the real summary text, so a later compaction by any provider can build on it.

When native compaction starts from an ordinary local summary, that summary is included as a context message alongside the prepared conversation. Later native passes reuse the provider payload instead of re-injecting its placeholder summary. Snapcompact source text keeps its separate archive migration path.

For speculative native compaction, `providerReplayThroughEntryId` records the snapshot's last entry, not the later commit position. Context rebuilding and the next compaction preparation both include messages appended between those positions, followed by post-commit messages. The native payload and uncovered interval are replayed once each; `/clear` discards both when it supersedes that compaction.

Advisor runtimes retain native `preserveData` for subsequent maintenance and attach its provider payload to the in-memory compaction summary for the next model request. Native replay already contains the retained tail, so advisors do not also append that tail as raw messages. Local summaries still keep recent messages separately. Advisor requests use the shared message converter so both textual compaction summaries and native payloads reach the provider.

### Handoff generation

`packages/agent/src/compaction/compaction.ts` exports `generateHandoff(...)` and `generateHandoffFromContext(...)`. Coding-agent uses the context-aware function through `SessionHandoff`: the side request uses the base system prompt, normalized tools, transformed live history, and live prompt-cache key, with a unique side session id and trailing agent-attributed `user` handoff prompt. It starts with `toolChoice: "none"` and retries once with `"auto"` only after an explicit-tool-choice compatibility rejection. Only joined text blocks are returned; tools are never dispatched. See [the handoff pipeline](./handoff-generation-pipeline.md).

Handoff commits a regular `CompactionEntry` on the current session: `SessionMaintenance.handoff()` (manual `/handoff`) and the auto-maintenance `handoff` method both generate the document via `SessionHandoff.generateDocument()` and store it as the compaction summary with `firstKeptEntryId` from `prepareCompaction`, so recent history is kept and the session id, transcript, and provider cache key are unchanged.

When `compaction.handoffSaveToDisk` is enabled, an **automatically triggered** handoff also writes `handoff-<ISO timestamp>.md` in the persisted session's artifact directory. Manual handoffs are not written by this setting, and non-persisted sessions have no artifact directory.

### File-operation context in summaries

Compaction tracks cumulative file activity using assistant tool calls:

- `read(path)` → read set
- `write(path)` → modified set
- `edit(path)` → modified set

Cumulative behavior:

- Includes prior compaction details only when prior entry is pi-generated (`fromExtension !== true`).
- In split turns, includes turn-prefix file ops too.
- `details.readFiles` excludes files also modified; `details.modifiedFiles` carries the rest (persisted shape is unchanged).

The file list is a grouped, prefix-folded directory tree (find-tool shape) with a per-file access marker — `(Read)` for read-only files, `(Write)` for modified files never read, `(RW)` for modified files also present in the cumulative read set. Capped at 20 files with an `[…N files elided…]` line. LLM-summary strategies append it as a `<files>` tag (via `upsertFileOperations`); snapcompact renders it inside its summary template as a `FILES` section instead.

```xml
<files>
# packages/agent/src/compaction/
compaction.ts (Read)
utils.ts (RW)
## prompts/
file-operations.md (Write)
</files>
```

Legacy `<read-files>`/`<modified-files>` tags from summaries written by earlier versions are stripped (alongside `<files>`) before re-appending, so old summaries self-heal on the next compaction.

### Persist and reload

After summary generation (or hook-provided summary), agent session:

1. Appends `CompactionEntry` with `appendCompaction(...)`; the handoff method commits the generated document as the entry's summary on the same session.
2. Rebuilds display context from the active leaf via `buildDisplaySessionContext()`.
3. Replaces live agent messages with rebuilt context.
4. Synchronizes active todo phases from the rebuilt branch and closes provider sessions whose history was rewritten.
5. Emits `session_compact` hook event.

## Branch summarization pipeline

Branch summarization is tied to tree navigation, not token overflow.

### Trigger

During `navigateTree(...)`:

1. Compute abandoned entries from old leaf to common ancestor using `collectEntriesForBranchSummary(...)`.
2. If caller requested summary (`options.summarize`), generate summary before switching leaf.
3. If summary exists, attach it at the navigation target using `branchWithSummary(...)`.

Operationally this is commonly driven by `/tree` flow when `branchSummary.enabled` is enabled.

### Branch switch shape (visual)

```text
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D (abandoned branch, unchanged)
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### Preparation and token budget

`generateBranchSummary(...)` computes budget as:

- `tokenBudget = (model.contextWindow || 128000) - branchSummary.reserveTokens`

`prepareBranchEntries(...)` then:

1. First pass: collect cumulative file ops from all summarized entries, including prior pi-generated `branch_summary` details.
2. Second pass: walk newest → oldest, adding messages until token budget is reached.
3. Prefer preserving recent context.
4. May still include large summary entries near budget edge for continuity.

Compaction entries are included as messages (`compactionSummary`) during branch summarization input.

### Summary generation and persistence

Branch summarization:

1. Converts and serializes selected messages with `serializeConversationForSummary()` and the target model's preferred dialect.
2. Wraps in `<conversation>`.
3. Uses custom instructions if supplied, otherwise `branch-summary.md`.
4. Calls summarization model with `SUMMARIZATION_SYSTEM_PROMPT` and a 2,048-token output limit.
5. Prepends `branch-summary-preamble.md`.
6. Appends file-operation tags.

Result is stored as `BranchSummaryEntry` with optional details (`readFiles`, `modifiedFiles`).

## Extension and hook touchpoints

### `session_before_compact`

Pre-compaction hook.

Can:

- cancel compaction (`{ cancel: true }`)
- provide full custom compaction payload (`{ compaction: CompactionResult }`)

The hook's `customInstructions` carries only the public user focus. Internal summarizer guidance — currently the plan-mode "Approve and compact context" distillation prompt — travels a separate `internalGuidance` channel on `CompactOptions` that reaches only native summarization, never this hook or `session.compacting`; when both are set the summarizer uses `internalGuidance` while hooks still see the public `customInstructions` (issue #4359).

### `session.compacting`

Prompt/context customization hook for default compaction.

Can return:

- `prompt` (override base summary prompt)
- `context` (extra context lines injected into `<additional-context>`)
- `preserveData` (stored on compaction entry)

### `session_compact`

Post-compaction notification with saved `compactionEntry` and `fromExtension` flag.

### `session_before_tree`

Runs on tree navigation before default branch summary generation.

Can:

- cancel navigation
- provide custom `{ summary: { summary, details } }` used when user requested summarization

### `session_tree`

Post-navigation event exposing new/old leaf and optional summary entry.

## Runtime behavior and failure semantics

- Manual compaction aborts current agent operation first. If that abort cut a turn in flight, the compaction resumes it once the summary is committed — or immediately when it rejects as a no-op (session too small / already compacted), since that pass makes no history change — using a queued steer/follow-up first, otherwise the auto-continue prompt. A hook cancel or summarizer failure does not resume. The resume is skipped when `compaction.autoContinue` is `false` or the caller passed `suppressContinuation` (plan-mode approval dispatches its own execution turn). A manual compaction issued while idle never starts a turn. A prompt submitted while the compaction runs waits for it and, if it starts or queues a turn, replaces the resume; a locally handled extension/custom command hands the resume back — unless a turn it triggered (`pi.sendMessage(..., { triggerTurn: true })`, `pi.sendUserMessage()`), a later prompt, or any other turn starts first. A second manual compaction started while such a resume is still withheld takes it over.
- `abortCompaction()` cancels manual compaction, auto-compaction, and handoff generation controllers.
- Auto compaction emits start/end session events for UI/state updates.
- Auto compaction can try multiple model candidates and retry transient failures; long retry delays prefer the next candidate when one is available.
- Overflow errors are excluded from generic retry path because they are handled by context promotion/compaction.
- If auto-compaction fails:
   - overflow path emits `Context overflow recovery failed: ...`
   - incomplete-output path emits `Incomplete response recovery failed: ...`
   - threshold/idle paths emit `Auto-compaction failed: ...`
- Branch summarization can be cancelled via abort signal (e.g., Escape), returning canceled/aborted navigation result.

## Settings and defaults

Defined in `packages/coding-agent/src/session/context-settings.ts`:

- `compaction.enabled` = `true`
- `compaction.experimentalContextManagement` = `false`. Opt-in persistent notes, branch-bound raw-history retrieval, and local context-window rollover; toggling it adds or removes `context_notes`/`new_context` in the running session.
- `compaction.methodOrder` = `["remote", "snapcompact", "handoff", "shake", "soft"]`. `remote` uses provider-native server compaction (OpenAI Responses compact, Anthropic compaction beta) when available; unavailable or failed methods advance to the next preference.
- `compaction.asyncEnabled` = `true`. Async (speculative) compaction: when context enters the pre-threshold band `[threshold − lead, threshold)` (lead = `clamp(threshold × 0.125, 8192, 32000)`), maintenance starts a background summarization for the first configured LLM-backed method (`remote`, `handoff`, or `soft`) off a branch snapshot, isolated from the live turn by a side session id. The armed result is committed instantly when the threshold is actually crossed, hiding summarization latency; post-snapshot turns are appended after the summary unchanged. Armed results are discarded when the branch prefix changes (new compaction, reset boundary, `/tree` navigation), when a provider-native replay payload is no longer readable by the active model, or when context grows past `keepRecentTokens` since compute (a fresh speculation replaces it). Speculation is skipped while an extension registers `session_before_compact`. The status line pulses the auto-compact icon while a speculation runs and holds it in accent when a result is armed.
- `compaction.reserveTokens` is unset by default. The effective reserve is `max(floor(contextWindow × 0.15), configuredReserve ?? 16384)`. Budget checks use the proportional reserve when the unset default is impractical on a small window, or when the effective reserve reaches/exceeds the whole window. Explicit reserves otherwise retain the 15% floor.
- `compaction.keepRecentTokens` = `20000`
- `compaction.autoContinue` = `true`
- `compaction.midTurnEnabled` = `true`; a `false` value applies to the session that configured it, not to spawned subagents — each subagent keeps mid-run checks so its single-turn assignment still compacts at the configured threshold.
- `compaction.handoffSaveToDisk` = `false`
- The `handoff` method generates a handoff document through the live-cache side-request pipeline and commits it as a compaction entry on the current session (no new session is created); `/handoff` does the same manually.
- `compaction.remoteEndpoint` = `undefined`
- `compaction.remoteStreamingV2Enabled` = `true`
- `compaction.v2RetainedMessageBudget` = `64000`
- `compaction.thresholdPercent` = `-1` and `compaction.thresholdTokens` = `-1`; a positive fixed token limit takes precedence over percentage, and otherwise the reserve-based threshold is used.
- `compaction.modelThresholds` = `{}`; `provider/model-id` or `provider/…*` prefix → a token base the threshold policy scales in place of the window (dropping a global `thresholdTokens`), a fixed trigger (`"f90000"`), or a percentage replacing both thresholds, while that model is active. Editable from the `/models` Roles view (`k`). See [Settings](./settings.md#context-compaction-and-memory).
- `task.agentCompactionThresholdOverrides` = `{}`; exact-name task/eval agent → token count (`90000`) or percentage (`"80%"`) replacing both thresholds for that agent only. See [Settings](./settings.md#context-compaction-and-memory).
- `compaction.idleEnabled` = `false`
- `compaction.idleThresholdTokens` = `200000`
- `compaction.idleTimeoutSeconds` = `300`
- `compaction.supersedeReads` = `true`
- `compaction.dropUseless` = `true`
- `snapcompact.systemPrompt` = `"none"` (`"agents-md"` and `"all"` opt into transient system-prompt imaging)
- `snapcompact.toolResults` = `false` (transient imaging of large tool results, the newest one included; `read` results stay text unless the model's catalog rule sets `snapcompact-image-reads` (Opus 5.5+), since frames lose the exact indentation an edit copies; the planner keeps a result in the form it was first sent in until the `snapcompact.*` settings, the model or earlier history change, or later images push the request past the provider's image cap; a downstream request-byte limit can still drop older inline frames, as it can any inline image)
- `snapcompact.shape` = `"auto"`
- `branchSummary.enabled` = `false`
- `branchSummary.reserveTokens` = `16384`

These values are consumed at runtime by `AgentSession`, `SessionMaintenance`, and the compaction/branch-summarization modules.
