#!/usr/bin/env python3
"""A fake Anthropic Messages API on localhost, for zero-cost checks of what Claude Code really sends.

Every POST to /v1/messages is logged whole (one JSON line per request: path, the request body) to the file named by
its first argument, and answered with a short stream: the first main-conversation request one server instance answers
gets one Bash tool call, the second a closing text, and so on (one server serves one prompt of one process). A request whose system prompt is effortless's effort judge
gets its verdict (FAKE_JUDGE, a JSON object). Anything else gets a 404. After 200 requests every request gets a 400, so
that a client that loops stops.

  python3 fakeapi.py <log.jsonl> <port-file>     binds an ephemeral port on 127.0.0.1 and writes it to <port-file>

Nothing here reaches the network: it serves 127.0.0.1 only and makes no requests of its own.
"""
import itertools, json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG, PORT_FILE = sys.argv[1], sys.argv[2]
JUDGE = os.environ.get('FAKE_JUDGE', '{"model":"opus","effort":"xhigh","sure":0.9,"why":"test"}')
COMMAND = os.environ.get('FAKE_COMMAND', 'echo hi')
FINAL = os.environ.get('FAKE_FINAL', 'Done.\nSTATUS: COMPLETE')
lock = threading.Lock()
served = [0]
USAGE = dict(input_tokens=1200, output_tokens=40, cache_creation_input_tokens=0, cache_read_input_tokens=0)


def text_of(content):
    if isinstance(content, str): return content
    return '\n'.join(b.get('text', '') if isinstance(b, dict) else str(b) for b in content or [])


def system_text(body):
    s = body.get('system')
    return s if isinstance(s, str) else '\n'.join(b.get('text', '') for b in s or [] if isinstance(b, dict))


def blocks_of(m):
    return m.get('content') if isinstance(m.get('content'), list) else [dict(type='text', text=m.get('content') or '')]


def answered_since_prompt(msgs):
    """Whether a tool result follows the latest prompt (a user turn with text of its own that is not a reminder)."""
    at = max((i for i, m in enumerate(msgs) if m.get('role') == 'user' and any(b.get('type') == 'text' and not b.get('text', '').lstrip().startswith('<system-reminder>')
                                                                              for b in blocks_of(m))), default=0)
    return any(b.get('type') == 'tool_result' for m in msgs[at + 1:] if m.get('role') == 'user' for b in blocks_of(m))


main_count = [0]
ids = itertools.count(1)


def main_served(body):
    """How many main-conversation requests this server has answered, this one included: odd ones get the tool call."""
    with lock:
        main_count[0] += 1
        return main_count[0]


def sse(events):
    return ''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def message(body, blocks, stop):
    mid = f'msg_fake_{next(ids)}'   # each answer's id is new, or a resumed transcript merges two answers into one
    start = dict(type='message_start', message=dict(id=mid, type='message', role='assistant', model=body.get('model', 'claude-opus-5-5'),
                                                     content=[], stop_reason=None, stop_sequence=None, usage=USAGE))
    events = [start]
    for i, b in enumerate(blocks):
        if b['type'] == 'text':
            events += [dict(type='content_block_start', index=i, content_block=dict(type='text', text='')),
                       dict(type='content_block_delta', index=i, delta=dict(type='text_delta', text=b['text']))]
        else:
            events += [dict(type='content_block_start', index=i, content_block=dict(type='tool_use', id=b['id'], name=b['name'], input={})),
                       dict(type='content_block_delta', index=i, delta=dict(type='input_json_delta', partial_json=json.dumps(b['input'])))]
        events.append(dict(type='content_block_stop', index=i))
    events += [dict(type='message_delta', delta=dict(stop_reason=stop, stop_sequence=None), usage=dict(output_tokens=40)), dict(type='message_stop')]
    return events


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self): self.send_error(404)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('content-length') or 0))
        try: body = json.loads(raw)
        except Exception: body = {}
        with lock:
            served[0] += 1
            with open(LOG, 'a') as fh: fh.write(json.dumps(dict(path=self.path, body=body)) + '\n')
        if served[0] > 200: return self.send_error(400)
        if not self.path.startswith('/v1/messages') or self.path.startswith('/v1/messages/count_tokens'):
            return self.send_error(404)
        msgs = body.get('messages') or []
        if 'You choose which Claude model and reasoning effort' in system_text(body):
            blocks, stop = [dict(type='text', text=JUDGE)], 'end_turn'
        elif main_served(body) % 2 == 0:
            blocks, stop = [dict(type='text', text=FINAL)], 'end_turn'
        else:
            blocks, stop = [dict(type='tool_use', id=f'toolu_fake_{len(msgs)}', name='Bash', input=dict(command=COMMAND, description='fake'))], 'tool_use'
        events = message(body, blocks, stop)
        if body.get('stream'):
            data = sse(events)
            self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.send_header('content-length', str(len(data))); self.end_headers()
            self.wfile.write(data)
        else:
            content = [dict(type='text', text=b['text']) if b['type'] == 'text' else dict(type='tool_use', id=b['id'], name=b['name'], input=b['input']) for b in blocks]
            data = json.dumps(dict(id=f'msg_fake_{next(ids)}', type='message', role='assistant', model=body.get('model'), content=content, stop_reason=stop,
                                   stop_sequence=None, usage=USAGE)).encode()
            self.send_response(200); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(data))); self.end_headers()
            self.wfile.write(data)


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
open(PORT_FILE, 'w').write(str(server.server_address[1]))
server.serve_forever()
