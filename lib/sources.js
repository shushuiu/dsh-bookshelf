/**
 * Where a missing book can legitimately come from.
 *
 * Only two kinds of source are automated here: public-domain catalogs that
 * serve the file themselves (Project Gutenberg through Gutendex) and catalog
 * lookups that lead to a lender or a bookshop (Open Library). Everything else is
 * a plain outbound link to a shop or a subscription reader the user already has
 * an account with — this bundle never automates a shadow library, and it does
 * not store anything but what it downloaded from those official endpoints.
 *
 * @module dsh-bookshelf/sources
 */

import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';

import { safeFileStem } from './library.js';

/** Project Gutenberg's own search page; its catalog is the authoritative one. */
const GUTENBERG = 'https://www.gutenberg.org';

/** Open Library's search API. */
const OPEN_LIBRARY = 'https://openlibrary.org/search.json';

/** Browser user-agent for catalog reads. */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Read a JSON endpoint with a bounded timeout.
 * @param url - absolute URL.
 * @param options - cancellation and timeout.
 * @returns the parsed JSON body.
 */
async function readJson(url, options = {}) {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 12000);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const response = await fetch(url, {
    signal,
    headers: { 'user-agent': USER_AGENT, 'accept': 'application/json' },
  });
  if (!response.ok) throw new Error(`目录服务返回 HTTP ${response.status}`);
  return await response.json();
}

/**
 * Search the public-domain and catalog sources for one book.
 * @param query - title and authors of the book.
 * @param options - cancellation.
 * @returns one section per source; a failing source reports its reason only.
 */
export async function searchSources(query, options = {}) {
  const { title, authors = [] } = query;
  const terms = [title, ...authors.slice(0, 1)].filter((part) => typeof part === 'string' && part.trim() !== '');
  const search = terms.join(' ');
  const [gutenberg, openLibrary] = await Promise.all([
    searchGutenberg(search, options).catch((error) => ({ error: describe(error) })),
    searchOpenLibrary(search, options).catch((error) => ({ error: describe(error) })),
  ]);
  return { query: search, gutenberg, openLibrary, channels: channelsFor(title) };
}

/**
 * Look the book up in Project Gutenberg's catalog.
 * @param search - free-text query.
 * @param options - cancellation.
 * @returns the first page of matches, each with the formats it can be read in.
 */
async function searchGutenberg(search, options) {
  const url = `${GUTENBERG}/ebooks/search/?query=${encodeURIComponent(search)}`;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15000);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const response = await fetch(url, {
    signal,
    headers: { 'user-agent': USER_AGENT, 'accept': 'text/html,application/xhtml+xml' },
  });
  if (response.status === 403) throw new Error('古登堡拒绝了匿名搜索（HTTP 403）');
  if (!response.ok) throw new Error(`古登堡目录返回 HTTP ${response.status}`);
  const html = await response.text();
  const items = [];
  for (const block of html.split('<li class="booklink">').slice(1)) {
    const id = /<a class="link" href="\/ebooks\/(\d+)"/.exec(block)?.[1];
    if (id === undefined) continue;
    const title = clean(/<span class="title">([\s\S]*?)<\/span>/.exec(block)?.[1]);
    if (title === undefined) continue;
    const author = clean(/<span class="subtitle">([\s\S]*?)<\/span>/.exec(block)?.[1]);
    const downloadsText = clean(/<span class="extra">([\s\S]*?)<\/span>/.exec(block)?.[1]);
    const downloads = downloadsText === undefined ? undefined : Number.parseInt(downloadsText.replace(/[^0-9]/g, ''), 10);
    items.push({
      id,
      title,
      authors: author === undefined ? [] : [author],
      downloads: Number.isFinite(downloads) ? downloads : undefined,
      page: `${GUTENBERG}/ebooks/${id}`,
      // `.epub.noimages` is the small edition; it redirects to the cache file.
      epub: `${GUTENBERG}/ebooks/${id}.epub.noimages`,
      readOnline: `${GUTENBERG}/ebooks/${id}.html.images`,
      plain: `${GUTENBERG}/ebooks/${id}.txt.utf-8`,
    });
    if (items.length >= 6) break;
  }
  return { items, searchUrl: url };
}

/**
 * Reduce one search-cell fragment to plain text.
 * @param value - raw markup.
 * @returns the text, or undefined when empty.
 */
function clean(value) {
  if (typeof value !== 'string') return undefined;
  const text = decodeEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text;
}

/**
 * Decode the entity forms the catalog page uses.
 * @param text - text containing entities.
 * @returns decoded text.
 */
function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/gi, '&');
}

/**
 * Look the book up in Open Library, which also fronts the Internet Archive's
 * lending copies.
 * @param search - free-text query.
 * @param options - cancellation.
 * @returns catalog entries with links to read or borrow.
 */
async function searchOpenLibrary(search, options) {
  const fields = 'key,title,author_name,first_publish_year,edition_count,has_fulltext,ia,ebook_access,isbn';
  const url = `${OPEN_LIBRARY}?q=${encodeURIComponent(search)}&limit=6&fields=${fields}`;
  let data;
  try {
    data = await readJson(url, options);
  } catch (first) {
    // Open Library's TLS handshake drops out intermittently; one retry is enough.
    data = await readJson(url, options).catch(() => {
      throw new Error(`Open Library 暂时不可用（${describe(first)}）`);
    });
  }
  const docs = Array.isArray(data?.docs) ? data.docs : [];
  return {
    items: docs.map((doc) => {
      const key = typeof doc.key === 'string' ? doc.key : undefined;
      const ia = Array.isArray(doc.ia) && doc.ia.length > 0 ? doc.ia[0] : undefined;
      return {
        key,
        title: String(doc.title ?? '').trim(),
        authors: Array.isArray(doc.author_name) ? doc.author_name.slice(0, 3) : [],
        year: doc.first_publish_year,
        access: typeof doc.ebook_access === 'string' ? doc.ebook_access : undefined,
        page: key === undefined ? undefined : `https://openlibrary.org${key}`,
        borrow: key === undefined ? undefined : `https://openlibrary.org${key}`,
        archive: typeof ia === 'string' ? `https://archive.org/details/${ia}` : undefined,
      };
    }).filter((item) => item.title !== ''),
  };
}

/**
 * Pick the first URL of the preferred media types.
 * @param formats - Gutendex format table.
 * @param types - media types in preference order.
 * @returns the URL, or undefined.
 */
function firstUrl(formats, types) {
  for (const type of types) {
    const value = formats[type];
    if (typeof value === 'string' && value.startsWith('http')) return value;
  }
  return undefined;
}

/**
 * Turn a thrown value into a sentence for the panel.
 * @param error - thrown value.
 * @returns the message.
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Download a Project Gutenberg EPUB into the local library.
 * @param request - catalog id, title and the download URL the catalog returned.
 * @param libraryDir - absolute library directory.
 * @param options - cancellation.
 * @returns the saved file's path, size and the refreshed index entry inputs.
 */
export async function downloadGutenberg(request, libraryDir, options = {}) {
  const { id, title, url } = request;
  if (typeof url !== 'string') throw new Error('缺少可下载的 EPUB 地址');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('下载地址无效');
  }
  // Only the official hosts, over TLS, may be fetched — and every redirect hop
  // is checked again, so a crafted URL cannot steer this row elsewhere.
  if (!isGutenbergUrl(parsed)) throw new Error('只允许从 Project Gutenberg 下载');

  const timeout = AbortSignal.timeout(60000);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let response;
  let current = parsed;
  for (let hop = 0; hop < 4; hop += 1) {
    response = await fetch(current, { signal, redirect: 'manual', headers: { 'user-agent': USER_AGENT } });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || location === null) break;
    current = new URL(location, current);
    if (!isGutenbergUrl(current)) throw new Error('下载被重定向到非 Gutenberg 地址，已拒绝');
  }
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 1024) throw new Error('下载内容不完整');
  const ext = '.epub';
  const stem = safeFileStem(`${title ?? `gutenberg-${id}`}（古登堡 ${id}）`, ext);
  await fs.mkdir(libraryDir, { recursive: true });
  // Never replace a book that is already in the library.
  for (let index = 1; index <= 99; index += 1) {
    const fileName = `${stem}${index === 1 ? '' : ` (${index})`}${ext}`;
    const target = join(libraryDir, fileName);
    try {
      await fs.writeFile(target, bytes, { flag: 'wx' });
      return { path: target, fileName, size: bytes.length, source: 'Project Gutenberg' };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('同名文件太多了，请先整理一下书库目录');
}

/**
 * Whether a URL is one of Project Gutenberg's own HTTPS hosts.
 * @param url - a parsed URL.
 * @returns true when it may be fetched.
 */
function isGutenbergUrl(url) {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'gutenberg.org' || host.endsWith('.gutenberg.org');
}

/**
 * Outbound links for a title the user may own, buy, or borrow somewhere.
 * These are plain links: the panel never talks to these services itself.
 * @param title - the book title.
 * @returns labelled links.
 */
export function channelsFor(title) {
  const keyword = encodeURIComponent(String(title ?? '').trim());
  if (keyword === '') return [];
  return [
    { id: 'weread', label: '微信读书', url: `https://weread.qq.com/web/search/books?keyword=${keyword}` },
    { id: 'doubanread', label: '豆瓣阅读', url: `https://read.douban.com/search?q=${keyword}` },
    { id: 'jd', label: '京东', url: `https://search.jd.com/Search?keyword=${keyword}&enc=utf-8` },
    { id: 'dangdang', label: '当当', url: `http://search.dangdang.com/?key=${keyword}` },
    { id: 'openlibrary', label: 'Open Library', url: `https://openlibrary.org/search?q=${keyword}` },
  ];
}