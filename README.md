# dsh-usage-stats

DeepSeek Harness 插件：在**设置页**里加一个「用量统计」区块，按时间段显示 token 用量与**估算**花费。

> 花费是估算，不是账单。插件把会话日志里每次模型调用的 `usage` 折成时段桶，再按四层价格解析链算钱：
> 你的覆盖 → 内置参考价 → **中转站自报价** → 只计 tokens。
> 每个模型旁边会标出这个价格是**哪来的**（参考价 / 网关价 / 未配置）。

---

# 第一部分：给人看

## 它显示什么

- **四个时间段**：今日（按小时）、近 7 天（按天）、近 30 天（按天）、全部（按月）
- **每个桶里**：输入 / 输出 / 缓存读 / 缓存写 tokens，以及估算金额（¥）
- **按模型明细**：每个 `provider/model` 的合计，带价格来源标签
- **未定价的模型**单独列出，只计 tokens，页面底部提示

## 装完之后基本不用配

如果你用的是常见模型（DeepSeek / Claude / GPT / Gemini 系列），**开箱就会自动匹配价格**——
中转站把 provider 名字改成什么样都不影响，插件会把模型名归一化后再查表：

```
fluxtoken/claude-3-5-sonnet-20241022  →  claude-3-5-sonnet  →  按 Sonnet 参考价
anyproxy/openai/gpt-4o-mini[128k]     →  gpt-4o-mini        →  按 4o-mini 参考价
xx-api/deepseek-v3:free               →  deepseek-v3:free   →  按 DeepSeek 价
```

## 让插件直接问中转站要价格（推荐）

多数中转站自己就公布价格。在 `cordis.patch.yml` 里加一条：

```yaml
config:
  gateways:
    - provider: 'my-relay'                    # 必须等于日志里的 message.source.provider
      baseUrl: 'https://relay.example.com'
      kind: 'openrouter'                      # 或 'oneapi'
      # apiKey: 'sk-...'                      # 站点允许匿名读 /models 就不用填
```

- `kind: openrouter` → 读 `/v1/models` 里的 `pricing.prompt/completion`（USD/token）
- `kind: oneapi` → 读 `/api/pricing` 或 `/api/models` 里的 `model_ratio`（one-api / new-api 家族）

抓到后**缓存 12 小时**（`gatewayTtlMinutes` 可改）。站点不给价格、返回 404、断网，都只会退回上一层，
不影响统计本身。

## 手动覆盖（想钉死某个价格时）

```yaml
pricing:
  'my-relay/*':
    rate: 2.5                    # 混合均价，元 / 百万 token
  'my-relay/big-model':
    cacheMiss: 15                # 分档价
    cacheHit: 1.5
    output: 75
```

匹配顺序：`provider/model` → `provider/*` → `*`。**覆盖 > 参考价 > 网关价**。
分档形状下 cacheWrite 计入 cacheMiss。

**怎么反推单价**：`账单金额 ÷ tokens × 1,000,000`。账单只给总数时就用混合均价。

## 页面上的价格来源

| 标签 | 含义 |
| --- | --- |
| 参考价 | 内置表的公开标价（按 `usdToCny` 换算，会过期） |
| 网关价 | 中转站自己公布的价 |
| 手动覆盖 | 你在 `pricing` 里写的 |
| 未配置单价 | 三样都没命中，只计 tokens |

内置表**明确是近似值**：公开标价会变，汇率也会变（`usdToCny` 默认 7.2）。
要精确就把覆盖写上——覆盖永远优先。

## 已知限制

- 估算按「单价 × tokens」算；同一 provider 内缓存命中率波动大时会有偏差
- 只统计 `assistant/message` 里记录的调用；日志被重写覆盖的调用仍计入（钱确实花了）
- 只统计**这台机器这份 Harness** 的用量；同账号在别处消费不会出现在这里
- 未识别的模型名（各站自定义别名）只会落到「未配置单价」
- 首次打开要重放全部历史会话（约 1–5 秒），之后只重放变化过的会话

## 许可

个人自用插件，未附许可证文件。要用请自行判断。

---

# 第二部分：给 agent 看

> 契约、不变量、易错点。改代码前先读这一节。

## 文件地图

| 文件 | 角色 |
| --- | --- |
| `index.js` | **Host**：同源路由、扫描会话日志、折叠时段桶、**四层价格解析**、L2 抓取 |
| `client.js` | **Client**：设置页组件，`fetch` 同源路由并渲染（含价格来源标签） |
| `cordis.patch.yml` | 唯一一行 Host 配置插入（`id: usage-stats`） |
| `locale/{en,zh}.json` | 设置页条目的标题/描述；UI 文案内联在 `client.js` 的 `texts` |
| `icon.svg` | 设置页图标 |
| `package.json` | `exports` 映射与 `dsh.bundle` / `dsh.client` 声明 |

## 数据通路

```
Client --POST /usage-stats/api/stats--> Host
                                         ├─ 读 $DSH_HOME/sessions
                                         ├─ 折叠 assistant/message.usage
                                         ├─ 解析价格（L0 → L1 → L2）
                                         └─ 同源 JSON（含每个模型的 priceSource）
```

- 唯一路由：`/usage-stats/api/stats`（`ROUTE_PREFIX = /usage-stats/api`）
- `ctx.connection.requestRejection` 是同源信任栅栏，**不能去掉**
- 请求体上限 `MAX_BODY_BYTES = 64 KiB`
- 不写文件；唯一的对外请求是 L2 抓网关价目（每个 provider 每 TTL 一次）

## 价格解析链（顺序不可换）

| 层 | 函数 | 命中条件 | `priceSource` |
| --- | --- | --- | --- |
| L0 | `resolvePrice(settings.pricing, key)` | 精确键 → `provider/*` → `*` | `override` |
| L1 | `officialPriceOf(canonicalModel(key), usdToCny)` | 内置表正则命中 | `official` |
| L2 | `gatewayCache.get(provider)` → `get(canonical)` → `get('*')` | 网关之前抓到过 | `gateway` |
| L3 | — | 都没命中 | `none` |

- `autoOfficial: false` 可关掉 L1（只想用覆盖和网关价时）
- L2 只对**同一个 provider** 生效：`provider` 取 `key` 第一个 `/` 之前的部分
- L2 失败**不抛错**，保留上一次结果；`fetchGatewayPrices` 内部吞掉所有异常

## 名称归一化（`canonicalModel`）

顺序：去 `provider/` 前缀 → 去模型名自带的 vendor 前缀 → 去 `-20241022` / `-2024-10-22` →
去 `[128k]` / `[1m]` → 去 `-latest|preview|beta|free|vN` → `_`→`-`。

⚠️ **改这里等于改所有价格命中**：新增规则要让 `claude-3-5-sonnet` 这类常见写法仍然落到
`claude.*sonnet` 正则上。改完用「归一化自测」一节的方法跑一遍。

## 单价与换算

- 内置表 `OFFICIAL_TABLE` 用 **USD/1M**（`{in, out}`），`fromUsd()` 换算成
  `{cacheMiss, cacheHit: in×0.25, output}` 的 CNY 规则；`cacheHit` 取输入价 1/4 是**近似**
- one-api：`quota = tokens × model_ratio × group_ratio`，`USD 1 = 500000 quota`
  → `USD/1M = ratio × group × 2`；`completion_ratio` 拆输出价
- OpenRouter：`pricing.prompt/completion` 是 **USD per token**，×1e6 后再换算
- 覆盖里的 `{ rate }` 始终是「元 / 百万 token」，对所有 token 一价

## 配置 schema

```ts
{
  basis?: string,                 // 页脚说明
  autoOfficial?: boolean,         // 默认 true，关掉就只剩 L0/L2
  usdToCny?: number,              // 默认 7.2
  gatewayTtlMinutes?: number,     // 默认 720（12h）
  gateways?: Array<{
    provider: string,             // 必须等于 message.source.provider
    baseUrl: string,
    kind: 'openrouter' | 'oneapi',
    apiKey?: string,              // 仅供读价目，不会写进日志
  }>,
  pricing?: { [pattern: string]: { rate: number } | { cacheMiss: number, cacheHit: number, output: number } }
}
```

## 改动时容易踩的坑

- **`DEFAULT_PRICING` 不要放 `'*'`**：会盖住 L1/L2。默认是空对象
- **locale 键要对称**：`en` / `zh` 少一个键会显示原始键名；UI 文案在 `client.js` 的 `texts`
- **不要改路由前缀**：`client.js` 用相对路径 `new URL('usage-stats/api/stats', base)`
- **`document` 可能不存在**：`client.js` 里 `typeof document === 'undefined'` 的兜底要保留
- **`priceSource` 必须回传**：Client 用它决定显示哪个标签
- **L2 不要串 provider**：网关价只对配置里的那个 provider 生效
- **首次扫描性能**：全量重放 O(会话数 × 事件数)，别在里面加同步 IO 或网络请求

## 归一化自测（不需要启动 Harness）

```powershell
$env:ELECTRON_RUN_AS_NODE=1
# 复制 index.js 并追加导出：
#   export { canonicalModel, resolveRowPrice, buildViews }
& "…\DeepSeek Harness.exe" run.mjs
```

断言三件事：
1. `canonicalModel('fluxtoken/claude-3-5-sonnet-20241022') === 'claude-3-5-sonnet'`
2. 空 `pricing` + `autoOfficial: true` 时，`relay/claude-opus-4-8` 解析为 `official`
3. 配了网关价后，未识别模型解析为 `gateway`；不配则 `none`
