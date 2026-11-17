# dsh-usage-stats

用量统计：设置页里新增一个「用量统计」区块，按时间段显示 tokens 与估算人民币花费。

## 它做什么

- 主机侧扫描全部会话日志，把每条 `assistant/message` 上的 `usage`
  （`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`）
  连同 `message.source.{provider,model}` 折成时段桶。
- 四个视图：今日（按小时）、近 7 天（按天）、近 30 天（按天）、全部（按月）。
- 花费是**估算**：按 `config.pricing` 的单价乘出来。没有匹配单价的模型只计 tokens，
  页面会列出「未配置单价」的供应商。
- 首次扫描会重放全部历史会话（几秒）；之后按 `sessionPersistence.stat` 的 revision
  跳过没变过的会话，只重放变化的那些。

## 数据通路

Host 半边注册一条同源 JSON 路由（`POST /usage-stats/api/stats`，带
`ctx.connection.requestRejection` 信任栅栏），Client 半边从页面同源 `fetch` 它，
不经过任何第三方服务，也不写任何文件。

## 配置

单价单位是「元 / 百万 token」，改 `cordis.patch.yml` 里 `usage-stats` 行的
`config.pricing`。一条规则有两种形状：

```yaml
- id: usage-stats
  name: 'dsh-usage-stats'
  config:
    basis: '2026-10 账单反推'      # 页脚展示的「单价依据」，纯文本
    pricing:
      'deepseek-account/*':        # provider 通配
        rate: 0.1171               # ① 单一均价：所有 token 一个价
      'fluxtoken/claude-opus-5-5': # 精确到 provider/model
        rate: 1.7056
      'fluxtoken/claude-opus-4-8':
        cacheMiss: 15              # ② 分档价：你手上有 cache/输出 拆分时用
        cacheHit: 1.5
        output: 75
```

匹配顺序：`provider/model` → `provider/*` → `*`。分档形状下 `cacheWrite` 计入 `cacheMiss`。

**默认单价不是官方价，是从你自己的账单反推的混合均价**（因为账单只给「总金额 ÷ 总
tokens」，不给 cache/输出拆分）：

| provider | 依据 | 反推单价 |
| --- | --- | --- |
| `deepseek-account/*` | ¥240.56 ÷ 2,054,704,056 tokens（2026-10） | **0.1171** |
| `fluxtoken/claude-opus-4-8` | ¥29.57 ÷ 5.63M | 5.2527 |
| `fluxtoken/claude-opus-5-5` | ¥7.30 ÷ 4.28M | 1.7056 |
| `fluxtoken/claude-sonnet-4-6` | ¥2.12 ÷ 2.61M | 0.8122 |
| `fluxtoken/claude-sonnet-5-5` | ¥0.580 ÷ 875.88K | 0.6622 |
| `fluxtoken/claude-fable-5-1` | ¥0.438 ÷ 95.54K | 4.584 |
| `fluxtoken/*`（兜底） | ¥41.0751 ÷ 13.88M | 2.9587 |
| `openai/*`（兜底） | `gpt-6-astra`：¥0.281 ÷ 85.67K | 3.28 |

账单换了就改这张表，或把 `basis` 改成人话说明新依据。

## 为什么不直接抓两家面板的接口

两条路都试过了，都不通：

- **FluxToken**：面板端点是真的（`/api/v1/usage/dashboard/{stats,trend,models}`），
  但它认浏览器 `localStorage.auth_token`（JWT）。用 `FLUXTOKEN_API_KEY`（`sk-…`）
  请求返回 `401 INVALID_TOKEN`；OpenAI 兼容的 `/v1/dashboard/billing/*` 是 404。
  不想为此把长期 JWT 存进本地。
- **DeepSeek Platform**：`platform.deepseek.com` 对非浏览器请求直接
  「Request Blocked」；DSH 只托管了「余额」这一个官方能力，没有账单接口。

要做「真账单」只剩两条路，需要你点头：

1. **余额账本**：定时采样账户余额（`deepseekAccount.getBalance`），存本地小账本，
   按天算真实花费（充值当成余额上升自动排除）。只覆盖 deepseek-account，FluxToken
   没有余额接口。
2. **一次性抓取**：你从浏览器 DevTools 复制一次 FluxToken 的 Bearer token，
   我把真实日账单拉下来落成静态基准。token 过期后需要重贴。

## 已知限制

- 估算按「均价 × tokens」算；同一 provider 内 cache 命中率变化大时会有偏差
  （FluxToken 的 opus-4-8 ¥5.25/M 与 sonnet-4-6 ¥0.81/M 差 6 倍，就是缓存比例不同）。
- 只统计 `assistant/message` 记录的调用；被日志重写（surface replace）覆盖的调用仍计入，
  因为钱确实花掉了。
- 日志只是这台机器这台 Harness 的用量；同一账号在别处（其它工具/机器）的消费不在这里，
  所以「全部」不会等于平台账单的累计值。
- 时区按浏览器自己的 UTC 偏移分桶，跨时区旅行后历史桶会跟着偏移重算。
- 首次打开要重放全部历史会话（约 1–5 秒，取决于日志体积），页面会显示「正在读取会话日志」；
  之后只重放 revision 变过的会话。重启应用后的第一次同样会慢一次。
- 「按模型」那张表是**全部时间**的合计，不随上面的时段切换。

## 自检

改完代码后可以离线跑一遍（不依赖正在运行的 Harness）：

```powershell
$env:ELECTRON_RUN_AS_NODE=1
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" scripts\verify.mjs
```

它会用 `$DSH_HOME/sessions` 里的真实日志跑一遍 Host 折叠，再把结果喂给 Client 组件渲染，
最后检查屏幕文本里有没有 `undefined` / `NaN` / 缺 `¥`。需要带 zstd 的 Node（22.15+ / 24）。
