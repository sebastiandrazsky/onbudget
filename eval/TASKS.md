# Evaluation tasks: upstream provenance

Each task is a real merged pull request in a public Python project. The model starts from the pull request's base commit, receives the task statement below, and is scored with test files taken from the pull request's fix commit, which it never sees. The statements in this file are the statements given to the model: they are copied byte for byte from the lab's `statement.md` files. The harness strips leading and trailing whitespace from each one, and in the seven-task session it puts a header and one line with the offline test command before each statement (`eval/harness.py`, `eval/tasks.json`).

`eval/upstream.json` carries the same data for scripts: repository, commits, hidden files, fail-to-pass test ids, the pinned requirements of the lab environment, and the SHA-256 of each statement. `eval/rebuild_tasks.py` rebuilds the fixture tree that `eval/lib.py` expects from public sources, using that file and the statements in this one. The statements here are the reference for the text. The test id lists below are printed from `eval/upstream.json`, which is the reference for the ids.

## How a run is scored

The finished tree is copied, the original test directory is restored, the hidden test files are laid over it, and the scoring command runs with the task's pinned environment (`score_once` and `run_tests` in `eval/lib.py`). Besides the arguments listed per task, pytest gets `-q -p no:cacheprovider --tb=no --continue-on-collection-errors --timeout=3 --timeout-method=signal` and a JUnit XML report. A test id is `classname::name` from that report. A task is complete when every fail-to-pass (f2p) test passes, every pass-to-pass (p2p) test still passes, and, for the tasks that have one, the changelog rule in `eval/tasks.json` holds. An f2p test is one that fails, errors or is missing at the base commit with the hidden files laid over it, and passes at the fix commit. A p2p test passes in both places. The p2p lists are not stored in this repository; `python3 eval/rebuild_tasks.py` derives them.

## Rebuilding a task

The lab's fixtures (base trees, hidden tests, venvs, oracles) are not in this repository. To rebuild and check one task from public sources, with git, tar, Python 3 and network access to github.com and PyPI:

```
python3 eval/rebuild_tasks.py --lab /tmp/onbudget-lab --prove pluggy
```

The first command prints `PASS pluggy: ...` when every f2p test fails at the base commit and passes at the fix commit. Without `--prove` it only builds. Without a task name it builds all nine; packaging alone runs about 62,000 tests several times. To run the evaluation on a rebuilt directory, rebuild the seven session tasks and set `ONBUDGET_LAB` to it. Eight of the nine tasks (all but packaging) were rebuilt this way and compared with the lab's copies: the base, hidden and fix trees and the pip pins match, and so do the f2p and p2p sets. A Python version different from the lab's prints a warning.

## Summary

| Task | Upstream repository | Licence | Pull request | f2p | p2p | Used in |
|---|---|---|---|---|---|---|
| boltons | [mahmoud/boltons](https://github.com/mahmoud/boltons) | BSD-3-Clause | [#443](https://github.com/mahmoud/boltons/pull/443) | 14 | 450 | seven-task session |
| falcon | [falconry/falcon](https://github.com/falconry/falcon) | Apache-2.0 | [#2738](https://github.com/falconry/falcon/pull/2738) | 25 | 4148 | seven-task session |
| markdown-it-py | [executablebooks/markdown-it-py](https://github.com/executablebooks/markdown-it-py) | MIT | [#433](https://github.com/executablebooks/markdown-it-py/pull/433) | 12 | 1019 | seven-task session |
| pluggy | [pytest-dev/pluggy](https://github.com/pytest-dev/pluggy) | MIT | [#738](https://github.com/pytest-dev/pluggy/pull/738) | 4 | 197 | seven-task session |
| pydantic-settings | [pydantic/pydantic-settings](https://github.com/pydantic/pydantic-settings) | MIT | [#972](https://github.com/pydantic/pydantic-settings/pull/972) | 7 | 655 | seven-task session |
| werkzeug | [pallets/werkzeug](https://github.com/pallets/werkzeug) | BSD-3-Clause | [#3288](https://github.com/pallets/werkzeug/pull/3288) | 129 | 859 | seven-task session |
| werkzeug-cond | [pallets/werkzeug](https://github.com/pallets/werkzeug) | BSD-3-Clause | [#3308](https://github.com/pallets/werkzeug/pull/3308) | 48 | 985 | seven-task session |
| packaging | [pypa/packaging](https://github.com/pypa/packaging) | Apache-2.0 OR BSD-2-Clause | [#1351](https://github.com/pypa/packaging/pull/1351) | 5 | 62399 | round-one single-task runs |
| tenacity | [jd/tenacity](https://github.com/jd/tenacity) | Apache-2.0 | [#694](https://github.com/jd/tenacity/pull/694) | 4 | 174 | round-one single-task runs |

f2p and p2p are the counts of fail-to-pass and pass-to-pass tests. All nine environments were built with Python 3.14.5.

## boltons

- Upstream repository: <https://github.com/mahmoud/boltons>
- Licence: BSD-3-Clause
- Pull request: [#443](https://github.com/mahmoud/boltons/pull/443), "Edge-case hardening sweep: six long-standing crash/hang/correctness fixes", merged 2026-08-06T20:44:20Z
- Base commit (the tree the model starts from): [`c1c25da365cf14878cf5317147e7a09b5d124df5`](https://github.com/mahmoud/boltons/commit/c1c25da365cf14878cf5317147e7a09b5d124df5)
- Fix commit (source of the hidden tests): [`814a5a7c6e27fcb52c524ca4fe2b05108903058c`](https://github.com/mahmoud/boltons/commit/814a5a7c6e27fcb52c524ca4fe2b05108903058c)
- Hidden test files: `tests/test_iterutils.py`, `tests/test_jsonutils.py`, `tests/test_strutils.py`, `tests/test_tableutils.py`, `tests/test_timeutils.py`
- Scoring command, run from the repository root with no `PYTHONPATH`: `python -m pytest tests`
- Environment: Python 3.14.5, 6 pinned packages (`requirements` in `eval/upstream.json`)
- Used in: seven-task session
- Excluded tests and other notes: none.

### boltons: fail-to-pass tests (14)

- `tests.test_iterutils::test_xfrange_descending`
- `tests.test_iterutils::test_xfrange_matches_frange`
- `tests.test_iterutils::test_xfrange_wrong_direction`
- `tests.test_jsonutils::test_jsonl_iterator_mid_last_line_seek_terminates`
- `tests.test_jsonutils::test_jsonl_iterator_rel_seek_negative`
- `tests.test_strutils::test_multi_replace_empty_mapping`
- `tests.test_tableutils::test_to_text_empty_table`
- `tests.test_tableutils::test_to_text_no_headers`
- `tests.test_tableutils::test_to_text_none_headers`
- `tests.test_tableutils::test_to_text_short_headers_padded`
- `tests.test_timeutils::test_daterange_step_does_not_advance`
- `tests.test_timeutils::test_daterange_wrong_direction`
- `tests.test_timeutils::test_isoparse_fraction_overprecise`
- `tests.test_timeutils::test_isoparse_fractional_seconds`

The pass-to-pass set is 450 tests.

### boltons: task statement

<!-- statement:begin boltons -->
You are working in the `boltons` Python utility library (the current directory is the repository root; `python` and `pytest` on PATH have all dependencies installed; there is no network). An edge-case review found six long-standing bugs. Fix all of them in the library code under `boltons/` so that the following hold:

1. `boltons.tableutils.Table.to_text()` must not crash on degenerate tables. `Table([[]]).to_text()` returns `''`. A table whose headers are empty (for example `Table([[], [1]])`) renders no header row and no separator rule, the same convention `to_html` uses. A `None` header renders as the text `None`, like a `None` data cell. Headers shorter than the table width are padded with `None` cells, as `to_html` does.
2. `boltons.timeutils.isoparse` must read fractional seconds as a decimal fraction, not as an integer count of microseconds: `.851` is 851000 microseconds, `.051` is 51000 and `.000001` is 1, so `datetime.isoformat()` round-trips at the `milliseconds` and `microseconds` timespecs. A fraction with more than 6 digits is truncated to microsecond precision instead of raising.
3. `boltons.timeutils.daterange` must always terminate. A step that cannot advance (`0`, `(0, 0, 0)`, or a self-cancelling tuple such as `(0, 1, -31)`) raises `ValueError`, including when `stop` is `None`. A step that points away from `stop` yields nothing, like `range(1, 5, -1)`. Behaviour for valid steps, including `datetime` arguments with sub-day `timedelta` steps, stays the same.
4. `boltons.strutils.MultiReplace` built from an empty mapping (`{}` or `[]`) is a no-op: `.sub(text)` and `multi_replace(text, {})` return `text` unchanged instead of raising `KeyError`.
5. `boltons.jsonutils.JSONLIterator` must not loop forever when a seek lands past the last newline in the file (for example a mid-line `rel_seek` into a final line that has no trailing newline; iteration then yields nothing). A negative `rel_seek` must count back from the end of the file, so `rel_seek=-0.5` behaves exactly like `rel_seek=0.5`.
6. `boltons.iterutils.xfrange` must yield the same elements as `frange`, using `frange`'s deterministic count-based semantics. That includes descending ranges (`list(xfrange(5, 0, step=-1.25)) == [5.0, 3.75, 2.5, 1.25]`), wrong-direction ranges yielding nothing (`xfrange(1, 5, step=-1)` and `xfrange(5, 0)`), and inexact float boundaries (`len(frange(1.0, step=0.1)) == 10`, `len(frange(10.0, step=0.1)) == 100`). `frange`'s own output must not change, and a zero step raises `ValueError` for both functions (for `xfrange` when iterated).
7. All existing tests must still pass.
<!-- statement:end boltons -->

## falcon

- Upstream repository: <https://github.com/falconry/falcon>
- Licence: Apache-2.0
- Pull request: [#2738](https://github.com/falconry/falcon/pull/2738), "feat(app): add functionality to report all exceptions", merged 2026-09-18T17:07:55Z
- Base commit (the tree the model starts from): [`f05cc8361bcc0c87939fa4e017edac3604b70e99`](https://github.com/falconry/falcon/commit/f05cc8361bcc0c87939fa4e017edac3604b70e99)
- Fix commit (source of the hidden tests): [`e578d21c2a1f61d6021b53484b8c4fb8cf185954`](https://github.com/falconry/falcon/commit/e578d21c2a1f61d6021b53484b8c4fb8cf185954)
- Hidden test files: `tests/test_error_reporter.py`, `tests/test_error_handlers.py`
- Scoring command, run from the repository root with `PYTHONPATH=.`: `python -m pytest tests --ignore=tests/asgi/test_asgi_servers.py --ignore=tests/test_wsgi_servers.py`
- Environment: Python 3.14.5, 28 pinned packages (`requirements` in `eval/upstream.json`)
- Used in: seven-task session
- Excluded tests and other notes:
  - live-server tests (uvicorn/gunicorn/waitress subprocesses) excluded.
  - The scoring command ignores `tests/asgi/test_asgi_servers.py`, `tests/test_wsgi_servers.py`.
  - Excluded as unstable across repeated lab runs (in neither list): `tests.asgi.test_ws::test_ws_enter_context_timeout`.
  - Fails at the fix commit in the lab environment, so it is in neither list: `tests.asgi.test_ws::test_echo`.

### falcon: fail-to-pass tests (25)

- `tests.test_error_reporter::test_handler_not_found[asgi]`
- `tests.test_error_reporter::test_handler_not_found[wsgi]`
- `tests.test_error_reporter::test_handler_raises_exception[asgi-False]`
- `tests.test_error_reporter::test_handler_raises_exception[asgi-True]`
- `tests.test_error_reporter::test_handler_raises_exception[wsgi-False]`
- `tests.test_error_reporter::test_handler_raises_exception[wsgi-True]`
- `tests.test_error_reporter::test_handler_raises_http_error[asgi]`
- `tests.test_error_reporter::test_handler_raises_http_error[wsgi]`
- `tests.test_error_reporter::test_handler_raises_http_status[asgi]`
- `tests.test_error_reporter::test_handler_raises_http_status[wsgi]`
- `tests.test_error_reporter::test_handler_reraises[asgi]`
- `tests.test_error_reporter::test_handler_reraises[wsgi]`
- `tests.test_error_reporter::test_report_404[asgi]`
- `tests.test_error_reporter::test_report_404[wsgi]`
- `tests.test_error_reporter::test_report_fatal_error_rendering_asgi_headers[True-200 OK]`
- `tests.test_error_reporter::test_report_fatal_error_rendering_asgi_headers[True-204 No Content]`
- `tests.test_error_reporter::test_report_fatal_error_starting_resp[asgi-False]`
- `tests.test_error_reporter::test_report_fatal_error_starting_resp[asgi-True]`
- `tests.test_error_reporter::test_report_fatal_error_starting_resp[wsgi-False]`
- `tests.test_error_reporter::test_report_fatal_error_starting_resp[wsgi-True]`
- `tests.test_error_reporter::test_report_http_status[asgi]`
- `tests.test_error_reporter::test_report_http_status[wsgi]`
- `tests.test_error_reporter::test_report_none[asgi]`
- `tests.test_error_reporter::test_report_none[wsgi]`
- `tests.test_error_reporter::test_report_websocket`

The pass-to-pass set is 4148 tests.

### falcon: task statement

<!-- statement:begin falcon -->
You are working in the `falcon` repository (the current directory is the repository root; `python` and `pytest` on PATH have all dependencies installed; there is no network). There is currently no way to observe every exception raised while Falcon processes a request, for example to log it or send it to an error tracker. Add that capability for both the WSGI (`falcon.App`) and ASGI (`falcon.asgi.App`) applications. Requirements:

1. Add `App.set_error_reporter(reporter)` to both application classes. The reporter is a plain (synchronous) callable `reporter(req, ex, params, handled)` in both WSGI and ASGI apps, where `req` is the request, `ex` the exception, `params` the dict of responder keyword arguments, and `handled` a bool. Only one reporter can be set; calling the method again replaces the previous one. With no reporter set, behaviour is exactly as before.
2. The reporter is called for every exception that is passed to the app's error handling, including `HTTPError` and `HTTPStatus` instances (for example a request to an unknown route reports `falcon.HTTPRouteNotFound` with `handled=True`), whether it was raised while routing, in middleware or the responder, or while rendering the response body. It is called before the matching error handler is invoked. `handled` is True when an error handler matches the exception type and False when none does, in which case the exception still propagates to the app server as it does today.
3. If an error handler re-raises the very same exception object, that exception is not reported a second time.
4. If an error handler raises an `HTTPError` or `HTTPStatus`, that new exception is also reported, as handled, and the response is rendered from it as before (so a handler turning `ZeroDivisionError` into `HTTPStatus` yields two reports, in that order).
5. If an error handler, or the error serializer, raises any other exception, it is reported with `handled=False` and propagates to the application server. Falcon must not write anything about it to the WSGI error stream itself.
6. If the response cannot be started (for example `resp.status` is not a valid status, or an ASGI header value cannot be encoded), the resulting exception is reported with `handled=False` and propagates to the application server.
7. Exceptions raised by an ASGI WebSocket responder are reported as handled, and the WebSocket client still sees the disconnect.
8. Add a news fragment `docs/_newsfragments/1942.newandimproved.rst` and document the new method on both app classes. Existing tests must still pass.
<!-- statement:end falcon -->

## markdown-it-py

- Upstream repository: <https://github.com/executablebooks/markdown-it-py>
- Licence: MIT
- Pull request: [#433](https://github.com/executablebooks/markdown-it-py/pull/433), "Use the CommonMark whitespace set, not the Python one", merged 2026-09-17T11:35:53Z
- Base commit (the tree the model starts from): [`337c2d544ca68d815f2943325d0e892b02c074d1`](https://github.com/executablebooks/markdown-it-py/commit/337c2d544ca68d815f2943325d0e892b02c074d1)
- Fix commit (source of the hidden tests): [`6f586542653a56d2ee8549a0dccfaa6ba5ebe14a`](https://github.com/executablebooks/markdown-it-py/commit/6f586542653a56d2ee8549a0dccfaa6ba5ebe14a)
- Hidden test files: `tests/test_port/test_whitespace.py`
- Scoring command, run from the repository root with `PYTHONPATH=.`: `python -m pytest tests --ignore=tests/test_packaging`
- Environment: Python 3.14.5, 18 pinned packages (`requirements` in `eval/upstream.json`)
- Used in: seven-task session
- Excluded tests and other notes: The scoring command ignores `tests/test_packaging`.

### markdown-it-py: fail-to-pass tests (12)

- `tests.test_port.test_whitespace::test_character_survives_in_output[\x1c]`
- `tests.test_port.test_whitespace::test_character_survives_in_output[\x1d]`
- `tests.test_port.test_whitespace::test_character_survives_in_output[\x1e]`
- `tests.test_port.test_whitespace::test_character_survives_in_output[\x1f]`
- `tests.test_port.test_whitespace::test_character_survives_in_output[\x85]`
- `tests.test_port.test_whitespace::test_fence_info_is_not_split_on_it`
- `tests.test_port.test_whitespace::test_reference_label_is_not_folded[\x1c]`
- `tests.test_port.test_whitespace::test_reference_label_is_not_folded[\x1d]`
- `tests.test_port.test_whitespace::test_reference_label_is_not_folded[\x1e]`
- `tests.test_port.test_whitespace::test_reference_label_is_not_folded[\x1f]`
- `tests.test_port.test_whitespace::test_reference_label_is_not_folded[\x85]`
- `tests.test_port.test_whitespace::test_table_cell_keeps_the_character`

The pass-to-pass set is 1019 tests.

### markdown-it-py: task statement

<!-- statement:begin markdown-it-py -->
You are working in the `markdown-it-py` repository (the current directory is the repository root; `python` and `pytest` on PATH have all dependencies installed; there is no network). `str.strip()` and `str.split()` called without arguments use `str.isspace()`, which treats U+001C, U+001D, U+001E, U+001F and U+0085 as whitespace. CommonMark and JavaScript's `String.prototype.trim` do not, so upstream markdown-it keeps those characters. Several call sites in this port rely on the Python behaviour. Fix it so that the following hold:

1. Add `MD_TRIM_CHARS` and a helper `mdTrim(string)` to `markdown_it/common/utils.py`. `MD_TRIM_CHARS` is the set of characters `String.prototype.trim` removes in JavaScript, minus U+FEFF. `mdTrim` strips leading and trailing characters from that set. Also add a compiled regex `MD_TRIM_RE` that matches a run of one or more of those characters.
2. The five characters above survive in rendered output instead of being stripped: at the edges of paragraph text (`x\x85` renders as `<p>x\x85</p>`), in ATX and setext headings, and in table cells. Real whitespace is still trimmed at those edges.
3. Reference label normalisation (`normalizeReference`) uses the same set: a usage `[a b]` must not resolve to a definition `[a\x85b]: http://example.com`, while runs of real whitespace inside a label still collapse to a single space.
4. The HTML fence renderer splits the info string on the same set instead of Python's `str.split()`: one of the five characters inside an info string is not a separator, while real whitespace still separates the language name from the rest.
5. Every call site that currently strips or splits with the Python whitespace set where upstream's `trim` is meant (headings, setext headings, paragraphs, table rows and cells, fence info, reference labels) uses `mdTrim`/`MD_TRIM_RE`. Behaviour for all other inputs is unchanged.
6. All existing tests must still pass.
<!-- statement:end markdown-it-py -->

## pluggy

- Upstream repository: <https://github.com/pytest-dev/pluggy>
- Licence: MIT
- Pull request: [#738](https://github.com/pytest-dev/pluggy/pull/738), "Change precedence of hook call value, hookspec default, hookimpl default", merged 2026-09-25T07:16:08Z
- Base commit (the tree the model starts from): [`f51e3a70c7f8414bff96e05c4ddb066972353376`](https://github.com/pytest-dev/pluggy/commit/f51e3a70c7f8414bff96e05c4ddb066972353376)
- Fix commit (source of the hidden tests): [`54fb4ddda7d0e0dc9dde12fa5cebb9ae13d8cff9`](https://github.com/pytest-dev/pluggy/commit/54fb4ddda7d0e0dc9dde12fa5cebb9ae13d8cff9)
- Hidden test files: `testing/test_invocations.py`
- Scoring command, run from the repository root with `PYTHONPATH=src`: `python -m pytest testing --ignore=testing/benchmark.py`
- Environment: Python 3.14.5, 11 pinned packages (`requirements` in `eval/upstream.json`)
- Used in: seven-task session
- Excluded tests and other notes: The scoring command ignores `testing/benchmark.py`.

### pluggy: fail-to-pass tests (4)

- `testing.test_invocations.TestHookspecDefaultArgumentValue::test_call_value_overrides_hookimpl_default`
- `testing.test_invocations.TestHookspecDefaultArgumentValue::test_call_value_overrides_hookimpl_default_in_wrappers`
- `testing.test_invocations.TestHookspecDefaultArgumentValue::test_hookspec_default_and_call_override_hookimpl_default`
- `testing.test_invocations.TestHookspecDefaultArgumentValue::test_old_spec_new_impl`

The pass-to-pass set is 197 tests.

### pluggy: task statement

<!-- statement:begin pluggy -->
You are working in the `pluggy` repository (the current directory is the repository root; `python` and `pytest` on PATH have all dependencies installed and `PYTHONPATH=src` is set; there is no network; the tests live in `testing/`). Hookspecs can now declare default values for arguments, but hookimpl argument defaults still behave unhelpfully: if a hookimpl function declares a default for an argument, that default is always used, even when the hook call passes an explicit value. Change the precedence. Requirements:

1. When a hook call passes a value for an argument, every hookimpl that accepts that argument receives the passed value, even if the hookimpl declares its own default for it.
2. The full precedence is: value passed by the hook call, then the hookspec's default value, then the hookimpl's default value.
3. When neither the call nor the hookspec provides the argument (for example a new hookimpl running against an older hookspec that does not have the argument), the hookimpl's own default is used, as before.
4. This applies to every kind of hookimpl: plain implementations, new-style wrappers (`wrapper=True`) and old-style hook wrappers (`hookwrapper=True`).
5. Document the behaviour in `docs/index.rst` (a short "Hookimpl argument defaults" section with a `versionchanged` note) and add a changelog fragment `changelog/442.bugfix.rst`.
6. All existing tests must still pass.
<!-- statement:end pluggy -->

## pydantic-settings

- Upstream repository: <https://github.com/pydantic/pydantic-settings>
- Licence: MIT
- Pull request: [#972](https://github.com/pydantic/pydantic-settings/pull/972), "Fix CLI append-action detection for collection subtypes", merged 2026-09-19T19:42:46Z
- Base commit (the tree the model starts from): [`5db59f3abc7b83b5f5d333b846d412cec79a5354`](https://github.com/pydantic/pydantic-settings/commit/5db59f3abc7b83b5f5d333b846d412cec79a5354)
- Fix commit (source of the hidden tests): [`2420bb67fec083f465ff52f8381e7406191c890c`](https://github.com/pydantic/pydantic-settings/commit/2420bb67fec083f465ff52f8381e7406191c890c)
- Hidden test files: `tests/test_source_cli.py`
- Scoring command, run from the repository root with `PYTHONPATH=.`: `python -m pytest tests --ignore=tests/test_docs.py`
- Environment: Python 3.14.5, 43 pinned packages (`requirements` in `eval/upstream.json`)
- Used in: seven-task session
- Excluded tests and other notes:
  - tests/test_docs.py excluded from scoring: its parametrised ids embed docs line numbers, which shift whenever docs/index.md is edited.
  - The scoring command ignores `tests/test_docs.py`.

### pydantic-settings: fail-to-pass tests (7)

- `tests.test_source_cli::test_cli_bare_sequence_subtypes_are_repeated_options`
- `tests.test_source_cli::test_cli_mapping_subtypes_use_dict_args`
- `tests.test_source_cli::test_cli_sequence_subtypes_are_repeated_options`
- `tests.test_source_cli::test_cli_variadic_named_mapping_subtype`
- `tests.test_source_cli::test_cli_variadic_named_sequence_subtypes`
- `tests.test_source_cli::test_cli_variadic_non_collection_raises`
- `tests.test_source_cli::test_cli_variadic_positional_sequence_subtype`

The pass-to-pass set is 655 tests.

### pydantic-settings: task statement

<!-- statement:begin pydantic-settings -->
You are working in the `pydantic-settings` repository (the current directory is the repository root; `python` and `pytest` on PATH have all dependencies installed; there is no network). The CLI settings source (`pydantic_settings/sources/providers/cli.py`, with helpers in `pydantic_settings/sources/utils.py`) decides whether a field is a collection by matching its annotation against the exact origins `(list, set, dict, Sequence, Mapping)`, so collection subtypes fall through. For example `CliVariadicArg[tuple[str, ...]]` fails with `CliVariadicArg requires a list, set, dict, Sequence, or Mapping type`, and plain `tuple` or `frozenset` fields are not registered as repeated options, so repeated flags are not merged. Fix this so that the following hold:

1. Collection detection matches subclasses of `collections.abc.Sequence`, `collections.abc.Set` and `collections.abc.Mapping`, not only the exact origins listed above. This covers `tuple`, `frozenset`, `typing.Tuple`, `MutableSequence`, `MutableMapping`, `deque` and `OrderedDict`, parameterized (`tuple[str, ...]`, `OrderedDict[str, str]`) or bare (`tuple`, `frozenset`), and also inside `X | None`.
2. `CliVariadicArg[...]` accepts those types for named options (`--values a b`) and for positional arguments (`CliPositionalArg[CliVariadicArg[tuple[str, ...]]]`). The parsed value has the field's own type: `('a', 'b')` for a tuple, `frozenset({'x', 'y'})` for a frozenset, an `OrderedDict` for `OrderedDict[str, str]` given `key=value` items.
3. Plain (non-variadic) fields of those collection types behave like `list` and `set` fields: repeated options are merged (`--values a --values b` gives `('a', 'b')`, `--tags x --tags y` gives a `frozenset`), and a single plain value does not have to be JSON encoded.
4. Mapping subtypes (`OrderedDict[str, str]`, `MutableMapping[str, str]`, optional or not) take dict-style `key=value` arguments, like `dict`.
5. `str`, `bytes` and `bytearray` are sequences too but must keep taking a single value; they are not treated as collections (an extra positional token after `--name a` is still an unrecognized argument).
6. The `SettingsError` raised for `CliVariadicArg` on a non-collection type now reads `CliVariadicArg requires a Sequence, Set, or Mapping type for <dest>`, where `<dest>` is the field's destination name as before.
7. The CLI section of `docs/index.md` describes the new behaviour.
8. All existing tests must still pass.
<!-- statement:end pydantic-settings -->

## werkzeug

- Upstream repository: <https://github.com/pallets/werkzeug>
- Licence: BSD-3-Clause
- Pull request: [#3288](https://github.com/pallets/werkzeug/pull/3288), "add ETag structured header class", merged 2026-09-21T18:39:32Z
- Base commit (the tree the model starts from): [`6bcd0eb4c25d6f51888a52b1abe69045bdaedfe2`](https://github.com/pallets/werkzeug/commit/6bcd0eb4c25d6f51888a52b1abe69045bdaedfe2)
- Fix commit (source of the hidden tests): [`36358505609c12ae931ba0eee6ed8b62ac3de619`](https://github.com/pallets/werkzeug/commit/36358505609c12ae931ba0eee6ed8b62ac3de619)
- Hidden test files: `tests/test_http.py`, `tests/test_wrappers.py`
- Scoring command, run from the repository root with `PYTHONPATH=src`: `python -m pytest tests -m 'not dev_server' --ignore=tests/middleware/test_http_proxy.py --ignore=tests/test_serving.py --ignore=tests/test_reloader.py`
- Environment: Python 3.14.5, 20 pinned packages (`requirements` in `eval/upstream.json`)
- Used in: seven-task session
- Excluded tests and other notes:
  - live-server tests (xprocess, dev_server marker) excluded: they need subprocess servers and time out here.
  - The scoring command ignores `tests/middleware/test_http_proxy.py`, `tests/test_serving.py`, `tests/test_reloader.py`.
  - The marker expression `not dev_server` deselects tests that carry that marker.

### werkzeug: fail-to-pass tests (129)

2 of these ids (`test_from_directory`, `test_path`) are listed as fail-to-pass by the lab's oracle but also pass at the base commit. Their ids contain the scratch directory, which the oracle step spelled `<WD>/...` at base and `/private<WD>/...` at the fix, so it saw them as missing at base. `eval/lib.py` folds the two spellings into one when it scores, so they count as f2p tests (129 in all, 127 of which really flip). They are `f2p_spelling_artifacts` in `eval/upstream.json`.

- `tests.test_http.TestHTTPUtility::test_accept`
- `tests.test_http.TestHTTPUtility::test_accept_matches`
- `tests.test_http.TestHTTPUtility::test_accept_mime_specificity`
- `tests.test_http.TestHTTPUtility::test_accept_parameter_with_space`
- `tests.test_http.TestHTTPUtility::test_authorization_basic_incorrect_padding`
- `tests.test_http.TestHTTPUtility::test_authorization_basic_validate`
- `tests.test_http.TestHTTPUtility::test_authorization_eq`
- `tests.test_http.TestHTTPUtility::test_authorization_header`
- `tests.test_http.TestHTTPUtility::test_authorization_ignore_invalid_parameters`
- `tests.test_http.TestHTTPUtility::test_authorization_token_padding`
- `tests.test_http.TestHTTPUtility::test_bad_authorization_header_encoding`
- `tests.test_http.TestHTTPUtility::test_bad_cookies`
- `tests.test_http.TestHTTPUtility::test_cache_control_header`
- `tests.test_http.TestHTTPUtility::test_cookie_domain_encoding`
- `tests.test_http.TestHTTPUtility::test_cookie_domain_resolving`
- `tests.test_http.TestHTTPUtility::test_cookie_maxsize`
- `tests.test_http.TestHTTPUtility::test_cookie_partitioned`
- `tests.test_http.TestHTTPUtility::test_cookie_partitioned_sets_secure`
- `tests.test_http.TestHTTPUtility::test_cookie_quoting`
- `tests.test_http.TestHTTPUtility::test_cookie_samesite_attribute[None-foo=bar]`
- `tests.test_http.TestHTTPUtility::test_cookie_samesite_attribute[lax-foo=bar; SameSite=Lax]`
- `tests.test_http.TestHTTPUtility::test_cookie_samesite_attribute[none-foo=bar; SameSite=None]`
- `tests.test_http.TestHTTPUtility::test_cookie_samesite_attribute[strict-foo=bar; SameSite=Strict]`
- `tests.test_http.TestHTTPUtility::test_cookie_samesite_invalid`
- `tests.test_http.TestHTTPUtility::test_cookie_unicode_dumping`
- `tests.test_http.TestHTTPUtility::test_cookie_unicode_keys`
- `tests.test_http.TestHTTPUtility::test_cookie_unicode_parsing`
- `tests.test_http.TestHTTPUtility::test_csp_header`
- `tests.test_http.TestHTTPUtility::test_dict_header[=foo, =-expect2]`
- `tests.test_http.TestHTTPUtility::test_dict_header[a=1, b="2, 3", c="4, d=5-expect3]`
- `tests.test_http.TestHTTPUtility::test_dict_header[foo, bar=-expect1]`
- `tests.test_http.TestHTTPUtility::test_dict_header[foo="bar baz", blah=42-expect0]`
- `tests.test_http.TestHTTPUtility::test_dump_cookie`
- `tests.test_http.TestHTTPUtility::test_dump_header`
- `tests.test_http.TestHTTPUtility::test_dump_options_header`
- `tests.test_http.TestHTTPUtility::test_empty_keys_are_ignored`
- `tests.test_http.TestHTTPUtility::test_etags`
- `tests.test_http.TestHTTPUtility::test_etags_bool`
- `tests.test_http.TestHTTPUtility::test_is_resource_modified`
- `tests.test_http.TestHTTPUtility::test_is_resource_modified_for_range_requests`
- `tests.test_http.TestHTTPUtility::test_language_accept`
- `tests.test_http.TestHTTPUtility::test_list_header["a\\"b", c-expect3]`
- `tests.test_http.TestHTTPUtility::test_list_header[a b, "c, d"-expect2]`
- `tests.test_http.TestHTTPUtility::test_list_header[a b, c-expect1]`
- `tests.test_http.TestHTTPUtility::test_list_header[a b-expect0]`
- `tests.test_http.TestHTTPUtility::test_list_header[a"b,c", "d e"-expect4]`
- `tests.test_http.TestHTTPUtility::test_list_header[a, "b, c", "d, e-expect6]`
- `tests.test_http.TestHTTPUtility::test_list_header[a, ,,b,-expect5]`
- `tests.test_http.TestHTTPUtility::test_mime_accept`
- `tests.test_http.TestHTTPUtility::test_parse_cookie`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;  ; a=b ; -expect1]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;=b-expect4]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a*0*=UTF-8''b;a*1=c;a*2*=%C2%B5-expect24]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a*0*=b-expect23]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a*0=b;a*1=c;d=e-expect22]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a*=ASCII'en'b-expect15]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a*=BAD''%62-expect19]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a*=US-ASCII''%62-expect16]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a*=US-ASCII''%C2%B5-expect18]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a*=UTF-8''%C2%B5-expect17]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a*=UTF-8'''%F0%9F%90%8D'.txt-expect20]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a*=b-expect14]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a-expect2]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a="';'";b="\xb5";-expect7]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a="\U0001f40d.txt"-expect21]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a="\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\-expect25]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a="b c"-expect8]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a="b"-expect5]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a="b%22c"-expect13]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a="b\\"c";d=e-expect9]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a="b\\\\\\"c"-expect12]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a="c:\\"-expect11]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a="c:\\\\"-expect10]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a=-expect3]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a=\xb5-expect6]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header[v;a=b;c=d;-expect0]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header_broken_values`
- `tests.test_http.TestHTTPUtility::test_parse_options_header_case_insensitive`
- `tests.test_http.TestHTTPUtility::test_parse_options_header_empty[-]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header_empty[;a=b-]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header_empty[None-]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header_empty[v-v]`
- `tests.test_http.TestHTTPUtility::test_parse_options_header_empty[v;-v]`
- `tests.test_http.TestHTTPUtility::test_parse_set_cookie_directive`
- `tests.test_http.TestHTTPUtility::test_remove_entity_headers`
- `tests.test_http.TestHTTPUtility::test_remove_hop_by_hop_headers`
- `tests.test_http.TestHTTPUtility::test_set_header`
- `tests.test_http.TestHTTPUtility::test_www_authenticate_eq`
- `tests.test_http.TestHTTPUtility::test_www_authenticate_header`
- `tests.test_http.TestHTTPUtility::test_www_authenticate_token_padding`
- `tests.test_http.TestRange::test_content_range_parsing`
- `tests.test_http.TestRange::test_if_range_parsing`
- `tests.test_http.TestRange::test_range_parsing`
- `tests.test_http.TestRegression::test_best_match_works`
- `tests.test_http::test_accept_invalid_float[+0.5]`
- `tests.test_http::test_accept_invalid_float[.5]`
- `tests.test_http::test_accept_invalid_float[0.5_1]`
- `tests.test_http::test_accept_invalid_float[\U0001fbf0.\U0001fbf5]`
- `tests.test_http::test_accept_valid_int_one_zero`
- `tests.test_http::test_authorization_to_header[Basic V2Vya3pldWc6V2VrcnpldWc=]`
- `tests.test_http::test_authorization_to_header[Digest username=Mufasa, realm="testrealm@host.invalid", nonce=dcd98b7102dd2f0e8b11d0f600bfb0c093, uri="/dir/index.html", qop=auth, nc=00000001, cnonce=0a4f113b, response=6629fae49393a05397450978507c4ef1, opaque=5ccc069c403ebaf9f0171e9517f40e41]`
- `tests.test_http::test_content_range_invalid_int[*/\U0001fbf1\U0001fbf2\U0001fbf3]`
- `tests.test_http::test_content_range_invalid_int[1-+2/3]`
- `tests.test_http::test_content_range_invalid_int[1_23-125/*]`
- `tests.test_http::test_http_date[0-Thu, 01 Jan 1970 00:00:00 GMT]`
- `tests.test_http::test_http_date[value0-Sun, 06 Nov 1994 08:49:37 GMT]`
- `tests.test_http::test_http_date[value1-Sun, 06 Nov 1994 16:49:37 GMT]`
- `tests.test_http::test_http_date[value2-Sun, 06 Nov 1994 08:49:37 GMT]`
- `tests.test_http::test_http_date[value4-Thu, 01 Jan 1970 00:00:00 GMT]`
- `tests.test_http::test_http_date[value5-Mon, 01 Jan 0001 00:00:00 GMT]`
- `tests.test_http::test_http_date[value6-Tue, 01 Jan 0999 00:00:00 GMT]`
- `tests.test_http::test_http_date[value7-Wed, 01 Jan 1000 00:00:00 GMT]`
- `tests.test_http::test_http_date[value8-Wed, 01 Jan 2020 00:00:00 GMT]`
- `tests.test_http::test_http_date[value9-Wed, 01 Jan 2020 00:00:00 GMT]`
- `tests.test_http::test_parse_date[ Sun 02 Feb 1343 08:49:37 GMT-expect4]`
- `tests.test_http::test_parse_date[ Sun Nov  6 08:49:37 1994-expect2]`
- `tests.test_http::test_parse_date[Sun, 06 Nov 1994 08:49:37 GMT    -expect0]`
- `tests.test_http::test_parse_date[Sunday, 06-Nov-94 08:49:37 GMT-expect1]`
- `tests.test_http::test_parse_date[Thu, 01 Jan 1970 00:00:00 GMT-expect5]`
- `tests.test_http::test_parse_date[Thu, 33 Jan 1970 00:00:00 GMT-None]`
- `tests.test_http::test_parse_date[foo-None]`
- `tests.test_http::test_range_invalid_int[+1-]`
- `tests.test_http::test_range_invalid_int[1-1_23]`
- `tests.test_http::test_range_invalid_int[\U0001fbf1\U0001fbf2\U0001fbf3]`
- `tests.test_send_file::test_from_directory[/private<WD>/tests/res-test.txt]`
- `tests.test_send_file::test_path[/private<WD>/tests/res/index.html]`
- `tests.test_wrappers::test_etag_response`
- `tests.test_wrappers::test_etag_response_412`
- `tests.test_wrappers::test_etag_response_freezing`

The pass-to-pass set is 859 tests.

### werkzeug: task statement

<!-- statement:begin werkzeug -->
You are working in the `werkzeug` repository (the current directory is the repository root; `python` and `pytest` on PATH have all dependencies installed and `PYTHONPATH=src` is set; there is no network). Single ETag values are awkward to work with: they are passed around as `tuple[str, bool] | tuple[None, None]`, and `Response.get_etag`/`set_etag` plus `http.quote_etag`/`unquote_etag` form an inconsistent API. Replace that interface with a class, following the conventions of the other structured header classes in `werkzeug.datastructures`. Requirements:

1. Add a class `ETag(value, weak=False)` in `werkzeug.datastructures` (importable as `werkzeug.datastructures.ETag`). It has settable `value` (the unquoted value) and `weak` attributes, a classmethod `from_header(value)` that parses a quoted ETag with an optional `W/` or `w/` prefix and returns `None` for an empty or invalid (unquoted) value, and `to_header()`, which returns `""` when the value is empty or contains a double quote, `W/"value"` for a weak ETag and `"value"` otherwise. It compares equal by value and weak flag, is truthy when the value is non-empty, `str()` gives the header form, and `repr()` looks like `<ETag 'x' strong>` or `<ETag 'x' weak>`.
2. Rename the existing `ETags` class to `ETagSet`, with the same behaviour. The old name `werkzeug.datastructures.ETags` keeps working but emits a `DeprecationWarning` saying it was renamed to `ETagSet` and will be removed in Werkzeug 3.3.
3. Add an `etag` header property to the response class. It returns an `ETag`, or `None` when the header is missing or invalid. It can be set to an `ETag`, a `(value, weak)` tuple, or a `str` (meaning `(value, False)`); setting `None` or using `del` removes the header. Changing `value` or `weak` on the returned object updates the response header.
4. `Response.get_etag()` and `Response.set_etag()` are deprecated in favour of `etag`: they still work (`get_etag` still returns `(value, weak)` or `(None, None)`) but emit a `DeprecationWarning` that names the replacement.
5. `werkzeug.http.quote_etag` and `werkzeug.http.unquote_etag` are deprecated the same way and still work.
6. Internal code (conditional-request handling, `add_etag`, `make_conditional`, `is_resource_modified`, the shared-data middleware, `send_file`, and anything else that used the deprecated functions or the old tuple form) uses `ETag`/`response.etag` so that it never triggers these deprecation warnings. The test configuration turns warnings into errors.
7. Mention the change in `CHANGES.rst` and the datastructures docs.
8. Existing tests must still pass. Update test code that uses the deprecated names to the new API instead of silencing the warnings. Run the suite with `python -m pytest tests -m "not dev_server" --ignore=tests/test_serving.py --ignore=tests/test_reloader.py --ignore=tests/middleware/test_http_proxy.py`; the live-server tests cannot run here.
<!-- statement:end werkzeug -->

## werkzeug-cond

- Upstream repository: <https://github.com/pallets/werkzeug>
- Licence: BSD-3-Clause
- Pull request: [#3308](https://github.com/pallets/werkzeug/pull/3308), "split make_conditional into apply_conditions and apply_range", merged 2026-09-27T17:19:56Z
- Base commit (the tree the model starts from): [`671537e0e5c7dcec4ac61ffc755dbd8936cefcfb`](https://github.com/pallets/werkzeug/commit/671537e0e5c7dcec4ac61ffc755dbd8936cefcfb)
- Fix commit (source of the hidden tests): [`830d4b3957e9532be5f510e499dd797964d064d6`](https://github.com/pallets/werkzeug/commit/830d4b3957e9532be5f510e499dd797964d064d6)
- Hidden test files: `tests/test_apply_conditions.py`, `tests/test_apply_range.py`, `tests/test_http.py`, `tests/test_send_file.py`, `tests/test_wrappers.py`
- Scoring command, run from the repository root with `PYTHONPATH=src`: `python -m pytest tests -m 'not dev_server' --ignore=tests/middleware/test_http_proxy.py --ignore=tests/test_serving.py --ignore=tests/test_reloader.py`
- Environment: Python 3.14.5, 20 pinned packages (`requirements` in `eval/upstream.json`)
- Used in: seven-task session
- Same repository as `werkzeug`, a different pull request and base commit.
- Excluded tests and other notes:
  - live-server tests (xprocess, dev_server marker) excluded: they need subprocess servers and time out here.
  - The scoring command ignores `tests/middleware/test_http_proxy.py`, `tests/test_serving.py`, `tests/test_reloader.py`.
  - The marker expression `not dev_server` deselects tests that carry that marker.

### werkzeug-cond: fail-to-pass tests (48)

- `tests.test_apply_conditions::test_if_match`
- `tests.test_apply_conditions::test_if_match_fail[value0-etag0]`
- `tests.test_apply_conditions::test_if_match_fail[value1-etag1]`
- `tests.test_apply_conditions::test_if_match_fail[value2-etag2]`
- `tests.test_apply_conditions::test_if_match_fail[value3-None]`
- `tests.test_apply_conditions::test_if_match_precedence`
- `tests.test_apply_conditions::test_if_match_star_exists`
- `tests.test_apply_conditions::test_if_match_star_fail`
- `tests.test_apply_conditions::test_if_modified_since[value0-last_modified0-304]`
- `tests.test_apply_conditions::test_if_modified_since[value1-last_modified1-304]`
- `tests.test_apply_conditions::test_if_modified_since[value2-last_modified2-200]`
- `tests.test_apply_conditions::test_if_modified_since[value3-None-200]`
- `tests.test_apply_conditions::test_if_modified_since_post`
- `tests.test_apply_conditions::test_if_none_match[value0-etag0-304]`
- `tests.test_apply_conditions::test_if_none_match[value1-etag1-304]`
- `tests.test_apply_conditions::test_if_none_match[value2-etag2-304]`
- `tests.test_apply_conditions::test_if_none_match[value3-etag3-200]`
- `tests.test_apply_conditions::test_if_none_match[value4-None-200]`
- `tests.test_apply_conditions::test_if_none_match_post`
- `tests.test_apply_conditions::test_if_none_match_precedence`
- `tests.test_apply_conditions::test_if_none_match_star[False-200]`
- `tests.test_apply_conditions::test_if_none_match_star[True-304]`
- `tests.test_apply_conditions::test_if_unmodified_since[value0-last_modified0]`
- `tests.test_apply_conditions::test_if_unmodified_since[value1-last_modified1]`
- `tests.test_apply_conditions::test_if_unmodified_since[value2-None]`
- `tests.test_apply_conditions::test_if_unmodified_since_fail`
- `tests.test_apply_range::test_advertise`
- `tests.test_apply_range::test_clamp_stop`
- `tests.test_apply_range::test_clamp_suffix`
- `tests.test_apply_range::test_if_range_date[None-200]`
- `tests.test_apply_range::test_if_range_date[last_modified0-206]`
- `tests.test_apply_range::test_if_range_date[last_modified1-200]`
- `tests.test_apply_range::test_if_range_date[last_modified2-200]`
- `tests.test_apply_range::test_if_range_etag[None-200]`
- `tests.test_apply_range::test_if_range_etag[etag0-206]`
- `tests.test_apply_range::test_if_range_etag[etag1-200]`
- `tests.test_apply_range::test_if_range_etag[etag2-200]`
- `tests.test_apply_range::test_no_length[0]`
- `tests.test_apply_range::test_no_length[None]`
- `tests.test_apply_range::test_only_first`
- `tests.test_apply_range::test_other_unit`
- `tests.test_apply_range::test_post`
- `tests.test_apply_range::test_precondition_applied`
- `tests.test_apply_range::test_range`
- `tests.test_apply_range::test_start_too_large`
- `tests.test_send_file::test_etag`
- `tests.test_send_file::test_file`
- `tests.test_send_file::test_object`

The pass-to-pass set is 985 tests.

### werkzeug-cond: task statement

<!-- statement:begin werkzeug-cond -->
You are working in the `werkzeug` repository (the current directory is the repository root; `python` and `pytest` on PATH have all dependencies installed and `PYTHONPATH=src` is set; there is no network). `Response.make_conditional` mixes up the order and semantics of HTTP preconditions and byte ranges, `send_file` has its own partial copy of that logic, and `SharedDataMiddleware` has a third. Split the logic into two correct response methods and make the callers use them. Requirements:

1. Add `Response.apply_conditions(request, *, exists=True)` that evaluates the request's preconditions in RFC 9110 order. If `If-Match` is present it is evaluated alone; otherwise `If-Unmodified-Since` is evaluated. A failed precondition raises `PreconditionFailed`. `If-Match` uses strong comparison against the response `etag`: a weak response ETag, a weak entry in the set, or a missing response ETag all fail. `*` succeeds only when `exists` is true. `If-Unmodified-Since` fails only when the response `last_modified` is later than the header date; a response without `last_modified` passes.
2. After those pass, `apply_conditions` evaluates `If-None-Match` if present, otherwise `If-Modified-Since`. `If-None-Match` uses weak comparison, and `*` matches when `exists` is true. A match sets the status to 304 for GET and HEAD and raises `PreconditionFailed` for other methods; no match leaves the response alone. `If-Modified-Since` applies only to GET and HEAD, gives 304 when `last_modified` exists and is not later than the header date, and is ignored when `last_modified` is missing. A present `If-None-Match` takes precedence over `If-Modified-Since` even when it does not match.
3. Add `Response.apply_range(request)`. It always advertises `Accept-Ranges: bytes` (`accept_ranges`). It then applies a `Range` header only when: the method is GET, the status is still 200, the range unit is `bytes`, and the response has a known `content_length` greater than zero. If `If-Range` is present it must match: an ETag must equal the response ETag by strong comparison, and a date must equal the response `last_modified` exactly; otherwise the full response is sent. Only the first range is used. Values are clamped (a stop beyond the end is cut to the last byte, a suffix longer than the content becomes the whole content), and a start at or past the end raises `RequestedRangeNotSatisfiable`. A satisfiable range turns the response into a 206 with a correct `Content-Range` (for example `bytes 0-4/10`), the right `content_length`, and only the selected bytes as body.
4. `Response.make_conditional`, `werkzeug.http.is_resource_modified` and `werkzeug.http.is_byte_range_valid` are deprecated: they still work but emit a `DeprecationWarning` that names the replacement.
5. Refactor `werkzeug.utils.send_file` to use the new methods when `conditional=True`: call `apply_conditions` then `apply_range`; if either raises an `HTTPException`, close the response and re-raise; a 304 result drops any `X-Sendfile` header. It also detects the download name, size and modification time from file-like objects (a `name` attribute, the stream length when seekable, `fileno()` stat), seeks file objects to the start so range lengths are right, and falls back to `application/octet-stream` instead of raising `TypeError` when the MIME type cannot be determined. Text-mode files still raise `ValueError`. With `use_x_sendfile` the response body is empty. The generated ETag is the last-modified timestamp and the size joined by `-` (no path hash) and is set through `response.etag`.
6. `SharedDataMiddleware` serves files through `send_file`. Its `cache` and `fallback_mimetype` parameters are deprecated (still accepted, with a `DeprecationWarning`).
7. Document the change in `CHANGES.rst` and `docs/quickstart.rst`.
8. Existing tests must still pass. Move or update test code that uses the deprecated functions instead of silencing the warnings (the test configuration turns warnings into errors). Run the suite with `python -m pytest tests -m "not dev_server" --ignore=tests/test_serving.py --ignore=tests/test_reloader.py --ignore=tests/middleware/test_http_proxy.py`; the live-server tests cannot run here.
<!-- statement:end werkzeug-cond -->

## packaging

- Upstream repository: <https://github.com/pypa/packaging>
- Licence: Apache-2.0 OR BSD-2-Clause
- Pull request: [#1351](https://github.com/pypa/packaging/pull/1351), "fix: reject invalid interpreter tags", merged 2026-07-28T03:40:28Z
- Base commit (the tree the model starts from): [`826426fc88773515fab149a5f6bde85761e57fbb`](https://github.com/pypa/packaging/commit/826426fc88773515fab149a5f6bde85761e57fbb)
- Fix commit (source of the hidden tests): [`26fa1d42ccd98010d5fcf701dd10069e761b034c`](https://github.com/pypa/packaging/commit/26fa1d42ccd98010d5fcf701dd10069e761b034c)
- Hidden test files: `tests/test_tags.py`, `tests/test_utils.py`
- Scoring command, run from the repository root with `PYTHONPATH=src`: `python -m pytest tests`
- Environment: Python 3.14.5, 10 pinned packages (`requirements` in `eval/upstream.json`)
- Used in: round-one single-task runs
- Excluded tests and other notes: none.

### packaging: fail-to-pass tests (5)

- `tests.test_tags.TestParseTag::test_invalid_interpreter_raises[2-none-any]`
- `tests.test_tags.TestParseTag::test_invalid_interpreter_raises[2.7.6-none-any]`
- `tests.test_tags.TestParseTag::test_invalid_interpreter_raises[py+3-none-any]`
- `tests.test_tags.TestParseTag::test_invalid_interpreter_raises[py3.2-none-any]`
- `tests.test_utils::test_parse_wheel_invalid_filename[playlyfe-0.1.1-2.7.6-none-any.whl]`

The pass-to-pass set is 62399 tests.

### packaging: task statement

<!-- statement:begin packaging -->
You are working in the `packaging` repository (the current directory is the repository root; `python` and `pytest` on PATH have all dependencies installed and `PYTHONPATH=src` is set; there is no network). Malformed wheel names such as `playlyfe-0.1.1-2.7.6-none-any.whl` are accepted today: the tag `2.7.6-none-any` expands into the numeric "interpreter" tags `2`, `7` and `6`. Reject them. Requirements:

1. `packaging.tags.parse_tag` raises `InvalidTag` when any interpreter component (each member of a compressed, dot-separated interpreter set) is not a valid identifier in the sense of `str.isidentifier()`. The message contains the words `invalid interpreter` and names the tag and the offending component. Examples that must be rejected: `2-none-any`, `2.7.6-none-any`, `py3.2-none-any`, `py+3-none-any`.
2. Valid tags keep parsing exactly as before. That includes custom implementation identifiers (`sillywalk-none-any`, `graalpy311-none-any`, `_custom-none-any`), uppercase input (still normalised), and every tag `sys_tags()` produces. ABI and platform components keep their existing rules: only empty ones are rejected.
3. `packaging.utils.parse_wheel_filename` raises `InvalidWheelFilename` for wheel names whose tag set fails this validation, wrapping the parser failure. Its message for a bad tag set becomes `Invalid wheel filename (invalid tag component): <filename repr>`.
4. Update the docstrings and API documentation of the affected functions and exceptions (`docs/tags.rst`, `docs/utils.rst`) and add a `CHANGELOG.rst` entry.
5. All existing tests must still pass.
<!-- statement:end packaging -->

## tenacity

- Upstream repository: <https://github.com/jd/tenacity>
- Licence: Apache-2.0
- Pull request: [#694](https://github.com/jd/tenacity/pull/694), "fix: restore support for falsy wait values and callable + strategy", merged 2026-08-06T06:44:13Z
- Base commit (the tree the model starts from): [`a09999688c8d3bb3d4ca1716748009954cc7c4d0`](https://github.com/jd/tenacity/commit/a09999688c8d3bb3d4ca1716748009954cc7c4d0)
- Fix commit (source of the hidden tests): [`389aab8b2688f7a1df41c2dd7797eeb18c8baff9`](https://github.com/jd/tenacity/commit/389aab8b2688f7a1df41c2dd7797eeb18c8baff9)
- Hidden test files: `tests/test_asyncio.py`, `tests/test_tenacity.py`
- Scoring command, run from the repository root with `PYTHONPATH=.`: `python -m pytest tests`
- Environment: Python 3.14.5, 9 pinned packages (`requirements` in `eval/upstream.json`)
- Used in: round-one single-task runs
- Excluded tests and other notes: none.

### tenacity: fail-to-pass tests (4)

- `tests.test_asyncio.TestAsyncio::test_wait_falsy_values_mean_no_wait`
- `tests.test_tenacity.TestWaitConditions::test_wait_combine_passes_state_positionally`
- `tests.test_tenacity.TestWaitConditions::test_wait_falsy_values_mean_no_wait`
- `tests.test_tenacity.TestWaitConditions::test_wait_radd_plain_callable`

The pass-to-pass set is 174 tests.

### tenacity: task statement

<!-- statement:begin tenacity -->
You are working in the `tenacity` retry library (the current directory is the repository root; `python` and `pytest` on PATH have all dependencies installed; there is no network). A recent typing clean-up introduced three runtime regressions in wait handling. None is caught by the test suite, and each only shows up once a retry actually happens. Fix them so that the following hold:

1. Falsy `wait` values mean "do not wait" again. `Retrying(wait=None)`, `Retrying(wait=0)` and `wait=sum([])` (which is the int `0`) must retry without sleeping instead of raising `TypeError` from inside the retry loop.
2. The same holds for `AsyncRetrying`.
3. `plain_callable + wait_strategy` builds a `wait_combine` again. A plain callable is a valid wait, and since functions have no `__add__` this goes through `wait_base.__radd__`; for example a function returning `2.0` added to `wait_fixed(1)` waits `3.0`.
4. A non-zero number on the left, such as `5 + wait_fixed(1)`, is rejected with `TypeError` at the addition itself, while `sum()` over a list of wait strategies keeps working.
5. `wait_combine` passes the retry state to each strategy positionally, as the retry loop itself does, so a callable whose parameter is not named `retry_state` works.
6. Add a release note under `releasenotes/notes/` that describes the three fixes.
7. All existing tests must still pass.
<!-- statement:end tenacity -->
