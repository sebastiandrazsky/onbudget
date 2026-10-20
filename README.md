# onbudget

onbudget gives a Claude Code task a hard budget, in dollars or in points of your 5-hour or weekly usage window. Before each model request it checks whether the budget can still cover that request. If it cannot, the request is not sent.

```
/onbudget $3 Implement authentication
/onbudget 10% 5h Build this application
/onbudget 5% week Fix these bugs
/onbudget 5h Refactor the parser       what the 5-hour window has left
/onbudget week Write the migration     what the weekly window has left
/onbudget            show the budget, the spend and the points moved
/onbudget off        remove the budget
```

## What it guarantees, and in which units

- **The refusal happens before the request is sent.** onbudget sits on Claude Code's model-request hook. When the spend so far, plus what the dearest request of the task has cost, would reach the budget, the next request is answered by the plugin with a notice and never reaches the API. Requests already running are not cancelled, and each one holds back its own reserve.
- **Dollars are list-price dollars as `/cost` counts them**, read from Claude Code's own ledger, subagents included. onbudget does no pricing of its own.
- **Window budgets are in whole points of the window, for the whole account**, as Claude Code reports them. `10% 5h` is ten points of the 5-hour window, not ten percent of what is left. `5h` and `week` are what the window has left below 99% when you set the budget.
- **Every budget is also bounded by what the account has left.** While a budget is open, both windows count as limits, and onbudget stops at 99% of either one with its own notice, before Claude Code's limit message would end the session in the middle of a request.
- **Idle means idle.** With no budget set, onbudget adds nothing to Claude's context and changes no request. It makes no network calls, runs no commands, and reads no credentials.

Where a budget can still be passed, and by how much, is under Limitations: one request that costs more than any before it, and Claude Code's own request between turns.

## Results

The benchmark: seven real bug fixes in Python libraries (boltons, falcon, markdown-it-py, pluggy, pydantic-settings and two in werkzeug), given in one prompt to one headless session and scored by upstream tests the model never saw. Claude Opus 5.5 at medium effort in every run. Every row names its Claude Code version and n, the number of runs; with n of 2 or 3, treat a difference of a task or less as noise. `REPORT.md` has the method and the full tables, and `eval/` the raw data.

At $2.47 on Claude Code 2.1.304, the release current on 2026-10-20:

| | Claude Code | n | Tasks complete, of 7 | Within $2.47 | Ended by itself, with a report | Wrong completion claims | Cost, each run | Per finished task |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| onbudget | 2.1.304 | 3 | 5, 5, 5 | 3 of 3 | 3 of 3 | 0 of 21 | $2.00, $1.86, $1.97 | $0.39 |
| Plain, `--max-budget-usd 2.47` | 2.1.304 | 2 | 5, 6 | 2 of 2 | 2 of 2 | 0 of 14 | $2.06, $2.25 | $0.39 |
| Budget sentence in the prompt | 2.1.304 | 2 | 5, 5 | 2 of 2, one only because a safety cap refused its next request | 1 of 2 | 0 of 7 | $2.38, $2.10 | $0.45 |

- No onbudget run went over its budget, here or in the first round (Claude Code 2.1.289: 7 runs of the seven-task session and 2 single-task runs).
- On this build onbudget finished no more tasks than plain Claude Code under its own cap or a sentence in the prompt. Claude Code 2.1.304 shows a plain session budget signals of its own: its token countdown, and with `--max-budget-usd` the budget in the system prompt. Neither `--max-budget-usd` run reached the cap, so these runs do not show what happens there.
- By task count: five tasks cost onbudget $1.86 to $2.00, the `--max-budget-usd` arm $2.06 and the sentence arm $2.10 and $2.38; six tasks cost the `--max-budget-usd` arm $2.25. The second `--max-budget-usd` run used seven subagents; no onbudget run used any.
- One sentence-arm run was still working at $2.38 when the evaluation's silent safety cap, which applies onbudget's stop rule, refused its next request; it ended without a report. Without a cap, nothing in that arm would have stopped it.

In the first round, on Claude Code 2.1.289, with an earlier build of onbudget (git tag `eval-freeze`):

| | Budget | n | Tasks complete, of 7 | Within budget | Ended by itself, with a report | Wrong completion claims | Cost, each run |
| --- | --- | --- | --- | --- | --- | --- | --- |
| onbudget | $4.20 | 3 | 7, 7, 6 | 3 of 3 | 3 of 3 | 1 of 21 | $3.07, $3.57, $3.67 |
| Budget sentence in the prompt | $4.20 | 2 | 5, 6 | 2 of 2 | 2 of 2 | 0 of 14 | $1.92, $2.69 |
| Plain, simple cap | $4.20 | 2 | 5, 6 | 0 of 2 | 0 of 2 | none made | $4.25, $4.25 |
| Plain, onbudget's stop rule as a silent cap | $4.20 | 2 | 5, 3 | 2 of 2 | 0 of 2 | none made | $3.35, $3.25 |
| onbudget | $2.47 | 3 | 6, 5, 6 | 3 of 3 | 2 of 3 | 0 of 14 | $2.32, $1.84, $2.16 |
| Budget sentence in the prompt | $2.47 | 3 | 5, 5, 5 | 3 of 3, one only because the safety cap refused its next request at $2.33 | 2 of 3 | 0 of 14 | $2.33, $2.05, $2.08 |
| Plain, simple cap | $2.47 | 2 | 0, 1 | 0 of 2 | 0 of 2 | none made | $3.14, $3.57 |
| Plain, onbudget's stop rule as a silent cap | $2.47 | 2 | 0, 1 | 2 of 2 | 0 of 2 | none made | $2.01, $1.78 |

On 2.1.289, plain Claude Code under a cap split the work across subagents in six of eight runs and was cut off mid-work. Per finished task at $4.20, onbudget cost $0.52 and the sentence $0.42, but onbudget finished the two dearest tasks that the sentence arm mostly left; by task count, six tasks cost onbudget $3.67 and the sentence $2.69, and only onbudget reached seven ($3.07, $3.57). In one onbudget run at $2.47 the plugin refused the next request at $2.32 before the model had reported; the model had first read CRITICAL one request earlier, which is why the meter now turns CRITICAL two requests before the stop. Every run of both rounds had a one-line `~/CLAUDE.md` in context, a pointer to a writing-style skill.

## Prior art

Claude Code has budget signals of its own, and other plugins budget too. Claude Code 2.1.304 adds a countdown of tokens left to every request (`<total_tokens>`), counting down from a server-set 15 million at each prompt. Its hidden `--task-budget <tokens>` flag sends an API-side task budget in tokens. Its Wrap-Up Allowance applies at the 5-hour limit and not at the weekly one. `claude -p --max-budget-usd` caps dollars in print mode only, and its documentation says spend can pass the cap. Among plugins, redline (sankalpgunturi/redline) sets session budgets in several forms and locks tools at 90%; MartinLoop (Keesan12/martin-loop) gives dollar task budgets that end a `claude -p` child process; rainy-day (markwpearce/rainy-day-plugin) sets percentage budgets with a tool lock.

What onbudget adds to these is the refusal at the model request, before it is sent, and budgets counted in points of the weekly window as well as the 5-hour one.

## Install

onbudget needs Claude Code 2.1.287 or later: from that release the mods API it is built on (function hooks in plugins) is on by default. The plugin's test suites (`tests/`) all passed on Claude Code 2.1.288 and 2.1.304, on macOS.

From GitHub, in a terminal:

```bash
claude plugin marketplace add sebastiandrazsky/onbudget
claude plugin install onbudget@onbudget
```

or inside a Claude Code session:

```
/plugin marketplace add sebastiandrazsky/onbudget
/plugin install onbudget@onbudget
```

From a local checkout, for one session:

```bash
claude --plugin-dir /path/to/onbudget
```

Type `/onbudget`. It should answer `onbudget: no budget is set` and name its version and the Claude Code builds it was tested on.

### When onbudget is not running, there is no budget

Nothing outside the plugin enforces a budget. If the plugin does not run, requests are neither metered nor refused, and `ONBUDGET` is ignored, so a headless task runs with no budget at all. That happens when Claude Code starts in safe mode (`--safe-mode`) or `--bare` mode, which load no plugins, when an organisation's managed settings turn plugins or mods off, and when Anthropic switches the mods API off.

How to tell. In a terminal session, `/onbudget` is offered when you type `/onb`, and once a budget is set a status line shows the spend under the prompt. Without the plugin, `/onbudget` is not offered and, typed anyway, is sent to Claude as an ordinary prompt. In a headless run, `claude -p "/onbudget"` prints `onbudget: no budget is set` without a model request when the plugin is running; or set `ONBUDGET_LOG` to a file name, and if the file is not there after the run, the plugin did not run.

## Use

### A dollar budget

```
/onbudget $3 Implement authentication
```

The task is sent with a short protocol appended, which you can read in the transcript: the budget, how to work under it, and how to report at the end. From then on:

- A status line under the prompt shows the spend, for example `onbudget: spent $1.23 of $3.00 | left before the stop $1.60 (53%) | tier MEDIUM`.
- After each tool result Claude is shown the same line. "Left before the stop" is exactly what the stop rule still allows, so the line reads $0.00 when the next request will be refused.
- Reasoning effort is capped at `medium` while the budget is set. Your setting comes back when the budget is removed.
- When Claude ends the task with its STATUS line, the plugin adds a line of its own in a terminal session: the spend, how the task ended, how many whole points each usage window moved, and that the budget is still open.

Follow-up prompts draw on the same budget. Once the budget has stopped the session, a further prompt is turned away with the reason, and nothing is spent on it. `/onbudget off` removes the budget, and `/onbudget <budget> <instructions>` replaces it with a new one.

### A share of a usage window

```
/onbudget 10% 5h Build this application
/onbudget 5% week Fix these bugs
```

A point is worth a different number of dollars on every plan, so onbudget learns the rate from your own usage: in every session where the plugin is loaded it records how far each window moved and how much the session cost. A percentage budget set after it has seen three points of movement is converted into dollars at that rate, and the dollars are enforced as a dollar budget is. `/onbudget` shows the rate it has learned. Before a rate is known, the budget is enforced on the window reading itself, in whole points, with a 3% minimum. You can also set the rate yourself (see Configuration).

### What a window has left

```
/onbudget 5h Refactor the parser
/onbudget week Write the migration
```

The budget is the points between the window's reading and 99% when you give the command, converted to dollars when a rate is known and counted in the window's own points when it is not. onbudget keeps one point back from the account's limit because a reading can be up to a point below the true figure; without a rate it keeps about two points more, one for the request the reading may not show yet and one for the next. A session with no reading yet (a new session, or a headless run) sizes the budget from the first one, which arrives with Claude's first answer, so that first request goes out before the budget is known. If the window resets while the task runs, the budget stays what it was when you set it.

### Every budget is also bounded by what the account has left

The meter follows whichever comes first, the budget or one of the windows, and names the window when it is the closer one: `left before the stop $0.40 (17%), set by the account's 5-hour limit`. A budget larger than what a window has left says so when you set it and runs against the window. A window with nothing left refuses the budget in one line, and a new session that has no reading of its own uses the last reading seen on this machine for that check, as long as that window has not reset since.

Accounts that report no usage window (an API key, a gateway) have no such limits: dollar budgets work as described, and budgets counted in a window cannot be enforced. A gateway's own spend limit, which Claude Code also reports, is not used.

### Headless runs

```bash
ONBUDGET='$3' claude -p "Implement authentication"
ONBUDGET='5h' claude -p "Build this application"
```

`ONBUDGET` applies to the first prompt of the session, once. If the value cannot be used, the prompt is dropped with the reason; the task is not run without its budget. When the budget stops a headless run, the run's result is the plugin's notice, which begins `[onbudget] Stopped:`.

## How it works

**The ledger.** Spend is the growth of the session's own cost ledger since the budget was set. Each request is charged the ledger's growth since the previous request completed, and no more than its growth since the request was sent, so a request is not charged for the ones that ran beside it or for what was spent between requests. Two requests that finish at the same instant cannot be told apart: the first to read the ledger is charged both, the total stays exact, and the reserve errs high.

**The stop.** A request cannot be priced before it is sent, so the plugin holds back what the dearest request so far has cost: refuse when `spent + reserve × (requests in flight + 1) ≥ budget`. A window of the account is a limit of the same shape. With a learned rate, its room is converted into the task's dollars from the reading that came with the latest answer; without one, each request is reckoned to move the window by a point, or by the largest step seen between two readings.

**The meter.** Claude is told the budget once, with the task, and shown the meter after every tool result. The tier is HIGH from 70% left, MEDIUM from 30%, LOW from 10%, and CRITICAL below that or when two requests' worth or less is left at the cost of the dearest so far. With requests one at a time, each costing no more than the dearest before it, Claude has therefore read CRITICAL at least twice before a request can be refused. The protocol asks Claude to stop adding scope at LOW, to leave the tree in its best verified state at CRITICAL, to verify before it claims anything, and to end with what is complete, what is unfinished and what was not verified. After a compaction the protocol is sent again.

**Claude Code's own countdown.** Claude Code 2.1.304 adds `<total_tokens>N tokens left</total_tokens>` to every request, counting down from a server-set 15 million. Under a budget that number is not the task's budget, and a model shown both sees two signals that disagree. While a budget is open onbudget leaves the countdown out of new requests through Claude Code's attachment hook. The copy in the system prompt stays. An attachment already sent keeps the answer it was sent with, and a resumed session gets the same answers again, so the prompt cache's prefix never changes. A countdown under a million tokens could be a budget you set yourself, and is kept; so is any countdown when `CLAUDE_CODE_TOTAL_TOKENS_REMINDER` is set.

**Effort.** Each request's effort is lowered to the cap and never raised. Nothing in your settings is changed, so there is nothing to restore.

## What it reads, writes and changes

`claude plugin validate --strict .claude-plugin/plugin.json` lists every engine call the plugin can make:

```
./register.ts calls: $.clock.after (via submitLater), $.clock.now, $.command.register, $.env.get (via load), $.fs.write (via log), $.prompt.submit (via submitLater), $.session.id, $.session.model (via calModel, rateFor), $.session.usage, $.session.version, $.store.delete, $.store.get (via calModel, load, otherRecords, prune, startReadings), $.store.keys (via otherRecords, prune), $.store.set, $.ui.log (via say), $.ui.status (via showStatus)
./register.ts env writes: nothing
./register.ts env reads: CLAUDE_CODE_TOTAL_TOKENS_REMINDER, ONBUDGET, ONBUDGET_EFFORT, ONBUDGET_LOG
```

It reads the session's cost and usage-window readings, the session id and model, those four environment variables, and its own store. It writes its own store, a JSON file under your Claude config directory (`plugins/store/onbudget_*.json`): the budget of each session that has one, calibration records (dollars spent and points moved per session, window and model, nothing else), the newest reading of each window with its reset time, and, per budgeted session, which countdowns it left out. Records older than 30 days are deleted. It writes a status line, and an event log only if `ONBUDGET_LOG` names a file.

While a budget is set, and only then, it changes four things: the effort of each request, one line of context after each tool result and with each follow-up prompt, whether a request is sent at all, and whether Claude Code's countdown goes into a new request. The plugin is two files, `hooks/core.ts` (the logic) and `hooks/register.ts` (the hooks), about 1,200 lines together. `eval/` and `tests/` are not loaded by the plugin.

## Limitations

**One request can pass the budget.** The API cannot cap what one request costs, and a request can cost more than any before it, usually the first after a long idle period, which re-reads the whole conversation at the cache-write price. That request overruns the budget, can skip the CRITICAL tier, and the plugin stops at the next one with the real figure. A compaction's own request is sent by Claude Code and is not checked; its cost is counted.

**Claude Code's own requests are counted, not stopped.** In a terminal session Claude Code makes a request of its own when a turn ends, to suggest your next prompt. It does not pass through the hook the plugin refuses requests on, so the spend can end a few cents past the budget: in a test on Claude Code 2.1.289, a $0.07 budget stopped at $0.069 finished at $0.115. `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` removes that request. Headless runs do not make it.

**The stop falls between requests.** The plugin can refuse a request; it cannot choose a good moment in the work. If the model does not wrap up in time, the stop can land in the middle of an edit. Parallel subagents make the stop come early, because each request in flight holds back a reserve. In the evaluation the real model never started a subagent under onbudget, so the accounting for requests in flight is tested with a scripted model running two subagents side by side in a real Claude Code process.

**Window readings are whole points for the whole account.** On the account onbudget was built on, a 5-hour point was worth about $0.81 to $0.95 of list-price usage, so a `5h` budget, or the 5-hour limit under any budget, is known to within about a dollar there. A weekly point was worth roughly $7 to $20 by the evaluation's own spend, which moved the weekly window only a few whole points in each round. The weekly rate onbudget learns errs low on purpose, and with so little movement it errs far: it stood at $3.24 to $3.49 per point, so a `week` budget in dollars came out at half or less of what the window had left. Setting `usdPerPointWeek` yourself avoids that. Your other sessions move the same readings, between two readings by more than the point onbudget keeps back if they are busy, and then Claude Code's own limit can still end the task first. A percentage budget converted with a learned rate buys somewhat less than its nominal share, because the rate errs low on purpose.

**Model-specific limits are not seen.** Some plans also limit individual models. Claude Code's mods API reports only the 5-hour and weekly windows and a gateway's spend limit; the per-model figures exist only on an undocumented endpoint that needs the session's credential and a network call, and onbudget makes neither. A model-specific limit can end a task without onbudget seeing it coming.

**The hooks worker.** Since Claude Code 2.1.299, when the worker that runs mods cannot be handed an action or cannot answer, Claude Code refuses the actions a mod could have blocked. That applies to every installed mod, onbudget included, with or without a budget set, and no plugin can change it.

**Effort defaults differ by model.** Claude Code's default effort is medium on Opus, Sonnet and Haiku 5.5, so the cap changes nothing there unless you raised it. On Fable 5.1 the default is high and the cap applies. effortless reports that changing effort in the middle of a conversation rewrote most of the prompt cache on Fable 5.1 and older Opus models (not verified here), so setting a budget in a long Fable conversation may cost one cache rewrite; the `effort` option `keep` avoids it.

**Another plugin can override the effort cap.** effortless (HeyCubit/effortless) also sets each request's effort. Claude Code orders plugins only by their manifests' dependencies, so which one wins depends on the order they load in. When a request goes out above the cap, onbudget names the plugin once, logs every such request, and shows it in `/onbudget`. The stop is unaffected, because it reads the ledger.

**One countdown can show after a resume.** In the first request of a resumed session, a new countdown cannot be told from the ones already sent, so it is kept.

**Organisations can turn mods off.** Managed settings can disable plugins or mods, and then there is no budget (see Install).

**What the evaluation covered.** One model (Claude Opus 5.5), one kind of task (bug fixes in Python libraries with test suites), on macOS. Windows and Linux, the VS Code, desktop and mobile surfaces, other models, teammates and workflow agents have not been tested.

**Completion claims are Claude's.** The plugin measures spend, not whether the work is right. The protocol asks Claude to verify before claiming and to say what it did not verify, and the STATUS line can still be wrong: in the first round (Claude Code 2.1.289) one of 42 claims made under onbudget was wrong, a task reported complete with 47 of its 48 hidden tests passing; in the second (2.1.304) none of 21 was.

**Dollar figures are list prices.** On a subscription you are not billed these dollars; they are the unit Claude Code's ledger counts in.

## Configuration

Set these with `/config` after installing, or in `pluginConfigs` in your settings. The installer says the three options are not yet set; until you set them, the defaults below apply.

| Option | Default | Meaning |
| --- | --- | --- |
| `effort` | `medium` | Effort cap while a budget is set: `low`, `medium`, `high`, or `keep` to leave effort alone. |
| `usdPerPoint5h` | `0` | Dollars of list-price usage per point of your 5-hour window. `0` means learn it. |
| `usdPerPointWeek` | `0` | The same for the weekly window. |

Environment variables: `ONBUDGET` (budget for the first prompt, in any of the forms above), `ONBUDGET_EFFORT` (overrides the `effort` option), `ONBUDGET_LOG` (path of a JSON-lines event log).

## Development

```bash
claude plugin validate --strict .claude-plugin/plugin.json   # the plugin manifest and hooks as the engine reads them
claude plugin validate --strict .                            # the marketplace manifest
claude plugin test .                                         # tests/*.test.ts, run inside the engine
python3 tests/e2e/run.py                                     # a real `claude -p` with a scripted model
python3 tests/e2e/wire.py                                    # a real `claude -p` against a fake API on localhost: what is sent
python3 tests/e2e/interactive.py                             # a real terminal session through a pseudo-terminal
```

None of these makes a model request or spends anything. `ONBUDGET_CLAUDE_BIN` points the Python suites at another Claude Code build, and `EFFORTLESS_DIR` adds effortless to `wire.py`. The GitHub workflow runs the first five against the current Claude Code release.

The plugin never loads `tests/` or `eval/`. What they run: the test suites start Claude Code processes with their own config directories, a scripted model or a fake Anthropic API on 127.0.0.1, and a fake key. `eval/` is the paid evaluation: it starts headless Claude Code sessions under your own login, runs the test suites of the task repositories it copies from a local lab directory, and before each session checks that `https://api.anthropic.com` answers and that `claude auth status` reports a login. `eval/README.md` explains how to run it and what it costs, and `eval/runs/` keeps each run's logs and scores, with this machine's home path replaced by `/Users/user`.

To rename the plugin, change `NAME` in `hooks/core.ts`, the two literal `'onbudget'` strings in `hooks/register.ts` (the command registration and its matcher), the `name` fields in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and the `ONBUDGET*` variable names if you want those to follow.

## License

MIT. See `LICENSE`.
