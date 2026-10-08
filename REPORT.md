# onbudget: engineering and evaluation report

Version 0.1.0, built 2026-10-08 and 09 on Claude Code 2.1.289 (CLI) and 2.1.293 (desktop-bundled), macOS, a Max subscription, Claude Opus 5.5.

<!-- VERDICT:START -->
The paid evaluation is still running. Status: `python3 eval/queue.py status`. Results: `python3 eval/report.py`.
<!-- VERDICT:END -->

## What was built

A Claude Code plugin of function hooks: `hooks/core.ts` (the budget logic, pure functions, 320 lines) and `hooks/register.ts` (eight hooks, 525 lines). No dependencies, no build step, no network or model calls of its own.

- `/onbudget <$X | N% 5h | N% week> <task>`, `/onbudget`, `/onbudget off`; `ONBUDGET` for headless runs.
- A ledger of the task's own spend, taken from the session's cost ledger, subagents included.
- A stop that refuses the request the budget cannot cover, with a notice written by the plugin.
- A meter line the model sees after every tool result, and a protocol sent once with the task.
- An effort cap while a budget is set.
- Percentage budgets converted with a rate learned from the account's own readings.

Around it: 101 tests that run inside the engine, 36 end-to-end checks against the real CLI, 21 checks in a real terminal session, and an evaluation harness with spend rails.

## What changed from the prototype, and why

### Concurrent requests were charged for each other

The prototype measured a request's cost as the ledger's growth over the request's whole duration. Claude Code starts a subagent while the main request that spawned it is still streaming, so the main request was charged for every subagent request that ran beside it. In the raw log of the prototype's baseline run `D-TIGHT-1-a0` the largest "single request" is recorded as $2.08. Priced from its own tokens it cost $0.52. That inflated figure was the stop's reserve, which is why the baseline arm was stopped with over a dollar of budget unspent and scored 0 of 7.

onbudget charges a request the ledger's growth since the previous request completed, and no more than its growth since the request itself was sent. The first bound removes the requests that ran beside it; the second removes what was spent between requests, such as a compaction. In the three paid smoke runs every request's charge equals its token-priced cost to six decimal places, and the charges sum to the CLI's own total.

The ledger itself was never wrong: total spend is the engine's figure. What was wrong was the reserve derived from it.

### The reserve counts requests in flight

The stop rule is `spent + reserve × (in flight + 1) ≥ budget`. Without the in-flight term, several loops can each pass the check at the same moment and overrun together.

### The interactive command could not have worked

The prototype's `/within` submitted the task from inside its `command.run` hook. The engine refuses that ("it would wait on the turn this hook is holding"). The prototype never saw the refusal because its interactive path was never run. onbudget submits the task from a timer once the hook has returned, and retries a few times in headless mode, where the session is not ready for a moment after the command. This is checked in a real terminal session on both builds.

### Percentage budgets without a shipped constant

The prototype multiplied points by $0.97 and $12.65, measured on one account. onbudget ships no rate. In every session it records how many dollars the ledger grew and how many points each window moved, per model, and pools them: total dollars over total points, with two standard deviations of whole-point rounding error added to the points. The estimate errs low, and other sessions on the account push it lower, so a percentage budget buys fewer dollars than its nominal share and never more.

Before three points of movement have been seen there is no rate. A percentage budget set then is enforced on the window's own reading, with a 3% minimum, and stops if the window fills or stops being reported. With a rate, the reading is only a backstop against a rate gone wrong.

What the prototype called "calibration" was a number in a config file. What is here is a measurement with a stated direction of error. It is still an estimate of something Claude Code does not expose.

### The protocol asks for verification and an honest ending

The prototype's text said "Verify by running the tests before you finish, and fix only failures", and it was observed to suppress useful tests. The new text makes verification part of the task, tells the model to do fewer things before it skips checks, and asks for a final account of what is complete, what is unfinished and what was changed but not verified. It defers to a final format the task itself asks for.

### A stop the person can read

The prototype answered a refused request with an empty end of turn. onbudget answers with a notice that names the spend, the reserve, the requests still running if any, says it comes from the plugin and not from Claude, and says the work should be treated as unfinished. In a headless run that notice is the run's result.

### Lifecycle

State lives in the plugin's store, keyed by session. A reload, a resumed session whose ledger survived or started over, `/clear`, a compaction, an interrupted request, and a switch to another session inside one process are each handled and each tested. `ONBUDGET` is used once per session.

### Not built

Forecasting, automatic effort escalation, subagent denial, a dashboard, a price table. None had evidence behind it.

## How it was checked without spending

| Suite | Count | What it exercises |
| --- | --- | --- |
| `claude plugin test .` | 101 | The plugin loaded by the engine's own test host, over a mocked ledger, model, store and clock: the stop, concurrency, percentage budgets, calibration, every lifecycle path, fail-closed and fail-open behaviour. |
| `python3 tests/e2e/run.py` | 36 | Real `claude -p` processes with a scripted model and ledger: prompt rewriting, effort, meter lines as the transcript recorded them, the stop as the run's result, the typed and slash command, calibration carried between processes, resume with the ledger kept and restarted. |
| `python3 tests/e2e/interactive.py` | 21 | A real terminal session through a pseudo-terminal: `/onbudget` typed by hand, the status line, the stop on screen, a refused follow-up, `off`, Esc during a request, `/compact`, `/clear`, exit and `--resume`. |
| `python3 eval/selftest.py` | 57 | The harness: scoring of base and fixed trees for all nine tasks, the spend ceiling, the lock, the guards, resume, the watchdog. |

All pass on Claude Code 2.1.289 and 2.1.293. None sends a model request: the end-to-end suites point the API at a closed port as well as mocking the model.

Two independent reviews were run on the code before any money was spent. The plugin review raised 46 findings from four angles; the eight most serious were each handed to a separate reviewer told to refute them, and all eight were confirmed with a reproduction. Those and the worthwhile smaller ones are fixed, each with a test. The serious ones:

- A `/resume` inside a running session kept enforcing the previous session's budget on the new one.
- The command typed as prompt text, when it failed, sent the raw text to the model with no budget.
- A percentage budget without a rate ran on indefinitely once the window was full or no longer reported.
- A compaction's cost was charged to the next request and became the reserve for the rest of the budget.
- `/onbudget off` failed in exactly the state where the fail-closed notice tells the person to run it.
- A model switch relabelled the session's calibration data.

The harness review raised 28 findings; all were fixed or answered. The serious ones were ways to pay twice for a finished run and a signal handler that defeated `nohup`.

## What was verified, what is assumed, what is untested

Verified by a test or a paid run:

- Spend equals the engine's ledger; per-request charges equal token-priced costs (three smoke runs, 16 requests).
- The usage-window readings arrive with the first answer of a session and after every answer.
- The stop, the meter, the effort cap, the protocol and every command form, in headless and interactive sessions, on two builds.
- The plugin changes nothing when no budget is set.

Assumed:

- A list-price dollar moves a usage window equally whatever the request. The prototype's data agrees for Opus within the rounding of whole points; nothing tests other models.
- The engine keeps the session id across `--resume` and reports `resume` or `clear` when a process changes session. Both were observed on these builds.

Untested:

- Windows, Linux, the desktop app's Code tab, VS Code, mobile.
- A switch of session with `/resume` inside a real terminal (engine-level tests only).
- A real compaction under a budget (the interactive check answers the compaction from the mock).
- Teammates, workflow agents, long sessions, models other than Opus 5.5.
- A weekly percentage budget end to end: the weekly window moved one point during the whole build.

<!-- EVALUATION:START -->
## Evaluation

Not finished. See the status command at the top.
<!-- EVALUATION:END -->
