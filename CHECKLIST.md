# Checklist before publishing

A pass through onbudget in a real terminal session with a real model. It takes about fifteen minutes and costs about $1 of usage. Tick each line as you go; anything that does not match is a reason not to publish yet.

The automated suites already drive these same paths against a scripted model (`python3 tests/e2e/interactive.py`). This checklist is the part they cannot do: a real model reading the meter, and your own eyes on the screen.

## Set up

```bash
mkdir -p /tmp/onbudget-check && cd /tmp/onbudget-check && git init -q
claude --plugin-dir ~/Documents/onbudget
```

Accept the folder-trust question for the scratch folder.

## 1. Nothing happens until you ask

- [ ] Type `/onb`. The typeahead offers `/onbudget` with the hint `<$X | N% 5h | N% week> <task> · off`.
- [ ] `/onbudget` answers `no budget is set`, then the usage line, then one calibration line per window.
- [ ] Send any small prompt (`say hi`). No status line appears under the prompt and the answer looks as it always does.

## 2. A dollar budget that is enough

- [ ] `/onbudget $0.60 Write fizzbuzz.py with a pytest file for it, and run the tests.`
- [ ] The command answers `budget $0.60 set` and says effort is capped at medium.
- [ ] Your task appears in the transcript as your own prompt, followed by the protocol text that starts `You have a hard usage budget of $0.60`.
- [ ] A status line under the prompt reads `onbudget: spent $… of $0.60 | remaining …% | tier …` and moves as Claude works.
- [ ] Claude runs the tests before it finishes.
- [ ] Its last message says what is complete and how it was verified, and ends with `STATUS: COMPLETE`.
- [ ] `/onbudget` shows the spend, the request count, and the dearest request so far.

## 3. A follow-up on the same budget

- [ ] Send `Also handle multiples of 7 as "Bazz", and update the tests.` The status line keeps counting from where it was.

## 4. A budget that runs out

- [ ] `/onbudget $0.12 Write a 3,000-word design document for a plugin system, in a file, section by section.`
- [ ] Before long a message appears that begins `[onbudget] Stopped:` and states the spend, the reserve, and that it comes from the plugin and not from Claude.
- [ ] The status line reads `onbudget: budget spent (…)`. The spend shown is at or under $0.12, or over it by less than one request.
- [ ] Send `continue`. It is refused with the same kind of notice and nothing is spent.
- [ ] `/onbudget off` answers `budget removed (…)`, the status line disappears, and `continue` now gets a normal answer.

## 5. A percentage budget

- [ ] `/onbudget` and read the calibration lines. If the 5-hour line shows a rate, note it.
- [ ] `/onbudget 3% 5h Add type hints to fizzbuzz.py and run the tests.`
- [ ] With a rate: the answer shows a dollar figure and the rate it used, and says the rate errs low. Without one: it says the budget is enforced on the window's own reading in whole points.
- [ ] `/onbudget 1% 5h anything` with no rate learned yet is refused, and the answer says why and what the smallest budget is.
- [ ] `/onbudget off`.

## 6. Interrupt, compact, resume, clear

- [ ] `/onbudget $1 Explain every file in this folder in detail.` While Claude is working, press Esc. The turn stops. `/onbudget` still shows the budget, and the spend includes the interrupted request.
- [ ] `/compact`, then `go on`. The session continues and the status line is still there.
- [ ] Leave with Ctrl-C twice, then `claude --plugin-dir ~/Documents/onbudget --resume` and pick the session. The status line comes back with the same spend. `/onbudget` agrees.
- [ ] `/clear`. The status line disappears and `/onbudget` answers `no budget is set`.

## 7. Headless

```bash
cd /tmp/onbudget-check
ONBUDGET='$0.30' claude -p --plugin-dir ~/Documents/onbudget "List the files here and say what each does."
ONBUDGET='plenty' claude -p --plugin-dir ~/Documents/onbudget "List the files here."
```

- [ ] The first prints a normal answer that ends with a `STATUS:` line.
- [ ] The second prints that `"plenty" is not a budget` and does not run the task.

## 8. The repository

- [ ] `claude plugin validate ~/Documents/onbudget` passes.
- [ ] `claude plugin test ~/Documents/onbudget` reports no failures.
- [ ] The name and email in `LICENSE`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` are the ones you want published.
- [ ] `README.md` has your GitHub account in place of `<owner>` in the install line.
- [ ] `REPORT.md` says the evaluation finished, and its numbers match the table in `README.md`.

## Clean up

```bash
rm -rf /tmp/onbudget-check
```

The plugin's own data is one file, `~/.claude/plugins/store/onbudget_*.json`. Deleting it resets the learned calibration.
