# 域名比价模块

自建的注册商报价聚合层。所有 adapter 输出统一结构，上层不关心数据来源。

```
types.ts      统一报价模型 RegistrarQuote + 通用工具
porkbun.ts    Porkbun adapter
compare.ts    多注册商并发聚合与排序（直连，不落库）
store.ts      本地价格缓存（node:sqlite）
refresh.ts    刷新调度：节流、退避、限流避让
```

## 快速验证

```bash
# 无密钥：走 Porkbun 官方 mock 端点，验证链路与字段映射
node --import tsx scripts/price-check.ts example.com

# 缓存：刷新 → 查看 → 统计
node --import tsx scripts/price-cache.ts refresh example.com
node --import tsx scripts/price-cache.ts show example.com
node --import tsx scripts/price-cache.ts stats

# 有密钥：走真实端点
PORKBUN_API_KEY=... PORKBUN_SECRET_KEY=... node --import tsx scripts/price-cache.ts refresh example.com

# 测试
node --import tsx --test tests/pricing*.test.ts
```

## 为什么必须缓存

Porkbun 限流「10 秒内最多 10 次」，Cloudflare 的 Check 更是直连注册局。
用户每次查询都实时打各家 API 会立刻撞限流，因此架构是：

```
定时任务（refresh --stale） → 拉取 → 落库 → 用户查询命中缓存
                                              ↓ 未命中才实时补一次
```

**不要**在请求路径上直接调 `comparePrices`，除非确认缓存未命中。

## 三个关键设计决策

### 1. 首年价与续费价分开存储

许多注册商以极低首年价引流（`.com` 首年 $0.99、续费 $29）。
**只展示首年价会误导用户**，所以 `register` 与 `renew` 是两个独立字段，
且排序用续费价。

`PriceQuote.onSale` 标记促销：优先采用注册商的显式标记
（Porkbun 的 `firstYearPromo`），缺失时由「实际价 vs 标准价」的差值推断。

### 2. 无法解析的价格返回 `null`，绝不返回 `0`

`parsePrice('string')` → `null`，而不是 `0`。
`0` 会被下游误读为「免费」，而 `null` 表示「未知」，语义上安全。

### 3. 单个注册商失败不影响整体

`comparePrices` 用 `Promise.allSettled`：某家超时或报错时，
错误进 `errors` 数组，其余报价照常返回。单家超时默认 10 秒。

## 存储层

用 **`node:sqlite`**（Node 22+ 内置），不引入 `better-sqlite3` 等原生模块，
避免 Windows 编译工具链依赖与二进制分发问题。

两张表：
- `quotes` —— 以 `(registrar, domain)` 为主键的报价快照
- `price_history` —— 仅在价格变动时追加，用于「涨价/降价」提示与异常排查

过期判定用 `>=` 而非 `>`：写入与读取可能落在同一毫秒，
用 `>` 会让 `ttlMs=0` 的数据被误判为新鲜，导致刷新任务永远跳过它。

## 刷新调度

`refresh.ts` 替用户挡住限流：

- **串行出队**，两次请求间强制间隔（默认 1.1 秒，为 Porkbun 10 秒 10 次留余量）
- **指数退避**重试（1s → 2s → 4s），单域名上限 3 次
- **命中 429 时**读取 `Retry-After`，暂停整个队列
- **超时中断**，默认 10 秒

并发是无效的：各家限流都按时间窗口计，并发只会更容易触发。

## 接入新注册商

实现 `RegistrarAdapter` 即可：

```ts
export class CloudflareAdapter implements RegistrarAdapter {
  readonly id = 'cloudflare'
  readonly name = 'Cloudflare'
  async fetchQuote(domain, options) {
    // ... 请求并映射到 RegistrarQuote
  }
}
```

映射时注意：
- 币种统一为 USD（保留原值以便追溯）
- 溢价域名必须设置 `premium: true`，否则比价结果无意义
- ICANN 费、隐私保护费等隐性费用应计入总价

## Porkbun 接口要点

- 端点：`POST /domain/checkDomain/{domain}`，批量 `POST /domain/checkDomain`（最多 25 个）
- 认证：`X-API-Key` / `X-Secret-API-Key` 请求头
- **限流：10 秒内最多 10 次**（响应 `limits.naturalLanguage` 会告知用量）
- sandbox key 以 `pk1_sb_` 开头，走隔离环境、不产生真实扣费
- 未配置密钥时 adapter 自动回落到 `/mock/` 端点，返回结构一致的示例数据

`source` 字段会标明本次数据来自 `live` / `sandbox` / `mock`，
避免把示例数据误当成真实价格。

> mock 端点返回的是 schema 示例，`additional.renewal/transfer` 的 price 是
> 字面量 `"string"`，因此显示为 `—`。这是预期行为，不是 bug。

## 已知限制

- 目前只有 Porkbun 一家 adapter
- 未处理汇率：假设所有注册商均以 USD 计价
- 缓存无自动清理：`price_history` 会持续增长，长期运行需加保留策略
- 单进程实现：多实例部署时缓存不共享，需换成共享存储
