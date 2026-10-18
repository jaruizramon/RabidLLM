<previous_handoff>
{{{previousHandoff}}}
</previous_handoff>

<new_turn>
Compressed event log. One line per event: USER (what was asked), THOUGHT (the model's
reasoning, headed), CALL tool(target), RESULT tool(outcome), CONCLUSION (what it said).
Old events may be dropped from the top; the pad is the turn, not a sample of it.
{{{turnTranscript}}}
</new_turn>

<recent_actions>
{{{actionLog}}}
</recent_actions>

Update the handoff. Preserve every hard requirement and decision. Use recent_actions for every path and command you name. Output only the Markdown handoff. Maximum {{maxHandoffTokens}} tokens.
