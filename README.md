# onbudget

Give Claude Code a task and a usage budget. It meters what the task spends, shows Claude the meter so it can pace itself, and refuses the request that would take the task past the budget.

```
/onbudget $3 Implement authentication
/onbudget 10% 5h Build this application
/onbudget 5% week Fix these bugs
/onbudget            show the budget and what is spent
/onbudget off        remove the budget
```

A budget is in dollars of API-equivalent usage (what `/cost` counts), or a share of your 5-hour or weekly usage window. The goal is as much finished, verified work as the budget allows, and an honest account of what is left when it runs out.

onbudget is a free, open-source Claude Code plugin. It makes no network calls, runs no commands, and has no dependencies or build step.

<!-- COMPARISON:START -->
## Measured against plain Claude Code

The evaluation has not finished. See `REPORT.md` for its status.
<!-- COMPARISON:END -->

## Install

onbudget uses Claude Code's function-hooks plugin API, which is early access. It was built and tested on Claude Code 2.1.289 and 2.1.293.

From a marketplace, once the repository is published (replace `<owner>` with the GitHub account that hosts it):

```
/plugin install onbudget --marketplace <owner>/onbudget
```

From a local checkout, for one session:

```bash
claude --plugin-dir /path/to/onbudget
```

Check that it loaded by typing `/onbudget`. It should answer "no budget is set". If the command is not offered, the function-hooks API is switched off in your build: start Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and try again.

## Use

### A dollar budget

```
/onbudget $3 Implement authentication
```

The task is sent with a short protocol appended, which you can read in the transcript: the budget, how to work under it, and how to report at the end. From then on:

- A status line under the prompt shows the spend, for example `onbudget: spent $1.23 of $3.00 | remaining 59% | tier MEDIUM`.
- After each tool result Claude is shown the same line. That reading is what lets it decide to cut scope, verify what it has, and wrap up before the money runs out.
- Reasoning effort is capped at `medium` while the budget is set. Your setting comes back when the budget is removed.
- A request is refused when the task's spend, plus a reserve for that request, would reach the budget. Claude does not get to answer; the plugin writes the notice itself and says so.

Follow-up prompts draw on the same budget. `/onbudget off` removes it, and `/onbudget <budget> <instructions>` replaces it with a new one.

### A share of a usage window

```
/onbudget 10% 5h Build this application
/onbudget 5% week Fix these bugs
```

Claude Code reports your usage windows as whole percentage points for the whole account. A point is worth a different number of dollars on every plan, so onbudget learns the rate from your own usage: in every session where the plugin is loaded it records how far each window moved and how much the session cost. A percentage budget set after it has seen three points of movement is converted into dollars at that rate, and the dollars are enforced exactly as a dollar budget is. `/onbudget` shows the rate it has learned.

A percentage budget set before a rate is known is enforced on the window reading itself, and keeps that rule until it ends. That works, but coarsely: the reading is in whole points, it lags by one request, and it counts everything on the account, including your other sessions. The smallest budget in this mode is 3%. It also stops if the window fills up or stops being reported, because then the reading can no longer show what the task uses. onbudget tells you which mode a budget is in when you set it.

If you already know your rate you can set it in the plugin's options instead of waiting (see Configuration).

### Headless runs

```bash
ONBUDGET='$3' claude -p "Implement authentication"
ONBUDGET='10% 5h' claude -p "Build this application"
```

`ONBUDGET` applies to the first prompt of the session, once. If the value cannot be used, the prompt is dropped with the reason; the task is not run without its budget. When the budget stops a headless run, the run's result is the plugin's notice, which begins `[onbudget] Stopped:`.

## How it works

### The ledger

Spend is the growth of the session's own cost ledger since the budget was set. The ledger is Claude Code's, counted per API response at list prices, and it includes subagents. onbudget does no pricing of its own.

### The reserve

A request cannot be priced before it is sent, so the plugin holds back what the dearest request so far has cost. The stop rule is: refuse when `spent + reserve × (requests in flight + 1) ≥ budget`. Subagents run requests beside the main thread, and each one in flight may still cost a reserve. Each request is charged the ledger's growth since the previous request completed, and no more than its growth since the request was sent, so a request is not charged for the ones that ran beside it or for what was spent between requests.

### The meter and the protocol

The model is told the budget once, with the task, and shown the meter after every tool result: spent, remaining, and a tier (HIGH, MEDIUM, LOW, CRITICAL). The protocol asks it to stop adding scope at LOW, to leave the tree in its best verified state at CRITICAL, to verify before it claims anything, and to end with what is complete, what is unfinished, and what was not verified. After a compaction the protocol is sent again, because the prompt that carried it may have been summarised away.

### Effort

Each request's effort is lowered to the cap and never raised. Nothing in your settings is changed, so there is nothing to restore.

## What it reads, writes and changes

It reads the session's cost and usage-window readings, the session id and model, three environment variables (`ONBUDGET`, `ONBUDGET_EFFORT`, `ONBUDGET_LOG`), and its own store.

It writes its own store, a JSON file under your Claude config directory (`plugins/store/onbudget_*.json`): the budget of each session that has one, and calibration records (dollars spent and points moved per session, window and model, nothing else). Records older than 30 days are deleted. It writes a status line. If `ONBUDGET_LOG` names a file, it writes an event log there; otherwise it logs nothing.

While a budget is set, and only then, it changes three things: the effort of each request, one line of context after each tool result and with each follow-up prompt, and whether a request is sent at all. With no budget set every hook passes its event through untouched.

The whole plugin is two files, `hooks/core.ts` (the logic) and `hooks/register.ts` (the hooks), about 850 lines together.

## Limitations

### The stop is a reserve, and a request can exceed it

The API offers no way to cap what one request costs, and a request can cost more than any before it. The usual cause is a long idle period: the first request afterwards re-reads the whole conversation at the cache-write price. When that happens the budget is overrun by that one request, and the plugin stops at the next one and reports the real figure. Requests already in flight when the budget stops are not cancelled. A compaction's own model request is sent by Claude Code and is not checked; its cost is counted.

### The stop falls between requests

The plugin can refuse a request; it cannot choose a good moment in the work. If the model does not wrap up in time, the stop can land in the middle of an edit. The meter exists to prevent that, and in the evaluation the model usually ended by itself, but nothing forces it to.

### Completion claims are Claude's

The plugin measures spend. It does not know whether the work is right. The protocol tells Claude to verify before claiming and to list what it did not verify, and the evaluation scores those claims against hidden tests (see `REPORT.md`), but a wrong claim is possible. When the plugin itself stops a session it makes no claim and says the work should be treated as unfinished.

### Verification under a tight budget

The protocol tells Claude not to skip checks to save money and to do fewer things instead. `REPORT.md` shows how often it ran the tests in each arm of the evaluation.

### Percentage budgets rest on an estimate

Claude Code does not expose what a percentage point costs. The learned rate errs low on purpose, so a percentage budget buys somewhat less than its nominal share, more so on a new install with little data. Other sessions on the account push the rate lower still. The rate is learned per model; a list-price dollar is assumed to move the window equally whatever the request.

The rate belongs to the machine's Claude config directory, not to an account. If your plan changes, or you log in to another account, the old rate is wrong until new readings outweigh it or you delete the store file. As a backstop the plugin stops a converted budget when the window has moved more than twice the budgeted points. Accounts that report no usage window (API keys, gateways) cannot use percentage budgets at all.

### Dollar figures are list prices

On a subscription you are not billed these dollars. They are the unit Claude Code's ledger counts in.

### The API underneath is early access

Function hooks may change between Claude Code releases without notice. `claude plugin validate .` and `claude plugin test .` in this repository tell you whether a new build still accepts the plugin.

### Effort given as a number

The cap applies to the named effort levels. A request whose effort is a number (some agent definitions set one) is sent unchanged.

### Not verified

Windows and Linux, the VS Code and mobile surfaces, the desktop app's Code tab, models other than Claude Opus 5.5, teammates and workflow agents, and sessions longer than a few hundred requests have not been tested. Switching sessions with `/resume` inside a running session is covered by the engine-level tests only, not by a real terminal run.

## Configuration

Set these with `/config` after installing, or in `pluginConfigs` in your settings.

| Option | Default | Meaning |
| --- | --- | --- |
| `effort` | `medium` | Effort cap while a budget is set: `low`, `medium`, `high`, or `keep` to leave effort alone. |
| `usdPerPoint5h` | `0` | Dollars of list-price usage per point of your 5-hour window. `0` means learn it. |
| `usdPerPointWeek` | `0` | The same for the weekly window. |

Environment variables: `ONBUDGET` (budget for the first prompt), `ONBUDGET_EFFORT` (overrides the `effort` option), `ONBUDGET_LOG` (path of a JSON-lines event log).

## Development

```bash
claude plugin validate .            # the manifest and hooks as the engine will read them
claude plugin test .                # the tests in tests/*.test.ts, run inside the engine
python3 tests/e2e/run.py            # end-to-end against the real CLI with a scripted model; sends nothing
python3 tests/e2e/interactive.py    # the same in a real terminal session through a pseudo-terminal
```

None of these makes a model request. `eval/` holds the paid evaluation; `eval/README.md` explains how to run it and what it costs.

To rename the plugin, change `NAME` in `hooks/core.ts`, the two literal `'onbudget'` strings in `hooks/register.ts` (the command registration and its matcher), the `name` fields in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and the `ONBUDGET*` variable names if you want those to follow.

## License

MIT. See `LICENSE`.
