# Checklist before publishing

A pass through onbudget in a real terminal session with a real model. It takes about twenty minutes and costs about $1 of usage, plus what the three real tasks of section 10 spend. Tick each line as you go; anything that does not match is a reason not to publish yet.

The automated suites already drive these same paths against a scripted model (`python3 tests/e2e/interactive.py`), and `eval/interactive_smoke.py` drove steps 1, 2 and 4 with the real model. This checklist is the part no script can do: your own eyes on the screen, and the steps no script covered with a real model (5, 6, and most of 7 and 8).

## Set up

```bash
mkdir -p /tmp/onbudget-check && cd /tmp/onbudget-check && git init -q
claude --plugin-dir ~/Documents/onbudget
```

Accept the folder-trust question for the scratch folder. During the steps below Claude Code will ask before it creates or edits a file there; answer Yes. If it offers to install a language-server plugin, that is Claude Code's own offer and has nothing to do with onbudget.

## 1. Nothing happens until you ask

- [ ] Type `/onb`. The typeahead offers `/onbudget` with the hint `<$X | N% 5h | N% week | 5h | week> <task> · off`.
- [ ] `/onbudget` answers `no budget is set`, then the usage line, then one calibration line per window.
- [ ] Send any small prompt (`say hi`). No status line appears under the prompt and the answer looks as it always does.

## 2. A dollar budget that is enough

- [ ] `/onbudget $0.60 Write fizzbuzz.py with a pytest file for it, and run the tests.`
- [ ] The command answers `budget $0.60 set` and says effort is capped at medium.
- [ ] Your task appears in the transcript as your own prompt, followed by the protocol text that starts `You have a hard usage budget of $0.60`.
- [ ] A status line under the prompt reads `onbudget: spent $… of $0.60 | left before the stop $… (…%) | tier …` and moves as Claude works.
- [ ] Claude runs the tests before it finishes.
- [ ] Its last message says what is complete and how it was verified, and ends with `STATUS: COMPLETE`.
- [ ] Below it, a line from the plugin: `onbudget: Claude ended the task with STATUS: COMPLETE, at $… of $0.60; the 5-hour window moved … points, the weekly window moved … (whole points, whole account). The budget is still open…`
- [ ] `/onbudget` shows the spend, the request count, the dearest request so far, the points each window moved, and `onbudget 0.1.0, tested on Claude Code 2.1.288 to 2.1.304`.

## 3. A follow-up on the same budget

- [ ] Send `Also handle multiples of 7 as "Bazz", and update the tests.` The status line keeps counting from where it was.

## 4. A budget that runs out

- [ ] `/onbudget $0.12 Write a 3,000-word design document for a plugin system, in a file, section by section.`
- [ ] As the spend nears the stop the status line's tier turns CRITICAL, and stays there for at least two of Claude's steps before the stop.
- [ ] Before long a message appears that begins `[onbudget] Stopped:` and states the spend, the reserve, and that it comes from the plugin and not from Claude.
- [ ] The status line reads `onbudget: stopped at $… of $0.12: …`. The figure at the stop is at or under $0.12, or over it by less than one request. It may rise by a few cents afterwards: that is Claude Code's own prompt-suggestion request (see the README's limitations).
- [ ] Send `continue`. It is not sent: a line says the budget has stopped this session and how to go on.
- [ ] `/onbudget off` answers `budget removed (…)`, the status line disappears, and `continue` now gets a normal answer.

## 5. A percentage budget

- [ ] `/onbudget` and read the calibration lines. If the 5-hour line shows a rate, note it.
- [ ] `/onbudget 3% 5h Add type hints to fizzbuzz.py and run the tests.`
- [ ] With a rate: the answer shows a dollar figure and the rate it used, and says the rate errs low. Without one: it says the budget is enforced on the window's own reading in whole points.
- [ ] `/onbudget 1% 5h anything` with no rate learned yet is refused, and the answer says why and what the smallest budget is.
- [ ] `/onbudget off`.

## 6. What a window has left, and the account's limits

- [ ] `/onbudget 5h Add a docstring to fizzbuzz.py.` The answer says `budget … (what the 5-hour usage window had left) set` and gives the window's reading: with a rate, `The window is at N%: M points are left below 99%, about $…`; without one, that the budget is the window's own points.
- [ ] While it runs, `/onbudget` lists `account limit, 5-hour window: at N% …` and `account limit, weekly window: …`, each with where onbudget stops for it.
- [ ] `/onbudget off`.
- [ ] `/onbudget $500 Reply with the word ok.` (unless you really have $500 of 5-hour window left). The answer says the account's 5-hour window has less left than the budget, about how much, and that the task runs against that. The status line names the 5-hour limit. `/onbudget off` once Claude has answered.
- [ ] `/onbudget week Reply with the word ok.` Unless you set `usdPerPointWeek`, the answer gives the weekly figure in points, says a weekly budget counts the window's own points, and says it stops about two points before 99%. `/onbudget off`.
- [ ] If a window happens to be at 97% or more: `/onbudget $1 anything` is refused in one line, and nothing is sent.

## 7. Interrupt, compact, resume, clear

- [ ] `/onbudget $1 Explain every file in this folder in detail.` While Claude is working, press Esc. The turn stops. `/onbudget` still shows the budget, and the spend includes the interrupted request.
- [ ] `/compact`, then `go on`. The session continues and the status line is still there.
- [ ] Leave with Ctrl-C twice, then `claude --plugin-dir ~/Documents/onbudget --resume` and pick the session. The status line comes back with the same spend. `/onbudget` agrees.
- [ ] `/clear`. The status line disappears and `/onbudget` answers `no budget is set`.

## 8. Headless

```bash
cd /tmp/onbudget-check
ONBUDGET='$0.30' claude -p --plugin-dir ~/Documents/onbudget "List the files here and say what each does."
ONBUDGET='plenty' claude -p --plugin-dir ~/Documents/onbudget "List the files here."
ONBUDGET='5h' claude -p --plugin-dir ~/Documents/onbudget "Say what fizzbuzz.py does in one sentence."
claude -p --plugin-dir ~/Documents/onbudget "/onbudget"
claude -p --safe-mode --plugin-dir ~/Documents/onbudget "/onbudget"
```

- [ ] The first prints a normal answer that ends with a `STATUS:` line.
- [ ] The second prints that `"plenty" is not a budget` and does not run the task.
- [ ] The third answers normally (its budget was sized from the first reading).
- [ ] The fourth prints `onbudget: no budget is set` and the usage, at no cost.
- [ ] The fifth does not: in safe mode the plugin is not loaded, and `/onbudget` reaches Claude as an ordinary prompt. That is what "not running" looks like.

## 9. The repository and the publication copy

- [ ] `claude plugin validate --strict ~/Documents/onbudget/.claude-plugin/plugin.json` and `claude plugin validate --strict ~/Documents/onbudget` pass, and the "calls" list is the one in the README.
- [ ] `claude plugin test ~/Documents/onbudget` reports no failures.
- [ ] The name in `LICENSE`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and the GitHub account in the README's install lines, are the ones you want published.
- [ ] `REPORT.md` says the evaluation finished, and its numbers match the table in `README.md`.
- [ ] In a clean config directory, `claude plugin marketplace add sebastiandrazsky/onbudget` then `claude plugin install onbudget@onbudget` installs it, and `/onbudget` answers (needs read access to the repository while it is private).
- [ ] The repository's GitHub workflow is green on its latest run.
- [ ] You push `~/Documents/onbudget-publish/onbudget`, not `~/Documents/onbudget`: the archive's history carries your user name, home paths, e-mail and the interactive sessions' screen captures. The command at the end of `REPORT.md` shows the copy is clean; run it again after any change to the copy.

## 10. Three real tasks

Run each on work of your own, in a session started as in Set up or with the plugin installed from the repository.

- [ ] A `5h` task, for example `/onbudget 5h <a task you would have run anyway>`. The answer gives what the 5-hour window had left; the status line moves; the task ends with Claude's STATUS line and the plugin's own line under it.
- [ ] A `week` task, for example `/onbudget week <a task>`. The answer gives the weekly window's points; the meter reads in points; the end line gives the points each window moved.
- [ ] A dollar budget that runs out, for example `/onbudget $0.30 <a task larger than that>`. The meter turns CRITICAL at least two requests before the stop; the stop is the plugin's notice; the spend at the stop is at or under the budget, or over it by less than one request.
- [ ] If you want your own capture for the README's first screen, copy the status line, the stop notice and the end-of-task line from these sessions.

## Clean up

```bash
rm -rf /tmp/onbudget-check
```

The plugin's own data is one file, `~/.claude/plugins/store/onbudget_*.json`. Deleting it resets the learned calibration.
