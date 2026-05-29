#!/usr/bin/env node
'use strict'

const path = require('path')
const fs = require('fs')
const { run } = require('../src/runtime')
const { init } = require('../src/init')

const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const positional = args.filter(a => !a.startsWith('--'))
const subcommand = positional[0]

if (flags.has('--help') || flags.has('-h') || args.length === 0) {
  console.log(`
  ahtml — the self-launching web app runtime

  Usage:
    ahtml init [name]            scaffold a new .ahtml project
    ahtml <file.ahtml>           run a .ahtml file
    ahtml <file.ahtml> --no-open   don't auto-open browser
    ahtml <file.ahtml> --no-watch  don't watch for changes
    ahtml --version              print version
    ahtml --help                 show this help

  Blocks:
    <server lang="node">   Node.js backend (required, default)
    <server lang="python"> Python 3 backend (Flask-style routes, stdlib sqlite3)
    <client>               HTML frontend (required)
    <db type="sqlite">     SQLite schema, auto-provisioned
    <deps>                 pip packages for python servers, one per line
    <style>                CSS injected into client
    <env>                  KEY=value pairs → process.env
`)
  process.exit(0)
}

// ahtml init [name]
if (subcommand === 'init') {
  init(positional[1])
  return
}

if (flags.has('--version')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
  console.log(`ahtml v${pkg.version}`)
  process.exit(0)
}

const target = positional[0]
if (!target || !fs.existsSync(target)) {
  console.error(`[ahtml] file not found: ${target}`)
  process.exit(1)
}

if (!target.endsWith('.ahtml')) {
  console.warn(`[ahtml] warning: file doesn't have .ahtml extension`)
}

run(target, {
  open: !flags.has('--no-open'),
  watch: !flags.has('--no-watch'),
})