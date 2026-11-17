# dsh-usage-stats

DeepSeek Harness 插件：在**设置页**里加一个「用量统计」区块，按时间段显示 token 用量与**估算**花费。

> 花费是估算，不是账单。插件把会话日志里每次模型调用的 `usage` 折成时段桶，再乘你在配置里填的单价。
> 想要接近真实账单，请用自己账单反推单价后填进 `config.pricing`（见下文）。

---

# 第一部分：给人看

## 它显示什么

- **四个时间段**：今日（按小时）、近 7 天（按天）、近 30 天（按天）、全部（按月）
- **每个桶里**：输入 / 输出 / 缓存读 / 缓存写 tokens，以及估算金额（¥）
- **按模型明细**：每个 `provider/model` 的合计（全部时间）
- **未配置单价的模型**会单独列出来，只计 tokens 不算钱 —— 页面会把它们列在下面提醒你

## 安装

1. 把整个目录放进 Harness profile 的 `node_modules/` 下，目录名 `dsh-usage-stats`
2. 在 profile 的 Cordis 配置里应用 `cordis.patch.yml`（它只插入一行 Host 配置）
3. 重启 / 重载 Harness，打开 **设置 → 用量统计**

> 依赖 Harness 的「设置页扩展」与「同源自定义路由」两个能力。Host 半边读会话日志，
> Client 半边只做渲染；不需要额外服务、不写任何文件、不联网。

## 配置单价（关键一步）

打开 `cordis.patch.yml`，改 `usage-stats` 这一行的 `config.pricing`。单位是 **元 / 百万 token**。

两种写法：

```yaml
pricing:
  # ① 混合均价：所有 token 一个价（账单只给「总金额 ÷ 总 tokens」时用这个）
  'my-provider/*':
    rate: 1.23

  # ② 分档价：你手上有 cache / 输出 的拆分时用
  'my-provider/big-model':
    cacheMiss: 15
    cacheHit: 1.5
    output: 75
```

匹配顺序：`provider/model` → `provider/*` → `*`。
分档形状下 **cacheWrite 计入 cacheMiss**。

**怎么反推单价**：拿一次账单，`金额 ÷ tokens × 1,000,000`。
如果账单只有一个总数，就用混合均价；同一 provider 内不同模型价格差很多时，
建议拆成 `provider/model` 逐条填。

`basis` 是页脚展示的一句说明，写成你这次的依据就行（例如「2026-11 账单反推」）。

## 已知限制

- 估算按「单价 × tokens」算；同一 provider 内缓存命中率波动大时会有偏差
- 只统计 `assistant/message` 里记录的调用；日志被重写覆盖的调用仍计入（钱确实花了）
- 只统计**这台机器这份 Harness** 的用量；同账号在别处消费不会出现在这里
- 时区按浏览器当前 UTC 偏移分桶；换时区后历史桶会按新偏移重算
- 首次打开要重放全部历史会话（约 1–5 秒，取决于日志体积），之后只重放变化过的会话

## 许可

个人自用插件，未附许可证文件。要用请自行判断。

---

# 第二部分：给 agent 看

> 这一节是给自动化 agent / 未来的维护者看的：契约、不变量、易错点。

## 文件地图

| 文件 | 角色 |
| --- | --- |
| `index.js` | **Host 半边**：注册同源路由、扫描会话日志、折叠成时段桶、算钱 |
| `client.js` | **Client 半边**：设置页区块组件，`fetch` 同源路由并渲染 |
| `cordis.patch.yml` | 唯一一行 Host 配置插入（`id: usage-stats`），含 `pricing` / `basis` |
| `locale/en.json`、`locale/zh.json` | 文案；键名两边必须对称 |
| `icon.svg` | 设置页图标 |
| `package.json` | `exports` 映射与 `dsh.bundle` / `dsh.client` 声明 |

## 数据通路（必须保持）

```
Client (设置页)  --POST /usage-stats/api/stats-->  Host (index.js)
                                                     ↓ 读 $DSH_HOME/sessions
                                                     ↓ 折叠 assistant/message.usage
                                                     ← 同源 JSON
```

- 只有一条路由：`/usage-stats/api/stats`（`ROUTE_PREFIX` = `/usage-stats/api`）
- Host 侧用 `ctx.connection.requestRejection` 做同源信任栅栏；**不要**去掉
- 请求体上限 `MAX_BODY_BYTES = 64 KiB`
- 不写文件、不联网、不新增存储：统计完全来自会话日志的折叠

## 折叠规则（不变量）

1. 每条 `assistant/message` 的 `usage` 取 `inputTokens` / `outputTokens` /
   `cacheReadTokens` / `cacheWriteTokens`，非有限或负值按 0（`num()`）
2. 模型身份取 `message.source.{provider,model}`，缺失时用 `unknown`
3. **日志重写不退款**：被 surface replace 覆盖的副本仍计入
4. 增量重放依据 `sessionPersistence.stat` 的 revision：没变过的会话跳过
5. 分桶按调用方传入的 `tzOffsetMinutes`（浏览器 UTC 偏移），并对越界值钳制
   （`MAX_TZ_MINUTES = 840`）
6. 花费 = `tokens / 1e6 × rate`；分档形状下 cacheWrite 归入 cacheMiss
7. 没有匹配规则的模型：计 tokens，**不计钱**，并在响应里列出，供页面提示

## 配置 schema（`config`）

```ts
{
  basis?: string,                          // 页脚说明，纯文本
  pricing?: {
    [pattern: string]:                    // 'provider/model' | 'provider/*' | '*'
      | { rate: number }                  // 混合均价，元/百万 token
      | { cacheMiss: number, cacheHit: number, output: number }
  }
}
```

匹配优先级：精确 `provider/model` → `provider/*` → `*`。
`DEFAULT_PRICING` 里的值是**占位符**，只为开箱能跑；不要把它当成真实价格。

## 改动时容易踩的坑

- **locale 键必须对称**：只加 `zh.json` 的键会让 `en` 语言下显示原始键名
- **不要改路由前缀**：`client.js` 里 `new URL('usage-stats/api/stats', base)` 是相对路径，
  改一边就会 404
- **`document` 可能不存在**：`client.js` 用 `typeof document === 'undefined'` 兜底，
  这样同一份代码能在非浏览器环境里被引用（保持这个判断）
- **首次扫描的性能**：全量重放是 O(会话数 × 事件数)，别在里面加同步 IO
- **金额精度**：全程用 number，展示时再格式化；不要在中间步骤四舍五入

## 自检思路

没有打包独立的测试脚本（历史脚本含本机绝对路径，已移除）。改动后建议：

1. 用真实 `$DSH_HOME/sessions` 跑一遍折叠，断言：总 tokens 与逐桶求和一致；
2. 给 Client 组件喂一份构造的响应，检查文本里没有 `undefined` / `NaN`、金额带 `¥`；
3. 换一个 `pricing` 规则（改 `cordis.patch.yml`）后重载，确认「未配置单价」列表相应变化。
