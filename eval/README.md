# onbudget evaluation harness

Compares three ways of running the same work under a usage budget, on the seven-task session benchmark of the
within-lab prototype (boltons, falcon, markdown-it-py, pluggy, pydantic-settings, werkzeug and werkzeug-cond in one
workspace, one prompt). Scoring is the lab's, ported. Python 3 standard library only.

Paid runs cost real money. Read "Safety rails" before starting any.

## Arms and levels

Model (`opus[1m]`), effort (`--effort medium`), tools, prompt body, scoring and the external watchdog are the same in every arm.

| Arm | Prompt | Plugin loaded | Environment |
| --- | --- | --- | --- |
| A plain | task list, final-line instruction | `eval/capmod` (silent external cap) | `CAP_USD`, `CAP_LOG` |
| B prompt-only | A plus one budget paragraph before the final-line instruction | `eval/capmod` | `CAP_USD`, `CAP_LOG` |
| C onbudget | identical to A (the plugin appends its own text) | the repository root | `ONBUDGET`, `ONBUDGET_LOG` |
| A0 plain, simple cap | identical to A | `eval/capmod` | `CAP_USD`, `CAP_LOG`, `CAP_RULE=simple` |

Arm A0 was added after the first results (see "Runs added after the first results" below).

The budget paragraph of arm B, for a dollar level: "I have a usage budget of $4.20 (API-equivalent cost) for this entire
session. Stay within it: prioritise finishing and verifying as many of the tasks as you can, and stop before you exceed it."
For the percentage level the amount reads "4% of my 5-hour Claude usage limit".

| Level | Arm C gets | Arms A and B get | Kill threshold |
| --- | --- | --- | --- |
| TIGHT | `ONBUDGET="$4.20"` | cap $4.20 | $5.20 |
| HARD | `ONBUDGET="$2.47"` | cap $2.47 | $3.47 |
| PCT | `ONBUDGET="4% 5h"` | cap $3.88 (4 x the lab's $0.97 per 5h point) | $4.88 |
| SMOKE (one task) | `ONBUDGET="$0.46"` packaging, `"$0.28"` tenacity | cap $0.28 tenacity | cap + $1.00 |

TIGHT and HARD are the lab's frozen values (`v0/reference.json`). The $3.88 is the harness's cap and reference figure only;
it is never passed to the onbudget plugin.

Launch line (all arms):

    claude -p --output-format json --plugin-dir <plugin> --permission-mode acceptEdits --setting-sources project,local
      --strict-mcp-config --disable-slash-commands --allowedTools 'Bash(python:*),Bash(python3:*),Bash(pytest:*)'
      --disallowedTools WebFetch,WebSearch --model 'opus[1m]' --effort medium

There is no `--max-budget-usd` (it makes Claude Code tell the model about the budget). `claude` is the one on PATH unless
`ONBUDGET_CLAUDE_BIN` names another; its version is recorded in every run's `env.json`.

## Runs added after the first results

The main queue (18 slots) finished on 2026-10-09. Two things in its results led to six more runs. The onbudget plugin was not
changed between the two batches (git tag `eval-freeze`).

1. **Arm A0, four runs.** `eval/capmod` applies onbudget's stop rule in arms A and B, including a reserve for every request
   in flight. Plain Claude Code ran 4 to 6 subagents in parallel in all four arm A runs, so the rule stopped it with 19 to 28%
   of the budget unspent. That is a property of the rule, not of plain Claude Code. Arm A0 is the same plain arm under the
   simplest possible cap (`CAP_RULE=simple`: refuse only once the spend has reached the cap). It can overshoot by whatever is
   in flight when the cap is reached. Two runs at TIGHT, two at HARD.
2. **One more HARD run each for arms B and C**, because that is where the two were closest.

`python3 eval/queue.py run --phase added` runs both groups (`simple-cap`, `hard-extra`).

One scoring run was repeated by hand: in `hard-C-2-a0` both scoring attempts for falcon stalled at the test runner's 300 s
watchdog and returned no results (the lab hit the same stall once). `python3 eval/harness.py rescore hard-C-2-a0` scored the
saved tree again: falcon 25/25 hidden, 4148/4148 existing. The first values are kept under `score_history` in its `score.json`.

## Second round (2026-10-20, Claude Code 2.1.304)

The first round ran on Claude Code 2.1.289. On 2.1.304, the release current when this round ran, Claude Code adds a
token countdown of its own to every request, and onbudget now leaves it out while a budget is open; the meter, the stop
and the account's windows changed as well (see `CHANGELOG.md` and the addendum to `REPORT.md`). The shipping build was
frozen as git tag `eval-freeze-3` and run again here. Everything for this round lives in `eval/r2/`: its own
`state.json` (ledger and ceiling), `queue.log`, `results.csv`, `report.txt` and `runs/`. The first round's files above
are untouched. (`eval-freeze-2` marks an intermediate build that was never run with a real model.)

    ONBUDGET_EVAL_ROUND=2 ONBUDGET_EVAL_CEILING=<$25 less the smoke session> \
      ONBUDGET_CLAUDE_BIN=~/.local/share/claude/versions/2.1.304 \
      nohup python3 eval/queue.py run --phase r2 > eval/r2/queue.nohup 2>&1 &

| Phase | Slots, in this order |
| --- | --- |
| r2-onbudget | C x3 at HARD |
| r2-maxbudget | D x2 at HARD |
| r2-prompt | B x2 at HARD, only while the ceiling allows |

Arm D is plain Claude Code under its own cap: the arm A prompt, no budget paragraph, and `--max-budget-usd 2.47` on the
launch line. It loads `eval/capmod` with `CAP_RULE=off`, which refuses nothing and changes nothing the model receives
(`tests/e2e/run.py` checks the prompt, effort, tool results and context with it loaded); it only logs each request's
cost, so that the watchdog's cost rule (kill at cap + $1.00) and the per-request accounting work as in the other arms.
Claude Code tells the model about a `--max-budget-usd` cap, so the "USD budget:" void rule does not apply to arm D, and a
session that Claude Code ends with `error_max_budget_usd` counts as stopped, not as an infrastructure failure.

The same rails apply as in the first round, with a ceiling of $25 at list price for the whole round, the smoke session
included; the same model, effort, tasks and prompt body; and one CLI, 2.1.304, pinned by its path. There is no smoke
phase in the queue: `eval/interactive_smoke.py` ran first, on the same build. One rule is new: a usable arm C run that
ends over its budget, or claims a task it did not finish, stops the queue for the operator to report. Arms B and D see
Claude Code's own countdown; arm C does not, because onbudget leaves it out.

`~/CLAUDE.md` (a one-line pointer to a writing-style skill) sits above the work directory, so Claude Code had it in
context in every run of both rounds; `env.json` records it under `context_files`. It was left in place so that the
rounds stay comparable.

## Interactive sessions with the real model

`python3 eval/interactive_smoke.py` is outside the queue and its ledger. It drives one real terminal session with the real
model through a pseudo-terminal and costs about $0.20: `/onbudget $0.50` on a small coding task, `/onbudget`, a $0.07 budget
that cannot finish, a follow-up prompt, `/onbudget off`. It answers Claude Code's own file-permission prompts with Yes and
declines its offer of a language-server plugin. Each session's plugin log, screen text and summary are in
`eval/runs/interactive-real-<n>/`. Six sessions were run, $1.08 in all:

| Session | Checks | Note |
| --- | --- | --- |
| 1, 2 | 10 of 16 | the driver judged a turn over too early, and stalled on file-permission prompts it did not expect |
| 3, 4 | 15 of 16 | an offer to install a language-server plugin covered the prompt when the status command was typed |
| 5 | 16 of 16 | |
| 6 | 16 of 16 | with `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`: the spend after a stop no longer grows |
| 7 | 18 of 18 | 2026-10-20, Claude Code 2.1.304, build `eval-freeze-3`, $0.29; adds the end-of-task line and `/onbudget 5h` |

In session 4, and possibly session 3, the driver answered that plugin offer with Yes. The plugin (`pyright-lsp`) was already installed and enabled for
the user; the answer refreshed its install timestamp. From session 5 on the driver declines the offer.

Sessions 4 to 6 ran the plugin with the one change made after the freeze (a prompt sent after a stop is turned away).

## Commands

Run them from the repository root.

    python3 eval/selftest.py                 zero-cost self-tests: shim, scoring, finish, queue, e2e, dry (about 25 minutes)
    python3 eval/selftest.py shim queue      only the named ones; e2e-A, e2e-B, e2e-C pick the arm shape of the end-to-end pass
    python3 eval/queue.py plan               slots, order, worst-case spend, plugin and work-directory check; runs nothing
    python3 eval/queue.py run --phase smoke  the three smoke runs (worst case $4.02)
    python3 eval/queue.py run --phase main   main-tight, main-hard, pct, extra; refused until smoke has passed (see "Smoke gate")
    python3 eval/queue.py run --phase all    smoke, then main
    python3 eval/queue.py run                resume the selection used last (smoke when there is none)
    python3 eval/queue.py status             per-slot state, spend against the ceiling, current run, last 5h/7d reading, queue alive or not
    python3 eval/queue.py retry <slot>       release a slot that has no retries left, or a smoke slot whose run the watchdog killed
    python3 eval/report.py                   results tables (stdout and eval/report.txt)
    python3 eval/harness.py rescore <run_id> score a finished run again from its saved files

Unattended:

    nohup python3 eval/queue.py run --phase smoke > eval/queue.nohup 2>&1 &
    nohup python3 eval/queue.py run --phase main  > eval/queue.nohup 2>&1 &
    nohup python3 eval/queue.py run > eval/queue.nohup 2>&1 &          # resume whatever was selected last

Any other argument to `run` is refused (`run smoke` or `run --phase` alone print the usage and start nothing).
Started with `nohup`, the queue ignores a hangup, so closing the terminal does not stop it. On macOS it starts
`caffeinate -is` for its own lifetime.

Stop a running queue with `kill <pid>` (the pid is in `eval/queue.lock` and in `status`). What that costs depends on
where the run was:

- during a session: the session is killed, booked as an infrastructure failure on the next start, and has used one of
  the slot's three attempts (it was paid for);
- before a session started (plugin validation, tree copy): nothing is spent and no attempt is used;
- after the session ended, during scoring: the next start scores the run from its saved files. It is not repeated.

A slot that has used its three attempts stays `exhausted`, and an exhausted smoke slot keeps the main phases closed.
`python3 eval/queue.py retry <slot>` releases it: the slot's runs so far are marked retired in `state.json` (they stay
on disk, in the ledger and in the per-run rows of the report, flagged RETIRED) and the slot gets three fresh attempts.
`retry` is refused for any slot that is neither exhausted nor a smoke slot whose run the watchdog killed, so it cannot
be used to replace a valid result.

## Slots

Queue order is phase by phase; inside a phase the order is a shuffle with seed 20261008 (`plan` prints it).

| Phase | Slots |
| --- | --- |
| smoke | C on packaging at $0.46, C on tenacity at $0.28, A on tenacity at cap $0.28 (single task; the prompt is the task statement) |
| main-tight | A x2, B x2, C x2 at TIGHT |
| main-hard | A x2, B x2, C x2 at HARD |
| pct | C x1 at PCT |
| extra | C x1 at TIGHT, then B x1 at PCT, only while the ceiling allows |

## Safety rails

- **Spend ceiling.** $62.00 by default. `ONBUDGET_EVAL_CEILING` can lower it; a value above $64 is refused. The ceiling a
  start ran under is kept in `state.json`, and later starts use the lower of that and the current setting, so a resume
  without the variable does not go back to $62 (to raise it again, edit `"ceiling"` in `eval/state.json`). A run is launched
  only when `spent so far + cap + $1.00 <= ceiling`. A slot that does not fit is skipped and the next smaller one is tried;
  when nothing fits the queue stops and writes `eval/STOPPED.txt`. The `extra` slots are not tried while a slot of an
  earlier phase is still pending.
- **Ledger.** `eval/state.json` holds one entry per paid run. The worst case is reserved before the launch and replaced by the
  real cost afterwards, so a run that is still marked running (the queue was killed) counts at its worst case. The booked cost
  is the larger of the CLI's `total_cost_usd` and the plugin log's cost; a run that started and reported neither counts at its
  worst case. Void, failed and killed runs all count. Runs found in `eval/runs/` but missing from the ledger are added.
- **Watchdog.** The harness kills the session's process group when the logged cost exceeds cap + $1.00 or after 60
  minutes; such a run is kept as a result with 0 tasks COMPLETE. The cost rule only works while the plugin logs, so the
  run is also killed when the plugin has written no `session.start` row after 120 seconds, no cost after 300 seconds,
  or nothing at all for 900 seconds (the log is read twice before acting; in the lab's 29 runs the first cost came
  within 8 seconds and the longest silence was 116 seconds). A run killed for one of these three reasons is void, is
  booked at no less than its worst case, and stops the queue.
- **Standstill.** If more than 120 seconds pass between two 5-second watchdog polls (the machine slept, or the queue was
  suspended), the run is killed and booked as an infrastructure failure, not kept as a "timeout" result.
- **No orphan sessions.** Each session has a small detached helper process that kills the session's process group when the
  queue process disappears (SIGKILL, crash) or 62 minutes have passed. On start, the queue also kills any session whose
  pid is recorded in `state.json` or in the `pid.txt` of a run without a score.
- **Plugin gate.** `claude plugin validate <dir>/.claude-plugin/plugin.json` runs before every launch and its output must
  list a `turn.step` hook. (For the repository root, `claude plugin validate <dir>` checks `marketplace.json` and the
  hooks but not `plugin.json`, hence the explicit path.) If it fails, nothing is launched and the queue stops.
- **Set-up faults stop the queue.** Validation does not prove that a plugin loads. When a run shows that the plugin did
  not load (no `session.start` row), that the cap or budget it logged is not the one the harness set, or a log-fault
  kill, the queue stops after that one run instead of retrying or moving to the next slot.
- **Smoke gate.** The main phases start only when every smoke slot has a usable run and none of those runs had to be
  killed by the watchdog. A killed smoke run means the cap did not hold; fix the cause and `retry` the slot.
- **One CLI version.** The `claude --version` of the first launch is kept in `state.json`. A later launch that sees a
  different version stops the queue (the operator's own Claude Code may update the shared binary during a long
  evaluation). `ONBUDGET_CLAUDE_BIN` can point at a fixed version, for example
  `~/.local/share/claude/versions/2.1.289`. Runs set `DISABLE_AUTOUPDATER=1`.
- **One queue at a time.** `eval/queue.lock` holds the pid. A second queue refuses to start; a lock whose pid is dead is
  taken over by an atomic rename, so two queues starting together cannot both get it.
- **5-hour window.** If the newest five_hour reading in the run logs is 80% or more, the queue sleeps until its `resetsAt` plus
  90 seconds (5 hours after the reading when no reset time was logged). With no reading it proceeds.
- **Weekly window.** If the newest seven_day reading is 90% or more and its reset has not passed, the queue stops and says so
  in `eval/STOPPED.txt`.
- **Retries.** A slot whose run was void or an infrastructure failure is tried again at most twice. A void slot goes to the end
  of its phase; an infrastructure failure is retried after 10 and then 20 minutes and a zero-cost readiness check (DNS, HTTPS,
  `claude auth status`). Every attempt counts toward the ceiling.
- **Resume.** Re-running `queue.py run` kills a session that outlived a dead queue, scores runs whose session had ended,
  books interrupted runs, and continues. A slot with a usable run is never run again.
- **A paid session is never bought twice because scoring failed.** If scoring a finished session raises, the queue stops
  with `STOPPED.txt` naming the run (the traceback is in `queue.log`), and the run's worst case stays reserved. After
  the cause is fixed, the next `queue.py run` scores it first; `python3 eval/harness.py rescore <run_id>` does the same
  by hand. A run that could not be launched at all (work directory inside a git repository, leftover session store)
  also stops the queue and uses no attempt.

The arithmetic leaves room: with every run at cap + $1.00 the 16 slots before `extra` come to $60.92. The watchdog polls every
5 seconds and a killed run is booked at its last logged cost, which does not include requests in flight at the kill, so a
single run can end slightly above cap + $1.00. That overshoot is covered by the $3 between the default ceiling and $65
($1 if the ceiling is raised to $64, so do not raise it without a reason).

## Scoring

A task is COMPLETE when the hidden tests pass, the existing suite passes and the changelog rule in `eval/tasks.json` holds,
and the run was not killed. Test ids are compared after mapping `/private<WD>` to `<WD>`, and a task that does not pass on
the first scoring run is scored once more (both from the lab, see its `v0/DEVIATIONS.md`). Claims are read from the per-task
final lines; a task claimed COMPLETE and not scored COMPLETE is one false claim. The onbudget plugin appends its protocol
after the harness's final-line instruction, so arm C's prompt ends by asking for one `STATUS: COMPLETE` or
`STATUS: INCOMPLETE` line. To keep the claim metrics comparable, a `STATUS: COMPLETE` line counts as a COMPLETE claim on
every task that has no line of its own (`STATUS: INCOMPLETE` says nothing about a single task). Each run records
`claim_lines`, `status_line` and `tasks_unclaimed`, and the level table has a "tasks w/o claim" column: false claims
and "claimed w/o verified_final" can only count tasks that have a claim.

A run is **void** (excluded, slot retried) when the plugin wrote no `session.start` row, a `hookfail` or `stopfail` row was
logged, the transcript contains `USD budget:` or `budget_usd`, there is no transcript, the recorded main-thread effort is not
`medium`, the watchdog killed it because the plugin's log could not be trusted, or what the plugin logged about its budget
or cap disagrees with what the harness set (arm C: no `budget` row at all counts). An **infrastructure failure** (API
error, no result, zero cost without a stop, a standstill of the queue) is neither valid nor void.

For level PCT in arm C, `budget_enforced`, cost minus budget and "cost<=budget" use the dollar value the plugin itself
converted the percentage to (`budget` or `calibrated` row); while the plugin had none they are n/a. The $3.88 stays the
harness's cap, kill reference and ledger figure, and the PCT section of the report shows cost against it separately. A
PCT run of arm C killed at $4.88 is kept as a killed result, as the specification says; the report notes that this
threshold is the harness's assumption and not a figure the plugin enforced.

Verification metrics, new here: the shim that provides `python`, `python3` and `pytest` appends one line per invocation to
`shim.log`. Per task, `tests_run` is the number of pytest invocations, and `verified_final` is true when the last of them
started at or after the newest modification time of any file that differs from the base tree. A run reports the number of
tasks tested, the number verified_final, and how many tasks were claimed COMPLETE without verified_final.
`verified_final` has two blind spots, so a second figure is reported next to it. `verified_code` looks only at changed
code files (not `.rst`, `.md`, `.txt`, and not the task's changelog location) and is false when no code file changed:
a changelog entry written after the last test run does not clear it, and a task that was only baselined cannot earn it.
The tables show it as "verified/code-edited" (tasks verified_code / tasks with a changed code file). The shim records
that a test run started, not how it ended, so neither figure says the tests passed. `.DS_Store` files are ignored
everywhere (changed files, `ws.diff`, changelog rules).

## In the publication copy

The repository published as `sebastiandrazsky/onbudget` is a rewrite of this one's whole history
(`~/Documents/onbudget-publish/make_copy.py`, kept outside the repository). In every file of every commit, and in commit
messages and authorship: the home path of the machine the evaluation ran on reads `/Users/user`, also in Claude Code's
folder form (`-Users-user`); the e-mail address the commits were made with is replaced by the public one, and its local
part, where it appears on its own, by `user`; author and committer are the public identity. The `screen.txt` files of the interactive sessions (the screen as text, which shows
the slash commands installed on that machine) are left out of every commit. Nothing else was changed: the logs, scores,
diffs and tables are as the runs wrote them. The tags `eval-freeze`, `eval-freeze-2` and `eval-freeze-3` point at the
rewritten commits of the same builds.

## Files

Read from the lab (`ONBUDGET_LAB`, default `~/Documents/within-lab`), never written: `gate1/tasks/<name>/` with `base/`,
`hidden/`, `fix_src/`, `venv/`, `oracle.json`, `task.json`, `statement.md`. Where they come from: `TASKS.md` names each task's
upstream repository, pull request, base and fix commits, hidden tests and statement; `upstream.json` has the same for
scripts; `rebuild_tasks.py` rebuilds the layout from GitHub and PyPI (`python3 eval/rebuild_tasks.py --lab DIR --prove pluggy`,
then `ONBUDGET_LAB=DIR`). `THIRD_PARTY_NOTICES.md` holds the licences of the upstream projects whose code the runs quote.

Copied from the lab into `eval/`: the scoring and run code (`lib.py`, `harness.py`), `tasks.json` (documented test command and
changelog rule per task), `shim/`, `mockmodel/`.

Per run, in `eval/runs/<run_id>/`: `cmd.txt`, `env.json` (only the variables the harness sets, plus the claude version, the
session directory and the memory files above it), `spec.json`, `pid.txt`, `prompt.txt`, `out.json`, `err.txt`, `meter.jsonl*` (the
plugin's event log), `shim.log` (created empty at launch, so an empty file means no `python` or `pytest` call),
`score.json`, `final_message.txt`, `ws.diff` (each task directory against its base tree; caches and virtualenvs excluded,
binary files named only, capped at 2 MB), and the full `ws/` and `transcript/`. The transcript is copied from the CLI's
store once, at the first scoring; a rescore reads the saved copy.

The shim (`eval/shim/python`, with `python3` and `pytest` linked to it) runs the command in the prepared environment of
the task whose subdirectory it was started from: `WITHIN_WS` is the workspace root, `WITHIN_TASKS` holds the
environments, and `shim/pp/<task>` lists the task's PYTHONPATH entries. When `ONBUDGET_SHIM_LOG` is set it first appends
one JSON line (`ts`, `task`, `argv`, `cwd`); a logging failure never changes or blocks the command. The script itself
carries no comment, because a model can read it (a lab run did) and should not learn from it that calls are logged.

Queue files in `eval/`: `state.json` (order, ledger, ceiling, CLI version, retired runs), `queue.log`, `results.csv` (one row per run, all attempts),
`report.txt`, `STOPPED.txt` or `DONE.txt`.

Git-ignored: `runs/*/ws/`, `runs/*/transcript/`, `tmp/` (self-test scratch and self-test runs), `*.nohup`, `queue.lock`,
`PAUSED.json`. Everything else under `eval/` is small and meant to be committed.

Outside the repository: sessions run in `~/Documents/.onbudget-eval-work/<run_id>/ws` (`ONBUDGET_EVAL_WORK` to change) and
the tree is moved into `eval/runs/<run_id>/ws` when the session ends. Claude Code keeps its own copy of each transcript under
`~/.claude/projects/` (one directory per run, self-test runs included); the harness does not delete them.

## Self-tests

`python3 eval/selftest.py` sends no model request.

1. `shim`: the seven documented test commands exit 0 through the shim on fresh base trees and each leaves one log line; the
   verification metrics react to an edit and a re-test.
2. `scoring`: base trees score INCOMPLETE and upstream-fix trees COMPLETE for the seven tasks and the two smoke tasks.
3. `finish`: `harness.finish` on a synthetic run directory: the STATUS-line claim rule, `.DS_Store`, verified_final and
   verified_code, a rescore after the CLI store lost the transcript, the void and stop-the-queue cases, the PCT budget.
4. `queue`: plan, ceiling arithmetic with simulated ledgers, command-line parsing, retries, the 5h and weekly guards, the
   lock (including two queues racing for a stale lock), resume after an interruption, a finished session whose scoring
   fails, a run that cannot be launched, set-up faults and a changed CLI version, the smoke gate and `retry`, the extra
   slots, SIGHUP under `nohup`, a hard-killed queue, a standstill, the watchdog rules. No session is started (the
   processes involved are `sleep` and a stub queue).
5. `e2e`: one probe run and one full session pass in which `eval/mockmodel` answers every request from a script, issuing the
   seven test commands and two file writes through the real Bash and Write tools and the permission layer. The arm's own
   plugin is loaded as well when it exists and validates. These runs set `ANTHROPIC_BASE_URL` to a closed local port as a
   second barrier, and the self-test aborts if any of them reports a cost.
6. `dry`: the queue drives the real harness through the three smoke slots, again with the mock model answering and the
   arms' own plugins loaded, in a scratch directory with its own state. It checks the wiring that the paid smoke phase
   uses (slot to run, ledger booking, `results.csv`). The real run ids and the real ledger are not touched.

Before paid runs, `e2e-A`, `e2e-C` and `dry` should pass with `void_checks []` for the real plugins: that is the zero-cost
evidence that the plugin logs what the void rules expect.

## Deviations

From the lab's v0 harness:

1. Effort is `--effort medium` in every arm (the lab launched with xhigh and let its mod rewrite it).
2. Arms are A, B and C as above. The lab's arms (W, W-nometer, Wx, D) and its protocol text are gone; arm C's protocol comes
   from the plugin, and the harness does not parse budgets itself.
3. The session runs in a work directory outside this repository and the tree is moved into the run directory afterwards. In the
   lab the workspace was not inside a git repository; `eval/runs/` is, and Claude Code would have shown the model this
   repository's git status and commit titles. The harness refuses to launch if the work directory is inside a git repository.
4. Single-task runs (smoke) use the same shim and layout as session runs (`ws/<task>/`); the lab put the task's virtualenv
   on PATH directly. `tasks.json` and `shim/pp/` gained entries for packaging and tenacity.
5. The changelog rules for packaging and tenacity are expressed in `tasks.json` instead of the ablation's `note_and_docs`.
   A "new file in a directory" rule (falcon, pluggy, tenacity) ignores dot-files, so a `.DS_Store` left by Finder is not a
   changelog entry (the lab's rule for falcon and pluggy counted any new name).
6. The shim logs each invocation (`ONBUDGET_SHIM_LOG`), and scoring adds the verification metrics.
7. Quota readings are taken from `step`, `measure` and `end` rows (the lab read `measure` rows only).
8. Subagent spawns are the distinct non-null `agentId`s in `step` rows (the lab counted `spawn` rows).
9. Meter tiers are read with `tier <WORD>` from the injected line, whatever else the line says.
10. `ended` is `self`, `stopped`, `killed` or `error`; the stop row's `event` is recorded next to it.
11. Plugins are validated before the run directory is created, on every launch, without caching. A plugin that fails
    validation stops the queue instead of using up an attempt.
12. The watchdog has three more rules for a plugin that is not logging (no `session.start` row after 120 seconds, no cost
    after 300, nothing written for 900); a run killed by one of them is void and stops the queue. A standstill of the
    queue kills the run as an infrastructure failure. A run that ended on its own during a poll interval is no longer
    marked killed. A detached helper kills the session if the queue process dies.
13. Budget cross-check: arms A and B compare `session.start.cap` with the cap; arm C requires a `budget` row and compares its
    `raw` and, for dollar budgets, its `usd`.
14. Queue retries: void and infrastructure failures share one limit of two retries per slot (the lab allowed six
    infrastructure failures in a row). Back-off is 10 then 20 minutes.
15. Queue guards: 5h wait at 80% (lab 85%) with a 90-second margin (lab 120); the weekly rule is a fixed 90% stop (the lab
    paused at start + 6 points until the weekly reset).
16. Ceiling: a slot that does not fit is skipped in favour of a smaller one (the lab stopped at the first that did not fit).
    Unknown costs count at their worst case (the lab counted them as zero). The lowest ceiling used is kept in `state.json`.
17. A session that outlives a killed queue is killed on resume, and the queue handles SIGTERM by killing the session first.
    SIGHUP is handled the same way unless it is already ignored (`nohup`).
18. `rescore` recomputes the whole `score.json` from the saved files, not only the test results. The saved transcript is
    never replaced.
19. Environment variables beginning `ONBUDGET`, `CAP_`, `MOCK_` or `WITHIN_` are never inherited from the operator's shell.
20. The mock model accepts any tool in its script and an optional final message (`MOCK_FINAL`).
21. `eval/queue.py` has the name of a standard-library module. If the standard library asks for `queue` while `eval/` leads
    `sys.path`, the file hands over the real one.
22. A finished session whose scoring raises stops the queue and is scored later; the lab booked it as an infrastructure
    failure and ran the slot again. A run that could not be launched uses no attempt.
23. The queue stops after a run that shows a set-up fault (plugin not loaded, cap or budget mismatch, log-fault kill), and
    when the CLI version changes; the lab treated the first as an ordinary void and did not check the second.
24. A smoke run that the watchdog killed keeps the main phases closed; `queue.py retry <slot>` releases a slot.
25. Claims: a whole-session `STATUS: COMPLETE` line counts for every task without its own line, and the STATUS line is
    found anywhere in the final message, with markdown emphasis allowed (the lab read it only as the exact last line, in
    single-task runs).
26. `.DS_Store` files are not changed files. The scoring copy of a tree skips dangling symlinks instead of failing.
27. The shim script has no header comment (its description is in this file).
28. Quota movement and cost-against-budget are left n/a when the logged values are not numbers or, for a percentage
    budget, when the plugin logged no dollar conversion.

From the specification:

1. Smoke prompts are the task statement only, as the slot description says, so they do not end with the per-task final
   line. In single-task runs a claim is read from a `<task>: COMPLETE` line or from a last line `STATUS: COMPLETE`.
2. The percentage form of arm B's paragraph drops "(API-equivalent cost)", which describes dollars.
3. `ws/` is not written in place (deviation 3 above); it is in `eval/runs/<run_id>/ws` once the session has ended.
4. For level PCT the harness uses $3.88 as arm C's watchdog reference, worst-case figure and ledger budget. In the tables
   arm C's budget, cost minus budget and "cost<=budget" use the plugin's own converted dollar value (n/a without one);
   both figures are in the PCT section.
5. `ONBUDGET_EVAL_CEILING` accepts any value from 0 to 64, so a first start can also set the ceiling above 62, to at most
   64. A later start cannot raise the ceiling an earlier start used.
6. Invocations that only print version, help or a test listing (`--version`, `--help`, `--collect-only`, ...) do not count as
   test runs. With no file changed, any test run makes a task verified_final; `verified_code` (added) does not have that
   property. The shim does not record how a test run ended.
7. Cache directories beyond those named in the specification are ignored when trees are compared (`.hypothesis`,
   `.mypy_cache`, `.ruff_cache`, `.tox`, `venv`, `.venv`).
8. A zero-cost run is an infrastructure failure by the lab's rule, so the mock-model self-test run is one. Its `score.json`
   lists the void checks that would have applied under `void_checks`.
9. The self-tests also score the two smoke tasks (packaging, tenacity), and the end-to-end pass adds two file writes and
   scripted claims so that false claims, `verified_final` and `ws.diff` are exercised.
10. Size: the Python comes to about 1,640 lines (1,220 in the four runtime modules, 420 in the self-tests), above the aim
    of staying well under 1,200. About 280 of them came with the review fixes listed above (safety rails and their tests).
