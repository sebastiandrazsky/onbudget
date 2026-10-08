"""onbudget eval report: results tables from the per-run score.json files. Read-only apart from eval/report.txt; facts only.

  python3 eval/report.py        print the report and write eval/report.txt"""
import glob
import lib

ARMS = (('A', 'plain'), ('B', 'prompt-only'), ('C', 'onbudget'))
LEVELS = ('TIGHT', 'HARD', 'PCT', 'SMOKE')
ENDED = ('self', 'stopped', 'killed', 'error')


def scores(base=lib.EVAL):
    rows = [r for r in (lib.jload(p) for p in glob.glob(f'{base}/runs/*/score.json')) if r]
    rows.sort(key=lambda r: (r.get('ts') or '', r.get('run_id') or ''))
    retired = set((lib.jload(f'{base}/state.json', {}) or {}).get('retired') or [])       # runs the operator released with `queue.py retry`
    for r in rows: r['retired'] = r.get('run_id') in retired
    return rows


def usable(r):
    return not r.get('void') and not r.get('infra_failure') and not r.get('retired')


def spend(state, rows):
    """Everything paid so far. A run still marked running, or one whose cost is unknown, counts at its worst case."""
    ledger = state.get('ledger') or {}
    booked = sum(e['cost'] if e.get('cost') is not None else e['reserved'] for e in ledger.values())
    return booked + sum((r.get('cost_counted') or 0) for r in rows if r.get('run_id') not in ledger)


def mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def num(x, spec='.3f'):
    return 'n/a' if x is None else format(x, spec)


def flags(r):
    out = []
    if r.get('void'): out.append('VOID: ' + str(r.get('void_reason')))
    if r.get('infra_failure'): out.append('INFRA: ' + str(r.get('errors') or r.get('subtype')))
    if r.get('killed'): out.append('external kill: ' + str(r.get('killed')))
    if r.get('retired'): out.append('RETIRED by the operator (queue.py retry)')
    return '; '.join(out)


def level_table(rows, level):
    out = [f"{'arm':<15} {'budget':>7} {'valid':>5} {'mean COMPLETE':>14} {'all':>4} {'cost<=budget':>12} {'ended self/stopped/killed/error':>32} {'false claims':>12} {'tasks w/o claim':>15} "
           f"{'mean cost':>9} {'mean cost-budget':>16} {'mean verified_final':>19} {'verified/code-edited':>20} {'claimed w/o verified_final':>26}"]
    total = lambda rs, key: sum((r.get(key) or 0) for r in rs)
    for arm, label in ARMS:
        rs = [r for r in rows if r.get('level') == level and r.get('arm') == arm and usable(r)]
        if not rs and level == 'SMOKE' and arm == 'B': continue
        tasks = rs[0].get('tasks_total') if rs else None; judged = [r for r in rs if r.get('within_budget') is not None]
        out.append(f"{arm + ' ' + label:<15} {num(mean([r.get('budget_enforced', r.get('budget')) for r in rs]), '.2f'):>7} {len(rs):>5} {num(mean([r.get('tasks_complete') for r in rs]), '.2f') + '/' + str(tasks or '-'):>14} "
                   f"{sum(1 for r in rs if r.get('complete')):>4} {(str(sum(1 for r in judged if r['within_budget'])) if judged or not rs else 'n/a'):>12} {'/'.join(str(sum(1 for r in rs if r.get('ended') == e)) for e in ENDED):>32} "
                   f"{total(rs, 'false_claims'):>12} {total(rs, 'tasks_unclaimed'):>15} {num(mean([r.get('cost') for r in rs])):>9} {num(mean([r.get('cost_minus_budget') for r in rs]), '+.3f'):>16} "
                   f"{num(mean([r.get('tasks_verified_final') for r in rs]), '.2f'):>19} {str(total(rs, 'tasks_verified_code')) + '/' + str(total(rs, 'tasks_edited')):>20} {total(rs, 'claimed_without_verified_final'):>26}")
    out += ['  budget, cost<=budget, cost-budget: against the budget that was enforced (arm C at PCT: the plugin\'s own dollar conversion, n/a while it had none).',
            '  false claims and claimed w/o verified_final count only tasks with a claim; "tasks w/o claim" is the number they cannot see (a whole-session STATUS: COMPLETE claims every task without its own line).',
            '  verified/code-edited: tasks whose last test run started after their last code edit / tasks with a changed code file (changelog and docs edits ignored; whether that test run passed is not known).']
    return out


def task_matrix(rows, level):
    cells = {arm: [r for r in rows if r.get('level') == level and r.get('arm') == arm and usable(r)] for arm, _ in ARMS}
    out = ['  task by arm: runs in which the task was scored COMPLETE / valid runs (in brackets: runs in which it was verified_final)',
           f"  {'task':<19}" + ''.join(f'{arm + " " + label:>20}' for arm, label in ARMS)]
    for t in lib.EVAL_TASKS:
        cell = lambda rs: f"{sum(1 for r in rs if (r.get('scored') or {}).get(t) == 'COMPLETE')}/{len(rs)} [{sum(1 for r in rs if ((r.get('per_task') or {}).get(t) or {}).get('verified_final'))}]"
        out.append(f'  {t:<19}' + ''.join(f'{cell(cells[arm]):>20}' for arm, _ in ARMS))
    return out


def run_lines(r):
    pair = lambda a, b: f"{'-' if r.get(a) is None else r.get(a)}>{'-' if r.get(b) is None else r.get(b)}"
    letter = lambda v: {'COMPLETE': 'C', 'INCOMPLETE': 'I'}.get(v, '-')
    per = r.get('per_task') or {}
    head = (f"  {str(r.get('run_id')):<22} arm {r.get('arm')} budget {r.get('budget_raw')} cost {num(r.get('cost'))} (logged {num(r.get('cost_logged'))}) cost-budget {num(r.get('cost_minus_budget'), '+.3f')} "
            f"ended {r.get('ended')}{'/' + str(r.get('stop_event')) if r.get('stop_event') else ''} | COMPLETE {r.get('tasks_complete')}/{r.get('tasks_total')} | false claims {r.get('false_claims')} "
            f"(claim lines {r.get('claim_lines')}, STATUS line {r.get('status_line') or '-'}, tasks w/o claim {r.get('tasks_unclaimed')}) | tested {r.get('tasks_tested')} verified_final {r.get('tasks_verified_final')} "
            f"verified/code-edited {r.get('tasks_verified_code')}/{r.get('tasks_edited')} claimed w/o verified_final {r.get('claimed_without_verified_final')} pytest runs {r.get('pytest_runs')} | "
            f"turns {r.get('turns')} thinking {r.get('thinking_tokens')} output {r.get('output_tokens')} subagents {r.get('spawns')} | meter tiers {r.get('meter_tiers_shown') or '-'} | "
            f"effort {r.get('effort_main') or '-'} | 5h {pair('h5_first', 'h5_last')} 7d {pair('d7_first', 'd7_last')} | denied tool calls {r.get('permission_denials')}"
            + (f' | {flags(r)}' if flags(r) else ''))
    tasks = '      claimed/scored/verified_final: ' + '  '.join(
        f"{t} {letter((r.get('claimed') or {}).get(t))}/{letter(v)}/{'y' if (per.get(t) or {}).get('verified_final') else 'n'}" for t, v in (r.get('scored') or {}).items())
    return [head, tasks] if r.get('scored') else [head]


def pct_lines(r):
    cost, cap = r.get('cost'), r.get('budget')
    note = ([f"    the external kill is at the harness's assumed ${num(cap + 1, '.2f')} (4 x $0.97 per 5h point + $1.00), not at a figure the plugin enforced"]
            if r.get('killed') and r.get('arm') == 'C' and cap is not None else [])
    return [f"  run {r.get('run_id')} arm {r.get('arm')}" + (f' | {flags(r)}' if flags(r) else ''),
            f"    budget as stated: {r.get('budget_raw')} | spec the plugin parsed: {r.get('budget_spec_logged')}",
            f"    plugin's converted dollar budget: {r.get('budget_usd_logged')} | calibration it used: {r.get('budget_rate_logged')} | harness cap (nominal budget): ${num(cap, '.2f')}, cost minus that {num(None if None in (cost, cap) else cost - cap, '+.3f')}",
            f"    own spend: ${num(r.get('cost'))} (plugin's task spend {r.get('spent_logged')}) | ended {r.get('ended')}{'/' + str(r.get('stop_event')) if r.get('stop_event') else ''} | "
            f"COMPLETE {r.get('tasks_complete')}/{r.get('tasks_total')}",
            f"    5h reading: first {r.get('h5_first')}%, last {r.get('h5_last')}%, observed movement {r.get('h5_moved')} points ({r.get('quota_readings')} readings logged; account-wide, "
            'so other use of the account and a window reset during the run both show up here)'] + note


def report(base=lib.EVAL):
    rows = scores(base); state = lib.jload(f'{base}/state.json', {}) or {}
    out = ['onbudget evaluation: A plain, B prompt-only budget paragraph, C onbudget plugin. Same model (opus[1m]), effort (medium), tools, prompt body, scoring and',
           'external watchdog in every arm. Valid = not void and not an infrastructure failure. Facts only.']
    for level in LEVELS:
        if level == 'SMOKE' and not any(r.get('level') == 'SMOKE' for r in rows): continue
        out += ['', f'=== {level} ===' + (' (single-task smoke runs)' if level == 'SMOKE' else '')] + level_table(rows, level)
        if level != 'SMOKE': out += [''] + task_matrix(rows, level)
    out += ['', '=== PER-RUN ROWS (every attempt, including void, failed and killed runs; claimed/scored: C complete, I incomplete, - no claim) ===']
    for r in rows: out += run_lines(r)
    out += ['', '=== PERCENTAGE BUDGET (level PCT: "4% 5h" for arm C; $3.88 external cap for arms A and B) ===']
    pct = [r for r in rows if r.get('level') == 'PCT']
    out += [line for r in pct for line in pct_lines(r)] or ['  not run yet']
    out += ['', '=== TOTALS ===',
            f"  spend of every paid run (smoke, main, void, failed, killed; unknown costs counted at their worst case): ${spend(state, rows):.2f} of the ${lib.ceiling(state.get('ceiling')):.2f} ceiling",
            f"  runs {len(rows)} | valid {sum(1 for r in rows if usable(r))} | void {sum(1 for r in rows if r.get('void'))} | infrastructure failures {sum(1 for r in rows if r.get('infra_failure'))} | "
            f"externally killed {sum(1 for r in rows if r.get('killed'))}",
            f"  slots without a usable run and no retries left: {state.get('exhausted') or 'none'} | runs retired by the operator: {state.get('retired') or 'none'}",
            f"  claude CLI versions of the runs: {sorted({str(r['claude_version']) for r in rows if r.get('claude_version')}) or 'not recorded'}",
            '  deviations from the lab harness and from the specification are listed in eval/README.md']
    return '\n'.join(out)


if __name__ == '__main__':
    text = report(); print(text)
    open(f'{lib.EVAL}/report.txt', 'w').write(text + '\n')
