<system-interrupt reason="tool_call_loop_detected">
You called `{{tool_name}}` {{count}} consecutive times with identical arguments:
`{{arguments_summary}}`

Last result (truncated): `{{result_summary}}`

NEVER call `{{tool_name}}` with those arguments again in this run. The previous correction did not change the outcome, so repeating it stops the run. Use different arguments, choose another tool, or summarize findings and yield if complete.
</system-interrupt>
