# laya

One forward pass of typed questions over a piece of state, answered by the local Laya
decision model through its bridge daemon. Returns calibrated probabilities, not prose.

## Source

`packages/coding-agent/src/tools/laya.ts` — transport and question translation.
`packages/coding-agent/src/prompts/tools/laya.md` — the description the model sees.
Bridge: `~/.local/share/laya-bridge/server.py`, serving `convaiinnovations/laya` on
`127.0.0.1:37900` (reserved port; the bridge owns it, this tool is only a client).

## Inputs

| field | meaning |
| --- | --- |
| `state` | the text or JSON object to judge. The model sees nothing else. |
| `profile?` | a shipped question set: `triage` / `email` / `moderation` (support domains), `guard` (safety), `router` (difficulty + domain). None of them triages code. |
| `questions?` | a custom set. Each: `id`, `type` (`choice`/`score`), `instructions`, `criteria`, optional `descriptions`. |

Exactly one of `profile` or `questions` is required.

## Behaviour

`choice` answers return the chosen label with its probability (`class: build-error
(p=0.812)`); `score` answers return the level index rendered through the legend; `noul`
answers report the mass on "none of the listed options" verbatim, because it is not a
yes/no. Every answer carries the bridge's measured latency.

The tool translates the two-array form (`criteria` + `descriptions`) into the bridge's
`{label: description}` record and passes a `score` scale through as an ordered list. A
mismatched `descriptions` length is rejected locally — the bridge would otherwise
silently mislabel the options.

## Errors

- **Bridge down** — `fetch` failure is reported with the start command
  (`~/.local/share/laya-bridge/start.sh`), because that is a fixable local service.
- **Malformed question set** — rejected before any request is sent.
- **Bridge 4xx** — the bridge's own `error` string is surfaced verbatim (unknown
  profile, missing `state`, unknown question type).

## Why it exists

The main model can already classify; what it cannot do is classify *cheaply and
repeatably*. A 421M decision model answers a bounded question in one pass with no tokens
billed and no sampling noise, which makes "triage this failure before spending a turn on
it" a sensible move rather than an expensive one. It is a prior, not a verdict: anything
load-bearing is still verified with a real command.
