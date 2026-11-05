Ask the local Laya decision model one forward pass of typed questions over a piece of state.

Laya (`convaiinnovations/laya`) is a **decision** model, not a chat model: it does not generate text. It reads a state plus a set of typed questions and returns calibrated probabilities from a single pass — a few hundred milliseconds on the local bridge, no tokens billed, fully offline. Reach for it when the question is a bounded judgement over text you already have and a label with a probability is more useful than a paragraph.

Two ways to ask.

**`questions` — supply your own.** This is the general case, and the one to use for engineering work: classify a failure, pick a likely cause, rate an option. Each question has an `id` (the key you get back), a `type`, `instructions` describing what to judge from the state, and `criteria`:

- `choice` → `criteria` lists the option labels, optionally with `descriptions` (one per label, same order) saying what each option means. The answer carries the chosen label and its probability.
- `score` → `criteria` lists ordered levels, lowest first. The answer carries the level index (and the level text when the bridge knows the legend).

**`profile` — a shipped question set.** These are the sets the model was fine-tuned on, but they belong to specific domains; none of them triages code:

| profile | answers | use for |
| --- | --- | --- |
| `triage` | `intent` (refund / technical_help / billing_question / information / cancellation / other), `is_urgent`, `frustration`, `refund_requested`, `churn_risk` | customer-support messages |
| `guard` | `jailbreak`, `prompt_injection`, `sensitive_data` (noul), `harm_severity` (score 0–3), `topic` | screening untrusted content |
| `router` | `difficulty` (score 0–3: trivial → hard), `domain` (code / math_or_logic / …) | deciding how much model a task needs |
| `email`, `moderation` | the shipped email and moderation sets | those domains |

Rules that make the answer usable:

1. **Instructions are the whole job.** The model sees only your `state` and these instructions — no tools, no context, no ability to look anything up. Put the evidence in `state`; put the question in `instructions`.
2. **Ask about shape, not recall.** "Is this error a missing dependency or a type error?" is answerable from the text; "what does this library's API look like?" is not.
3. **Treat the output as a prior, not a verdict.** A 0.62 is a hint to look, not proof. Anything load-bearing still gets verified with a real command.
4. **Do not ask it to write, explain, or summarize.** It cannot.

When a `noul` question comes back, the number is the model's mass on "none of the listed options" — it is not a yes/no. If the bridge is not running, the call fails with the command that starts it; that is a local service you can start, not a permanent limitation.
