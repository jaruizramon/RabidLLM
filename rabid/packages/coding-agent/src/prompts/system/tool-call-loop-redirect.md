<system-interrupt reason="tool_call_loop_detected">
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
</system-interrupt>
