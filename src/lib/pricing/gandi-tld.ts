/**
 * 文件：src/lib/pricing/gandi-tld.ts
 * 用途：Gandi 的**逐后缀**价目抓取（补 Porkbun 未收录的国别后缀）
 *
 * ## 为什么需要这个模块
 *
 * Porkbun 的整表价目覆盖 910 个后缀，但不卖 `.al` / `.im` 等。
 * Gandi 可抓且价格有竞争力（`.im` 注册 $20.00）。
 *
 * ## 页面结构（实测）
 *
 * Gandi 的后缀页把价格按标签成组渲染，剥掉标签后形如：
 *
 * ```
 * .im domain prices | Registration | $20.00 | per year | For 1 to 2 years
 *                   | Transfer | Free | ...
 *                   | Renewal | $39.98 | per year
 * ```
 *
 * **注意注册价与续费价差别很大**（.im：$20.00 对 $39.98），
 * 所以必须按标签取值，不能用「出现次数最多」这类启发式——
 * 页面上还混有其他扩展名与附加服务的价格（$600.00、$2,00、$6,00 等），
 * 频率法会取错。
 *
 * robots.txt 允许抓取 /en-US/domain/tld/*（仅屏蔽带 query 的内部跳转路径）。
 */

import type { TldPrice, TldPriceSourceAdapter } from './tld-types'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const TIMEOUT_MS = 20_000

/**
 * 已知 Gandi 有售的后缀（863 个）。
 *
 * 来源：Gandi 的 sitemap（`/sitemap_en-US.xml`）列出全部 996 个
 * `/domain/tld/{后缀}` 页面地址，全量扫描后 863 个能解析出价格
 * （其余是 Gandi 实际不售的后缀，如 `.ads` `.af` `.москва`）。
 *
 * 清单在此硬编码而非每次抓 sitemap：
 * 一是刷新时少一次请求，二是清单变化应当是可审查的改动，
 * 而不是某天悄悄变了导致抓取范围漂移。
 * 需要更新时用 `scripts/tld-prices.ts gandi-scan` 重新生成。
 */
const GANDI_TLDS: string[] = [
  'abogado', 'ac', 'academy', 'accountant', 'accountants', 'actor', 'ad', 'adult', 'ae', 'ae.org', 'aero', 'aeroport.fr',
  'africa', 'ag', 'agency', 'ai', 'airforce', 'al', 'alsace', 'am', 'amsterdam', 'apartments', 'app', 'aq',
  'ar', 'archi', 'army', 'art', 'as', 'asia', 'associates', 'at', 'attorney', 'au', 'auction', 'audio',
  'auto', 'autos', 'avocat.fr', 'ax', 'az', 'ba', 'baby', 'band', 'bank', 'bar', 'barcelona', 'bargains',
  'basketball', 'bayern', 'bd', 'be', 'beauty', 'beer', 'berlin', 'best', 'bet', 'bf', 'bg', 'bh',
  'bi', 'bible', 'bid', 'bike', 'bingo', 'bio', 'biz', 'bj', 'black', 'blackfriday', 'blog', 'blue',
  'bm', 'bn', 'bo', 'boats', 'bond', 'boo', 'boston', 'bot', 'boutique', 'br', 'br.com', 'broker',
  'brussels', 'bs', 'bt', 'build', 'builders', 'business', 'buzz', 'bw', 'by', 'bz', 'bzh', 'ca',
  'cab', 'cafe', 'cam', 'camera', 'camp', 'capetown', 'capital', 'car', 'cards', 'care', 'career', 'careers',
  'cars', 'casa', 'case', 'cash', 'casino', 'cat', 'catering', 'cc', 'center', 'ceo', 'cf', 'cfd',
  'cg', 'ch', 'chambagri.fr', 'channel', 'charity', 'chat', 'cheap', 'chirurgiens-dentistes.fr', 'christmas', 'church', 'ci', 'city',
  'ck', 'cl', 'claims', 'cleaning', 'click', 'clinic', 'clothing', 'cloud', 'club', 'cm', 'cn', 'cn.com',
  'co', 'co.com', 'co.jp', 'co.uk', 'coach', 'codes', 'coffee', 'college', 'cologne', 'com', 'com.de', 'community',
  'company', 'compare', 'computer', 'condos', 'construction', 'consulting', 'contact', 'contractors', 'cooking', 'cool', 'coop', 'corsica',
  'country', 'coupons', 'courses', 'cr', 'credit', 'creditcard', 'cricket', 'cruises', 'cu', 'cv', 'cw', 'cx',
  'cy', 'cymru', 'cyou', 'cz', 'dad', 'dance', 'date', 'dating', 'day', 'de', 'de.com', 'deal',
  'dealer', 'deals', 'degree', 'delivery', 'democrat', 'dental', 'dentist', 'desi', 'design', 'dev', 'diamonds', 'diet',
  'digital', 'direct', 'directory', 'discount', 'diy', 'dj', 'dk', 'dm', 'do', 'doctor', 'dog', 'domains',
  'download', 'durban', 'dz', 'earth', 'eat', 'ec', 'eco', 'education', 'ee', 'eg', 'email', 'energy',
  'engineer', 'engineering', 'enterprises', 'equipment', 'es', 'esq', 'estate', 'et', 'eu', 'eu.com', 'eus', 'events',
  'exchange', 'expert', 'experts-comptables.fr', 'exposed', 'express', 'fail', 'faith', 'family', 'fan', 'fans', 'farm', 'fashion',
  'fast', 'feedback', 'fi', 'film', 'finance', 'financial', 'fish', 'fishing', 'fit', 'fitness', 'fj', 'flights',
  'florist', 'flowers', 'fly', 'fm', 'fo', 'foo', 'food', 'football', 'forex', 'forsale', 'forum', 'foundation',
  'fr', 'free', 'frl', 'fun', 'fund', 'furniture', 'futbol', 'fyi', 'ga', 'gal', 'gallery', 'game',
  'games', 'garden', 'gay', 'gb.net', 'gd', 'gdn', 'ge', 'gent', 'geometre-expert.fr', 'gf', 'gg', 'gh',
  'gi', 'gift', 'gifts', 'gives', 'giving', 'gl', 'glass', 'global', 'gm', 'gmbh', 'gn', 'gold',
  'golf', 'gp', 'gq', 'gr', 'gr.com', 'graphics', 'gratis', 'green', 'gripe', 'group', 'gs', 'gt',
  'guide', 'guitars', 'guru', 'gw', 'gy', 'hair', 'hamburg', 'haus', 'health', 'healthcare', 'help', 'here',
  'hiphop', 'hiv', 'hk', 'hm', 'hn', 'hockey', 'holdings', 'holiday', 'homes', 'horse', 'hospital', 'host',
  'hosting', 'hot', 'house', 'how', 'hr', 'ht', 'hu', 'hu.net', 'icu', 'id', 'ie', 'il',
  'im', 'immo', 'immobilien', 'in', 'in.net', 'inc', 'industries', 'info', 'ing', 'ink', 'institute', 'insurance',
  'insure', 'international', 'investments', 'io', 'iq', 'ir', 'irish', 'is', 'ist', 'istanbul', 'it', 'je',
  'jetzt', 'jewelry', 'jm', 'jo', 'jobs', 'joburg', 'jp', 'jp.net', 'jpn.com', 'juegos', 'kaufen', 'ke',
  'kg', 'kh', 'ki', 'kids', 'kim', 'kitchen', 'kiwi', 'kn', 'koeln', 'kr', 'kw', 'ky',
  'kyoto', 'kz', 'la', 'land', 'lat', 'latino', 'law', 'lawyer', 'lb', 'lc', 'lease', 'legal',
  'lgbt', 'li', 'life', 'lifestyle', 'lighting', 'limited', 'limo', 'link', 'live', 'living', 'lk', 'llc',
  'loan', 'loans', 'locker', 'lol', 'london', 'love', 'lr', 'ls', 'lt', 'ltd', 'ltda', 'lu',
  'luxe', 'luxury', 'lv', 'ly', 'ma', 'madrid', 'maison', 'makeup', 'management', 'market', 'marketing', 'markets',
  'mba', 'mc', 'md', 'me', 'me.uk', 'med', 'medecin.fr', 'media', 'melbourne', 'meme', 'memorial', 'men',
  'menu', 'mg', 'miami', 'mk', 'ml', 'mm', 'mn', 'mo', 'mobi', 'mobile', 'moda', 'moe',
  'moi', 'mom', 'money', 'monster', 'mortgage', 'motorcycles', 'mov', 'movie', 'mp', 'mq', 'mr', 'ms',
  'mt', 'mu', 'museum', 'music', 'mw', 'mx', 'my', 'mz', 'na', 'nagoya', 'name', 'navy',
  'nc', 'ne', 'net', 'network', 'new', 'news', 'nexus', 'nf', 'ng', 'ngo', 'ni', 'ninja',
  'nl', 'no', 'notaires.fr', 'now', 'np', 'nr', 'nrw', 'nu', 'nyc', 'nz', 'observer', 'okinawa',
  'om', 'one', 'ong', 'onl', 'online', 'ooo', 'org', 'org.uk', 'organic', 'osaka', 'pa', 'page',
  'paris', 'partners', 'parts', 'party', 'pe', 'pet', 'pf', 'pg', 'ph', 'pharmacien.fr', 'phd', 'phone',
  'photo', 'photography', 'photos', 'pics', 'pictures', 'pink', 'pizza', 'pk', 'pl', 'place', 'plumbing', 'plus',
  'pm', 'pn', 'poker', 'porn', 'port.fr', 'pr', 'press', 'pro', 'productions', 'prof', 'promo', 'properties',
  'property', 'protection', 'ps', 'pt', 'pub', 'pw', 'py', 'qa', 'qpon', 'quebec', 'quest', 'racing',
  'radio', 'radio.am', 'radio.fm', 're', 'realestate', 'realty', 'recipes', 'red', 'rehab', 'reise', 'reisen', 'reit',
  'rent', 'rentals', 'repair', 'report', 'republican', 'rest', 'restaurant', 'review', 'reviews', 'rich', 'rio', 'rip',
  'ro', 'rocks', 'rodeo', 'rs', 'rsvp', 'rugby', 'ruhr', 'run', 'rw', 'ryukyu', 'sa', 'sa.com',
  'saarland', 'sale', 'salon', 'sarl', 'sb', 'sbs', 'sc', 'school', 'schule', 'science', 'scot', 'sd',
  'se', 'se.net', 'security', 'select', 'services', 'sex', 'sexy', 'sg', 'sh', 'shiksha', 'shoes', 'shop',
  'shopping', 'show', 'si', 'singles', 'site', 'sk', 'ski', 'skin', 'sl', 'sm', 'sn', 'so',
  'soccer', 'social', 'software', 'solar', 'solutions', 'soy', 'spa', 'space', 'sport', 'spot', 'sr', 'srl',
  'st', 'storage', 'store', 'stream', 'studio', 'study', 'style', 'sucks', 'supplies', 'supply', 'support', 'surf',
  'surgery', 'sv', 'swiss', 'sx', 'sy', 'sydney', 'systems', 'taipei', 'talk', 'tattoo', 'tax', 'taxi',
  'tc', 'td', 'team', 'tech', 'technology', 'tel', 'tennis', 'tf', 'tg', 'th', 'theater', 'theatre',
  'tickets', 'tienda', 'tips', 'tires', 'tirol', 'tj', 'tk', 'tl', 'tm', 'tn', 'to', 'today',
  'tokyo', 'tools', 'top', 'tours', 'town', 'toys', 'tr', 'trade', 'trading', 'training', 'travel', 'tt',
  'tube', 'tv', 'tw', 'tz', 'ua', 'ug', 'uk', 'uk.com', 'uk.net', 'university', 'uno', 'us',
  'us.com', 'us.org', 'uy', 'uz', 'vacations', 'vana', 'vc', 've', 'vegas', 'ventures', 'vet', 'veterinaire.fr',
  'vg', 'vi', 'viajes', 'video', 'villas', 'vin', 'vip', 'vision', 'vlaanderen', 'vn', 'vodka', 'vote',
  'voting', 'voto', 'voyage', 'vu', 'wales', 'wang', 'watch', 'watches', 'webcam', 'website', 'wedding', 'wf',
  'whoswho', 'wien', 'wiki', 'win', 'wine', 'work', 'works', 'world', 'ws', 'wtf', 'xxx', 'xyz',
  'yachts', 'ye', 'yoga', 'yokohama', 'you', 'yt', 'za', 'za.com', 'zip', 'zm', 'zone', 'zuerich',
  'zw', 'ελ', 'ευ', 'бг', 'бел', 'ею', 'онлайн', 'орг', 'сайт', 'コム', 'みんな', 'ישראל',
  'קום', 'البحرين', 'بارت', 'بازار', 'بھارت', 'ڀارت', 'شبكة', 'भारत', 'भारतम्', 'भारोत', 'संगठन', 'ভারত',
  'ভাৰত', 'ਭਾਰਤ', 'ભારત', 'ଭାରତ', 'இந்தியா', 'భారత్', 'ಭಾರತ', 'ഭാരതം', '八卦', '餐厅', '公司', '购物',
  '机构', '健康', '닷넷', '닷컴', '企业', '商标', '商城', '商店', '世界', '台灣', '网店', '网络',
  '网站', '网址', '我爱你', '香港', '移动', '游戏', '娱乐', '在线', '招聘', '中国', '中文网',
]

/** 后缀 → Gandi 页面路径（路径即后缀本身，保留映射便于将来处理特例） */
function gandiPath(tld: string): string {
  return tld
}

const MONEY = String.raw`\$\s?[\d,]+(?:\.\d{2})?`

/** 从 "$1,234.56" 解析为数字；返回 null 表示无有效价格 */
function money(token: string | undefined): number | null {
  if (!token) return null
  const n = Number.parseFloat(token.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 从 Gandi 后缀页解析价格。
 *
 * 按标签锚定：
 * - `Registration` 后第一个金额 → 注册价
 * - `Renewal` 后第一个金额 → 续费价
 * - `Transfer` 后若是 `Free` 则记 null（免费转入不等于 0 元注册）
 *
 * 若连注册价都取不到，返回 null（宁可没有报价，也不要错误报价）。
 */
export function parseGandiPage(html: string, tld: string, fetchedAt = new Date().toISOString()): TldPrice | null {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\|+/g, '|')
    .replace(/\s+/g, ' ')

  /**
   * 价格表的起点：`<tld> domain prices`。
   *
   * **必须从这里开始找标签**，不能直接 indexOf('Registration')——
   * 页面前面的说明文字里也会出现 "registration"（如
   * "The minimum registration period is one year"），
   * 直接搜标签会命中正文，导致取不到价格。
   */
  const tableStart = (() => {
    // 允许 "domain prices" 前后有标签分隔符（剥标签后可能残留 `|`）
    const m = text.match(/domain prices/i)
    return m ? m.index! + m[0].length : -1
  })()
  if (tableStart === -1) return null

  const tableText = text.slice(tableStart)

  /**
   * 取标签之后的第一个金额。
   *
   * 剥标签后形如 `Registration|$20.00|per year`；标签与金额之间
   * 可能隔着空单元格（`.im` 为 `Transfer|Free`）。
   * 向后取窗口时遇到下一个已知标签即截断，
   * 避免把 Renewal 的价格当成 Registration 的。
   */
  const firstMoneyAfter = (label: string): { value: number | null; free: boolean } => {
    const idx = tableText.toLowerCase().indexOf(label.toLowerCase())
    if (idx === -1) return { value: null, free: false }

    const window = tableText.slice(idx + label.length, idx + label.length + 200)
    const stop = window.search(/Registration|Renewal|Transfer/i)
    const seg = stop === -1 ? window : window.slice(0, stop)

    // "Free" 表示免费转入——不等于 0 元，调用方据此记 null
    if (/^\s*\|?\s*free\b/i.test(seg)) return { value: null, free: true }

    const m = seg.match(new RegExp(MONEY))
    return { value: money(m?.[0]), free: false }
  }

  const reg = firstMoneyAfter('Registration')
  const ren = firstMoneyAfter('Renewal')
  const tra = firstMoneyAfter('Transfer')

  const register = reg.value
  const renew = ren.value
  // 免费转入记 null 而非 0
  const transfer = tra.free ? null : tra.value

  // 连注册价都没有，说明该后缀在 Gandi 无售或页面已改版
  if (register === null) return null

  return {
    tld,
    registrar: 'gandi',
    registrarName: 'Gandi',
    register,
    renew,
    transfer,
    regularRegister: register,
    onSale: false,
    currency: 'USD',
    source: 'crawled',
    website: 'https://www.gandi.net',
    fetchedAt,
  }
}

/**
 * 逐后缀抓取 Gandi。
 *
 * ## 为什么要并发
 *
 * 清单有 863 个后缀。串行抓取（每次一个请求 + 间隔）实测需 **16.6 分钟**，
 * 作为定时任务太慢。改为固定并发度抓取后降到约 1 分钟。
 *
 * 并发度取 4：既明显快于串行，又不会给对方造成突发压力。
 * 注意这是**对单个站点的礼貌抓取**，不是压测——不要贸然调高。
 *
 * ## 失败处理
 *
 * 单后缀失败跳过并记入 `lastErrors`；但**全部**失败时抛错，
 * 避免把「被拦截」伪装成「无报价」。
 */
export class GandiTldSource implements TldPriceSourceAdapter {
  readonly id = 'gandi'
  readonly name = 'Gandi'
  readonly website = 'https://www.gandi.net'

  lastErrors: { tld: string; message: string }[] = []

  async fetchAll(
    options: { signal?: AbortSignal; timeoutMs?: number; tlds?: string[]; delayMs?: number; concurrency?: number } = {},
  ): Promise<TldPrice[]> {
    const tlds = options.tlds ?? GANDI_TLDS
    const { timeoutMs = TIMEOUT_MS, delayMs = 60, concurrency = 4 } = options

    const out: TldPrice[] = []
    const errors: { tld: string; message: string }[] = []
    this.lastErrors = []

    const fetchOne = async (tld: string): Promise<TldPrice | null> => {
      const path = gandiPath(tld)
      if (!path) return null

      const controller = new AbortController()
      const onAbort = () => controller.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const res = await fetch(`https://www.gandi.net/en-US/domain/tld/${encodeURIComponent(path)}`, {
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
          signal: controller.signal,
        })
        if (!res.ok) {
          errors.push({ tld, message: `HTTP ${res.status}` })
          return null
        }
        const price = parseGandiPage(await res.text(), tld)
        if (!price) errors.push({ tld, message: '页面中未找到 Registration 价格' })
        return price
      } catch (error) {
        errors.push({ tld, message: error instanceof Error ? error.message : '抓取失败' })
        return null
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        // 每个请求后小睡，与并发度共同控制速率
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
      }
    }

    // 固定并发度的 worker 池：所有 worker 共享同一个游标
    let cursor = 0
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tlds.length)) }, async () => {
      while (cursor < tlds.length) {
        if (options.signal?.aborted) return
        const tld = tlds[cursor++]
        const price = await fetchOne(tld)
        if (price) out.push(price)
      }
    })
    await Promise.all(workers)

    this.lastErrors = errors

    // 全部失败说明是数据源级故障（被拦截、改版、网络不通），
    // 抛错以便上层保留旧数据并告警，而不是把已有数据清空
    if (out.length === 0 && errors.length > 0) {
      const detail = errors.slice(0, 3).map(e => `.${e.tld}: ${e.message}`).join('；')
      throw new Error(`Gandi 全部后缀抓取失败（${detail}${errors.length > 3 ? ` 等 ${errors.length} 项` : ''}）`)
    }

    return out
  }
}
