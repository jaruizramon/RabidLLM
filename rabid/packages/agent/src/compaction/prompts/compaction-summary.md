You MUST summarize the conversation above into a structured handoff summary for another LLM to resume the task.

IMPORTANT: If the conversation ends with an unanswered question or a request awaiting user response (e.g., "Please run command and paste output"), you MUST preserve that exact question/request.

You MUST use this format (sections can be omitted if not applicable):

## Goal
[User goals; list multiple if session covers different tasks.]

## Constraints & Preferences
- [Constraints or requirements mentioned]

## Progress

### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of next actions]

## Critical Context
- [Important data, pending questions, references]

## Additional Notes
[Anything else important not covered above]

You MUST output only the structured summary; you NEVER include extra text.

Evidence rules (apply to every section):
- Every `Done` item MUST cite the verification that proved it: the exact command/test and its outcome. A change that was only applied, read, or claimed is `In Progress`, never `Done`.
- Record a failing command or test under `Blocked` or `In Progress` with the exact command, the failing assertion/test, and the observed result. Never soften a failure to "needs testing" and never report it as passing.
- Record a repeated identical tool call and any ignored loop-guard corrective under `Blocked`, naming the tool and the correction. Never mark that call's target `Done`.

Sections MUST be kept concise. You MUST preserve exact file paths, function names, error messages, and relevant tool outputs or command results. You MUST include repository state changes (branch, uncommitted changes) if mentioned.
