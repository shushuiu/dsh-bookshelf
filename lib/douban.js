/**
 * Douban reading data: the wish ("想读") shelf of one Douban member and the
 * subject detail of one book.
 *
 * Everything here is plain HTML scraping with a browser user-agent: Douban's
 * book pages render server-side, so no JavaScript execution is needed. Parsing
 * is deliberately forgiving — a field that changes shape is left missing rather
 * than failing the whole page — because the shelf must stay readable even when
 * Douban adjusts its markup.
 *
 * @module dsh-bookshelf/douban
 */

/** A desktop browser user-agent; Douban answers anonymous HTML pages to this. */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Hard ceiling on how many collection pages one refresh walks. */
const MAX_PAGES = 40;

/**
 * Douban answered with a redirect to its anti-bot verification page (or 403).
 * The caller stops for a while instead of hammering the site.
 */
export class DoubanBlocked extends Error {
  /**
   * @param status - the HTTP status that reported the block.
   */
  constructor(status) {
    super(status === 403
      ? '豆瓣暂时限制了访问（HTTP 403），稍后会自动重试'
      : '豆瓣要求人机验证（HTTP 302），稍后会自动重试');
    this.name = 'DoubanBlocked';
    this.status = status;
  }
}

/**
 * A tiny cookie jar. Douban hands out a `bid` cookie and tightens its
 * anti-crawl checks for clients that never send one back.
 */
const cookieJar = new Map();

/**
 * The Cookie request header for the current jar.
 * @returns the header value, or undefined when the jar is empty.
 */
function cookieHeader() {
  if (cookieJar.size === 0) return undefined;
  return [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Keep whatever cookies a response set.
 * @param response - the response to read.
 */
function absorbCookies(response) {
  const list = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  for (const entry of list) {
    const pair = entry.split(';', 1)[0];
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    cookieJar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

/**
 * Fetch one Douban page as text.
 *
 * Redirects are not followed on purpose: when Douban decides this client is a
 * crawler it answers 302 to `sec.douban.com` instead of the page, and following
 * that would silently parse a verification screen as an empty result.
 *
 * @param url - absolute Douban URL.
 * @param options - request timeout and caller cancellation.
 * @returns the response body.
 * @throws {DoubanBlocked} when Douban refuses the request.
 */
export async function fetchDoubanPage(url, options = {}) {
  const { signal, timeoutMs = 15000 } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const headers = {
    'user-agent': USER_AGENT,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'referer': 'https://book.douban.com/',
  };
  const cookie = cookieHeader();
  if (cookie !== undefined) headers.cookie = cookie;
  const response = await fetch(url, { signal: combined, headers, redirect: 'manual' });
  absorbCookies(response);
  if (response.status === 302 || response.status === 301 || response.status === 403 || response.status === 429) {
    throw new DoubanBlocked(response.status);
  }
  if (!response.ok) throw new Error(`豆瓣返回 HTTP ${response.status}`);
  return await response.text();
}

/**
 * Fetch a binary asset (a cover image) the way a browser on Douban's own site
 * would, which is what the image CDN checks.
 * @param url - absolute image URL.
 * @param options - request timeout and caller cancellation.
 * @returns the raw bytes and their content type.
 */
export async function fetchDoubanImage(url, options = {}) {
  const { signal, timeoutMs = 15000 } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const response = await fetch(url, {
    signal: combined,
    headers: {
      'user-agent': USER_AGENT,
      'accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      // Without a Douban referer the image CDN answers 418 and no bytes.
      'referer': 'https://book.douban.com/',
    },
  });
  if (!response.ok) throw new Error(`封面返回 HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? 'image/jpeg';
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: type };
}

/**
 * Build the collection URL for one page of a member's wish shelf.
 * @param userId - numeric Douban member id.
 * @param start - zero-based row offset.
 * @returns the absolute URL.
 */
export function wishUrl(userId, start, mode = 'grid') {
  const id = encodeURIComponent(String(userId));
  return `https://book.douban.com/people/${id}/wish?start=${start}`
    + `&sort=time&rating=all&filter=all&mode=${mode}`;
}

/**
 * The member's display name, read from the page the wish shelf itself renders.
 * @param html - any page of that member's shelf.
 * @returns the name, or undefined.
 */
export function parseMemberName(html) {
  const title = /<title>\s*([\s\S]*?)\s*<\/title>/.exec(html);
  if (title === null) return undefined;
  const text = decodeEntities(stripTags(title[1])).trim();
  // "皮卡皮卡想读的书(29)" — the name is everything before the suffix.
  const name = text.replace(/想读的书.*$/u, '').trim();
  return name === '' ? undefined : name;
}

/**
 * The total row count the shelf header reports.
 * @param html - one page of the shelf.
 * @returns the total, or undefined when the header is absent.
 */
export function parseWishTotal(html) {
  const match = /<span class="subject-num">\s*\d+\s*-\s*\d+[\s\S]{0,20}?\/[\s\S]{0,10}?(\d+)/.exec(html);
  if (match === null) return undefined;
  const total = Number.parseInt(match[1], 10);
  return Number.isFinite(total) ? total : undefined;
}

/**
 * Parse the rows of one list-view page.
 * @param html - one page of a collection.
 * @returns one entry per row, with the fields that page exposes.
 */
export function parseWishPage(html) {
  const rows = [];
  // Row bodies are sliced between successive row openings rather than matched up
  // to `</li>`, because a row may itself contain a nested list.
  const starts = [...html.matchAll(/<li id="list(\d+)"[^>]*>/g)];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1].index : html.length;
    const body = html.slice(start.index, end);
    const link = /<div class="title">\s*<a href="https?:\/\/book\.douban\.com\/subject\/(\d+)\/?"[^>]*>([\s\S]*?)<\/a>/.exec(body);
    if (link === null) continue;
    const date = /<div class="date">\s*([\d-]+)\s*<\/div>/.exec(body);
    const intro = /<span class="intro">([\s\S]*?)<\/span>/.exec(body);
    const subjectId = link[1];
    if (rows.some((row) => row.subjectId === subjectId)) continue;
    rows.push({
      subjectId,
      title: decodeEntities(stripTags(link[2])).replace(/\s+/g, ' ').trim(),
      url: `https://book.douban.com/subject/${subjectId}/`,
      wishDate: date === null ? undefined : date[1],
      intro: intro === null ? undefined : decodeEntities(stripTags(intro[1])).replace(/\s+/g, ' ').trim(),
    });
  }
  return rows;
}

/**
 * Parse one page of the card ("grid") view, which carries the cover art.
 *
 * Douban's collection markup is not a contract, so each field is optional: a row
 * without a title is dropped, and every other field degrades to `undefined`
 * rather than failing the page.
 *
 * @param html - one page of a collection in grid mode.
 * @returns one entry per card.
 */
export function parseGridPage(html) {
  const rows = [];
  const starts = [...html.matchAll(/<li id="grid\d+"[^>]*>/g)];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1].index : html.length;
    const body = html.slice(start.index, end);
    // A card without a subject link is not a book; inventing an id from the
    // list ordinal would fabricate a shelf entry.
    const subjectId = /<a[^>]*href="(?:https?:\/\/book\.douban\.com)?\/subject\/(\d+)\//.exec(body)?.[1];
    if (subjectId === undefined) continue;
    const image = /<img[^>]*src="([^"]+)"[^>]*>/.exec(body);
    const titleCell = /<div class="title">\s*<a[^>]*>([\s\S]*?)<\/a>/.exec(body);
    const title = titleCell === null
      ? (decodeEntities(/<img[^>]*alt="([^"]*)"[^>]*>/.exec(body)?.[1] ?? '').trim())
      : decodeEntities(stripTags(titleCell[1])).replace(/\s+/g, ' ').trim();
    if (title === '') continue;
    const author = /<div class="author">([\s\S]*?)<\/div>/.exec(body);
    const date = /<div class="date">\s*([\d-]+)/.exec(body);
    const rating = /<span class="rating_nums">\s*([\d.]+)\s*<\/span>/.exec(body);
    rows.push({
      subjectId,
      title,
      url: `https://book.douban.com/subject/${subjectId}/`,
      wishDate: date === null ? undefined : date[1],
      intro: author === null
        ? undefined
        : decodeEntities(stripTags(author[1])).replace(/\s+/g, ' ').trim() || undefined,
      cover: image === null ? undefined : image[1].replace('/view/subject/m/', '/view/subject/l/'),
      rating: rating === null ? undefined : Number.parseFloat(rating[1]),
    });
  }
  return rows;
}

/**
 * Walk a collection's pages and deduplicate the rows.
 * @param userId - numeric Douban member id.
 * @param mode - `grid` for cards with covers, `list` for rows without.
 * @param parse - the parser for that mode.
 * @param options - cancellation plus a cap for very large shelves.
 * @returns the member name, reported total, and rows in shelf order.
 */
async function collectShelf(userId, mode, parse, options) {
  const { signal, maxPages = MAX_PAGES } = options;
  const rows = [];
  const seen = new Set();
  let member;
  let total;
  let start = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const html = await fetchDoubanPage(wishUrl(userId, start, mode), { signal });
    member ??= parseMemberName(html);
    total ??= parseWishTotal(html);
    const parsed = parse(html);
    if (parsed.length === 0) break;
    let added = 0;
    for (const row of parsed) {
      if (seen.has(row.subjectId)) continue;
      seen.add(row.subjectId);
      rows.push(row);
      added += 1;
    }
    // Douban decides how many rows one page carries, so advance by what it
    // actually returned and stop as soon as a page adds nothing new.
    start += parsed.length;
    if (added === 0) break;
    if (total !== undefined && rows.length >= total) break;
  }
  return { member, total: total ?? rows.length, rows };
}

/**
 * Walk every page of a member's wish shelf.
 *
 * The list view is the source of truth: it is what Douban has served for years
 * and it carries the intro line. The card view is read once more (one request
 * per page) purely to pick up cover art, and a failure there degrades to no
 * covers instead of losing the shelf.
 *
 * @param userId - numeric Douban member id.
 * @param options - cancellation plus a cap for very large shelves.
 * @returns the member name, the reported total, every row in shelf order, and
 *   the message of a cover pass that could not finish.
 * @throws {DoubanBlocked} when Douban refuses the shelf itself.
 */
export async function fetchWishShelf(userId, options = {}) {
  const { withCovers = true } = options;
  let shelf = await collectShelf(userId, 'list', parseWishPage, options);
  if (shelf.rows.length === 0) {
    // Douban changed the list markup: the cards are the remaining source.
    shelf = await collectShelf(userId, 'grid', parseGridPage, options);
    return shelf;
  }
  if (!withCovers) return shelf;
  try {
    const cards = await collectShelf(userId, 'grid', parseGridPage, options);
    const byId = new Map(cards.rows.map((row) => [row.subjectId, row]));
    for (const row of shelf.rows) {
      const card = byId.get(row.subjectId);
      if (card === undefined) continue;
      row.cover = card.cover;
      row.rating ??= card.rating;
      row.intro ??= card.intro;
      row.wishDate ??= card.wishDate;
    }
  } catch (error) {
    // Covers are a bonus: a refused or broken card pass must not throw away a
    // shelf the list view already delivered.
    shelf.coverWarning = error instanceof Error ? error.message : String(error);
    if (error instanceof DoubanBlocked) shelf.blocked = error.status;
  }
  return shelf;
}

/**
 * Parse a subject page into the metadata the shelf and the reader show.
 * @param html - the book.douban.com/subject/<id>/ page.
 * @param subjectId - the subject the page belongs to.
 * @returns the book record; every field is optional.
 */
export function parseSubject(html, subjectId) {
  const info = parseInfoBlock(html);
  const rating = firstMatch(html, /<strong class="ll rating_num"[^>]*>\s*([\d.]+)\s*<\/strong>/);
  const votes = firstMatch(html, /<span property="v:votes">\s*(\d+)\s*<\/span>/);
  const cover = parseCoverUrl(html);
  return {
    subjectId,
    title: parseSubjectTitle(html),
    cover,
    rating: rating === undefined ? undefined : Number.parseFloat(rating),
    votes: votes === undefined ? undefined : Number.parseInt(votes, 10),
    authors: splitPeople(info['作者']),
    translators: splitPeople(info['译者']),
    publisher: pick(info['出版社']),
    year: pick(info['出版年']),
    pages: pick(info['页数']),
    price: pick(info['定价']),
    binding: pick(info['装帧']),
    isbn: normalizeIsbn(pick(info['ISBN'])),
    series: pick(info['丛书']),
    subtitle: pick(info['副标题']),
    originTitle: pick(info['原作名']),
    summary: parseSummary(html),
    fetchedAt: Date.now(),
  };
}

/**
 * Read the labelled rows of the subject page's `#info` block.
 * @param html - subject page.
 * @returns label → raw cell markup.
 */
function parseInfoBlock(html) {
  const block = /<div id="info">([\s\S]*?)<\/div>/.exec(html);
  const result = {};
  if (block === null) return result;
  for (const row of block[1].split(/<br\s*\/?>/i)) {
    const label = /<span class="pl">\s*([^<]+?)\s*<\/span>/.exec(row);
    if (label === null) continue;
    const key = label[1].replace(/[:：]\s*$/, '').trim();
    if (key === '') continue;
    const value = row.slice(label.index + label[0].length).replace(/^[\s:：]+/, '');
    if (value.trim() === '') continue;
    result[key] = value;
  }
  return result;
}

/**
 * The subject's canonical title: the `og:title` the page publishes.
 * @param html - subject page.
 * @returns the title, or an empty string.
 */
function parseSubjectTitle(html) {
  const og = firstMatch(html, /<meta property="og:title" content="([^"]*)"/);
  if (og !== undefined) return decodeEntities(og).trim();
  const title = firstMatch(html, /<title>([\s\S]*?)<\/title>/);
  return title === undefined ? '' : decodeEntities(stripTags(title)).replace(/\s*\(豆瓣\)\s*$/, '').trim();
}

/**
 * The largest cover the page advertises.
 * @param html - subject page.
 * @returns an absolute image URL, or undefined.
 */
function parseCoverUrl(html) {
  const og = firstMatch(html, /<meta property="og:image" content="([^"]+)"/);
  if (og !== undefined) return og.replace('/view/subject/m/', '/view/subject/l/');
  const main = firstMatch(html, /<div id="mainpic">[\s\S]*?<a class="nbg"\s+href="([^"]+)"/);
  return main === undefined ? undefined : main;
}

/**
 * The "内容简介" paragraph.
 * @param html - subject page.
 * @returns plain text, capped so one page cannot bloat the cache.
 */
function parseSummary(html) {
  const intro = /<div class="intro">([\s\S]*?)<\/div>/.exec(html);
  if (intro === null) return undefined;
  const text = decodeEntities(stripTags(intro[1])).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text === '') return undefined;
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}

/**
 * Split Douban's multi-author cell into names.
 * @param value - raw cell markup.
 * @returns trimmed names, without the markup.
 */
function splitPeople(value) {
  if (value === undefined) return [];
  return stripTags(value)
    .split('/')
    .map((part) => decodeEntities(part).replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '');
}

/**
 * Reduce one cell to plain text.
 * @param value - raw cell markup.
 * @returns the text, or undefined when empty.
 */
function pick(value) {
  if (value === undefined) return undefined;
  const text = decodeEntities(stripTags(value)).replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text;
}

/**
 * Keep only the digits and X of an ISBN, which is how the library index stores it.
 * @param value - printed ISBN.
 * @returns the normalized ISBN, or undefined.
 */
function normalizeIsbn(value) {
  if (value === undefined) return undefined;
  const isbn = value.replace(/[^0-9Xx]/g, '').toUpperCase();
  return isbn.length >= 10 ? isbn : undefined;
}

/**
 * First capture group of a pattern.
 * @param text - haystack.
 * @param pattern - regular expression.
 * @returns the group, or undefined.
 */
function firstMatch(text, pattern) {
  const match = pattern.exec(text);
  return match === null ? undefined : match[1];
}

/**
 * Remove tags, keeping the text they wrapped.
 * @param html - markup fragment.
 * @returns the fragment's text.
 */
export function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

/**
 * Decode the entity forms Douban pages use.
 * @param text - text containing entities.
 * @returns decoded text.
 */
function codePoint(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff) return '\uFFFD';
  if (value >= 0xd800 && value <= 0xdfff) return '\uFFFD';
  return String.fromCodePoint(value);
}

export function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => codePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&amp;/gi, '&');
}