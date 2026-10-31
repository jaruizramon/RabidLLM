<system-reminder>
{{incompleteCount}} todo item{{#if plural}}s{{else}}{{/if}} still open, and {{mutations}} file-changing tool call(s) landed since your last `{{toolRefs.todo}}` update. If you finished a task, mark it done now so progress stays visible; otherwise keep working.
{{#if openList}}
{{openList}}
{{/if}}
{{#if recentActions}}
{{recentActions}}
{{/if}}
</system-reminder>
