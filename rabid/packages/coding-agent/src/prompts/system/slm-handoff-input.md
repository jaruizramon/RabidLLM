<previous_handoff>
{{{previousHandoff}}}
</previous_handoff>

<turn_notes>
The turn's notes: statements transcribed, thoughts summarised, tool outcomes recorded.
One line per event: `[USER]`, `[SAID]`, `[THOUGHT]`, `[TOOL name] target → outcome`.
Older notes may be dropped from the top.
{{{turnTranscript}}}
</turn_notes>

<recent_actions>
{{{actionLog}}}
</recent_actions>

Write the handoff for a successor who has none of these notes and cannot ask questions. Select: keep the objective and where it stands, each decision with its reason, the constraints that still bind, the facts the turn established (with the command and its outcome), the next concrete step, and the files that matter. Drop routine reads, repeated output, abandoned approaches and anything superseded. Quote exactly when you quote. Take every path and command from `<recent_actions>` or the notes. Output only the Markdown handoff. Maximum {{maxHandoffTokens}} tokens.
