# Changelog

## 0.1.0 (unreleased)

First version.

- `/onbudget <$X | N% 5h | N% week> <task>` runs a task under a usage budget; `/onbudget` shows the status; `/onbudget off` removes the budget. `ONBUDGET` sets the budget for a headless run.
- Spend is read from the session's own cost ledger, subagents included. Each request is charged its own cost even when requests overlap; the prototype charged a request for everything that ran beside it.
- A request is refused when the spend so far, plus the cost of the dearest request seen for it and for each request still in flight, would reach the budget. The refusal is a visible notice written by the plugin.
- Claude sees a one-line meter reading after each tool result and with each follow-up prompt. Effort is capped at medium while a budget is set (configurable).
- Percentage budgets are converted to dollars with a rate learned from this account's own usage readings, or enforced on the window reading itself until a rate is known.
- The budget survives compaction, a reload and a resumed session, and ends with `/clear`.
