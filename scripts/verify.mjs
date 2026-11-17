/**
 * Offline end-to-end check for this bundle.
 *
 *   node scripts/verify.mjs
 *
 * 1. Rebuilds the session corpus from `$DSH_HOME/sessions` (zstd JSONL frames)
 *    and hands it to the real Host half through a stub Context, then calls the
 *    registered route handler.
 * 2. Renders the real Client half with that payload through a minimal React
 *    stand-in and prints the resulting text, so a broken data contract
 *    (missing field, NaN, "undefined" on screen) fails loudly here.
 *
 * Requires a Node with `zlib.zstdDecompressSync` (Node >= 22.15 / 24).
 * This is a development harness only; the bundle never imports it.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const home = process.env.DSH_HOME ?? 'F:/dsh-data'
const sessionsRoot = join(home, 'sessions')

function sessionFiles(root) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (entry.name !== 'session.v4.jsonl.zstd') continue
      files.push({ id: dir, file: path })
    }
  }
  walk(root)
  return files
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function readEvents(file) {
  const buffer = readFileSync(file)
  const events = new Map()
  let index = 0
  while (true) {
    const at = buffer.indexOf(MAGIC, index)
    if (at < 0) break
    index = at + 1
    let out
    try {
      out = zstdDecompressSync(buffer.subarray(at))
    } catch {
      continue
    }
    const text = out.toString('utf8')
    if (!text.includes('"seq"')) continue
    for (const line of text.split('\n')) {
      if (!line) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof record?.seq !== 'number' || typeof record?.type !== 'string') continue
      if (!events.has(record.seq)) events.set(record.seq, record)
    }
  }
  return [...events.values()].sort((left, right) => left.seq - right.seq)
}

const corpus = new Map()
let revision = 0
for (const { id, file } of sessionFiles(sessionsRoot)) {
  corpus.set(id, { events: readEvents(file), revision: `verify-${revision++}` })
}

let route
const hostCtx = {
  connection: { requestRejection: () => undefined },
  sessionPersistence: { stat: async (id) => (corpus.has(id) ? { revision: corpus.get(id).revision } : undefined) },
  sessionQuery: {
    listSessions: async () => [...corpus.keys()].map((id) => ({ header: { id } })),
    readSession: async (id) => ({ events: corpus.get(id).events }),
  },
  webServer: {
    register: (value) => {
      route = value
      return () => {}
    },
  },
  effect: (callback) => {
    callback()
    return () => {}
  },
}

const host = await import(pathToFileURL(join(packageDir, 'index.js')).href)
await host.apply(hostCtx, {
  basis: 'verify harness · blended rates from the 2026-10 invoices',
  pricing: {
    'deepseek-account/*': { rate: 0.1171 },
    'deepseek-official/*': { rate: 0.1171 },
    'fluxtoken/claude-opus-4-8': { rate: 5.2527 },
    'fluxtoken/claude-opus-5-5': { rate: 1.7056 },
    'fluxtoken/claude-sonnet-4-6': { rate: 0.8122 },
    'fluxtoken/*': { rate: 2.9587 },
  },
})

let payload = ''
await route.handler(
  {
    method: 'POST',
    url: '/usage-stats/api/stats',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{"tzOffsetMinutes":480}')
    },
  },
  {
    headersSent: false,
    writeHead: () => {},
    end: (body) => {
      payload = body
    },
    destroy: () => {},
  },
)
await new Promise((resolve) => setTimeout(resolve, 50))

const envelope = JSON.parse(payload)
const value = envelope.value
console.log('[host] calls', value.calls, 'sessions', value.coverage.sessions, 'scanMs', value.scanMs)
for (const [name, view] of Object.entries(value.views)) {
  console.log(`[host] ${name}: buckets=${view.buckets.length} tokens=${view.total.tokens} cost=${view.total.cost.toFixed(2)} calls=${view.total.calls}`)
}
for (const model of value.models.slice(0, 5)) {
  const perMillion = model.tokens === 0 ? 0 : (model.cost / model.tokens) * 1_000_000
  console.log(`[host] model ${model.key}: tokens=${model.tokens} cny=${model.priced ? model.cost.toFixed(2) : '—'} (${model.priced ? perMillion.toFixed(3) : '—'} ¥/M)`)
}

/* ---------- Client half ---------- */
let loaded
globalThis.window = { __ModuleLoader__: { load: (mod) => { loaded = mod } } }
globalThis.document = { baseURI: 'http://127.0.0.1:5609/' }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => envelope })

const slots = []
let cursor = 0
let dirty = false
const effects = []
const React = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [
      slots[index],
      (next) => {
        const resolved = typeof next === 'function' ? next(slots[index]) : next
        if (resolved !== slots[index]) {
          slots[index] = resolved
          dirty = true
        }
      },
    ]
  },
  useEffect(effect) {
    effects.push(effect)
  },
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
}

await import(pathToFileURL(join(packageDir, 'client.js')).href)
const client = loaded.factory(() => React)
const registered = []
client.apply({
  get: (name) => (name === 'locale' ? { getLocale: () => ({ active: 'zh-CN' }), subscribe: () => () => {} } : undefined),
  slots: {
    inject: (key, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
})

function render() {
  cursor = 0
  effects.length = 0
  const tree = registered[0].component({ close: () => {} })
  for (const effect of effects) effect()
  return tree
}

let tree = render()
for (let pass = 0; pass < 4; pass += 1) {
  await new Promise((resolve) => setTimeout(resolve, 60))
  if (!dirty) break
  dirty = false
  tree = render()
}

const text = []
function walk(node) {
  if (node === null || node === undefined || node === false) return
  if (typeof node === 'string' || typeof node === 'number') {
    text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    node.forEach(walk)
    return
  }
  if (node.type === 'style') return
  for (const child of node.children ?? []) walk(child)
}
walk(tree)
const flat = text.join(' ').replace(/\s+/g, ' ')
console.log('[client]', flat.slice(0, 600))
console.log('[client] tail:', flat.slice(-420))

const problems = []
if (flat.includes('undefined')) problems.push('screens "undefined"')
if (flat.includes('NaN')) problems.push('screens "NaN"')
if (!flat.includes('¥')) problems.push('no CNY value')
if (!flat.includes('单价依据') && !flat.includes('Rate basis')) problems.push('no rate-basis line')
if (value.calls > 0 && !flat.includes('按模型') && !flat.includes('By model')) problems.push('no model breakdown')
console.log('[client] problems:', problems.length === 0 ? 'none' : problems.join(', '))
process.exitCode = problems.length === 0 ? 0 : 1
