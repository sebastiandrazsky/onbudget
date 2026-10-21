#!/usr/bin/env python3
"""The permission-dialog matcher of eval/interactive_smoke.py, on synthetic dialogs, at no cost.

The fixtures are modelled on dialogs Claude Code 2.1.306 drew in a live re-check (2026-10-21): a Write beside the working
folder, a Bash `cat >>` append and a Bash `wc -w` read on that outside path, a create inside the folder, and the banner,
which always shows the working path. They use temporary folders, never a personal path.

usage: python3 tests/e2e/dialogs.py
"""
import importlib.util, os, shutil, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('smoke', os.path.join(HERE, '..', '..', 'eval', 'interactive_smoke.py'))
smoke = importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)
RESULTS = []
RULE, DASH = '─' * 80, '╌' * 80
FOOT = ' Esc to cancel · Tab to amend'


def check(name, ok, detail=''):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'\n      {detail}' if detail and not ok else ''))


def banner(work):
    return ['╭─── Claude Code v2.1.306 ' + '─' * 53 + '╮', '│' + ' ' * 78 + '│', f'│   Welcome back!   cwd: {work}'.ljust(79) + '│', '╰' + '─' * 78 + '╯', '']


def prompt_box():
    return [RULE, '❯ ', RULE, '  ⚠ onbudget: tier HIGH · $0.15 left · budget $0.20', '  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt']


def file_dialog(kind, path, question, preview=('    1 # Plan', '    2')):
    return ['', RULE, f' {kind}', f' {path}', DASH, *preview, DASH, f' Do you want to {question}?', ' ❯ 1. Yes',
            '   2. Yes, allow all edits during this session (shift+tab)', '   3. No', '', FOOT]


def bash_dialog(what, command_lines, second):
    return ['', RULE, ' Bash command', ' Tip: auto mode handles these prompts for you — choose "switch to auto mode"', ' below', f' {what}', DASH,
            *command_lines, DASH, ' Do you want to proceed?', ' ❯ 1. Yes', f'   2. {second}',
            '   3. Yes, and switch to auto mode · auto mode handles these prompts for you', '   4. No', '', FOOT]


def screen(work, *parts):
    return [*banner(work), '⏺ Working on it.', *[l for p in parts for l in p]]


def answer(rows, work):
    d = smoke.find_dialog(rows)
    return (None, 'no dialog') if d is None else smoke.decide(d, work)


def main():
    base = tempfile.mkdtemp(prefix='onbudget-dialogs-', dir='/tmp' if os.path.isdir('/tmp') else None)
    try:
        work = os.path.join(base, 'recheck', 'work'); outside = os.path.join(base, 'recheck-work')
        os.makedirs(work); os.makedirs(outside)
        alias = os.path.realpath(work)   # macOS: /tmp is /private/tmp, so the dialog can name the folder by either spelling
        print(f'working folder {work}, as the dialog may name it: {alias}' + (' (the same: no alias on this system)' if alias == work else ''))
        cases = [
            # (name, rows, expected answer)
            ('a Write beside the folder, shown relative with ".." (as Claude Code drew it)', screen(work, file_dialog('Create file', '../../recheck-work/plan.md', 'create plan.md')), 'no'),
            ('a Write to an absolute path outside the folder', screen(work, file_dialog('Create file', f'{outside}/plan.md', 'create plan.md')), 'no'),
            ('a Bash cat >> append to a file outside the folder', screen(work, bash_dialog('Run shell command', [f" │ cat >> {outside}/design.md <<'EOF'", ' │', ' │ ## 7. Lifecycle', ' │ EOF'],
                                                                                          'Yes, and always allow access to recheck-work/ from this project')), 'no'),
            ('a Bash wc -w read outside the folder', screen(work, bash_dialog('Count words in the document', [f' wc -w {outside}/design.md'], f'Yes, allow reading from {outside} from this project')), 'no'),
            ('a Bash command inside the folder is still refused', screen(work, bash_dialog('Run the tests', [f' cd {work} && python3 -m pytest'], 'Yes, and don\'t ask again for python3 commands')), 'no'),
            ('the sensitive-file rm that interactive-real-7 approved', screen(work, bash_dialog('Remove misplaced files and run tests', [f' rm {base}/fizzbuzz.py && python3 -m unittest'], 'Yes, and always allow')), 'no'),
            ('a create inside the folder, relative', screen(work, file_dialog('Create file', 'fizzbuzz.py', 'create fizzbuzz.py')), 'yes'),
            ('a create inside the folder, absolute', screen(work, file_dialog('Create file', f'{work}/test_fizzbuzz.py', 'create test_fizzbuzz.py')), 'yes'),
            ('a create inside the folder through the /private alias', screen(work, file_dialog('Create file', f'{alias}/notes.md', 'create notes.md')), 'yes'),
            ('an edit inside the folder', screen(work, file_dialog('Edit file', 'design.md', 'make this edit to design.md', ('  12 -old', '  12 +new'))), 'yes'),
            ('a create in a subfolder of the folder', screen(work, file_dialog('Create file', 'pkg/mod.py', 'create mod.py')), 'yes'),
            ('a path written from the home folder, as Claude Code shows one there ("~/…")', screen(work, file_dialog('Create file', '~/Documents/project/fizzbuzz.py', 'create fizzbuzz.py')), 'no'),
            ('the home folder alone', screen(work, file_dialog('Create file', '~/fizzbuzz.py', 'create fizzbuzz.py')), 'no'),
            ('a path through a variable', screen(work, file_dialog('Create file', '$HOME/fizzbuzz.py', 'create fizzbuzz.py')), 'no'),
            ('a path cut with "…"', screen(work, file_dialog('Create file', 'very/long/…/plan.md', 'create plan.md')), 'no'),
            ('a path wrapped onto a second line', screen(work, ['', RULE, ' Create file', ' deep/folder/with/a/very/long/name/that/runs/on/past/the/edge/of/the/terminal/a', ' nd/plan.md',
                                                                DASH, '    1 x', DASH, ' Do you want to create plan.md?', ' ❯ 1. Yes', '   3. No', '', FOOT]), 'no'),
            ('the folder itself as the target', screen(work, file_dialog('Create file', work, f'create {os.path.basename(work)}')), 'no'),
            ('a question that names another file', screen(work, file_dialog('Create file', 'fizzbuzz.py', 'create ../evil.py')), 'no'),
            ('a kind it does not know', screen(work, file_dialog('Overwrite file', 'fizzbuzz.py', 'overwrite fizzbuzz.py')), 'no'),
            ('an offer with no question', screen(work, ['', RULE, ' LSP recommendations', ' Install pyright-lsp?', ' ❯ 1. Yes', '   2. No', '', FOOT]), 'no'),
            ('a dialog whose first option is not "1. Yes"', screen(work, ['', RULE, ' Create file', ' a.py', DASH, '    1 x', DASH, ' Do you want to create a.py?', ' ❯ 1. Yes, and allow all', '', FOOT]), 'no'),
            ('a dialog taller than the screen, its edge and heading scrolled off', ['   41 more of the file', '   42 and more', DASH, ' Do you want to create plan.md?', ' ❯ 1. Yes', '   3. No', '', FOOT], 'no'),
            ('the banner and the prompt box, with no dialog', screen(work, [''], prompt_box()), None),
        ]
        for name, rows, want in cases:
            got, why = answer(rows, work)
            check(f'{name}: {want or "nothing to answer"}', got == want, f'got {got} ({why})')
        # The record of a dialog: its kind and target, from the box.
        d = smoke.find_dialog(screen(work, bash_dialog('Count words in the document', [f' wc -w {outside}/design.md'], 'Yes')))
        check('a Bash dialog is recorded with its command', d and d['kind'] == 'Bash command' and smoke.target_of(d) == f'wc -w {outside}/design.md', str(d and smoke.target_of(d)))
        # Typing waits for the prompt box: never while a dialog is open.
        check('the prompt is open with the banner and the prompt box', smoke.input_open(screen(work, [''], prompt_box())))
        check('the prompt is not open while a dialog is', not smoke.input_open(screen(work, prompt_box(), file_dialog('Create file', 'a.py', 'create a.py'))))
        check('a dialog is read from its own box: the working path in the banner approves nothing',
              answer(screen(work, bash_dialog('Run shell command', [f' ls {work}'], 'Yes')), work)[0] == 'no')
        check('no personal path in the fixtures', not any(os.path.expanduser('~') in l for _, rows, _ in cases for l in rows))
    finally:
        shutil.rmtree(base, ignore_errors=True)
    print(f'\n{sum(RESULTS)} passed, {len(RESULTS) - sum(RESULTS)} failed')
    sys.exit(0 if all(RESULTS) else 1)


if __name__ == '__main__':
    main()
