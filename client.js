/**
 * dsh-usage-stats — Client half.
 *
 * One Settings section ("Usage statistics", right below Account & balance).
 * It renders token and estimated-CNY spend per time bucket from
 * `/usage-stats/api/stats`, which the Host half serves out of the session
 * corpus. Nothing is folded here: the Host already bucketed the range.
 */
window.__ModuleLoader__.load({
  id: 'dsh-usage-stats',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const NS = 'usage-stats'

    const TEXTS = {
      en: {
        nav: 'Usage statistics',
        title: 'Usage statistics',
        subtitle: 'Token and estimated CNY spend by time period, folded from every session log.',
        refreshed: 'Updated',
        refresh: 'Refresh',
        loading: 'Reading session logs…',
        loadingHint: 'The first pass replays every stored session; later passes reuse the unchanged ones.',
        retry: 'Retry',
        empty: 'No model usage recorded in this period.',
        tabHours: 'Today',
        tabDays7: '7 days',
        tabDays30: '30 days',
        tabMonths: 'All time',
        totalTokens: 'Tokens',
        totalCost: 'Estimated spend',
        totalCalls: 'Model calls',
        ofCalls: 'calls',
        output: 'output',
        cacheRead: 'cache hit',
        perBucket: 'per period',
        breakdown: 'By model',
        breakdownAll: 'By model (all time)',
        sep: ', ',
        columnModel: 'Model',
        columnTokens: 'Tokens',
        columnCost: 'Est. CNY',
        unpriced: 'No rate configured',
        unpricedNote: 'Providers without a rate rule count tokens but add no cost:',
        basisLabel: 'Rate basis',
        pricingNote: 'Rates are CNY per 1M tokens — edit',
        pricingNoteTail: 'row config.pricing. A rule is either one blended { rate } or a split { cacheMiss, cacheHit, output }.',
        coverage: 'sessions',
        callCount: 'calls',
        scanTime: 'scan',
        hour: 'hour',
      },
      zh: {
        nav: '用量统计',
        title: '用量统计',
        subtitle: '按时间段统计的 tokens 与估算人民币花费，全部从会话日志汇总。',
        refreshed: '更新于',
        refresh: '刷新',
        loading: '正在读取会话日志…',
        loadingHint: '首次会重放全部历史会话，之后只读变化的那些。',
        retry: '重试',
        empty: '这个时间段没有模型调用记录。',
        tabHours: '今日',
        tabDays7: '近 7 天',
        tabDays30: '近 30 天',
        tabMonths: '全部',
        totalTokens: 'tokens',
        totalCost: '估算花费',
        totalCalls: '调用次数',
        ofCalls: '次',
        output: '输出',
        cacheRead: '缓存命中',
        perBucket: '每个时段',
        breakdown: '按模型',
        breakdownAll: '按模型（全部时间）',
        sep: '、',
        columnModel: '模型',
        columnTokens: 'tokens',
        columnCost: '估算 ¥',
        unpriced: '未配置单价',
        unpricedNote: '未配置单价的供应商只计 tokens、不计金额：',
        basisLabel: '单价依据',
        pricingNote: '单价为「元 / 百万 token」，改',
        pricingNoteTail: '行的 config.pricing；一条规则可以是单一均价 { rate }，也可以是分档 { cacheMiss, cacheHit, output }。',
        coverage: '个会话',
        callCount: '次调用',
        scanTime: '扫描',
        hour: '时',
      },
    }

    /** Active locale id, read live from the locale service (never cached). */
    function readLocaleId(ctx) {
      try {
        const locale = ctx.get('locale')
        const snapshot = typeof locale?.getLocale === 'function' ? locale.getLocale() : undefined
        if (typeof snapshot?.active === 'string' && snapshot.active !== '') return snapshot.active
      } catch {
        // A missing locale service is not an error for this page.
      }
      return 'en'
    }

    function textsFor(localeId) {
      return String(localeId).toLowerCase().startsWith('zh') ? TEXTS.zh : TEXTS.en
    }

    function useTexts(ctx) {
      const [localeId, setLocaleId] = useState(() => readLocaleId(ctx))
      useEffect(() => {
        const locale = ctx.get('locale')
        if (typeof locale?.subscribe !== 'function') return undefined
        setLocaleId(readLocaleId(ctx))
        return locale.subscribe(() => setLocaleId(readLocaleId(ctx)))
      }, [ctx])
      return textsFor(localeId)
    }

    /** Fold one HTTP answer into its envelope value or a readable failure. */
    async function requestStats(signal) {
      const base = new URL('.', typeof document === 'undefined' ? 'http://dsh.internal/' : document.baseURI)
      const url = new URL('usage-stats/api/stats', base)
      const response = await fetch(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tzOffsetMinutes: -new Date().getTimezoneOffset() }),
        credentials: 'same-origin',
        signal,
      })
      const parsed = await response.json().catch(() => null)
      if (!response.ok || parsed === null || parsed.ok !== true) {
        throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
      }
      return parsed.value
    }

    function formatTokens(value) {
      const n = Number.isFinite(value) ? value : 0
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
      if (n >= 1e4) return `${(n / 1e3).toFixed(0)}K`
      return n.toLocaleString()
    }

    function formatCount(value) {
      return Number.isFinite(value) ? value.toLocaleString() : '0'
    }

    function formatMoney(value, texts) {
      if (!Number.isFinite(value) || value <= 0) return '¥0.00'
      if (value < 0.01) return '¥<0.01'
      if (value >= 1000) return `¥${Math.round(value).toLocaleString()}`
      return `¥${value.toFixed(2)}`
    }

    function formatClock(ms) {
      if (!Number.isFinite(ms)) return ''
      const date = new Date(ms)
      return [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join(':')
    }

    function bucketLabel(start, kind) {
      const date = new Date(start)
      if (kind === 'hour') return `${String(date.getHours()).padStart(2, '0')}`
      if (kind === 'month') return `${String(date.getFullYear()).slice(2)}/${date.getMonth() + 1}`
      return `${date.getMonth() + 1}/${date.getDate()}`
    }

    function bucketTitle(bucket, kind, texts) {
      const start = new Date(bucket.start)
      const end = new Date(bucket.end)
      const pad = (n) => String(n).padStart(2, '0')
      const range =
        kind === 'hour'
          ? `${pad(start.getHours())}:00–${pad(end.getHours())}:00`
          : kind === 'month'
            ? `${start.getFullYear()}-${pad(start.getMonth() + 1)}`
            : `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`
      return [
        range,
        `${formatTokens(bucket.tokens)} tokens`,
        `${formatMoney(bucket.cost, texts)}${bucket.costCalls === 0 ? ' (—)' : ''}`,
        `${formatCount(bucket.calls)} ${texts.ofCalls}`,
        `in ${formatTokens(bucket.input)} · out ${formatTokens(bucket.output)} · ${texts.cacheRead} ${formatTokens(bucket.cacheRead)}`,
      ].join('\n')
    }

    const CSS = `
.dsh-us-root { display:flex; flex-direction:column; gap:20px; padding:4px 2px 28px; color:var(--dsw-alias-label-primary,#1f2328); font-size:13px; line-height:1.5; }
.dsh-us-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
.dsh-us-title { margin:0; font-size:17px; font-weight:600; letter-spacing:.01em; }
.dsh-us-sub { margin:4px 0 0; color:var(--dsw-alias-label-secondary,#6b7280); font-size:12px; max-width:52ch; }
.dsh-us-actions { display:flex; align-items:center; gap:10px; flex:none; }
.dsh-us-stamp { color:var(--dsw-alias-label-secondary,#6b7280); font-size:11px; font-variant-numeric:tabular-nums; }
.dsh-us-btn { appearance:none; border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16)); background:var(--dsw-alias-bg-layer-1,transparent); color:inherit; font:inherit; font-size:12px; padding:5px 11px; border-radius:8px; cursor:pointer; transition:background .15s ease,border-color .15s ease; }
.dsh-us-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04)); }
.dsh-us-btn:disabled { opacity:.55; cursor:default; }
.dsh-us-tabs { display:inline-flex; padding:3px; gap:2px; border-radius:10px; background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04)); align-self:flex-start; }
.dsh-us-tab { appearance:none; border:0; background:transparent; color:var(--dsw-alias-label-secondary,#6b7280); font:inherit; font-size:12px; padding:5px 12px; border-radius:8px; cursor:pointer; }
.dsh-us-tab[data-active="true"] { background:var(--dsw-alias-bg-base,#fff); color:var(--dsw-alias-label-primary,#111); box-shadow:0 1px 2px rgba(0,0,0,.10); font-weight:600; }
.dsh-us-cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
.dsh-us-card { border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08)); border-radius:12px; background:var(--dsw-alias-bg-layer-1,#fff); padding:12px 14px; min-width:0; }
.dsh-us-card-label { color:var(--dsw-alias-label-secondary,#6b7280); font-size:11px; letter-spacing:.02em; }
.dsh-us-card-value { font-size:20px; font-weight:600; margin-top:3px; font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-us-card-hint { color:var(--dsw-alias-label-secondary,#6b7280); font-size:11px; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-us-section { border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08)); border-radius:12px; background:var(--dsw-alias-bg-layer-1,#fff); padding:14px; }
.dsh-us-section-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:10px; }
.dsh-us-section-title { font-size:12px; font-weight:600; }
.dsh-us-legend { display:flex; gap:12px; color:var(--dsw-alias-label-secondary,#6b7280); font-size:11px; }
.dsh-us-legend i { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:5px; vertical-align:1px; }
.dsh-us-chart { display:flex; flex-direction:column; }
.dsh-us-cols { display:grid; gap:2px; align-items:end; height:104px; }
.dsh-us-col { display:flex; flex-direction:column; justify-content:flex-end; gap:2px; height:100%; min-width:0; }
.dsh-us-col:hover .dsh-us-bar { filter:brightness(1.12); }
.dsh-us-bar { width:100%; border-radius:2px 2px 1px 1px; min-height:0; }
.dsh-us-bar-tokens { background:var(--dsw-alias-brand-primary,#3b82f6); }
.dsh-us-bar-cost { background:var(--dsw-alias-state-success-primary,#10b981); opacity:.85; }
.dsh-us-axis { display:grid; gap:2px; margin-top:6px; color:var(--dsw-alias-label-secondary,#6b7280); font-size:10px; font-variant-numeric:tabular-nums; }
.dsh-us-axis span { text-align:center; overflow:hidden; white-space:nowrap; }
.dsh-us-models { display:flex; flex-direction:column; gap:6px; }
.dsh-us-row { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:10px; align-items:baseline; padding:4px 0; border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06)); font-variant-numeric:tabular-nums; }
.dsh-us-row:first-child { border-top:0; }
.dsh-us-row-head { color:var(--dsw-alias-label-secondary,#6b7280); font-size:11px; border-top:0; padding-bottom:0; }
.dsh-us-model { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-us-model-tag { color:var(--dsw-alias-label-secondary,#6b7280); font-size:11px; margin-left:6px; }
.dsh-us-note { color:var(--dsw-alias-label-secondary,#6b7280); font-size:11px; }
.dsh-us-note code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10.5px; padding:1px 4px; border-radius:4px; background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05)); }
.dsh-us-state { border:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.12)); border-radius:12px; padding:22px 16px; text-align:center; color:var(--dsw-alias-label-secondary,#6b7280); font-size:12px; }
.dsh-us-error { color:var(--dsw-alias-state-error-primary,#dc2626); }
`

    function Chart({ view, texts }) {
      const buckets = view?.buckets ?? []
      const maxTokens = buckets.reduce((max, bucket) => Math.max(max, bucket.tokens), 0)
      const maxCost = buckets.reduce((max, bucket) => Math.max(max, bucket.cost), 0)
      const stride = Math.max(1, Math.ceil(buckets.length / 8))
      const columns = { gridTemplateColumns: `repeat(${Math.max(buckets.length, 1)}, minmax(0, 1fr))` }

      return h(
        'div',
        { className: 'dsh-us-chart' },
        h(
          'div',
          { className: 'dsh-us-cols', style: columns },
          buckets.map((bucket, index) => {
            const tokenPx = maxTokens === 0 ? 0 : Math.round((bucket.tokens / maxTokens) * 74)
            const costPx = maxCost === 0 ? 0 : Math.round((bucket.cost / maxCost) * 20)
            return h(
              'div',
              { className: 'dsh-us-col', key: `${bucket.start}-${index}`, title: bucketTitle(bucket, view.kind, texts) },
              h('div', {
                className: 'dsh-us-bar dsh-us-bar-tokens',
                style: { height: bucket.tokens === 0 ? 0 : `${Math.max(tokenPx, bucket.tokens > 0 ? 2 : 0)}px` },
              }),
              h('div', {
                className: 'dsh-us-bar dsh-us-bar-cost',
                style: { height: bucket.cost === 0 ? 0 : `${Math.max(costPx, bucket.cost > 0 ? 2 : 0)}px` },
              }),
            )
          }),
        ),
        h(
          'div',
          { className: 'dsh-us-axis', style: columns },
          buckets.map((bucket, index) =>
            h(
              'span',
              { key: `${bucket.start}-label-${index}` },
              index % stride === 0 || index === buckets.length - 1 ? bucketLabel(bucket.start, view.kind) : '',
            ),
          ),
        ),
      )
    }

    /**
     * Build the section component for one Client context. `ctx` is closed over
     * rather than read from props: a slot component receives owner props, not
     * the running context.
     */
    function createSection(ctx) {
      function UsageSection() {
        const texts = useTexts(ctx)
      const [range, setRange] = useState('hours')
      const [state, setState] = useState({ status: 'loading', data: null, error: null })
      const [tick, setTick] = useState(0)
      const [pending, setPending] = useState(false)

      useEffect(() => {
        const controller = new AbortController()
        let alive = true
        setState((previous) => ({ status: previous.data === null ? 'loading' : 'ready', data: previous.data, error: null }))
        setPending(true)
        requestStats(controller.signal)
          .then((data) => {
            if (alive) setState({ status: 'ready', data, error: null })
          })
          .catch((error) => {
            if (!alive || controller.signal.aborted) return
            setState((previous) => ({ status: previous.data === null ? 'error' : 'ready', data: previous.data, error }))
          })
          .finally(() => {
            if (alive) setPending(false)
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [tick])

      const data = state.data
      const view = data?.views?.[range] ?? null
      const total = view?.total ?? null
      const tabs = [
        { key: 'hours', label: texts.tabHours },
        { key: 'days7', label: texts.tabDays7 },
        { key: 'days30', label: texts.tabDays30 },
        { key: 'months', label: texts.tabMonths },
      ]
      const models = useMemo(() => (data?.models ?? []).slice(0, 8), [data])
      const onRefresh = useCallback(() => setTick((value) => value + 1), [])

      return h(
        'div',
        { className: 'dsh-us-root' },
        h('style', null, CSS),
        h(
          'header',
          { className: 'dsh-us-head' },
          h(
            'div',
            null,
            h('h2', { className: 'dsh-us-title' }, texts.title),
            h('p', { className: 'dsh-us-sub' }, texts.subtitle),
          ),
          h(
            'div',
            { className: 'dsh-us-actions' },
            data === null
              ? null
              : h(
                  'span',
                  { className: 'dsh-us-stamp' },
                  `${texts.refreshed} ${formatClock(data.generatedAt)}`,
                ),
            h(
              'button',
              { className: 'dsh-us-btn', type: 'button', onClick: onRefresh, disabled: pending },
              texts.refresh,
            ),
          ),
        ),

        h(
          'div',
          { className: 'dsh-us-tabs', role: 'tablist' },
          tabs.map((tab) =>
            h(
              'button',
              {
                key: tab.key,
                type: 'button',
                role: 'tab',
                className: 'dsh-us-tab',
                'data-active': String(range === tab.key),
                'aria-selected': range === tab.key,
                onClick: () => setRange(tab.key),
              },
              tab.label,
            ),
          ),
        ),

        state.status === 'loading'
          ? h(
              'div',
              { className: 'dsh-us-state' },
              h('div', null, texts.loading),
              h('div', { className: 'dsh-us-note', style: { marginTop: 6 } }, texts.loadingHint),
            )
          : state.error !== null && data === null
            ? h(
                'div',
                { className: 'dsh-us-state' },
                h('div', { className: 'dsh-us-error' }, String(state.error.message ?? state.error)),
                h(
                  'button',
                  { className: 'dsh-us-btn', type: 'button', onClick: onRefresh, style: { marginTop: 10 } },
                  texts.retry,
                ),
              )
            : total === null || total.calls === 0
              ? h('div', { className: 'dsh-us-state' }, texts.empty)
              : h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'dsh-us-cards' },
                    h(
                      'div',
                      { className: 'dsh-us-card' },
                      h('div', { className: 'dsh-us-card-label' }, texts.totalTokens),
                      h('div', { className: 'dsh-us-card-value' }, formatTokens(total.tokens)),
                      h(
                        'div',
                        { className: 'dsh-us-card-hint' },
                        `${texts.output} ${formatTokens(total.output)} · ${texts.cacheRead} ${formatTokens(total.cacheRead)}`,
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dsh-us-card' },
                      h('div', { className: 'dsh-us-card-label' }, texts.totalCost),
                      h('div', { className: 'dsh-us-card-value' }, formatMoney(total.cost, texts)),
                      h(
                        'div',
                        { className: 'dsh-us-card-hint' },
                        total.costCalls === 0
                          ? texts.unpriced
                          : `≈ ${formatMoney(total.cost / Math.max(total.costCalls, 1), texts)} / ${texts.ofCalls}`,
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dsh-us-card' },
                      h('div', { className: 'dsh-us-card-label' }, texts.totalCalls),
                      h('div', { className: 'dsh-us-card-value' }, formatCount(total.calls)),
                      h(
                        'div',
                        { className: 'dsh-us-card-hint' },
                        `≈ ${formatTokens(total.tokens / Math.max(total.calls, 1))} / ${texts.ofCalls}`,
                      ),
                    ),
                  ),
                  h(
                    'section',
                    { className: 'dsh-us-section' },
                    h(
                      'div',
                      { className: 'dsh-us-section-head' },
                      h('div', { className: 'dsh-us-section-title' }, `${texts.totalTokens} / ${texts.totalCost}`),
                      h(
                        'div',
                        { className: 'dsh-us-legend' },
                        h('span', null, h('i', { style: { background: 'var(--dsw-alias-brand-primary,#3b82f6)' } }), 'tokens'),
                        h('span', null, h('i', { style: { background: 'var(--dsw-alias-state-success-primary,#10b981)' } }), '¥'),
                      ),
                    ),
                    h(Chart, { view, texts }),
                  ),
                  models.length === 0
                    ? null
                    : h(
                        'section',
                        { className: 'dsh-us-section' },
                        h(
                          'div',
                          { className: 'dsh-us-section-head' },
                          h('div', { className: 'dsh-us-section-title' }, texts.breakdownAll),
                        ),
                        h(
                          'div',
                          { className: 'dsh-us-models' },
                          h(
                            'div',
                            { className: 'dsh-us-row dsh-us-row-head' },
                            h('div', null, texts.columnModel),
                            h('div', null, texts.columnTokens),
                            h('div', null, texts.columnCost),
                          ),
                          models.map((model) =>
                            h(
                              'div',
                              { className: 'dsh-us-row', key: model.key },
                              h(
                                'div',
                                { className: 'dsh-us-model', title: model.key },
                                model.key,
                                model.priced ? null : h('span', { className: 'dsh-us-model-tag' }, `· ${texts.unpriced}`),
                              ),
                              h('div', null, formatTokens(model.tokens)),
                              h('div', null, model.priced ? formatMoney(model.cost, texts) : '—'),
                            ),
                          ),
                        ),
                      ),
                  h(
                    'div',
                    { className: 'dsh-us-note' },
                    (data.unpriced ?? []).length === 0
                      ? null
                      : `${texts.unpricedNote} ${data.unpriced.slice(0, 4).join(texts.sep)}${data.unpriced.length > 4 ? ` +${data.unpriced.length - 4}` : ''}${texts.sep === '、' ? '。' : '.'}`,
                  ),
                  h(
                    'div',
                    { className: 'dsh-us-note' },
                    data.basis === undefined || data.basis === ''
                      ? null
                      : `${texts.basisLabel}：${data.basis}`,
                  ),
                  h(
                    'div',
                    { className: 'dsh-us-note' },
                    `${texts.pricingNote} `,
                    h('code', null, NS),
                    ` ${texts.pricingNoteTail}`,
                  ),
                  h(
                    'div',
                    { className: 'dsh-us-note' },
                    `${data.coverage?.sessions ?? 0} ${texts.coverage} · ${formatCount(data.calls)} ${texts.callCount} · ${texts.scanTime} ${data.scanMs}ms`,
                  ),
                ),
      )
      }

      return UsageSection
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const Section = createSection(ctx)
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'usage-stats',
              order: -9,
              label: () => textsFor(readLocaleId(ctx)).nav,
            },
            Section,
          ),
        )
      },
    }
  },
})
