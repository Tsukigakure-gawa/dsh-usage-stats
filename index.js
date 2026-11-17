/**
 * dsh-usage-stats — Host half.
 *
 * Folds every `assistant/message` usage record in the session corpus into
 * time buckets and serves the result to the Settings page over one
 * same-origin JSON route.
 *
 * Why the Host: the Client cannot read the session corpus. `assistant/message`
 * carries `usage` ({inputTokens, outputTokens, cacheReadTokens,
 * cacheWriteTokens}) together with the model identity in
 * `message.source.{provider,model}`, so the whole statistic is a fold over
 * committed session events — no new storage, no polling of the model.
 *
 * Cost is an ESTIMATE, but not a guess: rates live in this row's
 * `config.pricing` (CNY per million tokens) and default to blended rates
 * back-computed from the user's real invoices (`rate` shape). A model without
 * a matching rule contributes tokens but no cost, and the page says so.
 */

const ROUTE_PREFIX = '/usage-stats/api'
const ROUTE_PATH = '/usage-stats/api/stats'
const MAX_BODY_BYTES = 1 << 16
const HOUR = 3_600_000
const DAY = 86_400_000
const PER_UNIT = 1_000_000
const MAX_TZ_MINUTES = 14 * 60

/**
 * Rates used when the row's `config.pricing` is absent (CNY / 1M tokens).
 *
 * These are NOT list prices: they are blended rates derived from the user's own
 * 2026-10 invoices — DeepSeek ¥240.56 over 2.05B tokens, FluxToken ¥41.08 over
 * 13.88M tokens, split per model from FluxToken's "actual" column. A real
 * invoice states money over tokens, never the cache-miss/hit/output split, so
 * one blended rate per model is the honest shape.
 */
const DEFAULT_PRICING = {
  'deepseek-account/*': { rate: 0.1171 },
  'deepseek-official/*': { rate: 0.1171 },
  'fluxtoken/claude-opus-4-8': { rate: 5.2527 },
  'fluxtoken/claude-opus-5-5': { rate: 1.7056 },
  'fluxtoken/claude-sonnet-4-6': { rate: 0.8122 },
  'fluxtoken/claude-sonnet-5-5': { rate: 0.6622 },
  'fluxtoken/claude-fable-5-1': { rate: 4.584 },
  'fluxtoken/*': { rate: 2.9587 },
  'openai/*': { rate: 3.28 },
}

const DEFAULT_BASIS = '2026-10 账单反推 · DeepSeek ¥240.56/2.05B tokens · FluxToken ¥41.08/13.88M tokens'

/** One numeric token field, tolerating absent or malformed values. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** `provider/model` identity of one assistant message. */
function modelKeyOf(source) {
  const provider = typeof source?.provider === 'string' && source.provider !== '' ? source.provider : 'unknown'
  const model = typeof source?.model === 'string' && source.model !== '' ? source.model : 'unknown'
  return `${provider}/${model}`
}

/**
 * Fold one session's events into flat usage rows.
 * Every surface copy of a replaced message is kept: a rewrite of the log does
 * not refund the model call that produced the tokens.
 */
function rowsOf(events) {
  const rows = []
  for (const event of events ?? []) {
    if (event?.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === undefined || usage === null) continue
    const input = num(usage.inputTokens)
    const output = num(usage.outputTokens)
    const cacheRead = num(usage.cacheReadTokens)
    const cacheWrite = num(usage.cacheWriteTokens)
    if (input + output + cacheRead + cacheWrite === 0) continue
    rows.push({
      t: num(event.time),
      key: modelKeyOf(event.data?.message?.source),
      input,
      output,
      cacheRead,
      cacheWrite,
    })
  }
  return rows
}

/** Resolve one rate rule: exact `provider/model`, then `provider/*`, then `*`. */
function resolvePrice(pricing, key) {
  const direct = pricing[key]
  if (direct !== undefined && direct !== null && typeof direct === 'object') return direct
  const slash = key.indexOf('/')
  if (slash > 0) {
    const wildcard = pricing[`${key.slice(0, slash)}/*`]
    if (wildcard !== undefined && wildcard !== null && typeof wildcard === 'object') return wildcard
  }
  const fallback = pricing['*']
  return fallback !== undefined && fallback !== null && typeof fallback === 'object' ? fallback : undefined
}

/**
 * Estimated CNY for one row, or `null` when no rate rule matches its model.
 *
 * Two rule shapes are accepted:
 * - `{ rate }` — one blended CNY-per-1M-token price, applied to every token
 *   (input + output + cache). This is what a real invoice gives you: a total
 *   amount over a total token count, with no cache/output split.
 * - `{ cacheMiss, cacheHit, output }` — a per-category price list for providers
 *   that publish one.
 */
function costOf(rule, row) {
  if (rule === undefined) return null
  if (typeof rule.rate === 'number') {
    return ((row.input + row.output + row.cacheRead + row.cacheWrite) * rule.rate) / PER_UNIT
  }
  const miss = row.input + row.cacheWrite
  const hit = row.cacheRead
  return (miss * num(rule.cacheMiss) + hit * num(rule.cacheHit) + row.output * num(rule.output)) / PER_UNIT
}

/** Local-midnight epoch of the day containing `ms` (offset = minutes east of UTC). */
function dayStartOf(ms, offsetMinutes) {
  const shift = offsetMinutes * 60_000
  return Math.floor((ms + shift) / DAY) * DAY - shift
}

function emptyBucket(start, step) {
  return {
    start,
    end: start + step,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    calls: 0,
    cost: 0,
    costCalls: 0,
  }
}

function addTo(bucket, row, cost) {
  bucket.input += row.input
  bucket.output += row.output
  bucket.cacheRead += row.cacheRead
  bucket.cacheWrite += row.cacheWrite
  bucket.tokens += row.input + row.output + row.cacheRead + row.cacheWrite
  bucket.calls += 1
  if (cost !== null) {
    bucket.cost += cost
    bucket.costCalls += 1
  }
}

function sumBuckets(buckets) {
  const total = emptyBucket(0, 0)
  for (const bucket of buckets) {
    total.input += bucket.input
    total.output += bucket.output
    total.cacheRead += bucket.cacheRead
    total.cacheWrite += bucket.cacheWrite
    total.tokens += bucket.tokens
    total.calls += bucket.calls
    total.cost += bucket.cost
    total.costCalls += bucket.costCalls
  }
  return {
    input: total.input,
    output: total.output,
    cacheRead: total.cacheRead,
    cacheWrite: total.cacheWrite,
    tokens: total.tokens,
    calls: total.calls,
    cost: total.cost,
    costCalls: total.costCalls,
  }
}

/** One month key in the caller's timezone, `YYYY-MM`. */
function monthKeyOf(ms, offsetMinutes) {
  const local = new Date(ms + offsetMinutes * 60_000)
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Month start epoch of the month containing `ms`, in the caller's timezone. */
function monthStartOf(ms, offsetMinutes) {
  const local = new Date(ms + offsetMinutes * 60_000)
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1)
  return startLocal - offsetMinutes * 60_000
}

function nextMonthStartOf(start, offsetMinutes) {
  const local = new Date(start + offsetMinutes * 60_000)
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - offsetMinutes * 60_000
}

/**
 * Build the four ranges the page offers. All four come from the same row set,
 * so switching tabs never re-reads a session log.
 */
function buildViews(rows, pricing, offsetMinutes, now) {
  const today = dayStartOf(now, offsetMinutes)
  const hourBuckets = []
  for (let index = 0; index < 24; index += 1) hourBuckets.push(emptyBucket(today + index * HOUR, HOUR))

  const weekStart = today - 6 * DAY
  const weekBuckets = []
  for (let index = 0; index < 7; index += 1) weekBuckets.push(emptyBucket(weekStart + index * DAY, DAY))

  const monthStart = today - 29 * DAY
  const monthBuckets = []
  for (let index = 0; index < 30; index += 1) monthBuckets.push(emptyBucket(monthStart + index * DAY, DAY))

  const firstRowAt = rows.reduce((min, row) => (row.t > 0 && row.t < min ? row.t : min), now)
  const firstMonth = monthStartOf(firstRowAt, offsetMinutes)
  const currentMonth = monthStartOf(now, offsetMinutes)
  const allBuckets = []
  for (let start = firstMonth; start <= currentMonth && allBuckets.length < 240; ) {
    const next = nextMonthStartOf(start, offsetMinutes)
    allBuckets.push(emptyBucket(start, next - start))
    start = next
  }
  const allIndex = new Map()
  allBuckets.forEach((bucket, index) => allIndex.set(monthKeyOf(bucket.start, offsetMinutes), index))

  const models = new Map()
  const unpriced = new Set()

  for (const row of rows) {
    const price = resolvePrice(pricing, row.key)
    const cost = costOf(price, row)
    if (cost === null) unpriced.add(row.key)

    const hourIndex = Math.floor((row.t - today) / HOUR)
    if (hourIndex >= 0 && hourIndex < 24) addTo(hourBuckets[hourIndex], row, cost)

    const weekIndex = Math.floor((row.t - weekStart) / DAY)
    if (weekIndex >= 0 && weekIndex < 7) addTo(weekBuckets[weekIndex], row, cost)

    const dayIndex = Math.floor((row.t - monthStart) / DAY)
    if (dayIndex >= 0 && dayIndex < 30) addTo(monthBuckets[dayIndex], row, cost)

    const key = monthKeyOf(row.t, offsetMinutes)
    const index = allIndex.get(key)
    if (index !== undefined) addTo(allBuckets[index], row, cost)

    const entry = models.get(row.key) ?? { key: row.key, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, priced: cost !== null }
    entry.calls += 1
    entry.input += row.input
    entry.output += row.output
    entry.cacheRead += row.cacheRead
    entry.cacheWrite += row.cacheWrite
    entry.tokens += row.input + row.output + row.cacheRead + row.cacheWrite
    if (cost !== null) entry.cost += cost
    else entry.priced = false
    models.set(row.key, entry)
  }

  return {
    hours: { kind: 'hour', step: HOUR, buckets: hourBuckets, total: sumBuckets(hourBuckets) },
    days7: { kind: 'day', step: DAY, buckets: weekBuckets, total: sumBuckets(weekBuckets) },
    days30: { kind: 'day', step: DAY, buckets: monthBuckets, total: sumBuckets(monthBuckets) },
    months: { kind: 'month', step: 0, buckets: allBuckets, total: sumBuckets(allBuckets) },
    models: [...models.values()].sort((left, right) => right.tokens - left.tokens),
    unpriced: [...unpriced].sort(),
  }
}

/** Read one JSON request body, bounded. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

function writeJson(res, status, body) {
  if (res.headersSent === true) {
    res.destroy?.()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

function writeFailure(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/** Plain-object config coercion: this bundle ships no schema dependency. */
function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const pricing = raw.pricing !== null && typeof raw.pricing === 'object' ? raw.pricing : DEFAULT_PRICING
  const basis = typeof raw.basis === 'string' && raw.basis.trim() !== '' ? raw.basis.trim() : DEFAULT_BASIS
  return { pricing, basis }
}

/**
 * Required Host services: the route carrier, the two session-corpus readers,
 * and the connection trust fence the route answers behind.
 */
export const inject = ['connection', 'sessionPersistence', 'sessionQuery', 'webServer']

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  /** sessionId -> { revision, rows } so an unchanged log is never replayed. */
  const sessionRows = new Map()
  let inflight

  async function scan() {
    const startedAt = Date.now()
    const records = await ctx.sessionQuery.listSessions()
    const rows = []
    let sessions = 0
    let liveOnly = 0
    let failures = 0

    for (const record of records) {
      const id = record?.header?.id
      if (typeof id !== 'string' || id === '') continue
      let revision = null
      try {
        revision = (await ctx.sessionPersistence.stat(id))?.revision ?? null
      } catch {
        revision = null
      }
      const cached = sessionRows.get(id)
      if (revision !== null && cached !== undefined && cached.revision === revision) {
        rows.push(...cached.rows)
        sessions += 1
        continue
      }
      let snapshot
      try {
        snapshot = await ctx.sessionQuery.readSession(id)
      } catch {
        failures += 1
        continue
      }
      const own = rowsOf(snapshot.events)
      if (revision === null) liveOnly += 1
      else sessionRows.set(id, { revision, rows: own })
      rows.push(...own)
      sessions += 1
    }

    return {
      rows,
      scanMs: Date.now() - startedAt,
      coverage: {
        sessions,
        liveOnly,
        failures,
        total: records.length,
        firstAt: rows.length === 0 ? null : rows.reduce((min, row) => (row.t > 0 && row.t < min ? row.t : min), Infinity),
        lastAt: rows.length === 0 ? null : rows.reduce((max, row) => (row.t > max ? row.t : max), 0),
      },
    }
  }

  /** One shared scan: overlapping requests wait for the same pass. */
  async function rowsNow() {
    if (inflight === undefined) {
      inflight = scan().finally(() => {
        inflight = undefined
      })
    }
    return inflight
  }

  async function stats(offsetMinutes) {
    const pass = await rowsNow()
    const folded = buildViews(pass.rows, settings.pricing, offsetMinutes, Date.now())
    return {
      currency: 'CNY',
      unit: 'per-million-tokens',
      estimate: true,
      basis: settings.basis,
      generatedAt: Date.now(),
      timezoneOffsetMinutes: offsetMinutes,
      scanMs: pass.scanMs,
      coverage: pass.coverage,
      calls: pass.rows.length,
      views: {
        hours: folded.hours,
        days7: folded.days7,
        days30: folded.days30,
        months: folded.months,
      },
      models: folded.models,
      unpriced: folded.unpriced,
    }
  }

  function handler(req, res) {
    if (ctx.connection.requestRejection(req) !== undefined) {
      writeFailure(res, 403, 'forbidden', 'forbidden')
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    if (pathname !== ROUTE_PATH) {
      writeFailure(res, 404, 'not-found', 'unknown usage-stats route')
      return
    }
    if (req.method !== 'POST') {
      writeFailure(res, 405, 'method-error', 'method not allowed')
      return
    }
    void (async () => {
      try {
        const body = await readJsonBody(req)
        const raw = typeof body?.tzOffsetMinutes === 'number' && Number.isFinite(body.tzOffsetMinutes) ? body.tzOffsetMinutes : 0
        const offset = Math.max(-MAX_TZ_MINUTES, Math.min(MAX_TZ_MINUTES, Math.round(raw)))
        writeOk(res, await stats(offset))
      } catch (error) {
        writeFailure(res, 500, 'internal', error instanceof Error ? error.message : String(error))
      }
    })()
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'dsh-usage-stats: usage statistics route',
  )

  // A session that closes must not leave a stale revision behind: its next
  // observation either matches or is replayed again.
  ctx.effect(() => () => sessionRows.clear(), 'dsh-usage-stats: session row cache')
}
