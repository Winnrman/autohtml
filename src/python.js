'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

/**
 * Python backend support for ahtml.
 *
 * A `<server lang="python">` block is run as a standalone Python 3 process that
 * listens on the same API port the Node client server proxies `/api/*` to — so
 * the rest of the pipeline (client server, hot reload, db file) is unchanged.
 *
 * The shim below mirrors the Node `app`/`req`/`res`/`db` surface so authors get
 * a familiar API. Routes are registered with decorators:
 *
 *   @app.get('/api/items')
 *   def list_items(req, res):
 *       res.json(db.query('SELECT * FROM items'))
 *
 * The db wrapper uses Python's stdlib `sqlite3` (no native build step) and
 * reads/writes the same SQLite file the Node path uses — the on-disk format is
 * standard SQLite, so a db created by one runtime is readable by the other.
 *
 * Dependencies declared in a `<deps>` block are installed with pip into a
 * per-file virtualenv (`.<name>-venv/`) so installs are isolated and cached.
 */

// Defines app/req/res/db and runs before the user's <server> code.
const PYTHON_SHIM = `# -*- coding: utf-8 -*-
import sys, os, json, re, base64, sqlite3, threading, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

_ahtml_routes = []


class _App:
    """Express-like router. Decorators register handlers run on match."""
    def _register(self, method, path):
        def deco(fn):
            _ahtml_routes.append({'method': method, 'path': path, 'handler': fn})
            return fn
        return deco

    def get(self, path):    return self._register('GET', path)
    def post(self, path):   return self._register('POST', path)
    def put(self, path):    return self._register('PUT', path)
    def delete(self, path): return self._register('DELETE', path)
    def patch(self, path):  return self._register('PATCH', path)


app = _App()


class _Req:
    def __init__(self, method, path, url, headers, query, body, params):
        self.method = method
        self.path = path
        self.url = url
        self.headers = headers
        self.query = query        # dict, repeated keys -> list
        self.body = body          # parsed JSON (dict/list) or raw str or None
        self.params = params      # named route params, e.g. {'id': '42'}


class _Res:
    """Express-like response. status()/set() are chainable."""
    def __init__(self, handler):
        self._h = handler
        self._status = 200
        self._headers = {}
        self.sent = False

    def status(self, code):
        self._status = code
        return self

    def set(self, key, value):
        self._headers[key] = value
        return self

    def _send(self, content_type, payload):
        body = payload.encode('utf-8') if isinstance(payload, str) else payload
        self._h.send_response(self._status)
        if 'Content-Type' not in self._headers:
            self._h.send_header('Content-Type', content_type)
        for k, v in self._headers.items():
            self._h.send_header(k, v)
        self._h.send_header('Content-Length', str(len(body)))
        self._h.end_headers()
        if body:
            self._h.wfile.write(body)
        self.sent = True

    def json(self, data):  self._send('application/json', json.dumps(data))
    def send(self, text):  self._send('text/plain; charset=utf-8', str(text))
    def html(self, text):  self._send('text/html; charset=utf-8', str(text))


class _Db:
    """Mirrors the Node db API on top of stdlib sqlite3."""
    def __init__(self, path):
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()

    def query(self, sql, params=None):
        with self._lock:
            cur = self._conn.execute(sql, params or [])
            rows = [dict(r) for r in cur.fetchall()]
            cur.close()
        return rows

    def get(self, sql, params=None):
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def run(self, sql, params=None):
        with self._lock:
            cur = self._conn.execute(sql, params or [])
            self._conn.commit()
            result = {'changes': cur.rowcount, 'lastInsertRowid': cur.lastrowid}
            cur.close()
        return result

    def exec(self, sql):
        with self._lock:
            self._conn.executescript(sql)
            self._conn.commit()


# db is wired up in the footer if a <db> block exists; None otherwise.
db = None

# ---- USER SERVER CODE ----
`

// Runs after the user's <server> code: starts the HTTP server.
const PYTHON_FOOTER = `
# ---- END USER CODE ----

def _ahtml_match(method, path):
    for route in _ahtml_routes:
        if route['method'] != method:
            continue
        pattern = re.sub(r':([A-Za-z_][A-Za-z0-9_]*)', r'(?P<\\1>[^/]+)', route['path'])
        m = re.match('^' + pattern + '$', path)
        if m:
            return route, m.groupdict()
    return None, None


class _Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _dispatch(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = {k: (v[0] if len(v) == 1 else v)
                 for k, v in parse_qs(parsed.query).items()}

        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        body = None
        if raw:
            try:
                body = json.loads(raw.decode('utf-8'))
            except Exception:
                body = raw.decode('utf-8', 'replace')

        res = _Res(self)
        route, params = _ahtml_match(self.command, path)
        if route is None:
            res.status(404).json({'error': 'not found', 'path': path})
            return

        req = _Req(self.command, path, self.path, dict(self.headers), query, body, params or {})
        try:
            route['handler'](req, res)
            if not res.sent:
                res.status(204).send('')
        except Exception as e:
            traceback.print_exc()
            if not res.sent:
                res.status(500).json({'error': str(e)})

    do_GET = _dispatch
    do_POST = _dispatch
    do_PUT = _dispatch
    do_DELETE = _dispatch
    do_PATCH = _dispatch

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    port = int(os.environ['__AHTML_API_PORT'])

    db_path = os.environ.get('__AHTML_DB_PATH')
    if db_path:
        db = _Db(db_path)
        schema_b64 = os.environ.get('__AHTML_DB_SCHEMA', '')
        if schema_b64:
            schema = base64.b64decode(schema_b64).decode('utf-8')
            if schema.strip():
                db.exec(schema)

    server = ThreadingHTTPServer(('127.0.0.1', port), _Handler)
    print('ahtml python server listening on ' + str(port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
`

function buildPythonServerFile(serverCode) {
  return PYTHON_SHIM + serverCode + PYTHON_FOOTER
}

/**
 * Probe a candidate interpreter. Returns { cmd, version, basePrefix, isConda }
 * or null if it isn't a usable Python 3.
 */
function probePython(cmd) {
  try {
    const script =
      'import sys,os;' +
      'print(sys.version.split()[0]);' +
      'print(sys.base_prefix);' +
      "print(os.path.isdir(os.path.join(sys.base_prefix,'conda-meta')))"
    const out = execSync(`${cmd} -c "${script}"`, { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString().trim().split(/\r?\n/)
    const [version, basePrefix, condaFlag] = out
    if (!/^3\./.test(version || '')) return null
    const isConda =
      condaFlag === 'True' ||
      /(?:ana|mini)conda|miniforge|conda/i.test(basePrefix || '')
    return { cmd, version, basePrefix, isConda }
  } catch (_) {
    return null
  }
}

/**
 * Find a usable Python 3 interpreter, preferring a non-conda one.
 *
 * Conda/Anaconda bundles an old Microsoft C++ runtime (e.g. msvcp140 14.27)
 * and loads it into every process it spawns. A venv built from conda Python
 * inherits that, which breaks native wheels compiled against a newer runtime
 * (torch's c10.dll fails to initialize → WinError 1114). A python.org install
 * uses the up-to-date system runtime, so we prefer it when available.
 *
 * Returns the command string, or null if no Python 3 is found.
 */
function findPython() {
  const candidates = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python']

  const found = []
  for (const cmd of candidates) {
    const info = probePython(cmd)
    if (info) found.push(info)
  }
  if (!found.length) return null

  const clean = found.find(f => !f.isConda)
  if (clean) return clean.cmd

  // Only conda interpreters available — use one, but warn that native wheels
  // (torch, etc.) may fail to load on Windows.
  if (process.platform === 'win32') {
    console.warn('[ahtml] warning: only a conda/Anaconda Python was found. ' +
      'Native packages like torch may fail to load (DLL init error). ' +
      'Installing python.org Python is recommended for <deps> that use native wheels.')
  }
  return found[0].cmd
}

function venvPython(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python')
}

/**
 * Ensure a per-file virtualenv exists and the requested deps are installed.
 * Returns the path to the venv's python executable. Synchronous on purpose —
 * this is one-time setup and we want it finished before the server spawns.
 */
function setupVenv(deps, ahtmlPath, basePython) {
  const dir = path.dirname(ahtmlPath)
  const venvDir = path.join(dir, '.' + path.basename(ahtmlPath, '.ahtml') + '-venv')
  const py = venvPython(venvDir)
  const marker = path.join(venvDir, '.ahtml-base')

  // Resolve the real base_prefix of the chosen interpreter so we can tell
  // whether an existing venv was built from a different (e.g. conda) Python.
  let baseTag = basePython
  try {
    baseTag = execSync(`${basePython} -c "import sys;print(sys.base_prefix)"`,
      { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() || basePython
  } catch (_) {}

  const existing = fs.existsSync(py)
  const staleTag = existing && (!fs.existsSync(marker) ||
    fs.readFileSync(marker, 'utf8').trim() !== baseTag)

  if (existing && staleTag) {
    console.log('[ahtml] python interpreter changed — rebuilding venv → ' + path.basename(venvDir))
    fs.rmSync(venvDir, { recursive: true, force: true })
  }

  if (!fs.existsSync(py)) {
    console.log('[ahtml] creating python venv → ' + path.basename(venvDir))
    execSync(`"${basePython}" -m venv "${venvDir}"`, { stdio: 'inherit' })
    fs.writeFileSync(marker, baseTag)
  }

  if (deps && deps.length) {
    console.log('[ahtml] installing python deps: ' + deps.join(', '))
    const pkgs = deps.map(d => `"${d}"`).join(' ')
    execSync(`"${py}" -m pip install --quiet --disable-pip-version-check ${pkgs}`, {
      stdio: 'inherit',
    })
  }

  return py
}

module.exports = { buildPythonServerFile, findPython, setupVenv }
