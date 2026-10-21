# onbudget

Give a Claude Code task a spending limit, in dollars or as a share of your 5-hour or weekly usage; Claude sees what's left as it works, and onbudget stops it before the limit runs out.

```
/onbudget $3 Implement authentication
/onbudget 10% 5h Build this application
/onbudget week Write the migration
```

What you see, rendered by Claude Code with a scripted model: Claude Code 2.1.306 in an 80-column terminal, with the test suite's scripted model answering in place of Claude, at no cost. The three passages are copied from the screen as drawn, and nothing in them is edited.

```
  ⚠ onbudget: tier MEDIUM · $0.21 left · budget $0.50

⏺ [onbudget] Stopped: $0.07 of $0.12 is used, and the next request could cost up
  to $0.07, so it was not sent.
  This notice comes from the onbudget plugin, not from Claude. The work was
  interrupted: treat anything Claude has not reported as complete and verified
  as unfinished.
  To go on: /onbudget off (no budget), or /onbudget <budget> <instructions> (a
  new budget).

⏺ onbudget: Claude ended the task with STATUS: COMPLETE, at $0.20 of
  $0.50. The budget is still open: a follow-up prompt draws on it, and
  /onbudget off removes it.
```

The first line is Claude Code's status line under the prompt: the tier, what is left before the stop, and the budget. Claude Code cuts a plugin's status line at the terminal's width: after `onbudget: ` it shows the width less 17 characters, 63 in an 80-column terminal (measured on 2.1.304 and 2.1.306). onbudget's line is at most 60 characters, so it shows whole from 77 columns, and in a narrower terminal the budget is cut first. The second passage is a stop, under a $0.12 budget. The third ends a task.

Install (Claude Code 2.1.287 or later):

```bash
claude plugin marketplace add sebastiandrazsky/onbudget
claude plugin install onbudget@onbudget
```

- **Reads** the session's cost ledger and usage-window readings, its id and model, four environment variables, and its own store.
- **Writes** its own store (`~/.claude/plugins/store/onbudget_*.json`), a status line, and an event log only if you set `ONBUDGET_LOG`.
- **Sends** nothing anywhere. No network calls, no commands, no credentials. With no budget set it changes no request.

When you don't need it: in `claude -p`, Claude Code's own `--max-budget-usd` did as well as onbudget in our runs (Claude Code 2.1.304, n = 2 against 3). And at the 5-hour limit, Claude Code may let a response in progress finish under its Wrap-Up Allowance.

## What it guarantees, and in which units

- **The stop comes before the request.** onbudget sits on Claude Code's model-request hook. When the spend so far, plus what the dearest request of the task has cost, would reach the budget, the next request is answered by the plugin with a notice and never reaches the API. Requests already running are not cancelled, and each one holds back its own reserve.
- **Two documented ways past it.** One request that costs more than any before it, because nothing can price a request before it is sent; and Claude Code's own requests that do not pass through that hook, the next-prompt suggestion between turns and a compaction. Both are counted, and both are under Limitations.
- **Dollars are list-price dollars as `/cost` counts them**, read from Claude Code's own ledger, subagents included. onbudget does no pricing of its own.
- **Window budgets are in whole points of the window, for the whole account**, as Claude Code reports them. `10% 5h` is ten points of the 5-hour window, not ten percent of what is left. `5h` is what the 5-hour window has left below 99% when you set the budget. A weekly budget (`week`, `N% week`) is counted in the weekly window's own points unless you set `usdPerPointWeek`, and is good to about a point.
- **Every budget is also bounded by what the account has left.** While a budget is open, both windows count as limits, and onbudget stops short of either one with its own notice (at 99%, or about 97% when it counts the window's points), before Claude Code's limit message would end the session in the middle of a request.
- **It lands early.** The model reads where the stop is and wraps up before it. In the second round the three onbudget runs ended by themselves at tier LOW with 19 to 25% of the budget unspent.
- **Idle means idle.** With no budget set, onbudget adds nothing to Claude's context and changes no request.

## Results

The benchmark: seven real bug fixes in Python libraries (boltons, falcon, markdown-it-py, pluggy, pydantic-settings and two in werkzeug), given in one prompt to one headless session and scored by upstream tests the model never saw. `eval/TASKS.md` names each task's repository, commits and hidden tests. Claude Opus 5.5 at medium effort; `REPORT.md` has the method, both rounds' full tables and the exceptions, and `eval/` the raw data.

At $2.47 on Claude Code 2.1.304 (the release current on 2026-10-20):

| | n | Tasks complete, of 7 | Within $2.47 | Ended by itself, with a report | Cost, each run |
| --- | --- | --- | --- | --- | --- |
| onbudget | 3 | 5, 5, 5 | 3 of 3 | 3 of 3 | $2.00, $1.86, $1.97 |
| Plain, `--max-budget-usd 2.47` | 2 | 5, 6 | 2 of 2 | 2 of 2 | $2.06, $2.25 |
| Budget sentence in the prompt | 2 | 5, 5 | 2 of 2, one only because a safety cap refused its next request | 1 of 2 | $2.38, $2.10 |

- No onbudget run has gone over its budget: 12 runs with the real model, on Claude Code 2.1.289 and 2.1.304 (10 seven-task sessions and 2 single tasks). 11 of the 12 ended by themselves with a report.
- On 2.1.304 it is parity: onbudget finished no more tasks than plain Claude Code under its own cap or a sentence in the prompt. With n of 2 or 3, a difference of a task or less is noise. The six-task `--max-budget-usd` run did most of its work in seven subagents that Claude Code ran on Claude Sonnet 5.5 ($1.32 of its $2.25); the other, Opus only, finished 5 of 7.
- The build that ships is not byte for byte the one round two ran (git tag `eval-freeze-3`). `git diff eval-freeze-3 -- hooks .claude-plugin` shows weekly sizing (a weekly budget counts the window's points unless `usdPerPointWeek` is set) and display text only: the command's answers, the status line, the end-of-task line and the manifest's descriptions. Rendered side by side with `tests/e2e/modeltext.py`, what the model receives is identical under dollar and 5-hour budgets, which is what round two ran, and differs only under weekly budgets.
- On 2.1.289, with an earlier build of onbudget (git tag `eval-freeze`), plain Claude Code under a cap split the work across subagents in six of eight runs and was cut off mid-work; that round's table is in `REPORT.md`.
- Every run had a one-line `~/CLAUDE.md` in context, a pointer to a writing-style skill.

## How it relates to what Claude Code already does

- **`--max-budget-usd`** works in print mode and the SDK only and is checked after each response, and its documentation says spend can pass it. onbudget checks before each request and also works in a terminal session.
- **The `<total_tokens>` countdown** is undocumented and set by the server, padded to 15 million tokens. It has been in Claude Code builds since at least 2.1.200, on by default since at least 2.1.235, and 2.1.304 sends it only for models with a certain capability. It is not a task budget; while a budget is open onbudget leaves it out of new requests (see How it works).
- **The warning at 85% of the session limit** tells you; onbudget acts on the model's requests.
- **Auto-continue at a reset** (2.1.234 and later) carries on after the limit resets; a budget does not grow at a reset.
- **The Wrap-Up Allowance** lets a response in progress finish at the 5-hour limit. It is rolling out gradually and does not apply to API keys. onbudget stops before either limit, including the weekly one, where the allowance does not apply.
- **A near-limit note** ("Claude will wrap up the current step") has been in the binaries since 2.1.250 behind a flag; onbudget's meter tells the model what is left throughout.
- **The hidden `--task-budget` flag and the SDK's `taskBudget` (alpha)** set an API-side budget in tokens; onbudget does not use them.
- None of these gives a task a budget in an interactive session, and none acts at the weekly limit.

## Other plugins

Budgets on the weekly window already exist: redline (sankalpgunturi/redline, `80% 7d`), markwpearce/rainy-day-plugin, nikhilsitaram/claude-caliper's usage-guard (`--window 7d`, stopping at 99% by default), MohammadMD1383/claude-usage-plugin and michael-L-i/agent-budget. HeyCubit/effortless lowers effort near the limit. ccdwyer/budget-governor (a mod), cost-guard and budgetclaw cap dollars in interactive sessions. They enforce by locking tools, blocking prompts, ending the process (Keesan12/martin-loop) or proxying the API (metahumansworld/SIwithin). As far as both Anthropic marketplaces and a GitHub search showed on 2026-10-21, onbudget is the only one that refuses the individual model request from inside Claude Code, and the only one that publishes an evaluation with its raw data.

## Install

onbudget needs Claude Code 2.1.287 or later: from that release the mods API it is built on (function hooks in plugins) is on by default. Its test suites passed on Claude Code 2.1.288 and 2.1.304, on macOS, and all but the terminal suite pass in GitHub Actions on Linux with the release current at each push.

```bash
claude plugin marketplace add sebastiandrazsky/onbudget
claude plugin install onbudget@onbudget
```

Inside a Claude Code session the same two commands start with `/plugin` instead of `claude plugin`. To stay on this release until you choose to move, add the marketplace pinned to its tag instead:

```bash
claude plugin marketplace add sebastiandrazsky/onbudget#v0.1.0
```

From a local checkout, for one session: `claude --plugin-dir /path/to/onbudget`.

Type `/onbudget`. It should answer `onbudget: no budget is set` and name its version and the Claude Code builds it was tested on.

### When onbudget is not running, there is no budget

Nothing outside the plugin enforces a budget. If the plugin does not run, requests are neither metered nor refused, and `ONBUDGET` is ignored, so a headless task runs with no budget at all. That happens when Claude Code starts in safe mode (`--safe-mode`) or `--bare` mode, which load no plugins; when an organisation's managed settings turn plugins or mods off; when Anthropic switches the mods API off; and when Claude Code unloads the plugin (see "The hooks worker" under Limitations). A plugin that runs before onbudget can also skip its hooks; from 2.1.304 the transcript names the plugin and the event when it does. A request whose hook does not run is not checked, though its cost is in the ledger the next check reads. A hook that runs and fails, or runs out of time, is different: while a budget is set, the request is not sent, and the plugin says so (`[onbudget] Not sent: the budget check could not be completed`).

How to tell. In a terminal session, `/onbudget` is offered when you type `/onb`, and once a budget is set a status line under the prompt shows the tier and what is left. Without the plugin, `/onbudget` is not offered and, typed anyway, is sent to Claude as an ordinary prompt. In a headless run, `claude -p "/onbudget"` prints `onbudget: no budget is set` without a model request when the plugin is running; or set `ONBUDGET_LOG` to a file name, and if the file is not there after the run, the plugin did not run.

## Use

### A dollar budget

```
/onbudget $3 Implement authentication
```

The task is sent with a short protocol appended, which you can read in the transcript: the budget, how to work under it, and how to report at the end. From then on:

- A status line under the prompt shows the tier, what is left before the stop and the budget, for example `onbudget: tier MEDIUM · $1.60 left · budget $3.00`. When one of the account's windows is closer than the budget it is named, as in `tier HIGH · $61.16 left (5h limit) · budget $500.00`. Under a budget counted in points the figures are points, as in `tier HIGH · 78 pts left · budget 81 pts (week)`, and a budget that has stopped reads `STOPPED · $2.91 of $3.00 · /onbudget off`. `/onbudget` gives the full reading.
- After each tool result Claude is shown the meter, a longer line with the same figures: `[budget] spent $1.23 of $3.00 | left before the stop $1.60 (53%) | tier MEDIUM`. "Left before the stop" is exactly what the stop rule still allows, so the meter and the status line read $0.00 when the next request will be refused.
- Reasoning effort is capped at `medium` while the budget is set. Your setting comes back when the budget is removed.
- When Claude ends the task with its STATUS line, the plugin adds a line of its own in a terminal session: how the task ended, the spend against the budget, how many whole points each usage window moved, and that the budget is still open. Under a budget counted in points it gives the points the window moved against the points budgeted, and the task's own spend in dollars apart.

Follow-up prompts draw on the same budget. Once the budget has stopped the session, a further prompt is turned away with the reason, and nothing is spent on it. `/onbudget off` removes the budget, and `/onbudget <budget> <instructions>` replaces it with a new one.

### A share of a usage window

```
/onbudget 10% 5h Build this application
/onbudget 5% week Fix these bugs
```

A 5-hour point is worth a different number of dollars on every plan, so onbudget learns the rate from your own usage: in every session where the plugin is loaded it records how far each window moved and how much the session cost. A 5-hour percentage budget set after it has seen three points of movement is converted into dollars at that rate, and the dollars are enforced as a dollar budget is. Before a rate is known, the budget is enforced on the window reading itself, in whole points, with a 3% minimum. `/onbudget` shows the rate.

A weekly percentage budget is always enforced on the weekly window's own reading, in whole points, with a 3% minimum, unless you set `usdPerPointWeek` (see Configuration): the weekly rate onbudget learns errs far low (see Limitations), and converting with it would have given at most about two fifths of the share named.

### What a window has left

```
/onbudget 5h Refactor the parser
/onbudget week Write the migration
```

The budget is the points between the window's reading and 99% when you give the command. For `5h` they are converted to dollars when a rate is known; for `week`, only when you have set `usdPerPointWeek`. Otherwise the budget is counted in the window's own points, and onbudget stops about two points short of 99%, because the reading may not yet show the last requests. onbudget keeps one point back from the account's limit because a reading can be up to a point below the true figure. A session with no reading yet (a new session, or a headless run) sizes the budget from the first one, which arrives with Claude's first answer, so that first request goes out before the budget is known. If the window resets while the task runs, the budget stays what it was when you set it.

### Every budget is also bounded by what the account has left

The meter follows whichever comes first, the budget or one of the windows, and names the window when it is the closer one: `left before the stop $0.40 (17%), set by the account's 5-hour limit`. The status line marks it `(5h limit)`. A budget larger than what a window has left says so when you set it and runs against the window. A window with nothing left refuses the budget in one line, and a new session that has no reading of its own uses the last reading seen on this machine for that check, as long as that window has not reset since.

Accounts that report no usage window (an API key, a gateway) have no such limits: dollar budgets work as described, and budgets counted in a window cannot be enforced. A gateway's own spend limit, which Claude Code also reports, is not used.

### Headless runs

```bash
ONBUDGET='$3' claude -p "Implement authentication"
ONBUDGET='5h' claude -p "Build this application"
```

`ONBUDGET` applies to the first prompt of the session, once. If the value cannot be used, the prompt is dropped with the reason; the task is not run without its budget. When the budget stops a headless run, the run's result is the plugin's notice, which begins `[onbudget] Stopped:`.

## How it works

**The ledger.** Spend is the growth of the session's own cost ledger since the budget was set. Each request is charged the ledger's growth since the previous request completed, and no more than its growth since the request was sent, so a request is not charged for the ones that ran beside it or for what was spent between requests. Two requests that finish at the same instant cannot be told apart: the first to read the ledger is charged both, the total stays exact, and the reserve errs high.

**The stop.** A request cannot be priced before it is sent, so the plugin holds back what the dearest request so far has cost: refuse when `spent + reserve × (requests in flight + 1) ≥ budget`. A window of the account is a limit of the same shape. With a rate, its room is converted into the task's dollars from the reading that came with the latest answer; without one, each request is reckoned to move the window by a point, or by the largest step seen between two readings.

**The meter.** Claude is told the budget once, with the task, and shown the meter after every tool result. The tier is HIGH from 70% left, MEDIUM from 30%, LOW from 10%, and CRITICAL below that or when two requests' worth or less is left at the cost of the dearest so far (two points, for a budget counted in points). Claude has therefore read CRITICAL at least twice before a request can be refused, on one condition: requests one at a time, none costing more than the dearest before it. At small budgets that condition often fails. In the acceptance of 2026-10-21, the three live runs that came near the stop ($0.12, $0.15 and $0.25, on Claude Code 2.1.304 with Claude Opus 5.5) each read CRITICAL once, not twice, because a request cost more than any before it; none passed its budget. The protocol asks Claude to stop adding scope at LOW, to leave the tree in its best verified state at CRITICAL, to verify before it claims anything, and to end with what is complete, what is unfinished and what was not verified. After a compaction the protocol is sent again.

**Claude Code's countdown.** While a budget is open, onbudget leaves Claude Code's `<total_tokens>` countdown out of new requests, because it is not the task's budget. This is partial: the copy in the system prompt stays. Its effect on the model was never measured. An attachment already sent keeps the answer it was sent with, and a resumed session gets the same answers again, so the prompt cache's prefix does not change. A countdown under a million tokens could be a budget you set yourself, and is kept; so is any countdown when `CLAUDE_CODE_TOTAL_TOKENS_REMINDER` is set.

**Effort.** Each request's effort is lowered to the cap and never raised. Nothing in your settings is changed, so there is nothing to restore.

## What it reads, writes and changes

`claude plugin validate --strict .claude-plugin/plugin.json` lists every engine call the plugin can make:

```
./register.ts calls: $.clock.after (via submitLater), $.clock.now, $.command.register, $.env.get (via load), $.fs.write (via log), $.prompt.submit (via submitLater), $.session.id, $.session.model (via calModel, rateFor), $.session.usage, $.session.version, $.store.delete, $.store.get (via calModel, load, otherRecords, prune, startReadings), $.store.keys (via otherRecords, prune), $.store.set, $.ui.log (via say), $.ui.status (via showStatus)
./register.ts env writes: nothing
./register.ts env reads: CLAUDE_CODE_TOTAL_TOKENS_REMINDER, ONBUDGET, ONBUDGET_EFFORT, ONBUDGET_LOG
```

It reads the session's cost and usage-window readings, the session id and model, those four environment variables, and its own store. It writes its own store, a JSON file under your Claude config directory (`plugins/store/onbudget_*.json`): the budget of each session that has one, calibration records (dollars spent and points moved per session, window and model, nothing else), the newest reading of each window with its reset time, and, per budgeted session, which countdowns it left out. Records older than 30 days are deleted. It writes a status line, and an event log only if `ONBUDGET_LOG` names a file.

While a budget is set, and only then, it changes four things: the effort of each request, one line of context after each tool result and with each follow-up prompt, whether a request is sent at all, and whether Claude Code's countdown goes into a new request. The plugin is two files, `hooks/core.ts` (the logic) and `hooks/register.ts` (the hooks), about 1,350 lines together. Installing it copies the whole repository, `eval/` and `tests/` included; the plugin never loads either.

## Limitations

**One request can pass the budget.** The API cannot cap what one request costs, and a request can cost more than any before it, usually the first after a long idle period, which re-reads the whole conversation at the cache-write price. That request overruns the budget, can skip the CRITICAL tier, and the plugin stops at the next one with the real figure. A compaction's own request is sent by Claude Code and is not checked; its cost is counted.

**Claude Code's own requests are counted, not stopped.** In a terminal session Claude Code makes a request of its own when a turn ends, to suggest your next prompt. It does not pass through the hook the plugin refuses requests on, so the spend can end a few cents past the budget: in a test on Claude Code 2.1.289, a $0.07 budget stopped at $0.069 finished at $0.115. `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` removes that request. Headless runs do not make it.

**A budget that fits only a few requests gives little warning.** In the acceptance's live runs (Claude Code 2.1.304, Claude Opus 5.5), the first request of a session cost about $0.03 to $0.07 and the next up to three times as much. Before any request has been priced the reserve is $0.05, so at $0.12 a first request of $0.065 left no room for a second, and the meter had no request at CRITICAL to show. Give a task room for several of its dearest requests if Claude is to see the stop coming.

**It lands early.** The meter makes the model wrap up before the stop, so part of the budget usually goes unspent: 19 to 25% in the second round's three onbudget runs, which all ended at LOW. Under a budget counted in points the meter turns CRITICAL with two points left, which is a large share of a small weekly budget.

**The stop falls between requests.** The plugin can refuse a request; it cannot choose a good moment in the work. If the model does not wrap up in time, the stop can land in the middle of an edit. Parallel subagents make the stop come early, because each request in flight holds back a reserve. In the evaluation the real model never started a subagent under onbudget, so the accounting for requests in flight is tested with a scripted model running two subagents side by side in a real Claude Code process.

**Window readings are whole points for the whole account.** Your other sessions move the same readings, by more than the point onbudget keeps back if they are busy between two readings, and then Claude Code's own limit can still end the task first. On the account onbudget was built on, a 5-hour point was worth about $0.81 to $0.95 of list-price usage, so a `5h` budget, or the 5-hour limit under any budget, is known to within about a dollar there. A weekly point was worth at least $8.50: the first round's $59.49 of evaluation spend moved the weekly reading 6 whole points, so fewer than 7 true points. An upper bound needs a span in which nothing else used the account, which the evaluation did not have. A weekly budget in points is therefore good to about a point, at least $8.50 there. The rate onbudget learns for the weekly window stood at $3.24 to $3.49: it had seen the window move only 4 points in 19 sessions, so its allowance for rounding halves the raw $6.49, and other sessions' movement is counted against each session's own spend. That is why weekly budgets count points unless you set `usdPerPointWeek`. The learned weekly rate is still used for the weekly limit under dollar and 5-hour budgets, where it errs toward stopping early. A 5-hour percentage budget converted with a learned rate buys somewhat less than its nominal share, because the rate errs low on purpose.

**Model-specific limits are not seen.** Some plans also limit individual models. Claude Code's mods API reports only the 5-hour and weekly windows and a gateway's spend limit; the per-model figures exist only on an undocumented endpoint that needs the session's credential and a network call, and onbudget makes neither. A model-specific limit can end a task without onbudget seeing it coming.

**The hooks worker.** Installed mods share one worker thread. While it restarts, Claude Code refuses the calls a mod's guard hook would have seen rather than let them past (changelog, 2.1.292 and 2.1.295). If the worker crashes and Claude Code traces the crash to one mod, it unloads that mod, and after three crashes it cannot trace, it unloads every installed mod until `/reload-plugins` or a new session (Claude Code docs, "Troubleshoot mods"). With onbudget unloaded there is no budget; the transcript says which mod was unloaded.

**Effort defaults differ by model.** Claude Code's default effort is medium on Opus, Sonnet and Haiku 5.5, so the cap changes nothing there unless you raised it. On Fable 5.1 the default is high and the cap applies. effortless reports that changing effort in the middle of a conversation rewrote most of the prompt cache on Fable 5.1 and older Opus models (not verified here), so setting a budget in a long Fable conversation may cost one cache rewrite; the `effort` option `keep` avoids it.

**Another plugin can override the effort cap.** effortless (HeyCubit/effortless) also sets each request's effort. Claude Code orders plugins only by their manifests' dependencies, so which one wins depends on the order they load in. When a request goes out above the cap, onbudget names the plugin once, logs every such request, and shows it in `/onbudget`. The stop is unaffected, because it reads the ledger.

**One countdown can show after a resume.** In the first request of a resumed session, a new countdown cannot be told from the ones already sent, so it is kept.

**What the evaluation covered.** One model (Claude Opus 5.5; one plain run's subagents ran on Claude Sonnet 5.5), one kind of task (bug fixes in Python libraries with test suites), on macOS. Windows, the VS Code, desktop and mobile surfaces, other models, teammates and workflow agents have not been tested; Linux only by the test suites. No evaluated run used a weekly budget.

**Completion claims are Claude's.** The plugin measures spend, not whether the work is right. The protocol asks Claude to verify before claiming and to say what it did not verify, and the STATUS line can still be wrong: in the first round (Claude Code 2.1.289) one of 42 claims made under onbudget was wrong, a task reported complete with 47 of its 48 hidden tests passing; in the second (2.1.304) none of 21 was.

**Dollar figures are list prices.** On a subscription you are not billed these dollars; they are the unit Claude Code's ledger counts in.

## Configuration

Set these with `/config` after installing, or in `pluginConfigs` in your settings. The installer says the three options are not yet set; until you set them, the defaults below apply.

| Option | Default | Meaning |
| --- | --- | --- |
| `effort` | `medium` | Effort cap while a budget is set: `low`, `medium`, `high`, or `keep` to leave effort alone. |
| `usdPerPoint5h` | `0` | Dollars of list-price usage per point of your 5-hour window. `0` means learn it. |
| `usdPerPointWeek` | `0` | Dollars per point of your weekly window. `0` means weekly budgets count the window's own points; the learned rate is then used only for the weekly limit under other budgets. |

Environment variables: `ONBUDGET` (budget for the first prompt, in any of the forms above), `ONBUDGET_EFFORT` (overrides the `effort` option), `ONBUDGET_LOG` (path of a JSON-lines event log).

## Development

```bash
claude plugin validate --strict .claude-plugin/plugin.json   # the plugin manifest and hooks as the engine reads them
claude plugin validate --strict .                            # the marketplace manifest
claude plugin test .                                         # tests/*.test.ts, run inside the engine
python3 tests/e2e/run.py                                     # a real `claude -p` with a scripted model
python3 tests/e2e/wire.py                                    # a real `claude -p` against a fake API on localhost: what is sent
python3 tests/e2e/interactive.py                             # a real terminal session through a pseudo-terminal, 80 columns
python3 tests/e2e/modeltext.py <build A> <build B>           # what the model receives from two builds, compared byte for byte
```

None of these makes a model request or spends anything. `ONBUDGET_CLAUDE_BIN` points the Python suites at another Claude Code build, and `EFFORTLESS_DIR` adds effortless to `wire.py`. The GitHub workflow runs the first five against the current Claude Code release on every push and weekly.

The test suites start Claude Code processes with a scripted model or a fake Anthropic API on 127.0.0.1, and a fake key. `run.py` and `wire.py` give each process a config directory of its own; `interactive.py` uses yours, because a new one stops at the first-run screens, and removes what its sessions stored there when it ends. `eval/` is the paid evaluation: it starts headless Claude Code sessions under your own login, runs the test suites of the task repositories, and before each session checks that `https://api.anthropic.com` answers and that `claude auth status` reports a login. `eval/README.md` explains how to run it and what it costs, `eval/TASKS.md` identifies the tasks, `eval/rebuild_tasks.py` rebuilds them from GitHub and PyPI, and `eval/runs/` keeps each run's logs and scores, with this machine's home path replaced by `/Users/user`.

Every change users should receive bumps `version` in `.claude-plugin/plugin.json`, in both places in `.claude-plugin/marketplace.json`, and `VERSION` in `hooks/core.ts` (a test compares them), with a `CHANGELOG.md` entry: Claude Code updates an installed plugin only when its version changes.

To rename the plugin, change `NAME` in `hooks/core.ts`, the two literal `'onbudget'` strings in `hooks/register.ts` (the command registration and its matcher), the `name` fields in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and the `ONBUDGET*` variable names if you want those to follow.

## Security

To report a vulnerability, see `SECURITY.md`.

## License

MIT, copyright 2026 Sebastian Drazsky. See `LICENSE`. Code quoted from the benchmark's upstream projects in `eval/` keeps its own licences; see `eval/THIRD_PARTY_NOTICES.md`.
