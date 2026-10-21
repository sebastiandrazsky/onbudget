# Privacy

onbudget is a Claude Code plugin. It runs on your machine, inside your Claude Code session. This statement covers onbudget 0.1.2 and says the same as the README's section "What it reads, writes and changes". Last updated 2026-10-22.

## What it sends

Nothing anywhere. No network calls, no commands, no credentials, and no telemetry: nothing goes to the author, to Anthropic or to anyone else from onbudget. With no budget set it changes no request.

While a budget is set, it adds its own text to the requests Claude Code sends to the model: the budget protocol with the task, a meter line after tool results, a note with each follow-up prompt and a reminder after a compaction. The README quotes each text. They hold the budget, the spend and what is left, nothing about you.

## What it reads

- The session's cost ledger and the usage-window readings Claude Code reports, the session's id and model, Claude Code's version, and its own store.
- Three environment variables. None is a secret, and none holds a credential:
  - `ONBUDGET`: a budget for the first prompt of a headless run (`ONBUDGET='$3' claude -p "..."`).
  - `ONBUDGET_LOG`: `1` turns on the event log (below); off when unset, and any other value leaves it off.
  - `CLAUDE_CODE_TOTAL_TOKENS_REMINDER`: Claude Code's own setting, read only to respect it.

Claude Code also hands the plugin's hooks the session's events, your prompts and tool results among them. onbudget uses them to meter the task and to add its own text, and keeps none of them, except the first line of a budgeted task (below).

## What it writes

- **Its store.** One JSON file under your Claude config directory, `plugins/store/onbudget_*.json` (by default `~/.claude/plugins/store/`): the budget of each session that has one, with the first line of its task (at most 120 characters, shown by `/onbudget`), calibration records (dollars spent and points moved per session, window and model, nothing else), the newest reading of each window with its reset time, and, per budgeted session, which countdowns it left out, with the day it last went through other sessions' records. Records older than 30 days are deleted when a session starts: calibration records at every start, other sessions' budgets and flags at the first start of each day.
- **The event log, off by default.** With `ONBUDGET_LOG=1`, one JSON-lines file in the plugin's own folder, `log/events.jsonl`, continued in `log/events.1.jsonl`, `log/events.2.jsonl`, ... every 200 rows. For an install from the marketplace that folder is `plugins/cache/onbudget/onbudget/0.1.2` under your Claude config directory. The path is fixed in the code: no variable or setting can point it anywhere else. It records what the plugin did: the budget with the task's first line, each request's model, effort, token counts and cost, the names of the tools Claude called (not their input or output), the meter lines it added, Claude Code's token countdown when it left one out, the usage-window readings, errors in its own hooks, and the session's id and Claude Code's version. It stays until you delete it.
- **Display only.** The status line under the prompt, and lines in the transcript that Claude does not read: the line under Claude's STATUS line, the note when another plugin raises the effort, and the answers to `/onbudget`.

It writes nothing else: no build, start-up, settings or instructions file, and nothing in your project.

## Personal data

onbudget does not collect personal data such as names, email addresses or postal addresses, and it reads no credentials. The one piece of your own writing it keeps is the first line of each budgeted task, in the store and, if you turned it on, the event log. Whatever you wrote in that line stays on your machine, in the store until the record is deleted after 30 days, and in the event log until you delete it.

To remove everything onbudget keeps, delete `plugins/store/onbudget_*.json` under your Claude config directory and the `log` folder in the plugin's folder.

## Contact

Questions about this statement: open an issue at https://github.com/sebastiandrazsky/onbudget/issues, or write to sebastian@sebastiandrazsky.com. To report a vulnerability privately, see `SECURITY.md`.
