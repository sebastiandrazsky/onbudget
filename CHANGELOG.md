# Changelog

## 0.1.0 (unreleased)

First version.

- `/onbudget <$X | N% 5h | N% week | 5h | week> <task>` runs a task under a usage budget; `/onbudget` shows the status; `/onbudget off` removes the budget. `ONBUDGET` sets the budget for a headless run.
- Spend is read from the session's own cost ledger, subagents included. Each request is charged its own cost even when requests overlap; the prototype charged a request for everything that ran beside it.
- A request is refused when the spend so far, plus the cost of the dearest request seen for it and for each request still in flight, would reach the budget. The refusal is a visible notice written by the plugin.
- Claude sees a one-line meter reading after each tool result and with each follow-up prompt. What it calls "left before the stop" is what the stop rule still allows, with the reserve taken off. The tier turns CRITICAL when two requests' worth or less is left, so a model working one request at a time has read CRITICAL at least twice before a request can be refused, as long as no request costs more than the dearest before it. Effort is capped at medium while a budget is set (configurable).
- While a budget is open, the account's 5-hour and weekly usage windows are limits as well. The meter follows whichever of the budget and the two windows comes first and names the window when it does; the plugin stops with its own notice at 99% of a window (about 97% when no conversion rate is known), before Claude Code's limit message would end the session. A budget larger than what a window has left says so when it is set; a window with nothing left refuses the budget in one line, also in a new session, from the last reading seen on the machine.
- `5h` and `week` are budgets: what that window has left below 99% when the budget is set, in dollars when a conversion rate is known and in the window's own points when not. A reset of the window during the task does not enlarge the budget.
- Percentage budgets are converted to dollars with a rate learned from this account's own usage readings, or enforced on the window reading itself until a rate is known.
- Once a budget has stopped a session, further prompts are turned away with the reason, so nothing more is spent on them.
- In a terminal session, when Claude ends the task with its STATUS line, the plugin writes one line of its own: the spend, how the task ended, and that the budget is still open.
- The budget survives compaction, a reload, a resumed session and a switch to another session, and ends with `/clear`.
- Requires Claude Code 2.1.287 or later, where plugin mods are on by default. Tested on 2.1.289 and 2.1.299.
- A GitHub Actions workflow validates the plugin and runs its in-engine tests against the current Claude Code on every push and weekly. It has not run yet.
