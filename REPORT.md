# onbudget: engineering and evaluation report

Version 0.1.0, built 2026-10-08 and 09 on Claude Code 2.1.289 (CLI) and 2.1.293 (desktop-bundled), macOS, a Max subscription, Claude Opus 5.5.

This report was written for the first build (git tag `eval-freeze`) and its evaluation on Claude Code 2.1.289. The release candidate (git tag `eval-freeze-3`) and its evaluation on Claude Code 2.1.304 are in the addendum at the end, which supersedes the verdict below where they differ.

## Verdict

READY WITH LIMITATIONS, once you have run `CHECKLIST.md` yourself. Until then it is not ready to publish: the checklist is the one thing here a person has to do.

The plugin does what it says in headless and interactive sessions on both Claude Code builds, the evaluation finished, and its results are below. The limitations that matter:

- Against a short budget instruction in the prompt the gain is modest and rests on two or three runs per budget.
- The stop holds between the conversation's requests. Requests Claude Code makes on its own are counted and cannot be refused.
- One of 42 completion claims made under onbudget was wrong.
- Percentage budgets are conservative estimates, and the weekly one is untested end to end.

Paid evaluation spend: $60.57 of the $65 allowed ($59.49 for the 24 queued runs, $1.08 for six interactive sessions).

## What was built

A Claude Code plugin of function hooks: `hooks/core.ts` (the budget logic, pure functions, 324 lines) and `hooks/register.ts` (eight hooks, 529 lines). No dependencies, no build step, no network or model calls of its own.

- `/onbudget <$X | N% 5h | N% week> <task>`, `/onbudget`, `/onbudget off`; `ONBUDGET` for headless runs.
- A ledger of the task's own spend, taken from the session's cost ledger, subagents included.
- A stop that refuses the request the budget cannot cover, with a notice written by the plugin.
- A meter line the model sees after every tool result, and a protocol sent once with the task.
- An effort cap while a budget is set.
- Percentage budgets converted with a rate learned from the account's own readings.

Around it: 101 tests that run inside the engine, 40 end-to-end checks against the real CLI, 21 checks in a real terminal session, and an evaluation harness with spend rails.

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
| `python3 tests/e2e/run.py` | 40 | Real `claude -p` processes with a scripted model and ledger: prompt rewriting, effort, meter lines as the transcript recorded them, the stop as the run's result, the typed and slash command, calibration carried between processes, resume with the ledger kept and restarted. |
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

- Spend equals the engine's ledger; per-request charges equal token-priced costs, in all 24 evaluation runs, six of them with overlapping subagent requests.
- The usage-window readings arrive with the first answer of a session and after every answer.
- The stop, the meter, the effort cap, the protocol and every command form, in headless and interactive sessions, on two builds with a scripted model and on 2.1.289 with the real one.
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

## Evaluation

### Design

The benchmark is the lab's seven-task session: seven real upstream fixes in Python libraries (boltons, falcon, markdown-it-py, pluggy, pydantic-settings, and two in werkzeug), given in one prompt to one headless session. A task counts as complete when the upstream tests the model never saw pass, the existing suite still passes, and the changelog entry the task asks for exists. The scoring code is the lab's, ported unchanged and checked against the base and fixed trees of all tasks.

| Arm | What the model is told | What enforces the budget |
| --- | --- | --- |
| Plain, shared stop rule | Nothing about a budget | A silent plugin applying onbudget's stop rule |
| Plain, simple cap | Nothing about a budget | A silent plugin that refuses requests once spend has reached the budget |
| Prompt-only | One paragraph: the budget, stay within it, finish and verify as much as you can | The silent plugin with onbudget's stop rule, as a safety net |
| onbudget | Whatever the plugin sends | The plugin |

Everything else is the same in every arm: Claude Opus 5.5 with the 1M context, `--effort medium`, the same tools and permissions, the same prompt body, Claude Code 2.1.289.

Budgets: $4.20 and $2.47, the lab's frozen values (0.85 and 0.50 of what the prototype spent on these tasks with room to spare), and 4% of the 5-hour window.

The plugin was frozen (git tag `eval-freeze`) before the first seven-task run. The only real-model runs before that were three single-task smoke runs on tasks the lab had already used, and they led to no change.

### Results

Tasks complete out of 7, one figure per run, and what each run cost.

| Budget | Arm | Tasks complete | Mean | Cost | Within budget | Ended by itself, with a report |
| --- | --- | --- | --- | --- | --- | --- |
| $4.20 | Plain, shared stop rule | 5, 3 | 4.0 | $3.35, $3.25 | 2 of 2 | 0 of 2 |
| $4.20 | Plain, simple cap | 5, 6 | 5.5 | $4.25, $4.25 | 0 of 2 | 0 of 2 |
| $4.20 | Prompt-only | 5, 6 | 5.5 | $1.92, $2.69 | 2 of 2 | 2 of 2 |
| $4.20 | onbudget | 7, 7, 6 | 6.7 | $3.07, $3.57, $3.67 | 3 of 3 | 3 of 3 |
| $2.47 | Plain, shared stop rule | 0, 1 | 0.5 | $2.01, $1.78 | 2 of 2 | 0 of 2 |
| $2.47 | Plain, simple cap | 0, 1 | 0.5 | $3.14, $3.57 | 0 of 2 | 0 of 2 |
| $2.47 | Prompt-only | 5, 5, 5 | 5.0 | $2.33, $2.05, $2.08 | 3 of 3 | 2 of 3 |
| $2.47 | onbudget | 6, 5, 6 | 5.7 | $2.32, $1.84, $2.16 | 3 of 3 | 2 of 3 |
| 4% of the 5-hour window | Prompt-only (cap $3.88) | 6 | | $2.74 | 1 of 1 | 1 of 1 |
| 4% of the 5-hour window | onbudget (converted to $3.28) | 6 | | $2.83 | 1 of 1 | 1 of 1 |

24 paid runs, none void, none failed for infrastructure reasons. `eval/report.txt` has every run and every task.

### What the results show

Against plain Claude Code the difference is large. None of the eight plain runs ended by itself inside a budget; the cap cut every one of them off without a report. In six of the eight, plain Claude Code split the work across 3 to 6 parallel subagents, and a cap then catches all of them mid-task: at $2.47 it finished 0 or 1 task under either cap. Under the simple cap it also overshot, by 5 cents when it ran no subagents and by $0.67 and $1.10 when several were in flight.

Against a one-paragraph budget instruction the difference is modest. onbudget completed 1.2 more tasks at $4.20 (6.7 against 5.5), 0.7 more at $2.47 (5.7 against 5.0), and the same number on the percentage budget (6 and 6). At $4.20 it finished all seven tasks in two of three runs, which no prompt-only run did. At $2.47 and on the percentage budget the gap is no larger than the spread between onbudget's own runs. With two or three runs per cell none of this is statistically established.

The costs show why the two differ. A model that is told a budget and cannot see its spend plays safe: prompt-only stopped at 46% and 64% of the $4.20 budget with tasks unfinished. onbudget, shown the meter, used 73 to 87% and finished more. Prompt-only is the cheaper per completed task ($0.42 against $0.52 at $4.20). If the aim is the lowest spend, a sentence in the prompt does most of the work. If the aim is the most finished work a budget can buy, with the budget enforced and not just hoped for, the plugin adds something.

No onbudget run exceeded its budget. Seven session runs and two smoke runs; the closest came to 94% of it.

Completion claims were mostly right, not always. Under onbudget the model made a claim on each of 42 tasks across six runs. One was wrong: it reported `werkzeug-cond` complete when 47 of 48 hidden tests passed; its own run of the existing suite had passed. One erred the other way, reporting a task incomplete that was complete. Prompt-only made 35 claims, none wrong, on fewer attempted tasks. The earlier finding of no false claims does not hold as a rule.

Verification was not thinner. onbudget ran the test suites 11 to 17 times per run, prompt-only 8 to 14. Of the 45 tasks whose code onbudget edited, its last test run started after its last code edit in 44 (prompt-only: 32 of 32). Every onbudget final message listed what it had not verified.

The stop fired once, and it was not graceful. In one of the seven onbudget session runs the model worked on into the CRITICAL tier and the plugin refused its next request at $2.32 of $2.47. There was no closing report from the model. The tree was usable: six tasks complete, each last tested after its last edit. The run's result was the plugin's notice. In the other six runs the model ended by itself with a report.

The accounting holds under real concurrency. Six plain runs had 3 to 6 subagents with overlapping requests. In all 24 runs every request's charge equals its cost priced from its own tokens, to five decimal places, and the charges sum to the CLI's total.

The percentage budget behaved as designed. By its seventh run the plugin had seen 11 points of 5-hour-window movement in its own earlier runs and had learned $0.82 per point. It converted "4% 5h" to $3.28, spent $2.83, and the window moved 3 points. Over the onbudget runs of the main queue the raw figure is $19.00 for 20 points, $0.95 per point, in line with the lab's $0.97. The learned rate is lower on purpose.

### Interactive sessions with the real model

`eval/interactive_smoke.py` drives a real terminal session: `/onbudget $0.50` on a small coding task, `/onbudget`, a second budget too small to finish, a follow-up prompt, `/onbudget off`. In the final runs all 16 checks pass. The task was submitted as a prompt labelled as coming from the plugin, with the protocol visible; requests went out at medium effort in a session set to high; the model finished with a `STATUS: COMPLETE` line at $0.11 of $0.50; the $0.07 budget was stopped by the plugin with its notice on screen.

These sessions found what the headless runs could not. After a turn ends, an interactive Claude Code session makes a request of its own, the prompt suggestion. It does not pass through the hook the plugin refuses requests on. After the $0.07 budget stopped at $0.069, the session's spend rose to $0.115. With `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` it stayed at $0.068. The plugin counts this spend and shows it; it cannot prevent it.

The first three of the six sessions were spoiled by the driver script, not the plugin: it misjudged when a turn had ended and did not expect Claude Code's own file-permission prompts. Their logs are kept beside the others.

### One change after the freeze

Before the interactive sessions, a prompt sent after a stop entered the conversation and its request was refused. Each such turn let Claude Code make another request of its own. Now the prompt is turned away at submission with the reason, and nothing is spent. No evaluation run sends a prompt after a stop, so the 24 runs behave the same under either version. The change was run through every zero-cost suite on both builds and through the interactive session above.

### Limits of this evaluation

- Two or three runs per cell, one for the percentage budget. Treat differences of less than a task as noise.
- One model, one effort level, one kind of work: fixes to Python libraries that have test suites. Nothing here says how it does on work without tests.
- Six of the 24 runs were added after the first 18 had been seen: the plain arm under a simple cap, because the shared stop rule had stopped the plain arm with a fifth of its budget unspent, and a third $2.47 run for prompt-only and onbudget. The plugin was not changed in between.
- The prompt-only paragraph is one wording. Another might do better or worse.
- The plain arm varies a great deal with whether it decides to use subagents.
- Scoring stalled once (falcon's test run hit the runner's 300-second watchdog on both attempts) and was repeated by hand. The lab saw the same stall.
- The weekly window was not evaluated. It moved three points in the whole evaluation.
- The baseline arms had a budget figure in an environment variable the model could have read. Nothing suggests it did.

### Raw data

`eval/runs/<run>/` holds each run's prompt, command, plugin log, score, final message and diff. `eval/results.csv` has one row per run, `eval/report.txt` the tables, `eval/queue.log` the timeline. The full working trees and transcripts are on disk beside them and are not in git. The lab directory was read and never written.

## Addendum, 2026-10-20: release candidate and second round

### Pre-registered reading of round two

Written and committed with the frozen build (git tag `eval-freeze-3`) before the paid queue started. Round two runs that build on Claude Code 2.1.304, the release current on 2026-10-20, pinned by its binary path: an interactive smoke session, then arm C (onbudget) three times at HARD ($2.47), then arm D (plain Claude Code with `--max-budget-usd 2.47`) twice, then arm B (the budget sentence in the prompt) twice if the $25 ceiling still allows.

1. The guarantee. The README leads with what onbudget guarantees: a request the budget cannot cover is refused before it is sent, so a task ends within its budget. That claim stays only if every round-two arm C run ends within its budget. A run that does not stops the queue and is reported before anything else.
2. The comparison with the budget sentence. It stays near the top of the README only if round-two arm C at HARD averages at least 5.00 of 7 tasks complete, the figure of round one's arm B at HARD (Claude Code 2.1.289, n = 3). Otherwise it moves below the fold, as a table giving each row's Claude Code version and n.
3. Every number in README and REPORT carries its Claude Code version and n. No p-values are computed from round two.
4. Round two's arm B and arm D runs are reported beside the arm C rows with their version and n. They do not change rules 1 and 2.

### What changed since the first round, and why

The first round's 24 runs used Claude Code 2.1.289 and the build tagged `eval-freeze`. Two reviews later, the shipping build (`eval-freeze-3`) differs in six ways.

1. **The meter says where the stop is.** "Left before the stop" is exactly what the stop rule still allows, with the reserve for the next request (and for any request in flight) taken off, so the meter reads 0 when the next request will be refused. The tier also turns CRITICAL when two requests' worth or less is left at the cost of the dearest so far. In round one's `hard-C-1` the model first read CRITICAL at $2.27 of $2.47 and the next request but one was refused; with the same figures the meter now reads CRITICAL from $1.97. A randomised test of 2,000 budgets (each request no dearer than the dearest before it) finds at least two requests sent after the first CRITICAL reading in every one.
2. **The account's windows bound every budget.** While a budget is open, the 5-hour and weekly windows are limits too. The meter follows whichever comes first and names the window; the plugin stops at 99% (about 97% without a learned rate) with its own notice. A budget larger than what a window has left says so; a window with nothing left refuses the budget in one line, also in a new session, from the last reading kept on the machine.
3. **`5h` and `week` are budgets**: what the window has left below 99% when the budget is set, in dollars with a learned rate and in the window's points without one. A reset during the task does not enlarge the budget.
4. **Claude Code's own countdown is left out under a budget.** Claude Code 2.1.304 adds `<total_tokens>N tokens left</total_tokens>` to every request, counting down from a server-set 15 million at each prompt. Round one's transcripts (2.1.289) carry none, so the model behind round one's figures saw one budget signal. Under a budget the native figure is not the task's budget, and the build now leaves it out of new requests while a budget is open. The system prompt's copy stays; nothing already sent changes; after a resume every countdown gets the answer it was first sent with, by its text and the order in which that text appeared. A countdown under a million tokens, or one set with `CLAUDE_CODE_TOTAL_TOKENS_REMINDER`, is kept.
5. **An effort cap that another plugin overrides is reported.** effortless rewrites each request's effort. onbudget reads, after each request, the effort the engine actually received (`next.trace`), and when it is above the cap logs it per request, says so once naming the plugin, and shows it in `/onbudget`. It does not compete for the order.
6. **A receipt in points.** The end-of-task line and `/onbudget` give the whole points each window moved while the budget was open, labelled as whole points for the whole account.

Smaller: `/onbudget` states the version and the tested Claude Code range and says when no window reading exists yet; the evaluation's shim links are regular files; the public identity is in `LICENSE` and both manifests.

### The first audit's findings (2026-10-10) and how each was settled

1. *The meter and the stop disagreed.* Settled by change 1 above.
2. *A budget was blind to the account's limits.* Settled by change 2.
3. *`5h` and `week` did not exist.* Settled by change 3.
4. *No real-model run had a subagent or two requests in flight.* Still true of real runs (see the round-two rows). A scripted session now runs two subagents side by side in a real Claude Code process under onbudget: each request is charged its own cost, the charges sum to the ledger, and a request is refused for the reserve of one still in flight where it alone would have fitted (`tests/e2e/run.py`, check `subagents`).
5. *README install text, the placeholder owner, and the per-task cost figure.* The install section now states 2.1.287 or later with the builds tested, gives both install forms for `sebastiandrazsky/onbudget`, and the cost per finished task sits next to the cost by task count (see Results).
6. *Undisclosed: `~/CLAUDE.md` in context, and `hard-B-1` within budget only because of the cap.* Both are now stated in the README's results and here. `~/CLAUDE.md` (a one-line pointer to a writing-style skill) was in context in every run of both rounds; it was left in place so that the rounds stay comparable.
7. *Personal paths, screen captures and the personal e-mail in history.* Settled by the publication copy (below).

### The second review's findings (2026-10-20) and how each was settled

1. *The evaluation described a Claude Code users no longer run.* Round two ran on 2.1.304, pinned by path, with the shipping build. Round one's figures stay below, labelled 2.1.289.
2. *A mod can remove the countdown.* Built as change 4 and checked at no cost against a fake API on localhost (`tests/e2e/wire.py`): no copy in any budgeted request's messages, the system prompt's copy kept, no copy removed with no budget set, and every request starting with the one before it (the cache prefix) within a process and across four resumed processes with the budget set, kept and removed.
3. *Hook failure semantics.* Confirmed: no change was needed. The hooks-worker refusal from 2.1.299 is a README limitation.
4. *The platform converges on the meter, not the stop.* The README now leads with the refusal before sending and with weekly-window budgets.
5. *Effort defaults per model.* Documented in the README's limitations, including Fable 5.1's default of high and the unverified cache report. No code change.
6. *Coexistence with effortless.* Checked at effortless commit `df5602e` (2026-10-16), source read, against the fake API in both load orders (`EFFORTLESS_DIR=... python3 tests/e2e/wire.py effortless`): loaded first, onbudget's cap is overridden on the wire (effortless sent `xhigh` from its judge's verdict) and onbudget logs and names it for every such request; loaded second, the cap holds. The countdown rule and the stop held in both orders. The harness redirects only the Anthropic API, so effortless's own update check could still reach GitHub.
7. *Related tools.* Named in the README's prior-art paragraph, one factual clause each.
8. *Adoption mechanics.* The README shows the validator's calls list and states that nothing is added to context while idle. The repository was checked against the directory's pre-submission checklist (below).
9. *Round one's false claim.* The README states it with its version and n.

### Verification at no cost

| Suite | 2.1.288 | 2.1.304 | What it covers |
| --- | --- | --- | --- |
| `claude plugin validate --strict` (plugin and marketplace manifests) | pass | pass | manifests and hooks as the engine reads them |
| `claude plugin test .` | 136 of 136 | 136 of 136 | the logic and every hook inside the engine's test host |
| `tests/e2e/run.py` (scripted model, real CLI) | 57 of 57 | 57 of 57 | prompt, meter, stop, walls, `5h`, exhausted window, parallel subagents, capmod's three rules |
| `tests/e2e/wire.py` (fake API on localhost, real CLI) | 18 of 18 | 18 of 18 | the countdown, the cache prefix across resumes, effort on the wire, effortless both orders, capmod off identical to plain |
| `tests/e2e/interactive.py` (pseudo-terminal) | 21 of 21 | 21 of 21 | the command, status line, stop, refused follow-up, off, Esc, compact, clear, resume |
| `eval/selftest.py e2e-C e2e-D e2e-B` | | 27 of 27 | the harness end to end in the shape of each arm of round two |

2.1.288 is the oldest build tested that has mods on by default (2.1.287 was not available to test). On 2.1.288 the fake API also receives Claude Code's countdown, so the countdown checks ran there too. The pseudo-terminal driver needed one change for 2.1.299 and later: a prompt a hook turns away is put back into the input box, and the driver now clears it.

### Round two: results

Claude Code 2.1.304 at `~/.local/share/claude/versions/2.1.304` for every paid run, the shipping build `eval-freeze-3`, the HARD budget of $2.47, Claude Opus 5.5 at medium effort, the same seven tasks and prompt body as round one.

| Arm | n | Tasks complete, of 7 | Within $2.47 | Ended by itself, with a report | Wrong completion claims | Cost, each run | Per finished task |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C, onbudget | 3 | 5, 5, 5 | 3 of 3 | 3 of 3 | 0 of 21 | $2.00, $1.86, $1.97 | $0.39 |
| D, plain, `--max-budget-usd 2.47` | 2 | 5, 6 | 2 of 2 | 2 of 2 | 0 of 14 | $2.06, $2.25 | $0.39 |
| B, budget sentence in the prompt | 2 | 5, 5 | 2 of 2 | 1 of 2 | 0 of 7 | $2.38, $2.10 | $0.45 |

What the runs' own logs show, read by script from `score.json` and the plugin logs (no transcript was read):

- Arm C. All three runs ended by themselves, at LOW, with 0.47 to 0.61 dollars left; none reached CRITICAL or the stop. Claude Code's countdown was asked about 63, 52 and 61 times and left out every time. No request went out above the effort cap, no subagent was started, and the per-request charges sum to the session cost in every run. Every task they changed code for was tested after its last edit (5 of 5 in each run).
- Arm D. Neither run reached Claude Code's cap; both ended by themselves. The second started seven subagents and finished six tasks for $2.25.
- Arm B. `hard-r2-B-1` was still working at $2.38 when the silent safety cap (onbudget's stop rule) refused its next request; it made no report. Round one's `hard-B-1` ended the same way at $2.33.
- By task count: five tasks cost C $1.86 to $2.00, D $2.06, B $2.10 and $2.38; six tasks cost D $2.25.

The interactive smoke session (`eval/runs/interactive-real-7`, 2.1.304) passed 18 of 18 checks for $0.29: a $0.50 task finished with its STATUS line and the plugin's end line; a $0.07 budget was stopped by the plugin at $0.068 with its notice, its follow-up turned away; `/onbudget 5h` was sized from the live reading (the window at 1%: 98 points at a learned $0.84, $82.22) with both windows read as limits. An earlier attempt that day found the CLI logged out, got no answers, spent nothing, and was deleted.

### Reading round two against the pre-registration

1. The guarantee stands: every arm C run ended within its budget. Round two did not exercise the stop with the real model, because no run reached it; the evidence for the stop itself is round one's `hard-C-1`, the smoke session's $0.07 budget and the zero-cost suites.
2. Arm C at HARD averaged 5.00 of 7, the threshold, so the comparison stays near the top of the README. It reads as parity: on 2.1.304 onbudget finished no more tasks than the budget sentence (5.00, n = 2) or Claude Code's own cap (5.50, n = 2). The README says so in those words.
3. Every number in the README and here carries its Claude Code version and n. No p-values were computed.
4. Arms B and D are reported beside C.

### Spend

Round two: $14.62 for the seven queued runs (C $5.83, D $4.31, B $4.48) and $0.29 for the smoke session, $14.91 of the $25 approved. Both rounds together: $75.48 at list price.

### Where I disagree, or did something other than asked

- The comparison with the budget sentence met its threshold exactly, and round two also shows Claude Code's own cap finishing as many tasks. I kept the table near the top as the pre-registration says, with all three rows and the losing round-one rows, and the README claims no completion advantage for onbudget on 2.1.304.
- Leaving out Claude Code's countdown is not complete after a resume: in the first request of a resumed process a new countdown cannot be told from the ones already sent, so it is kept (one copy). Removing it would mean risking a rewrite of attachments already sent, which the brief rules out.
- The effort cap is reported, not defended, when another plugin overrides it, as asked.
- The account name `sebastiandrazsky` stays in the publication copy as the GitHub owner and the public address's domain, which you chose. The copy removes the home path, in both its forms, and the personal address.
- The learned weekly rate is far below the weekly point's apparent worth ($3.43 pooled against $6.49 raw, from 4 points in 19 sessions; the evaluation's own spend suggests $7 to $20). That is the rate erring low on purpose, with very little movement to learn from, not a defect. A `week` budget in dollars is therefore small on a new install; the README says so and points to `usdPerPointWeek`.

### The publication copy

`~/Documents/onbudget-publish/onbudget` is the tree to push, and `~/Documents/onbudget` stays as the archive; its history keeps the home path, the personal address and the screen captures, and must not be pushed. The copy is this repository's whole history rewritten as `eval/README.md` describes under "In the publication copy", by `~/Documents/onbudget-publish/make_copy.py`. In the copy, `eval-freeze` is `cef1515`, `eval-freeze-2` is `5930626` and `eval-freeze-3` is `6497bcd` (here: `3dd170f`, `0efe8a5`, `9d976cb`).

Checked against the directory's pre-submission checklist (claude.com/docs/plugins/pre-submission-checklist): a README of well over 40 words and a LICENSE at the root; the name `onbudget` in lowercase letters, not a reserved word (whether it is free can only be checked by the portal's Validate); `.claude-plugin/plugin.json` with author, homepage and repository; `hooks/hooks.json` with a `modules` array; no `.DS_Store`, `Thumbs.db`, `desktop.ini` or `__MACOSX` entries; file names valid on Windows and macOS; no symbolic links (the shim's two links are now copies), submodules or LFS; 456 files, the largest 95 KiB, all text; readable source, no credentials; and a README that says what the plugin and the repository's scripts run and contact.

One command shows the copy is clean. It counts, over every object in the copy's object store and every file outside it, the home path in either form and the personal address, then lists any `screen.txt` or system file in any commit's tree, any unreachable object, and every author and committer:

```bash
cd ~/Documents/onbudget-publish/onbudget && echo "home path or personal address: $({ git cat-file --batch-all-objects --batch; find . -type f ! -path './.git/objects/*' -exec cat {} +; } | LC_ALL=C grep -a -c -E '/Users/user|-Users-user|user|gmail\.com') | screen.txt in any tree: $(git rev-list --all --objects | grep -c 'screen\.txt$') | system files: $(git rev-list --all --objects | grep -c -E '\.DS_Store|__pycache__|\.pyc$|Thumbs\.db|desktop\.ini|__MACOSX') | unreachable objects: $(git fsck --unreachable --no-reflogs 2>/dev/null | wc -l | tr -d ' ') | identities: $(git log --all --format='%an <%ae>, %cn <%ce>' | sort -u | tr '\n' ' ')"
```

A clean copy prints four zeros and the one identity, `Sebastian Drazsky <sebastian@sebastiandrazsky.com>`.
