"""onbudget eval queue: unattended, resumable, one paid run at a time, with a hard spend ceiling.

  python3 eval/queue.py plan                         slots, order and worst-case spend; runs nothing
  python3 eval/queue.py run --phase smoke            the three small smoke runs only
  python3 eval/queue.py run --phase main             main-tight, main-hard, pct, extra (refused until smoke has completed)
  python3 eval/queue.py run --phase added            simple-cap, hard-extra (the runs added after the first results)
  python3 eval/queue.py run                          resume the phase selection used last (smoke when there is none)
  python3 eval/queue.py status                       progress, spend against the ceiling, current run, last quota readings
  python3 eval/queue.py retry <slot>                 release a slot without retries left, or a smoke slot whose run the watchdog killed
  nohup python3 eval/queue.py run > eval/queue.nohup 2>&1 &        unattended

Every attempt of every slot gets its own run directory and session; a slot with a usable run is never repeated."""
import os, sys
if __name__ == 'queue':                                # a standard-library module asked for `queue` while eval/ leads sys.path: give it the real one
    import importlib.util, sysconfig
    _spec = importlib.util.spec_from_file_location('queue', os.path.join(sysconfig.get_path('stdlib'), 'queue.py'))
    sys.modules['queue'] = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(sys.modules['queue'])
import csv, datetime, glob, json, random, signal, socket, subprocess, time, traceback, urllib.error, urllib.request
import harness, lib, report
from lib import jload, jdump, ceiling

BASE = lib.EVAL                                    # state, logs and runs live here (the self-tests point it at a scratch directory)
SEED = 20261008
MAX_RETRIES = 2                                    # a slot whose run was void or failed is tried again at most twice
H5_WAIT_AT, D7_STOP_AT, RESET_MARGIN = 80, 90, 90  # percent, percent, seconds
INFRA_BACKOFF_MIN = (10, 20)
ECHO = True                                        # also print log lines (they land in queue.nohup)
PHASES = ('smoke', 'main-tight', 'main-hard', 'pct', 'extra', 'simple-cap', 'hard-extra')   # the last two were added after the first results
SELECT = {'smoke': PHASES[:1], 'main': PHASES[1:5], 'added': PHASES[5:], 'all': PHASES}


class Stop(RuntimeError):
    """Something only the operator can settle: the queue stops with STOPPED.txt and launches nothing further."""


def f(name): return f'{BASE}/{name}'
def stamp(): return time.strftime('%Y-%m-%d %H:%M:%S')
def scores(): return report.scores(BASE)
def save(state): jdump(f('state.json'), state)
def worst(slot): return slot['usd'] + harness.KILL_OVER
spend = report.spend


def log(msg):
    with open(f('queue.log'), 'a') as fh: fh.write(f'{stamp()} {msg}\n')
    if ECHO: print(f'{stamp()} {msg}', flush=True)


def full_order(state):
    """The persisted queue order, with any phase the state does not know yet in its seeded order."""
    order = dict(state.get('order') or {})
    for p in PHASES: order.setdefault(p, [s['id'] for s in slots() if s['phase'] == p])
    return order


# ---------------------------------------------------------------- slots
def slots():
    """Every slot in queue order: phases in order, a fixed-seed shuffle inside each phase (the two extra slots keep their order)."""
    def session(phase, arm, level, i, prefix=None):
        return dict(id=f'{prefix or level.lower()}-{arm}-{i}', phase=phase, mode='session', arm=arm, level=level, **harness.LEVELS[level])
    def smoke(arm, task, usd):
        return dict(id=f'smoke-{arm}-{task}', phase='smoke', mode='single', arm=arm, level='SMOKE', task=task, usd=usd, raw=f'${usd:.2f}')
    groups = {'smoke': [smoke('C', 'packaging', 0.46), smoke('C', 'tenacity', 0.28), smoke('A', 'tenacity', 0.28)],
              'main-tight': [session('main-tight', arm, 'TIGHT', i) for arm in 'ABC' for i in (1, 2)],
              'main-hard': [session('main-hard', arm, 'HARD', i) for arm in 'ABC' for i in (1, 2)],
              'pct': [session('pct', 'C', 'PCT', 1)],
              'extra': [session('extra', 'C', 'TIGHT', 1, 'extra-tight'), session('extra', 'B', 'PCT', 1, 'extra-pct')],
              'simple-cap': [session('simple-cap', 'A0', level, i) for level in ('TIGHT', 'HARD') for i in (1, 2)],
              'hard-extra': [session('hard-extra', arm, 'HARD', 3) for arm in 'BC']}
    rng = random.Random(SEED); out = []
    for phase in PHASES:
        if phase != 'extra': rng.shuffle(groups[phase])
        out += groups[phase]
    return out


def tries(sid, rows):
    """The slot's attempts that count: a session was launched, and the operator has not retired the run (`retry`)."""
    return [r for r in rows if r.get('slot') == sid and r.get('launched', True) and not r.get('retired')]


def slot_state(sid, rows):
    """'done' (has a usable run), 'exhausted' (no usable run and no retries left) or 'pending'."""
    mine = tries(sid, rows)
    if any(report.usable(r) for r in mine): return 'done'
    return 'exhausted' if len(mine) > MAX_RETRIES else 'pending'


# ---------------------------------------------------------------- money
def first_fit(pending, spent, ceil):
    """The first pending slot whose worst case (cap + kill margin) still fits under the ceiling, or None."""
    return next((s for s in pending if spent + worst(s) <= ceil + 1e-9), None)


# ---------------------------------------------------------------- quota guards
def epoch(value):
    """A resetsAt value as epoch seconds: ISO-8601 text, or a number in seconds or milliseconds."""
    if isinstance(value, (int, float)): return value / 1000 if value > 1e11 else float(value)
    try: return datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except Exception: return None


def newest_reading(rows):
    r = next((x for x in reversed(rows) if x.get('h5_last') is not None or x.get('d7_last') is not None), None)
    return r and dict(run_id=r.get('run_id'), h5=r.get('h5_last'), h5_resets=r.get('h5_resets'), d7=r.get('d7_last'), d7_resets=r.get('d7_resets'),
                      at=epoch((r.get('ts') or '')) or 0)


def guard_decision(reading, now):
    """('go' | 'wait' | 'stop', seconds to wait, why) from the newest known quota reading (None when there is none)."""
    if not reading: return 'go', 0, 'no quota reading known'
    h5, d7 = reading.get('h5'), reading.get('d7')
    d7_reset = epoch(reading.get('d7_resets'))
    if d7 is not None and d7 >= D7_STOP_AT and not (d7_reset and d7_reset < now):
        return 'stop', 0, f"weekly usage {d7}% >= {D7_STOP_AT}% (run {reading.get('run_id')}, resets {reading.get('d7_resets')})"
    if h5 is None or h5 < H5_WAIT_AT: return 'go', 0, f'5h usage {h5}% < {H5_WAIT_AT}%'
    reset = epoch(reading.get('h5_resets')) or (reading.get('at') or now) + 5 * 3600     # unknown reset time: a 5h window is over 5 h after the reading
    wait = reset + RESET_MARGIN - now
    if wait <= 0: return 'go', 0, f'5h usage was {h5}% but that window has reset'
    return 'wait', wait, f"5h usage {h5}% >= {H5_WAIT_AT}%: waiting {wait / 60:.0f} min (reset {reading.get('h5_resets')} + {RESET_MARGIN} s)"


def preflight():
    """Zero-cost readiness check (no model call): the API host answers and the CLI is logged in. None when ready, else the reason."""
    host = (os.environ.get('ANTHROPIC_BASE_URL') or 'https://api.anthropic.com').split('//')[-1].split('/')[0]
    try: socket.getaddrinfo(host, 443)
    except Exception as e: return f'DNS lookup of {host} failed ({type(e).__name__})'
    try: urllib.request.urlopen(urllib.request.Request(f'https://{host}/'), timeout=15)
    except urllib.error.HTTPError: pass                  # any HTTP answer means the server is reachable
    except Exception as e: return f'cannot reach https://{host} ({type(e).__name__})'
    try:
        r = subprocess.run([harness.CLAUDE, 'auth', 'status'], env=lib.clean_env(), capture_output=True, text=True, timeout=60)
        if not json.loads(r.stdout).get('loggedIn'): return 'the claude CLI is logged out (needs `claude auth login`)'
    except Exception as e: return f'could not read the CLI login state ({type(e).__name__})'
    return None


def wait_ready():
    """Block at zero cost until the API is reachable and the CLI is logged in; no attempt is used while waiting. False after 24 h."""
    t0 = time.time(); told = False
    while (why := preflight()) is not None:
        if not told: log(f'not ready: {why}; waiting at zero cost'); told = True
        jdump(f('PAUSED.json'), dict(kind='infrastructure', reason=why, since=stamp()))
        if time.time() - t0 > 24 * 3600: return False
        time.sleep(60 if time.time() - t0 < 900 else 300)
    if told: os.remove(f('PAUSED.json')); log('ready again')
    return True


# ---------------------------------------------------------------- lock, state, recovery
def alive(pid):
    try: os.kill(int(pid), 0); return True
    except PermissionError: return True
    except Exception: return False


def acquire_lock(pid=None):
    """Take eval/queue.lock for this process. Returns None on success, else the pid of the live queue that holds it."""
    pid = pid or os.getpid(); tmp = f(f'queue.lock.{pid}'); lock = f('queue.lock'); stale = tmp + '.stale'
    for _ in range(3):
        jdump(tmp, dict(pid=pid, since=stamp()))
        try: os.link(tmp, lock); return None                      # atomic: fails when the lock exists
        except FileExistsError:
            holder = (jload(lock) or {}).get('pid')
            if holder != pid and alive(holder): return holder
            try: os.rename(lock, stale)                           # atomic too: only one queue can move a given lock away
            except OSError: continue
            moved = (jload(stale) or {}).get('pid')
            if moved not in (holder, pid) and alive(moved): os.rename(stale, lock); return moved     # another queue's fresh lock: put it back
            log(f'removed the stale lock of pid {holder}'); os.remove(stale)
        finally: os.remove(tmp)
    return -1


def release_lock():
    if (jload(f('queue.lock')) or {}).get('pid') == os.getpid(): os.remove(f('queue.lock'))
    try: os.remove(f('PAUSED.json'))
    except OSError: pass


def stub_score(rid, meta, reason, reserved):
    """score.json for a run whose session did not finish (queue interrupted, harness exception): an infrastructure failure. Its
    cost is the larger of the logged and the CLI cost, the worst case when a session was started but neither is known, and zero
    when nothing was started (`launched` false: not an attempt)."""
    rd = f('runs') + f'/{rid}'; os.makedirs(rd, exist_ok=True); harness.keep_workspace(rid, f('runs'))
    rows = lib.read_log(rd); logged = lib.logged_cost(rows); started = os.path.exists(f'{rd}/pid.txt'); out = jload(f'{rd}/out.json')
    cli = out.get('total_cost_usd') if isinstance(out, dict) else None; known = [c for c in (logged, cli) if isinstance(c, (int, float))]
    r = dict(run_id=rid, slot=meta.get('slot'), phase=meta.get('phase'), arm=meta.get('arm'), level=meta.get('level'), mode=meta.get('mode'), task=meta.get('task'),
             budget=meta.get('usd'), budget_raw=meta.get('raw'), cost=(max(known) if known else None), cost_logged=logged, cost_cli=cli,
             cost_counted=(max(known) if known else reserved if started else 0), launched=started, void=False, infra_failure=True, complete=False, tasks_complete=0,
             subtype='interrupted', errors=reason[:300], ts=meta.get('started') or time.strftime('%Y-%m-%dT%H:%M:%S'), **lib.quota(rows))
    jdump(f'{rd}/score.json', r)
    return r


def session_ended(rid):
    """True when the run's session ran to its end (by itself or under the watchdog), so that only its scoring can be missing."""
    rd = f('runs') + f'/{rid}'
    return (jload(f'{rd}/spec.json') or {}).get('wall_s') is not None or bool(jload(f'{rd}/out.json'))


def scoring_failed(rid, e):
    log(f'scoring of {rid} failed: ' + ''.join(traceback.format_exception(e)).strip().replace('\n', ' | '))
    return Stop(f'scoring of the finished run {rid} failed ({e!r}). Its session is paid for and will not be repeated; its worst case stays reserved. '
                f'Fix the cause, then start the queue again (it scores the run first) or run `python3 eval/harness.py rescore {rid}`')


def score_ended(rid):
    """Score a run whose session has ended. If that fails the queue stops: the session is paid for and is rescored, never repeated."""
    try: harness.keep_workspace(rid, f('runs')); return harness.finish(rid, f('runs'))
    except Exception as e: raise scoring_failed(rid, e) from e


def reconcile(state):
    """After an interruption: stop sessions that outlived the queue, score runs whose session had ended, book the rest as interrupted."""
    cur = state.get('current') or {}; runs = f('runs'); ledger = state.setdefault('ledger', {})
    launched = {os.path.basename(os.path.dirname(p)) for p in glob.glob(f'{runs}/*/spec.json')}
    def pid_of(rid):
        try: return int(open(f'{runs}/{rid}/pid.txt').read())
        except Exception: return None
    for pid in {cur.get('pid')} | {pid_of(rid) for rid in launched if not os.path.exists(f'{runs}/{rid}/score.json')}:
        if pid and alive(pid) and '--plugin-dir' in subprocess.run(['ps', '-o', 'command=', '-p', str(pid)], capture_output=True, text=True).stdout:
            log(f'killing a session that outlived the queue (pid {pid})')
            try: os.killpg(pid, signal.SIGKILL); time.sleep(2)
            except Exception: pass
    for rid in sorted(launched | {rid for rid, e in ledger.items() if e.get('status') == 'running'}):
        spec = jload(f'{runs}/{rid}/spec.json') or {}
        entry = ledger.setdefault(rid, dict(slot=spec.get('slot'), reserved=spec.get('usd', 0) + harness.KILL_OVER, cost=None, status='running'))
        r = jload(f'{runs}/{rid}/score.json')
        if r is None and session_ended(rid):
            r = score_ended(rid); log(f"scored {rid}, whose session had ended before the queue was interrupted (counted ${r['cost_counted']:.2f})")
        elif r is None:
            r = stub_score(rid, dict(spec, slot=entry.get('slot')), 'the queue was interrupted during this run', entry['reserved'])
            log(f"reconciled interrupted run {rid} (counted ${r['cost_counted']:.2f})")
        if entry.get('status') == 'running': entry.update(cost=r.get('cost_counted'), status='done')
    state['current'] = None; save(state)


def begin():
    """Take the lock and load the state. The caller runs reconcile(state) next."""
    os.makedirs(f('runs'), exist_ok=True)
    holder = acquire_lock()
    if holder: sys.exit(f"another queue is running (pid {holder}, lock {f('queue.lock')}); not starting")
    for name in ('STOPPED.txt', 'DONE.txt', 'PAUSED.json'):
        if os.path.exists(f(name)): os.remove(f(name))
    state = jload(f('state.json'), {}) or {}
    state.setdefault('seed', SEED); state.setdefault('ledger', {}); state.setdefault('exhausted', [])
    state.setdefault('order', {p: [s['id'] for s in slots() if s['phase'] == p] for p in PHASES})
    for p in PHASES: state['order'].setdefault(p, [s['id'] for s in slots() if s['phase'] == p])   # phases added to a queue already begun
    return state


def write_outputs():
    rows = scores(); tmp = f('results.csv.tmp')
    cols = list(dict.fromkeys(k for r in rows for k in r if k not in ('per_task', 'score_history'))) + ['per_task']       # one row per run, every attempt
    with open(tmp, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction='ignore'); w.writeheader()
        for r in rows: w.writerow({k: json.dumps(v) if isinstance(v, (dict, list)) else v for k, v in r.items()})
    os.replace(tmp, f('results.csv'))
    open(f('report.txt'), 'w').write(report.report(BASE) + '\n')


def end(state, kind, reason):
    """Finish cleanly: 'done' writes DONE.txt, 'stopped' writes STOPPED.txt explaining why."""
    write_outputs(); total = spend(state, scores())
    open(f('DONE.txt' if kind == 'done' else 'STOPPED.txt'), 'w').write(f"{stamp()} {kind.upper()}: {reason}\nspend ${total:.2f} of ${ceiling(state.get('ceiling')):.2f}\n")
    log(f'{kind.upper()}: {reason} (spend ${total:.2f})')
    return kind, reason


# ---------------------------------------------------------------- the queue
def attempt(state, slot, runner):
    """One paid run of a slot. The worst case is reserved in the ledger before the launch and replaced by the real cost afterwards."""
    sid = slot['id']; k = len(glob.glob(f('runs') + f'/{sid}-a*')); rid = f'{sid}-a{k}'
    spec = dict({key: v for key, v in slot.items() if key != 'id'}, run_id=rid, slot=sid, attempt=k)
    state['ledger'][rid] = dict(slot=sid, reserved=worst(slot), cost=None, status='running', started=stamp())
    state['current'] = dict(run_id=rid, slot=sid, pid=None, started=time.time()); save(state)
    log(f"start {rid} ({slot['phase']}, {slot['mode']}, arm {slot['arm']}, budget {slot['raw']}, cap ${slot['usd']:.2f})")

    def on_start(pid): state['current']['pid'] = pid; save(state)
    stop = None
    try: r = runner(spec, runs=f('runs'), on_start=on_start)
    except harness.PluginInvalid:
        del state['ledger'][rid]; state['current'] = None; save(state); raise        # nothing was launched
    except Exception as e:
        r = jload(f('runs') + f'/{rid}/score.json')
        if r is None and session_ended(rid):                              # the session is paid for: the fault is in scoring, not a reason to buy it again
            state['current'] = None; save(state); raise scoring_failed(rid, e) from e
        log(f'harness exception on {rid}: {e!r}')
        if r is None:
            r = stub_score(rid, spec, f'harness exception: {e!r}', worst(slot))
            if not r['launched']: stop = f'{rid} could not be launched ({e!r}); nothing was spent and no attempt was used'
    state['ledger'][rid].update(cost=r.get('cost_counted', worst(slot)), status='done'); state['current'] = None; save(state)
    write_outputs()
    log(f"done  {rid} cost {r.get('cost')} budget {r.get('budget')} ended={r.get('ended')} complete={r.get('tasks_complete')}/{r.get('tasks_total')} "
        f"verified={r.get('tasks_verified_final')} void={r.get('void')} {('[' + str(r.get('void_reason')) + '] ') if r.get('void') else ''}"
        f"infra={r.get('infra_failure')} 5h={r.get('h5_last')} 7d={r.get('d7_last')} spend=${spend(state, scores()):.2f}")
    if stop: raise Stop(stop)
    return r


def work(state, phases, runner=harness.run, ready=wait_ready, sleep=time.sleep, now=time.time, version=harness.claude_version):
    """Run every pending slot of the selected phases that fits under the ceiling. Returns ('done' | 'stopped', reason)."""
    ceil = ceiling(state.get('ceiling')); by_id = {s['id']: s for s in slots()}; smoke_ids = state['order']['smoke']
    while True:
        rows = scores(); states = {sid: slot_state(sid, rows) for sid in by_id}
        state['exhausted'] = sorted(sid for sid, st in states.items() if st == 'exhausted'); save(state)
        pending = [by_id[sid] for p in phases for sid in state['order'][p] if states[sid] == 'pending']
        killed = [r['run_id'] for r in rows if r.get('slot') in smoke_ids and report.usable(r) and r.get('killed')]   # the cap did not hold
        if killed or any(states[sid] != 'done' for sid in smoke_ids):    # the main phases never start before smoke has passed
            pending = [s for s in pending if s['phase'] == 'smoke']
            if not pending: return end(state, 'stopped', f"smoke has not passed ({ {sid: states[sid] for sid in smoke_ids} }; smoke runs the watchdog had to kill: {killed or 'none'}); "
                                                         'the main phases were not started. `queue.py retry <slot>` releases such a slot once the cause is fixed')
        if any(s['phase'] != 'extra' for s in pending): pending = [s for s in pending if s['phase'] != 'extra']       # extra slots wait for everything above them
        if not pending:
            left = [sid for p in phases for sid in state['order'][p] if states[sid] == 'exhausted']
            return end(state, 'done', 'every selected slot has a usable run' if not left else f'slots without a usable run and no retries left: {left}')
        spent = spend(state, rows); slot = first_fit(pending, spent, ceil)
        if slot is None:
            return end(state, 'stopped', f"no pending slot fits under the ${ceil:.2f} ceiling: spent ${spent:.2f}, smallest worst case ${min(map(worst, pending)):.2f}; "
                                         f"pending: {[s['id'] for s in pending]}")
        if slot is not pending[0]: log(f"skipping {[s['id'] for s in pending[:pending.index(slot)]]}: their worst case does not fit under the ceiling; {slot['id']} does")
        action, secs, why = guard_decision(newest_reading(rows), now())
        if action == 'stop': return end(state, 'stopped', why)
        if action == 'wait':
            log(why); jdump(f('PAUSED.json'), dict(kind='5h', reason=why, since=stamp(), until=time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now() + secs))))
            sleep(secs); os.remove(f('PAUSED.json')); log('resumed after the 5h reset'); continue
        if not ready(): return end(state, 'stopped', 'the API or the CLI login was not ready for 24 h')
        seen = version(); pinned = state.setdefault('claude_version', seen)
        if seen != pinned: return end(state, 'stopped', f'the claude CLI is now {seen!r}; the runs so far used {pinned!r}. Point ONBUDGET_CLAUDE_BIN at that version, '
                                                        'or remove "claude_version" from state.json to continue on the new one')
        try: r = attempt(state, slot, runner)
        except (harness.PluginInvalid, Stop) as e: return end(state, 'stopped', str(e))
        if r.get('stop_queue'): return end(state, 'stopped', f"{r.get('run_id')}: {r['stop_queue']}. A retry would repeat this set-up fault, so nothing further was launched")
        failed = 1 + len(tries(slot['id'], rows))
        if r.get('void'):                                                 # a void run is excluded and its slot goes to the end of its phase
            order = state['order'][slot['phase']]; order.remove(slot['id']); order.append(slot['id']); save(state)
            log(f"slot {slot['id']}: void run ({failed} of {1 + MAX_RETRIES} attempts used)")
        elif r.get('infra_failure') and failed <= MAX_RETRIES:
            mins = INFRA_BACKOFF_MIN[min(failed, len(INFRA_BACKOFF_MIN)) - 1]
            log(f"infrastructure failure on {r.get('run_id')} ({r.get('errors')}); attempt {failed} of {1 + MAX_RETRIES}; retrying after {mins} min and a readiness check")
            jdump(f('PAUSED.json'), dict(kind='infrastructure', reason=f"backing off {mins} min after {r.get('run_id')}", since=stamp()))
            sleep(mins * 60); os.remove(f('PAUSED.json'))


def run(selection):
    def on_signal(signum, _): raise SystemExit(f'signal {signum}')
    signal.signal(signal.SIGTERM, on_signal)
    if signal.getsignal(signal.SIGHUP) != signal.SIG_IGN: signal.signal(signal.SIGHUP, on_signal)      # under nohup a hangup stays ignored
    ceiling(); state = begin()
    try:
        if sys.platform == 'darwin':                                      # keep the machine awake for as long as this process lives
            try: subprocess.Popen(['caffeinate', '-is', '-w', str(os.getpid())], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except OSError: pass
        reconcile(state)
        resumed = '' if selection else ' (the selection used last)'; selection = selection or state.get('selection') or 'smoke'
        state['selection'] = selection; state['ceiling'] = ceiling(state.get('ceiling')); save(state)
        log(f"queue start/resume pid {os.getpid()} phases {selection}{resumed} spend ${spend(state, scores()):.2f} of ${state['ceiling']:.2f}")
        print(work(state, SELECT[selection]))
    except Stop as e: print(end(state, 'stopped', str(e)))
    except (SystemExit, KeyboardInterrupt) as e:
        log(f'queue interrupted ({e}); the run in progress, if any, is booked as an infrastructure failure on the next start'); raise
    except BaseException:
        open(f('STOPPED.txt'), 'w').write(f'{stamp()} STOPPED: the queue script crashed\n{traceback.format_exc()}\n'); log('CRASH ' + traceback.format_exc().strip().splitlines()[-1]); raise
    finally: release_lock()


# ---------------------------------------------------------------- read-only views
def plan():
    rows = scores(); state = jload(f('state.json'), {}) or {}; ceil = ceiling(state.get('ceiling')); spent = spend(state, rows); total = spent; cap_sum = 0
    by_id = {s['id']: s for s in slots()}; order = full_order(state)
    out = [f'ceiling ${ceil:.2f} | spent so far ${spent:.2f} | seed {SEED} | kill margin ${harness.KILL_OVER:.2f} | model {harness.MODEL} effort {harness.EFFORT}',
           f"{'#':>2} {'slot':<18} {'phase':<10} {'arm':<3} {'mode':<7} {'level':<5} {'budget':<7} {'cap':>5} {'worst':>6} {'cum. worst':>10}  state"]
    for i, sid in enumerate((sid for p in PHASES for sid in order[p]), 1):
        s = by_id[sid]; st = slot_state(sid, rows)
        if st == 'pending': total += worst(s); cap_sum += s['usd']
        fits = '' if st != 'pending' else 'fits' if total <= ceil + 1e-9 else 'DOES NOT FIT if every earlier run reaches its worst case'
        out.append(f"{i:>2} {sid:<18} {s['phase']:<10} {s['arm']:<3} {s['mode']:<7} {s['level']:<5} {s['raw']:<7} {s['usd']:>5.2f} {worst(s):>6.2f} {total:>10.2f}  {st} {fits}".rstrip()
                   + (f" ({s['task']})" if s.get('task') else ''))
    out.append(f'pending slots: at their caps ${spent + cap_sum:.2f}, at their worst cases ${total:.2f}; the queue launches a run only while spent + worst case <= ${ceil:.2f}')
    for name in sorted({p for a in harness.ARMS.values() for p in a['plugins']}):
        out.append(f"plugin {name}: {harness.PLUGINS[name]} " + ('(present)' if os.path.exists(f'{harness.PLUGINS[name]}/.claude-plugin/plugin.json') else '(MISSING: its arms cannot launch)'))
    ctx = harness.context_files(harness.WORK)
    out.append(f'sessions run in {harness.WORK}; files Claude Code reads from the directories above it: {ctx or "none"}')
    if any(x.endswith('/.git') for x in ctx): out.append('WARNING: the work directory is inside a git repository; runs are refused until ONBUDGET_EVAL_WORK points elsewhere')
    return '\n'.join(out)


def status():
    state = jload(f('state.json'), {}) or {}; rows = scores(); lock = jload(f('queue.lock')) or {}; live = bool(lock) and alive(lock.get('pid'))
    pause = jload(f('PAUSED.json')); cur = state.get('current') or {}; by_id = {s['id']: s for s in slots()}
    order = full_order(state)
    word = (f"PAUSED ({pause.get('kind')}: {pause.get('reason')})" if live and pause else f"RUNNING (pid {lock.get('pid')})" if live else
            'DONE' if os.path.exists(f('DONE.txt')) else 'STOPPED' if os.path.exists(f('STOPPED.txt')) else 'NOT RUNNING')
    out = [f"queue: {word} | phases {state.get('selection') or '-'} | spend ${spend(state, rows):.2f} of ${ceiling(state.get('ceiling')):.2f} | claude {state.get('claude_version') or '-'} | "
           f"void {sum(1 for r in rows if r.get('void'))} | infrastructure failures {sum(1 for r in rows if r.get('infra_failure'))}"]
    if cur.get('run_id'):
        c = lib.logged_cost(lib.read_log(f('runs') + f"/{cur['run_id']}")); mins = (time.time() - cur.get('started', time.time())) / 60
        out.append(f"current run: {cur['run_id']} pid {cur.get('pid')} ({'alive' if alive(cur.get('pid')) else 'not alive'}), {mins:.0f} min, logged cost so far {c}")
    rd = newest_reading(rows + [dict(lib.quota(lib.read_log(f('runs') + f"/{cur['run_id']}")), run_id=cur['run_id'])] if cur.get('run_id') else rows)
    out.append(f"last quota reading: 5h {rd['h5']}% (resets {rd['h5_resets']}), 7d {rd['d7']}% (resets {rd['d7_resets']}), from {rd['run_id']}" if rd else 'last quota reading: none')
    for s in (by_id[sid] for p in PHASES for sid in order[p]):             # the persisted queue order, as in `plan`
        runs = ', '.join(f"{r.get('run_id')}: {'RETIRED ' if r.get('retired') else ''}{'VOID' if r.get('void') else 'INFRA' if r.get('infra_failure') else str(r.get('tasks_complete')) + '/' + str(r.get('tasks_total'))}"
                         f" ${(r.get('cost') or 0):.2f} {r.get('ended') or r.get('subtype')}" for r in rows if r.get('slot') == s['id'])
        st = 'running' if cur.get('slot') == s['id'] else slot_state(s['id'], rows)
        out.append(f"  {s['id']:<18} {s['phase']:<10} {s['raw']:<7} {st:<9} {runs}")
    for name in ('STOPPED.txt', 'DONE.txt'):
        if os.path.exists(f(name)): out.append(open(f(name)).read().strip().split('\n\n')[0])
    try: out.append('--- last log lines ---\n' + ''.join(open(f('queue.log')).readlines()[-5:]).strip())
    except OSError: pass
    return '\n'.join(out)


def retry(sid):
    """Release a slot for fresh attempts. Its runs so far stay on disk, in the ledger and in the per-run rows of the report, but
    no longer count as attempts or as results. Only for a slot without retries left, or a smoke slot whose run the watchdog killed."""
    state = jload(f('state.json'), {}) or {}; rows = scores(); mine = tries(sid, rows)
    if alive((jload(f('queue.lock')) or {}).get('pid')): sys.exit('a queue is running; stop it first')
    if not (slot_state(sid, rows) == 'exhausted' or (sid.startswith('smoke-') and any(report.usable(r) and r.get('killed') for r in mine))):
        sys.exit(f'{sid}: not released (only a slot without retries left, or a smoke slot whose run the watchdog killed, can be)')
    state['retired'] = (state.get('retired') or []) + [r['run_id'] for r in mine]; save(state)
    return f"{sid}: released; retired runs {[r['run_id'] for r in mine]} (their cost stays in the ledger)"


def parse(args):
    """(command, argument) of a recognised command line, else None: anything unrecognised is refused, never read as a plain `run`."""
    args = list(args) or ['status']; cmd, rest = args[0], args[1:]
    if cmd == 'run' and len(rest) == 1 and rest[0].startswith('--phase='): rest = rest[0].split('=', 1)
    if cmd == 'run' and (not rest or (len(rest) == 2 and rest[0] == '--phase' and rest[1] in SELECT)): return cmd, (rest[1] if rest else None)
    if cmd == 'retry' and len(rest) == 1: return cmd, rest[0]
    return (cmd, None) if cmd in ('status', 'plan') and not rest else None


if __name__ == '__main__':
    cmd, arg = parse(sys.argv[1:]) or sys.exit(__doc__)
    if cmd == 'run': run(arg)
    else: print(retry(arg) if cmd == 'retry' else status() if cmd == 'status' else plan())
