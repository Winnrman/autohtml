'use strict'

/**
 * Parses an .ahtml file into its constituent blocks.
 *
 * Supported top-level tags:
 *   <server lang="node">  — server-side JS (node) or Python (lang="python") (required)
 *   <client>              — HTML served at / (required)
 *   <env>                 — KEY=VALUE pairs injected into process.env
 *   <style>               — scoped CSS auto-injected into <client>
 *   <db type="sqlite">    — SQL schema, auto-provisioned on first run
 *   <io>                  — Socket.IO server code, runs after client is loaded
 *   <deps>                — package list (pip for python); one per line
 *
 * Returns: { server, client, env, style, db, io, deps, meta }
 */

const BLOCK_RE = /<(server|client|env|style|db|io|deps)((?:\s+[^>]*)?)\s*>([\s\S]*?)<\/\1>/gi

function parseAttrs(attrStr) {
  const attrs = {}
  const re = /(\w+)(?:=["']([^"']*)["'])?/g
  let m
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2] ?? true
  }
  return attrs
}

function parse(source) {
  const blocks = { server: null, client: null, env: null, style: null, db: null, io: null, deps: null }
  const meta = {}

  let match
  BLOCK_RE.lastIndex = 0

  while ((match = BLOCK_RE.exec(source)) !== null) {
    const [, tag, attrStr, content] = match
    const attrs = parseAttrs(attrStr)

    switch (tag) {
      case 'server':
        blocks.server = content.trim()
        meta.serverLang = attrs.lang || 'node'
        meta.serverPort = attrs.port ? parseInt(attrs.port, 10) : null
        break
      case 'client':
        blocks.client = content.trim()
        meta.clientFramework = attrs.framework || 'html'
        break
      case 'db':
        blocks.db = content.trim()
        meta.dbType = attrs.type || 'sqlite'
        meta.dbFile = attrs.file || null
        break
      case 'env':
        blocks.env = parseEnvBlock(content)
        break
      case 'style':
        blocks.style = content.trim()
        break
      case 'io':
        blocks.io = content.trim()
        break
      case 'deps':
        blocks.deps = parseDepsBlock(content)
        break
    }
  }

  return { ...blocks, meta }
}

function parseEnvBlock(content) {
  const env = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    env[key] = val
  }
  return env
}

function parseDepsBlock(content) {
  const deps = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    deps.push(trimmed)
  }
  return deps.length ? deps : null
}

const SUPPORTED_DB_TYPES = ['sqlite']
const SUPPORTED_SERVER_LANGS = ['node', 'python']

function validate(parsed) {
  const errors = []

  if (!parsed.server) errors.push('Missing required <server> block')
  if (!parsed.client) errors.push('Missing required <client> block')

  if (parsed.meta.serverLang && !SUPPORTED_SERVER_LANGS.includes(parsed.meta.serverLang)) {
    errors.push(`Unsupported server lang "${parsed.meta.serverLang}" — supported: ${SUPPORTED_SERVER_LANGS.join(', ')}`)
  }

  if (parsed.db && parsed.meta.dbType && !SUPPORTED_DB_TYPES.includes(parsed.meta.dbType)) {
    errors.push(`Unsupported db type "${parsed.meta.dbType}" — supported: ${SUPPORTED_DB_TYPES.join(', ')}`)
  }

  const port = parsed.meta.serverPort
  if (port !== null && port !== undefined) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`Invalid port ${port} — must be an integer between 1 and 65535`)
    } else if (port < 1024) {
      errors.push(`Port ${port} requires root/admin privileges — use a port above 1023`)
    }
  }

  return errors
}

module.exports = { parse, validate }