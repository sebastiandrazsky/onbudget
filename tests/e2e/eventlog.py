"""onbudget's event log, as the end-to-end suites and the evaluation find it.

With ONBUDGET_LOG=1 the plugin writes one fixed file in its own folder, log/events.jsonl, continued in log/events.1.jsonl,
log/events.2.jsonl, ... every 200 rows; each process that logs starts it again. The suites run one Claude Code process at
a time against a plugin folder, so they clear the log before a process, read it there while the process runs, and keep a
copy beside that process's other files when it ends. Standard library only."""
import glob, os, re

CHUNK = re.compile(r'^events(?:\.(\d+))?\.jsonl$')


def chunks(plugin_dir):
    """The log's chunk files in a plugin folder, in order."""
    found = [f for f in glob.glob(os.path.join(plugin_dir, 'log', 'events*.jsonl')) if CHUNK.match(os.path.basename(f))]
    return sorted(found, key=lambda f: int(CHUNK.match(os.path.basename(f)).group(1) or 0))


def clear(plugin_dir):
    for f in chunks(plugin_dir): os.remove(f)


def lines(plugin_dir):
    out = []
    for f in chunks(plugin_dir):
        try: out += [l for l in open(f) if l.strip()]
        except OSError: pass
    return out


def keep(plugin_dir, dest):
    """Writes the log, its chunks joined in order, to `dest`, and clears it from the plugin folder."""
    with open(dest, 'w') as out: out.writelines(lines(plugin_dir))
    clear(plugin_dir)
