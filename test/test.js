'use strict'

const { parse, validate } = require('../src/parser')
const fs = require('fs')
const path = require('path')

let passed = 0
let failed = 0

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

console.log('\n── parser tests ──\n')

// Basic parse
const simple = `
<server lang="node">
app.get('/api/hi', (req, res) => res.json({ hi: true }));
</server>
<client>
<h1>hello</h1>
</client>
`
const p = parse(simple)
assert('finds server block', p.server !== null)
assert('finds client block', p.client !== null)
assert('server lang attr', p.meta.serverLang === 'node')
assert('server content correct', p.server.includes("app.get('/api/hi'"))
assert('client content correct', p.client.includes('<h1>hello</h1>'))

// Env block
const withEnv = simple + `<env>\nFOO=bar\nBAZ=qux\n</env>`
const pe = parse(withEnv)
assert('parses env block', pe.env !== null)
assert('env key FOO', pe.env.FOO === 'bar')
assert('env key BAZ', pe.env.BAZ === 'qux')

// Style block
const withStyle = simple + `<style>\nbody { color: red; }\n</style>`
const ps = parse(withStyle)
assert('parses style block', ps.style !== null)
assert('style content', ps.style.includes('body { color: red; }'))

// Validation
const valid = validate(p)
assert('valid file passes', valid.length === 0)

const noServer = parse(`<client><h1>hi</h1></client>`)
const errNoServer = validate(noServer)
assert('missing server caught', errNoServer.some(e => e.includes('server')))

const noClient = parse(`<server lang="node">app.get('/', () => {});</server>`)
const errNoClient = validate(noClient)
assert('missing client caught', errNoClient.some(e => e.includes('client')))

// Validate: db type
const badDb = parse(`<server lang="node">x;</server><client>y</client><db type="postgres">CREATE TABLE t(id INT);</db>`)
const errBadDb = validate(badDb)
assert('unsupported db type caught', errBadDb.some(e => e.includes('postgres')))

const goodDb = parse(`<server lang="node">x;</server><client>y</client><db type="sqlite">CREATE TABLE t(id INT);</db>`)
const errGoodDb = validate(goodDb)
assert('sqlite db type passes', errGoodDb.length === 0)

// Validate: port range
const badPort = parse(`<server lang="node" port="99999">x;</server><client>y</client>`)
const errBadPort = validate(badPort)
assert('out-of-range port caught', errBadPort.some(e => e.includes('99999')))

const privPort = parse(`<server lang="node" port="80">x;</server><client>y</client>`)
const errPrivPort = validate(privPort)
assert('privileged port caught', errPrivPort.some(e => e.includes('80')))

const goodPort = parse(`<server lang="node" port="3000">x;</server><client>y</client>`)
const errGoodPort = validate(goodPort)
assert('valid port passes', errGoodPort.length === 0)

// Python server lang
console.log('\n── python backend tests ──\n')
const pySrc = `
<server lang="python">
@app.get('/api/hi')
def hi(req, res):
    res.json({'hi': True})
</server>
<client><h1>py</h1></client>
`
const py = parse(pySrc)
assert('python server lang parsed', py.meta.serverLang === 'python')
assert('python server content kept', py.server.includes("@app.get('/api/hi')"))
assert('python lang validates', validate(py).length === 0)

// deps block
const depsSrc = pySrc + `<deps>\nrequests\nflask==3.0.0\n# a comment\n\n</deps>`
const pd = parse(depsSrc)
assert('deps block parsed to array', Array.isArray(pd.deps))
assert('deps has two entries', pd.deps.length === 2)
assert('deps keeps version pin', pd.deps.includes('flask==3.0.0'))
assert('deps skips comments/blanks', !pd.deps.some(d => d.startsWith('#') || d === ''))

const noDeps = parse(pySrc)
assert('no deps block → null', noDeps.deps === null)

// real python file
const pyFileSrc = fs.readFileSync(path.join(__dirname, 'python-notes.ahtml'), 'utf8')
const pyFile = parse(pyFileSrc)
assert('python-notes.ahtml parses', pyFile.server && pyFile.client)
assert('python-notes.ahtml validates', validate(pyFile).length === 0)
assert('python-notes.ahtml is python', pyFile.meta.serverLang === 'python')
assert('python-notes.ahtml has db', pyFile.db !== null)

// toPermPath: Windows extended-length prefix
console.log('\n── toPermPath tests ──\n')
// Inline the logic here so we can test it without spawning a child
function toPermPath(p) {
  const nodePath = require('path')
  const abs = nodePath.resolve(p)
  if (process.platform === 'win32' && !abs.startsWith('\\\\')) {
    return '\\\\?\\' + abs
  }
  return abs
}
if (process.platform === 'win32') {
  const result = toPermPath('C:\\Users\\hackr\\AppData\\Local\\Temp\\ahtml-server-123.js')
  assert('toPermPath adds \\\\?\\ prefix on Windows', result.startsWith('\\\\?\\'))
  const alreadyUNC = toPermPath('\\\\?\\C:\\already\\prefixed.js')
  assert('toPermPath does not double-prefix', alreadyUNC.startsWith('\\\\?\\') && !alreadyUNC.startsWith('\\\\?\\\\\\?\\'))
} else {
  const result = toPermPath('/tmp/ahtml-server-123.js')
  assert('toPermPath no-ops on non-Windows', !result.startsWith('\\\\?\\'))
}

// Real file
console.log('\n── todo.ahtml parse test ──\n')
const todoSrc = fs.readFileSync(path.join(__dirname, 'todo.ahtml'), 'utf8')
const todo = parse(todoSrc)
const todoErrs = validate(todo)
assert('todo.ahtml parses', todo.server && todo.client)
assert('todo.ahtml validates', todoErrs.length === 0)
assert('todo.ahtml has style', todo.style !== null)
assert('todo.ahtml has env', todo.env !== null)
assert('todo env APP_NAME', todo.env.APP_NAME === 'ahtml-todo')

console.log(`\n── ${passed + failed} tests: ${passed} passed, ${failed} failed ──\n`)
process.exit(failed > 0 ? 1 : 0)
