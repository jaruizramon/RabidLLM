<system-interrupt reason="tool_call_loop_detected">
{{#if repeated_failure}}
The same failure has now repeated {{count}} consecutive times:
`{{failure_signature}}`

Editing between attempts did not change it, so another guess will not either. Before the next attempt:
1. Re-run the failing command with the output UNFILTERED — drop `grep`, `head`, `tail`, `-q`, and `--quiet` — so source spans, `help:` and `note:` lines survive. The first error line names the symptom, not the cause.
2. Establish which version of the library is actually in use before changing the code again: the lockfile, `cargo tree -d`, or the installed package source.
3. Write one line stating the diagnosis, then make the change that follows from it. If no installed version can satisfy the error, state the blocker and yield instead of retrying.
{{else}}
{{#if repeated_cycle}}
You have now repeated the same {{period}}-probe sequence twice. The last turn returned:
`{{result_summary}}`

Last call: `{{arguments_summary}}`

Repeating the sequence cannot produce new evidence. Change modality: apply what the repeated output already proved (edit the file), read the authoritative spec or reference implementation, or state the blocker and yield. Repeating it stops the run.
{{else}}
{{#if repeated_result}}
You received the same `{{tool_name}}` output {{count}} consecutive times:
`{{result_summary}}`

Last arguments: `{{arguments_summary}}`

The output cannot change while the question stays the same. Do NOT re-run this probe or a near-identical variant. Change modality: read the authoritative spec, header, or reference implementation; run a different oracle; or state the blocker and yield. Repeating it stops the run.
{{else}}
You called `{{tool_name}}` {{count}} consecutive times with identical arguments:
`{{arguments_summary}}`

Last result (truncated): `{{result_summary}}`

NEVER call `{{tool_name}}` with those arguments again in this run. The previous correction did not change the outcome, so repeating it stops the run. Use different arguments, choose another tool, or summarize findings and yield if complete.
{{/if}}
{{/if}}
{{/if}}
</system-interrupt>
