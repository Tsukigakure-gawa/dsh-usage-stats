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
 * Cost is an ESTIMATE: rates live in this row's `config.pricing`
 * (CNY per million tokens). An invoice states money over tokens and never the
 * cache split, so the honest default shape is one blended rate per model.
 * Replace the sample rates below with rates back-computed from your own
 * invoice; a model without a matching rule contributes tokens but no cost,
 * and the page says so.
 */

const ROUTE_PREFIX = '/usage-stats/api'
const ROUTE_PATH = '/usage-stats/api/stats'
const MAX_BODY_BYTES = 1 << 16
const HOUR = 3_600_000
const DAY = 86_400_000
const PER_UNIT = 1_000_000
const MAX_TZ_MINUTES = 14 * 60

/**
 * Price resolution has four layers, highest priority first:
 *
 *   L0 override  — the row's `config.pricing` (exact key, then `provider/*`, then `*`)
 *   L1 official  — built-in table matched against a NORMALIZED model name, so a
 *                  relay that renames the provider (or appends a date/size tag)
 *                  still resolves to the right family
 *   L2 gateway   — prices the relay itself publishes (OpenRouter `/v1/models`,
 *                  one-api/new-api `/api/pricing`), fetched and cached
 *   L3 none      — tokens only; the page lists the model as unpriced
 *
 * Nothing here is authoritative: every model carries the source it resolved
 * from, and the page shows it, so an estimate is never mistaken for a bill.
 */
const PRICE_SOURCE = {
  override: 'override',
  official: 'official',
  gateway: 'gateway',
  none: 'none',
}

/** CNY per 1M tokens for the built-in table is configurable via `usdToCny`. */
const DEFAULT_USD_TO_CNY = 7.2

/** No overrides by default: L1/L2 do the work, L0 only when the caller sets it. */
const DEFAULT_PRICING = {}

const DEFAULT_BASIS = '自动匹配（L1 官方参考价 / L2 网关自报价），可用 config.pricing 覆盖'

/**
 * Reference list prices in USD per 1M tokens, converted at `usdToCny` unless the
 * row overrides them. Clearly an approximation: list prices change, and this
 * table is meant to be replaced by L0/L2 whenever the caller knows better.
 *
 * `models` is a pattern list tested against the canonical model name.
 */
const OFFICIAL_TABLE = [
  { models: [/^deepseek-(chat|v3)/], usd: { in: 0.27, out: 1.10 } },
  { models: [/^deepseek-reasoner|^deepseek-r1/], usd: { in: 0.55, out: 2.19 } },
  { models: [/claude.*opus/], usd: { in: 15, out: 75 } },
  { models: [/claude.*sonnet/], usd: { in: 3, out: 15 } },
  { models: [/claude.*haiku/], usd: { in: 0.8, out: 4 } },
  { models: [/^gpt-4o-mini/], usd: { in: 0.15, out: 0.6 } },
  { models: [/^gpt-4o/], usd: { in: 2.5, out: 10 } },
  { models: [/^gpt-4\.1-mini/], usd: { in: 0.4, out: 1.6 } },
  { models: [/^gpt-4\.1/], usd: { in: 2, out: 8 } },
  { models: [/^o[34](-mini)?$/], usd: { in: 1.1, out: 4.4 } },
  { models: [/gemini.*flash/], usd: { in: 0.3, out: 2.5 } },
  { models: [/gemini.*pro/], usd: { in: 1.25, out: 10 } },
]

/**
 * Canonical model name: drop the provider prefix, the vendor prefix, date
 * stamps, `[128k]`-style tags and `-latest`/`-preview`/`-free` suffixes.
 *
 *   'my-relay/claude-3-5-sonnet-20241022' -> 'claude-3-5-sonnet'
 *   'anyproxy/openai/gpt-4o-mini[128k]'    -> 'gpt-4o-mini'
 */
function canonicalModel(key) {
  let name = String(key ?? '').toLowerCase()
  const slash = name.indexOf('/')
  if (slash >= 0) name = name.slice(slash + 1)
  name = name.replace(/^[a-z0-9_.-]+\//, '')
  name = name.replace(/[-_](19|20)\d{6}$/, '')
  name = name.replace(/[-_](19|20)\d{2}[-_]\d{2}[-_]\d{2}$/, '')
  name = name.replace(/\[[^\]]*\]$/, '')
  name = name.replace(/[-_](latest|preview|beta|free|v\d+)$/, '')
  name = name.replace(/_/g, '-')
  return name
}

/** `{in, out}` USD -> a `{cacheMiss, cacheHit, output}` CNY rule. */
function fromUsd(usd, usdToCny) {
  const input = num(usd?.in) * usdToCny
  const output = num(usd?.out) * usdToCny
  if (input <= 0 && output <= 0) return undefined
  // Cache reads are typically a quarter of the input price; the exact ratio is
  // per provider, so this is a documented approximation, not a measurement.
  return { cacheMiss: input, cacheHit: input * 0.25, output: output > 0 ? output : input }
}

/** L1: first matching entry of the built-in table, or undefined. */
function officialPriceOf(canonical, usdToCny) {
  for (const entry of OFFICIAL_TABLE) {
    if (entry.models.some((pattern) => pattern.test(canonical))) return fromUsd(entry.usd, usdToCny)
  }
  return undefined
}

/**
 * one-api / new-api quota math: `quota = tokens * model_ratio * group_ratio`,
 * and USD 1 = 500000 quota, so USD per 1M tokens = ratio * group * 2.
 * `completionRatio` (when the site exposes it) splits input and output price.
 */
function fromOneApiRatio(ratio, groupRatio, usdToCny, completionRatio) {
  const usdIn = num(ratio) * (num(groupRatio) || 1) * 2
  if (usdIn <= 0) return undefined
  const usdOut = num(completionRatio) > 0 ? usdIn * num(completionRatio) : usdIn
  return fromUsd({ in: usdIn, out: usdOut }, usdToCny)
}

/**
 * Fetch one gateway's published prices. Two shapes are supported:
 *
 * - `openrouter`: `GET {baseUrl}/v1/models` -> `data[].pricing.{prompt,completion}`
 *   in USD per token.
 * - `oneapi`: `GET {baseUrl}/api/pricing` (new-api) or `/api/models` (one-api)
 *   -> `model_ratio` / `completion_ratio` / `group_ratio`, quota math above.
 *
 * Returns a `Map<canonicalModel, rule>` (plus `'*'` for a provider-wide rate),
 * or an empty map when the site answers with something unexpected. Never throws:
 * a relay that hides its prices must only cost us the L2 tier.
 */
async function fetchGatewayPrices(gateway, usdToCny, fetchImpl) {
  const out = new Map()
  const base = String(gateway.baseUrl ?? '').replace(/\/+$/, '')
  if (base === '' || typeof fetchImpl !== 'function') return out
  const headers = { accept: 'application/json' }
  if (typeof gateway.apiKey === 'string' && gateway.apiKey !== '') headers.authorization = `Bearer ${gateway.apiKey}`

  const getJson = async (path) => {
    const response = await fetchImpl(`${base}${path}`, {
      headers,
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined,
    })
    if (!response?.ok) return undefined
    return response.json()
  }

  try {
    if (gateway.kind === 'openrouter') {
      const body = await getJson('/v1/models')
      for (const item of body?.data ?? []) {
        const prompt = Number(item?.pricing?.prompt)
        const completion = Number(item?.pricing?.completion)
        if (!Number.isFinite(prompt) || prompt <= 0) continue
        const usd = { in: prompt * 1e6, out: (Number.isFinite(completion) && completion > 0 ? completion : prompt) * 1e6 }
        const rule = fromUsd(usd, usdToCny)
        if (rule) out.set(canonicalModel(String(item?.id ?? '')), rule)
      }
      return out
    }

    // one-api family: try /api/pricing first, then /api/models
    const pricing = await getJson('/api/pricing')
    const rows = Array.isArray(pricing) ? pricing : Array.isArray(pricing?.data) ? pricing.data : []
    for (const item of rows) {
      const name = String(item?.model_name ?? item?.model ?? '')
      const ratio = num(item?.model_ratio) > 0 ? item.model_ratio : item?.quota_type === 0 ? 1 : undefined
      const rule = fromOneApiRatio(ratio, item?.group_ratio, usdToCny, item?.completion_ratio)
      if (name !== '' && rule) out.set(canonicalModel(name), rule)
    }
    if (out.size > 0) return out

    const models = await getJson('/api/models')
    const list = Array.isArray(models) ? models : Array.isArray(models?.data) ? models.data : []
    for (const item of list) {
      const name = String(item?.model_name ?? item?.id ?? '')
      const rule = fromOneApiRatio(item?.model_ratio, item?.group_ratio ?? 1, usdToCny, item?.completion_ratio)
      if (name !== '' && rule) out.set(canonicalModel(name), rule)
    }
  } catch {
    // offline / wrong shape / blocked: L2 simply yields nothing
  }
  return out
}



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
 * Full four-layer resolution for one row. `gatewayPrices` is
 * `Map<providerName, Map<canonicalModel, rule>>` filled by the L2 loader.
 */
function resolveRowPrice(row, settings, gatewayPrices) {
  // L0 — explicit override (exact key, `provider/*`, `*`)
  const override = resolvePrice(settings.pricing, row.key)
  if (override !== undefined) return { price: override, source: PRICE_SOURCE.override }

  const canonical = canonicalModel(row.key)

  // L1 — built-in reference table
  if (settings.autoOfficial) {
    const official = officialPriceOf(canonical, settings.usdToCny)
    if (official !== undefined) return { price: official, source: PRICE_SOURCE.official }
  }

  // L2 — what the gateway itself published
  const slash = row.key.indexOf('/')
  const provider = slash > 0 ? row.key.slice(0, slash) : ''
  const fromGateway = gatewayPrices?.get(provider)
  if (fromGateway !== undefined) {
    const hit = fromGateway.get(canonical) ?? fromGateway.get('*')
    if (hit !== undefined) return { price: hit, source: PRICE_SOURCE.gateway }
  }

  // L3 — tokens only
  return { price: undefined, source: PRICE_SOURCE.none }
}

/**
 * Estimated CNY for one row, or `null` when no rule matched its model.
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
function buildViews(rows, resolve, offsetMinutes, now) {
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
    const resolved = resolve(row)
    const cost = costOf(resolved.price, row)
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

    const entry = models.get(row.key) ?? {
      key: row.key,
      canonical: canonicalModel(row.key),
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokens: 0,
      cost: 0,
      priced: cost !== null,
      priceSource: resolved.source,
    }
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
  const autoOfficial = raw.autoOfficial !== false
  const usdToCny = Number(raw.usdToCny) > 0 ? Number(raw.usdToCny) : DEFAULT_USD_TO_CNY
  const gateways = Array.isArray(raw.gateways)
    ? raw.gateways.filter(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          typeof item.provider === 'string' &&
          item.provider !== '' &&
          typeof item.baseUrl === 'string' &&
          item.baseUrl !== '',
      )
    : []
  const gatewayTtlMinutes = Number(raw.gatewayTtlMinutes) > 0 ? Number(raw.gatewayTtlMinutes) : 12 * 60
  return { pricing, basis, autoOfficial, usdToCny, gateways, gatewayTtlMs: gatewayTtlMinutes * 60_000 }
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

  /**
   * L2 gateway prices, cached per provider. A failed refresh keeps the previous
   * answer: an offline relay must not degrade a working estimate.
   */
  const gatewayCache = new Map()
  let gatewayInflight

  async function gatewaysNow() {
    if (settings.gateways.length === 0) return gatewayCache
    const stale = settings.gateways.some((gateway) => {
      const cached = gatewayCache.get(gateway.provider)
      return cached === undefined || Date.now() - cached.at > settings.gatewayTtlMs
    })
    if (!stale) return gatewayCache
    if (gatewayInflight === undefined) {
      gatewayInflight = (async () => {
        const fetchImpl = typeof fetch === 'function' ? fetch : undefined
        for (const gateway of settings.gateways) {
          const prices = await fetchGatewayPrices(gateway, settings.usdToCny, fetchImpl)
          if (prices.size > 0) gatewayCache.set(gateway.provider, { at: Date.now(), prices })
        }
      })().finally(() => {
        gatewayInflight = undefined
      })
    }
    await gatewayInflight
    return gatewayCache
  }

  async function stats(offsetMinutes) {
    const [pass, gateways] = await Promise.all([rowsNow(), gatewaysNow()])
    const priceMap = new Map([...gateways].map(([provider, entry]) => [provider, entry.prices]))
    const folded = buildViews(
      pass.rows,
      (row) => resolveRowPrice(row, settings, priceMap),
      offsetMinutes,
      Date.now(),
    )
    return {
      currency: 'CNY',
      unit: 'per-million-tokens',
      estimate: true,
      basis: settings.basis,
      pricing: {
        autoOfficial: settings.autoOfficial,
        usdToCny: settings.usdToCny,
        gatewaysConfigured: settings.gateways.map((gateway) => gateway.provider),
        gatewaysLoaded: [...priceMap.keys()],
      },
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
