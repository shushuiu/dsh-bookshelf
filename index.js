/**
 * dsh-bookshelf — Host half.
 *
 * Owns everything the browser cannot do itself: reading Douban's pages (they
 * send no CORS headers), proxying their cover CDN (it answers 418 without a
 * Douban referer), indexing the user's own ebook folder, parsing an EPUB, and
 * downloading a public-domain edition.
 *
 * The browser half talks to this half over the Harness connection's exact Fetch
 * routes, which is how a packaged client calls its own Host: every route lives
 * under `/api/bookshelf/` and shares one envelope, `{ ok: true, value }` or
 * `{ ok: false, error }`.
 *
 * @module dsh-bookshelf
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

import {
  DoubanBlocked,
  fetchDoubanImage,
  fetchDoubanPage,
  fetchShelf,
  SHELVES,
  parseSubject,
} from './lib/douban.js';
import { contentTypeFor, isReadable, matchLibrary, readBook, readPdfMeta, renderPdfCover, renderPdfPage, readPdfText, safeFileStem, scanLibrary } from './lib/library.js';
import { downloadGutenberg, searchSources } from './lib/sources.js';

/** The Douban member the shelf starts with, when the row config names nobody. */
// No baked-in member: a shared plugin must not show somebody else's wish list.
// The panel asks for the id on first run and stores it in prefs.json.
const DEFAULT_DOUBAN_USER = '';

/** Everything this bundle serves hangs off this prefix. */
const API = '/api/bookshelf';

/** Largest accepted attachment. */
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

/** Paragraphs one translation request may carry. */
const TRANSLATE_MAX_TEXTS = 24;

/** Characters one translated paragraph may have. */
const TRANSLATE_MAX_TEXT_CHARS = 2000;

/** Characters one translation request may carry in total. */
const TRANSLATE_MAX_BATCH_CHARS = 12000;

/** How many paragraphs are translated at once. */
const TRANSLATE_CONCURRENCY = 3;

/** Translation cache cap; a long book is a few thousand paragraphs. */
const TRANSLATE_CACHE_MAX = 60000;

/**
 * Anonymous translation endpoint used by the built-in route.
 *
 * `/translate_a/t` accepts repeated `q` parameters and answers with one entry
 * per paragraph, so a chapter is one request instead of one request per line —
 * the `/single` sibling takes exactly one `q` and rate-limits a burst almost
 * immediately.
 *
 * The Host's `translator` service is preferred when this profile exposes it,
 * but it is composed for agents, not for profile-level plugins, and its default
 * route (Bing) no longer works — so the plugin carries its own working route.
 */
const TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/t';

/** Deadline for one translation request. */
const TRANSLATE_TIMEOUT_MS = 15000;

/** Paragraphs one batched translation request carries. */
const TRANSLATE_BATCH_TEXTS = 20;

/** Characters one batched translation request carries. */
const TRANSLATE_BATCH_CHARS = 5000;

/** Attempts per batch, and how long to wait between them. */
const TRANSLATE_ATTEMPTS = 3;
const TRANSLATE_BACKOFF_MS = [700, 1800, 3600];

/** Rendered original pages kept on disk before the oldest are dropped. */
const TRANSLATE_MAX_PAGES_CACHED = 400;

/** How long the reader stays quiet after the endpoint rate-limits us. */
const TRANSLATE_COOLDOWN_MS = 30000;

/** Largest translation response accepted. */
const TRANSLATE_MAX_RESPONSE = 512 * 1024;

/**
 * How long the shelf backs off after Douban answers with its anti-bot redirect.
 * Douban throttles anonymous clients after a burst; a shelf refresh is one
 * request, and a book's subject page is one more, only when it is opened.
 */
const BLOCK_COOLDOWN_MS = 20 * 60 * 1000;

/** A book whose subject page failed waits this long before another attempt. */
const DETAIL_RETRY_MS = 2 * 60 * 1000;

/**
 * Gap between two subject-page reads while the shelf fills itself in.
 * Douban blocked this client after ~30 quick requests during development, so
 * the queue deliberately crawls: a 30-book shelf takes about a minute.
 */
const DETAIL_GAP_MS = 1500;

/**
 * The Harness home directory.
 * @returns the absolute path.
 */
function dataRoot() {
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home !== '') return home;
  return join(homedir(), '.dsh');
}

/**
 * Resolve a JSON envelope.
 * @param value - payload.
 * @returns a Response carrying `{ ok: true, value }`.
 */
function ok(value) {
  return Response.json({ ok: true, value });
}

/**
 * Resolve a JSON error envelope.
 * @param error - thrown value or message.
 * @param status - HTTP status.
 * @returns a Response carrying `{ ok: false, error }`.
 */
function fail(error, status = 400) {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ ok: false, error: message }, { status });
}

/**
 * Read a JSON request body.
 * @param request - the incoming request.
 * @returns the parsed object, or an empty object.
 */
async function jsonBody(request) {
  try {
    const body = await request.json();
    return body !== null && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

/**
 * Whether a sample of text reads as Chinese.
 * @param sample - the text to look at.
 * @returns true when most of the letters are CJK.
 */
function looksChinese(sample) {
  const text = typeof sample === 'string' ? sample : '';
  let cjk = 0;
  let letters = 0;
  for (const char of text.slice(0, 4000)) {
    if (/[\u4e00-\u9fff]/.test(char)) {
      cjk += 1;
      letters += 1;
    } else if (/[A-Za-z]/.test(char)) {
      letters += 1;
    }
  }
  return letters > 0 && cjk / letters > 0.3;
}

/**
 * Read one string field from an untrusted body.
 * @param body - request body.
 * @param key - field name.
 * @returns the trimmed string, or undefined.
 */
function textField(body, key) {
  const value = body[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Turn `~/Downloads` into an absolute path; the panel's quick-pick buttons and
 * anything a user types both use the short form.
 * @param value - a path, possibly starting with `~`.
 * @returns the absolute path.
 */
function expandHome(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return '';
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return join(homedir(), text.slice(2));
  return text;
}

/**
 * Where imports go before the user picks a folder of their own.
 *
 * `~/Documents/书架` rather than a hidden app-data path: the books are the
 * user's files, so they belong where the user can find them in Finder.
 * @returns the absolute path.
 */
function defaultLibraryDir() {
  return join(homedir(), 'Documents', '书架');
}

/**
 * Where older versions kept the default library, migrated on first scan.
 * @returns the absolute path.
 */
function legacyLibraryDir() {
  return join(dataRoot(), 'storages', 'bookshelf', 'library');
}

/** Wait for a delay. */
function sleep(ms) {
  return new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });
}

/** Cover art types the panel will relay; anything else is served as JPEG. */
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

/**
 * Write a book into the library without ever replacing an existing file.
 * @param dir - the library directory.
 * @param stem - sanitized file stem without extension.
 * @param ext - extension including the dot.
 * @param bytes - file contents.
 * @returns the path actually written.
 */
async function writeUnique(dir, stem, ext, bytes) {
  for (let index = 1; index <= 99; index += 1) {
    const target = join(dir, `${stem}${index === 1 ? '' : ` (${index})`}${ext}`);
    try {
      await fs.writeFile(target, bytes, { flag: 'wx' });
      return target;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('同名文件太多了，请先整理一下书库目录');
}

/**
 * The shelf's state: one Douban member's 想读 and 在读 lists, enriched with
 * subject details, plus the local library index and the user's preferences.
 */
class Shelf {
  /**
   * @param config - the row's config, already validated by the caller.
   */
  constructor(config) {
    const settings = config !== null && typeof config === 'object' ? config : {};
    this.root = join(dataRoot(), 'storages', 'bookshelf');
    this.cachePath = join(this.root, 'shelf.json');
    this.prefsPath = join(this.root, 'prefs.json');
    this.coverDir = join(this.root, 'covers');
    this.defaultLibraryDir = defaultLibraryDir();
    this.defaults = {
      doubanUserId: typeof settings.doubanUserId === 'string' && settings.doubanUserId.trim() !== ''
        ? settings.doubanUserId.trim()
        : DEFAULT_DOUBAN_USER,
      libraryDir: typeof settings.libraryDir === 'string' ? settings.libraryDir.trim() : '',
    };
    this.prefs = { ...this.defaults };
    this.shelf = { userId: '', member: undefined, totals: { wish: 0, do: 0 }, updatedAt: 0, books: [] };
    this.library = { dir: '', files: [], scannedAt: 0, skipped: 0, error: undefined };
    this.blockedUntil = 0;
    this.lastError = undefined;
    this.fillProgress = { running: false, done: 0, total: 0, failed: 0 };
    this.filling = undefined;
    this.resumeTimer = undefined;
    this.loading = undefined;
    this.refreshPromise = undefined;
    // Translation: the Host's own `translator` service does the routing, so this
    // class only caches what came back and keeps the book's place in the file.
    this.translator = undefined;
    this.translationsPath = join(this.root, 'translations.json');
    this.translations = new Map();
    this.translationsLoaded = undefined;
    this.translationSaveTimer = undefined;
    this.translationRoute = undefined;
    this.translationBlockedUntil = 0;
    /** Extracted PDF text per file version, so a re-open costs nothing. */
    this.pdfText = new Map();
    /** PDF titles and page counts per file version. */
    this.paperMeta = new Map();
    /** Covers being rendered right now, so two cards do not render one page twice. */
    this.paperCovers = new Map();
    /** Original pages being rendered for the reader's side pane. */
    this.paperPages = new Map();
  }

  /**
   * Load persisted state once.
   * @returns the loaded shelf.
   */
  async ensureLoaded() {
    this.loading ??= (async () => {
      await fs.mkdir(this.coverDir, { recursive: true }).catch(() => {});
      this.prefs = await this.readPrefs();
      this.shelf = await this.readShelf();
      return this;
    })();
    return await this.loading;
  }

  /**
   * Read the persisted preferences, falling back to the row config.
   * @returns the preferences.
   */
  async readPrefs() {
    const fallback = { ...this.defaults };
    try {
      const raw = await fs.readFile(this.prefsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed?.doubanUserId === 'string' && parsed.doubanUserId.trim() !== '') {
        fallback.doubanUserId = parsed.doubanUserId.trim();
      }
      if (typeof parsed?.libraryDir === 'string' && parsed.libraryDir.trim() !== '') {
        fallback.libraryDir = parsed.libraryDir.trim();
      }
      fallback.libraryDir = expandHome(fallback.libraryDir);
    } catch {
      // No saved preferences yet: the row config is the answer.
    }
    return fallback;
  }

  /**
   * The one-shot "your files moved" message, reported once and then forgotten.
   * @returns the message, or undefined.
   */
  takeMigrationNotice() {
    const error = this.migrationError;
    const moved = this.migratedCount;
    const kept = this.migratedKept;
    this.migrationError = undefined;
    this.migratedCount = 0;
    this.migratedKept = 0;
    if (error !== undefined) return error;
    if (!(moved > 0)) return undefined;
    return `已把 ${moved} 个文件从旧书库移到 ~/Documents/书架${kept > 0 ? `，${kept} 个同名文件留在原处` : ''}`;
  }

  /**
   * Persist the preferences.
   * @param patch - fields to change.
   * @returns the stored preferences.
   */
  async writePrefs(patch) {
    const next = { ...this.prefs };
    if (patch.doubanUserId !== undefined) next.doubanUserId = patch.doubanUserId;
    // Store an absolute path: a saved `~/Downloads` would never stat.
    if (patch.libraryDir !== undefined) next.libraryDir = expandHome(patch.libraryDir);
    this.prefs = next;
    await fs.mkdir(this.root, { recursive: true }).catch(() => {});
    await fs.writeFile(this.prefsPath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  /**
   * Whether the Host's translator service is reachable from this plugin.
   * @returns true when it is composed into this context.
   */
  canTranslate() {
    return typeof this.translator?.translate === 'function' && typeof this.translator?.resolve === 'function';
  }

  /**
   * Translate a batch of paragraphs in one request.
   *
   * The `/translate_a/t` entry point accepts repeated `q` parameters and answers
   * with one entry per paragraph, so a whole chapter costs a single request —
   * which is also what keeps the endpoint from rate-limiting us. Retries with
   * backoff absorb the 429s that a burst still produces.
   *
   * @param texts - source paragraphs.
   * @param target - destination language tag.
   * @returns one translation per input, in order.
   */
  async translateBatchRemote(texts, target) {
    const url = `${TRANSLATE_ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(target)}`;
    const body = texts.map((text) => `q=${encodeURIComponent(text)}`).join('&');
    let lastError;
    for (let attempt = 0; attempt < TRANSLATE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => { setTimeout(resolve, TRANSLATE_BACKOFF_MS[attempt - 1] ?? 3600); });
      }
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
        });
      } catch (error) {
        lastError = new Error(`翻译接口请求失败：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (response.status === 429) {
        lastError = new Error('翻译接口限流（HTTP 429）');
        // Still rate-limited after the backoff: stop bothering the endpoint for
        // a while instead of hammering it with every scroll.
        if (attempt === TRANSLATE_ATTEMPTS - 1) this.translationBlockedUntil = Date.now() + TRANSLATE_COOLDOWN_MS;
        continue;
      }
      if (!response.ok) {
        lastError = new Error(`翻译接口返回 HTTP ${response.status}`);
        if (response.status < 500) break;
        continue;
      }
      const raw = await response.text();
      if (raw.length > TRANSLATE_MAX_RESPONSE) throw new Error('翻译接口返回内容过大');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('翻译接口返回了无法解析的内容');
      }
      // One paragraph comes back as ["译文", "en"], a batch as [["译文", "en"], …].
      const entries = Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0]) ? parsed : [parsed];
      const out = texts.map((_, index) => {
        const entry = entries[index];
        const value = Array.isArray(entry) ? entry[0] : entry;
        return typeof value === 'string' ? value.trim() : '';
      });
      if (out.every((text) => text === '')) throw new Error('翻译接口返回了空内容');
      return out;
    }
    throw lastError ?? new Error('翻译接口不可用');
  }

  /**
   * The translation routes this host can try, most preferred first.
   *
   * The Host's own `translator` service is used when this plugin can see it
   * (profile-level plugins usually cannot), and the built-in batched route is
   * always there to carry the work.
   *
   * @param target - destination language tag.
   * @returns named routes, each translating a list of paragraphs.
   */
  translationRoutes(target) {
    const routes = [];
    if (this.canTranslate()) {
      routes.push({
        name: 'harness',
        runMany: async (texts) => {
          const out = [];
          for (const text of texts) {
            const spec = this.translator.resolve({ text, targetLanguage: target, provider: 'google' });
            const translated = await this.translator.translate(spec);
            out.push(typeof translated === 'string' ? translated.trim() : '');
          }
          return out;
        },
      });
    }
    routes.push({ name: 'google-direct', runMany: async (texts) => this.translateBatchRemote(texts, target) });
    return routes;
  }

  /**
   * Break one paragraph into translation-sized chunks at sentence boundaries.
   *
   * A PDF block can easily be four thousand characters — a whole page of prose
   * flattened by the text extractor. The translator endpoint is happier with
   * smaller pieces, and a failure then costs one sentence, not the page.
   * @param text - one paragraph.
   * @returns chunks that join back into the original text.
   */
  static translationChunks(text) {
    if (text.length <= TRANSLATE_MAX_TEXT_CHARS) return [text];
    const limit = TRANSLATE_MAX_TEXT_CHARS - 200;
    const sentences = text.split(/(?<=[.!?。！？;；:：])\s+/);
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
      if (sentence.length > limit) {
        // A single runaway sentence (a table row, a citation wall): cut it.
        if (current !== '') {
          chunks.push(current);
          current = '';
        }
        for (let index = 0; index < sentence.length; index += limit) {
          chunks.push(sentence.slice(index, index + limit));
        }
        continue;
      }
      if (current !== '' && current.length + sentence.length + 1 > limit) {
        chunks.push(current);
        current = sentence;
        continue;
      }
      current = current === '' ? sentence : `${current} ${sentence}`;
    }
    if (current !== '') chunks.push(current);
    return chunks;
  }

  /**
   * Split paragraphs into request-sized batches.
   * @param items - `{ key, text }` pairs.
   * @returns batches keeping the original order.
   */
  static translationBatches(items) {
    const batches = [];
    let current = [];
    let chars = 0;
    for (const item of items) {
      if (current.length > 0 && (current.length >= TRANSLATE_BATCH_TEXTS || chars + item.text.length > TRANSLATE_BATCH_CHARS)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(item);
      chars += item.text.length;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  /**
   * Load the translation cache once.
   * @returns the cache map.
   */
  async ensureTranslations() {
    this.translationsLoaded ??= (async () => {
      try {
        const raw = await fs.readFile(this.translationsPath, 'utf8');
        const parsed = JSON.parse(raw);
        for (const [key, value] of Object.entries(parsed?.entries ?? {})) {
          if (typeof value === 'string') this.translations.set(key, value);
        }
      } catch {
        // No cache yet: every paragraph is a first-time translation.
      }
      return this.translations;
    })();
    return await this.translationsLoaded;
  }

  /**
   * The cache key for one paragraph in one target language.
   * @param text - the source paragraph.
   * @param target - destination language tag.
   * @returns a short stable key.
   */
  static translationKey(text, target) {
    return createHash('sha1').update(`${target}\u0000${text}`).digest('hex');
  }

  /**
   * Persist the translation cache, debounced: paragraph-by-paragraph calls
   * would otherwise rewrite the file once per line.
   */
  scheduleTranslationSave() {
    if (this.translationSaveTimer !== undefined) return;
    this.translationSaveTimer = setTimeout(() => {
      this.translationSaveTimer = undefined;
      this.writeTranslations().catch(() => {});
    }, 2000);
    this.translationSaveTimer.unref?.();
  }

  /**
   * Write the translation cache, newest last, capped.
   */
  async writeTranslations() {
    await fs.mkdir(this.root, { recursive: true }).catch(() => {});
    const entries = {};
    const all = [...this.translations.entries()];
    for (const [key, value] of all.slice(-TRANSLATE_CACHE_MAX)) entries[key] = value;
    await fs.writeFile(this.translationsPath, JSON.stringify({ version: 1, entries }), 'utf8').catch(() => {});
  }

  /**
   * Translate paragraphs, reusing everything already translated.
   *
   * Only the paragraphs the reader is looking at are ever sent — that is the
   * whole point of translating per chapter instead of per book.
   *
   * @param texts - source paragraphs.
   * @param target - destination language tag.
   * @returns the translations in input order, plus how many came from cache.
   */
  async translateTexts(texts, target) {
    await this.ensureTranslations();
    const wanted = target.trim() === '' ? 'zh-CN' : target.trim();
    const source = texts.map((text) => (typeof text === 'string' ? text.trim() : ''));
    const keys = source.map((text) => (text === '' ? '' : Shelf.translationKey(text, wanted)));
    const results = keys.map((key) => (key === '' ? '' : this.translations.get(key) ?? ''));
    const cached = results.filter((translated) => translated !== '').length;

    // One entry per distinct paragraph: a book repeats lines (headers, footers)
    // far more often than one expects.
    const pending = [];
    const seen = new Set();
    for (let index = 0; index < source.length; index += 1) {
      const text = source[index];
      if (text === '' || results[index] !== '') continue;
      if (seen.has(keys[index])) continue;
      seen.add(keys[index]);
      pending.push({ key: keys[index], chunks: Shelf.translationChunks(text), done: [] });
    }

    let failed = 0;
    let provider = '';
    let failure = '';
    const available = this.translationRoutes(wanted);
    const sticky = available.find((route) => route.name === this.translationRoute);
    const routes = sticky === undefined ? available : [sticky];

    /** Fold finished chunks back into whole-paragraph translations. */
    const commit = () => {
      for (const entry of pending) {
        if (entry.committed === true) continue;
        if (entry.done.length !== entry.chunks.length || entry.done.some((chunk) => chunk === undefined)) continue;
        entry.committed = true;
        const translated = entry.done.join(' ').replace(/\s+/g, ' ').trim();
        if (translated === '') continue;
        this.translations.set(entry.key, translated);
        for (let index = 0; index < keys.length; index += 1) {
          if (keys[index] === entry.key) results[index] = translated;
        }
      }
    };

    const chunks = [];
    for (const entry of pending) {
      entry.chunks.forEach((text, slot) => chunks.push({ entry, slot, text }));
    }

    for (const batch of Shelf.translationBatches(chunks.map((item) => ({ text: item.text, ...item })))) {
      if (this.translationBlockedUntil > Date.now()) {
        failure = '翻译接口限流，稍后会自动恢复（约 30 秒）';
        continue;
      }
      const reasons = [];
      let done;
      for (const route of routes) {
        try {
          const out = await route.runMany(batch.map((item) => item.text));
          this.translationRoute = route.name;
          done = { out, name: route.name };
          break;
        } catch (error) {
          reasons.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (done === undefined) {
        failure = reasons.join(' / ').slice(0, 240);
        continue;
      }
      provider = done.name;
      batch.forEach((item, position) => {
        const translated = done.out[position] ?? '';
        if (translated === '') return;
        item.entry.done[item.slot] = translated;
      });
      commit();
    }

    // Paragraphs whose chunks never all arrived stay missing so a retry asks again.
    for (const entry of pending) {
      if (entry.committed !== true) failed += entry.chunks.length;
    }
    if (failure === '' && failed > 0 && pending.length > 0 && results.every((translated) => translated === '')) {
      failure = '翻译接口没有返回内容';
    }
    if (pending.length > 0) this.scheduleTranslationSave();
    return {
      translations: results,
      provider,
      failed,
      error: failure,
      cached,
      pending: pending.length,
      available: true,
    };
  }

  /**
   * Read the persisted shelf cache.
   * @returns the shelf, or an empty shelf.
   */
  async readShelf() {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.books)) {
        // Caches written before the 在读 shelf existed have no `shelf` field and
        // call the date `wishDate`; both migrate on read rather than on write.
        const books = parsed.books
          .filter((book) => book !== null && typeof book === 'object')
          .map((book) => ({
            ...book,
            shelf: book.shelf === 'do' ? 'do' : 'wish',
            shelfDate: book.shelfDate ?? book.wishDate,
          }));
        const totals = parsed.totals !== null && typeof parsed.totals === 'object'
          ? {
            wish: Number.isFinite(parsed.totals.wish) ? parsed.totals.wish : 0,
            do: Number.isFinite(parsed.totals.do) ? parsed.totals.do : 0,
          }
          : {
            wish: Number.isFinite(parsed.total) ? parsed.total : books.filter((book) => book.shelf === 'wish').length,
            do: 0,
          };
        return {
          userId: typeof parsed.userId === 'string' ? parsed.userId : '',
          member: typeof parsed.member === 'string' ? parsed.member : undefined,
          totals,
          updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
          books,
        };
      }
    } catch {
      // First run, or the cache was removed: start empty.
    }
    return { userId: '', member: undefined, totals: { wish: 0, do: 0 }, updatedAt: 0, books: [] };
  }

  /**
   * Persist the shelf cache.
   */
  async writeShelf() {
    await fs.mkdir(this.root, { recursive: true }).catch(() => {});
    const payload = {
      userId: this.shelf.userId,
      member: this.shelf.member,
      totals: this.shelf.totals,
      updatedAt: this.shelf.updatedAt,
      books: this.shelf.books.map((book) => ({
        subjectId: book.subjectId,
        title: book.title,
        url: book.url,
        shelf: book.shelf,
        shelfDate: book.shelfDate,
        intro: book.intro,
        cover: book.cover,
        rating: book.rating,
        detail: book.detail,
        detailError: book.detailError,
        detailTriedAt: book.detailTriedAt,
      })),
    };
    await fs.writeFile(this.cachePath, JSON.stringify(payload), 'utf8').catch(() => {});
  }

  /**
   * Remember why a Douban read failed, for the panel's notice line.
   * @param error - whatever was thrown.
   * @returns the message, for convenience.
   */
  recordFailure(error) {
    this.lastError = error instanceof Error ? error.message : String(error);
    return this.lastError;
  }

  /**
   * Re-read the wish shelf from Douban.
   *
   * One request per page of the shelf: the card view carries covers, so a
   * refresh never touches a subject page. Subject pages are read when a book is
   * opened, which keeps the plugin inside Douban's tolerance for anonymous
   * clients.
   *
   * @param options - a different Douban user id, for example after saving prefs.
   * @returns a summary of what the shelf now holds.
   */
  async refresh(options = {}) {
    const userId = options.userId ?? this.prefs.doubanUserId;
    // Nothing to read yet: the panel's first run asks for the id instead of
    // reporting a Douban redirect as an error.
    if (userId.trim() === '') return { total: 0, member: undefined, skipped: true };
    if (this.refreshPromise !== undefined && options.userId === undefined) return await this.refreshPromise;
    const run = (async () => {
      const previous = this.shelf.books;
      const previousById = new Map(previous.map((book) => [book.subjectId, book]));
      const fetched = [];
      const totals = { ...this.shelf.totals };
      let member;
      let blocked;
      let warning;
      for (const name of SHELVES) {
        try {
          const result = await fetchShelf(userId, name, { withCovers: options.withCovers !== false });
          member ??= result.member;
          totals[name] = Number.isFinite(result.total) ? result.total : result.rows.length;
          fetched.push(...result.rows);
          warning ??= result.coverWarning;
          if (result.blocked !== undefined) blocked = result.blocked;
        } catch (error) {
          if (!(error instanceof DoubanBlocked)) throw error;
          // One shelf refusing must not empty the other: the rows this shelf had
          // stay on display, and the panel reports the cooldown.
          blocked = error.status;
          warning = error.message;
          fetched.push(...previous.filter((book) => book.shelf === name));
        }
      }
      if (blocked !== undefined) {
        this.blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
        this.lastError = warning;
        return {
          member: this.shelf.member,
          total: this.shelf.books.length,
          totals: this.shelf.totals,
          books: this.shelf.books.length,
          stale: true,
          error: warning,
        };
      }
      this.blockedUntil = 0;
      this.lastError = warning;
      // Both shelves are newest-first on their own; one list newest-first again
      // keeps 「全部书籍」 in a chronology instead of 想读 then 在读.
      fetched.sort((a, b) => {
        const left = typeof a.shelfDate === 'string' ? a.shelfDate : '';
        const right = typeof b.shelfDate === 'string' ? b.shelfDate : '';
        if (left === right) return 0;
        if (left === '') return 1;
        if (right === '') return -1;
        return left < right ? 1 : -1;
      });
      this.shelf = {
        userId,
        member: member ?? this.shelf.member,
        totals,
        updatedAt: Date.now(),
        books: fetched.map((row) => {
          const cached = previousById.get(row.subjectId);
          return {
            ...row,
            // Keep a subject page already read for a book still on the shelf.
            detail: cached?.detail,
            cover: row.cover ?? cached?.cover,
            rating: row.rating ?? cached?.rating,
            detailError: undefined,
          };
        }),
      };
      await this.writeShelf();
      this.startFilling();
      return {
        member: this.shelf.member,
        total: this.shelf.books.length,
        totals,
        books: this.shelf.books.length,
      };
    })();
    this.refreshPromise = run;
    try {
      return await run;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  /**
   * Queue the remaining subject pages, unless a queue is already running.
   *
   * This is what makes covers, ratings and summaries appear on their own after
   * a refresh. It is deliberately slow (one request per DETAIL_GAP_MS) and it
   * stops dead the moment Douban pushes back, resuming once the cooldown ends.
   *
   * @returns the running queue.
   */
  startFilling() {
    if (this.prefs.doubanUserId.trim() === '') return;
    if (this.filling !== undefined) return this.filling;
    const fill = { running: true, done: 0, total: 0, failed: 0, blocked: false };
    this.fillProgress = fill;
    this.filling = (async () => {
      try {
        // Read the queue from the live shelf on every step: a refresh in the
        // middle replaces it, and the loop should follow the new one instead of
        // writing into books that are no longer listed.
        for (;;) {
          fill.total = this.shelf.books.length;
          fill.done = this.shelf.books.filter((book) => book.detail !== undefined).length;
          if (Date.now() < this.blockedUntil) {
            fill.blocked = true;
            break;
          }
          const book = this.shelf.books.find((entry) => entry.detail === undefined
            && !(entry.detailError !== undefined
              && Date.now() - (entry.detailTriedAt ?? 0) < DETAIL_RETRY_MS));
          if (book === undefined) break;
          try {
            await this.fetchDetail(book);
          } catch (error) {
            fill.failed += 1;
            if (error instanceof DoubanBlocked) {
              fill.blocked = true;
              break;
            }
          }
          await this.writeShelf().catch(() => {});
          await sleep(DETAIL_GAP_MS);
        }
      } finally {
        fill.running = false;
        this.fillProgress = { running: false, done: fill.done, total: fill.total, failed: fill.failed };
        this.filling = undefined;
        await this.writeShelf().catch(() => {});
        if (fill.blocked) this.scheduleResume();
      }
    })();
    return this.filling;
  }

  /**
   * Try again once Douban's cooldown has elapsed, so a refused fill heals itself.
   */
  scheduleResume() {
    if (this.resumeTimer !== undefined) return;
    const wait = Math.max(60 * 1000, this.blockedUntil - Date.now() + 1000);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      if (this.shelf.books.some((book) => book.detail === undefined)) this.startFilling();
    }, wait);
    // Never hold the Host process open for this.
    this.resumeTimer.unref?.();
  }

  /**
   * Fetch and store one book's subject page.
   * @param book - the shelf row to enrich.
   */
  async fetchDetail(book) {
    book.detailTriedAt = Date.now();
    try {
      const html = await fetchDoubanPage(book.url);
      const detail = parseSubject(html, book.subjectId);
      book.detail = detail;
      book.cover = book.cover ?? detail.cover;
      book.detailError = undefined;
      if (typeof detail.cover === 'string') await this.cacheCover(book.subjectId, detail.cover);
    } catch (error) {
      book.detailError = error instanceof Error ? error.message : String(error);
      if (error instanceof DoubanBlocked) {
        this.blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
        this.lastError = error.message;
      }
      throw error;
    }
  }

  /**
   * Store a cover next to the cache so repeat loads never touch Douban again.
   * @param subjectId - the book.
   * @param url - the cover URL.
   */
  async cacheCover(subjectId, url) {
    const target = join(this.coverDir, `${subjectId}.img`);
    try {
      const stat = await fs.stat(target);
      if (stat.size > 1024) return;
    } catch {
      // Not cached yet.
    }
    try {
      const { bytes, contentType } = await fetchDoubanImage(url);
      // The CDN's own header is relayed to the browser from an authenticated
      // origin, so only real image types are accepted.
      const type = COVER_TYPES.has(contentType.split(';')[0].trim()) ? contentType.split(';')[0].trim() : 'image/jpeg';
      await fs.writeFile(target, bytes);
      await fs.writeFile(`${target}.type`, type, 'utf8').catch(() => {});
    } catch {
      // A missing cover degrades one card; it must not fail the refresh.
    }
  }

  /**
   * Read a cached cover.
   * @param subjectId - the book.
   * @returns the bytes and content type, or undefined.
   */
  async readCover(subjectId) {
    const target = join(this.coverDir, `${subjectId}.img`);
    try {
      const bytes = await fs.readFile(target);
      const type = await fs.readFile(`${target}.type`, 'utf8').catch(() => 'image/jpeg');
      return { bytes, contentType: type.trim() || 'image/jpeg' };
    } catch {
      return undefined;
    }
  }

  /**
   * Rescan the configured ebook directory.
   * @returns the index summary.
   */
  /**
   * The folder a new file lands in: the configured one, else the default folder,
   * which is created on demand. Choosing it here is what makes the first import
   * work without opening settings at all.
   * @returns the absolute folder path.
   */
  async libraryTarget() {
    const dir = this.prefs.libraryDir !== '' ? expandHome(this.prefs.libraryDir) : this.defaultLibraryDir;
    if (this.prefs.libraryDir === '') {
      // Persist the effective folder so the panel shows a real path instead of
      // an empty field.
      this.prefs = { ...this.prefs, libraryDir: dir };
      await this.writePrefs({ libraryDir: dir }).catch(() => {});
    }
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  }

  /**
   * Move the library out of the old hidden default into the new one.
   *
   * Only runs when the configured folder is the legacy default and the new
   * default is empty, and it never overwrites: a name that already exists in
   * the destination stays where it was.
   * @returns how many entries were moved.
   */
  async migrateLibrary() {
    const target = this.defaultLibraryDir;
    const configured = this.prefs.libraryDir === '' ? target : expandHome(this.prefs.libraryDir);
    if (resolve(configured) !== resolve(legacyLibraryDir())) return 0;
    if (resolve(target) === resolve(configured)) return 0;
    const entries = await fs.readdir(configured, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined || entries.length === 0) {
      await this.writePrefs({ libraryDir: '' });
      return 0;
    }
    try {
      await fs.mkdir(target, { recursive: true });
    } catch (error) {
      this.migrationError = `书库目录 ${target} 建不出来：${error.message}`;
      return 0;
    }
    let moved = 0;
    let kept = 0;
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const from = join(configured, entry.name);
      const to = join(target, entry.name);
      const taken = await fs.stat(to).then(() => true, () => false);
      if (taken) {
        kept += 1;
        continue;
      }
      try {
        await fs.rename(from, to);
        moved += 1;
      } catch {
        // A cross-device move or a permission problem: copy then delete.
        try {
          await fs.cp(from, to, { recursive: true });
          await fs.rm(from, { recursive: true, force: true });
          moved += 1;
        } catch {
          kept += 1;
        }
      }
    }
    if (moved === 0) {
      // Files that could not move must stay reachable: keep pointing at the old
      // folder. Nothing to move at all means the switch is safe.
      if (kept > 0) {
        this.migrationError = `没能迁移书库（可能没有权限），文件仍在 ${configured}`;
        return 0;
      }
      await this.writePrefs({ libraryDir: '' });
      return 0;
    }
    await this.writePrefs({ libraryDir: '' });
    this.migratedKept = kept;
    return moved;
  }

  async scan() {
    if (!this.migrated) {
      this.migrated = true;
      const moved = await this.migrateLibrary().catch(() => 0);
      if (moved > 0) this.migratedCount = moved;
    }
    const isDefault = this.prefs.libraryDir === '';
    const dir = isDefault ? this.defaultLibraryDir : expandHome(this.prefs.libraryDir);
    // Distinguish "the folder is not there" from "the folder is empty": the
    // panel shows the difference, and a wrong path is the common case. The
    // default folder is simply absent until the first import, which is not an
    // error.
    const info = await fs.stat(dir).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) {
      this.library = {
        dir,
        isDefault,
        files: [],
        scannedAt: Date.now(),
        skipped: 0,
        error: isDefault ? undefined : `书库目录不存在或不是文件夹：${dir}`,
      };
      return this.library;
    }
    const result = await scanLibrary(dir);
    this.library = { dir, isDefault, files: result.files, scannedAt: result.scannedAt, skipped: result.skipped, error: undefined };
    return this.library;
  }

  /**
   * Find one indexed file by id.
   * @param fileId - the index id.
   * @returns the entry, or undefined.
   */
  /**
   * Title, authors and page count of a paper, extracted once per file version.
   * @param file - the indexed file.
   * @returns `{ title, authors, pages }`.
   */
  async paperInfo(file) {
    const key = `${file.id}:${file.mtime}`;
    const cached = this.paperMeta.get(key);
    if (cached !== undefined) return cached;
    const stem = file.name.replace(/\.[^.]+$/, '');
    const info = file.ext === '.pdf'
      ? await readPdfMeta(file).catch(() => ({ title: '', authors: [], pages: undefined }))
      : { title: '', authors: [], pages: undefined };
    const value = {
      title: info.title === '' ? stem : info.title,
      authors: info.authors,
      pages: info.pages,
    };
    this.paperMeta.set(key, value);
    if (this.paperMeta.size > 500) this.paperMeta.delete(this.paperMeta.keys().next().value);
    return value;
  }

  /**
   * The card cover of a paper: its first page, rendered once and kept on disk.
   * @param file - the indexed file.
   * @returns the PNG bytes, or undefined when it cannot be rendered.
   */
  async paperCover(file) {
    if (file.ext !== '.pdf') return undefined;
    const name = createHash('sha1').update(`${file.id}:${file.mtime}`).digest('hex').slice(0, 20);
    const target = join(this.coverDir, 'papers', `${name}.png`);
    const cached = await fs.readFile(target).catch(() => undefined);
    if (cached !== undefined && cached.length > 0) return cached;
    const running = this.paperCovers.get(name);
    if (running !== undefined) return await running;
    const job = (async () => {
      await fs.mkdir(dirname(target), { recursive: true }).catch(() => {});
      const rendered = await renderPdfCover(file, target);
      if (!rendered) return undefined;
      return await fs.readFile(target).catch(() => undefined);
    })();
    this.paperCovers.set(name, job);
    try {
      return await job;
    } finally {
      this.paperCovers.delete(name);
    }
  }

  /**
   * Render one page of a paper for the reader's original-page pane.
   *
   * Pages are kept on disk next to the covers: a 50 page paper renders in about
   * five seconds spread over the reading session, and every revisit is free.
   * @param file - the indexed file.
   * @param page - 1-based page number.
   * @returns the PNG bytes, or undefined when the page cannot be rendered.
   */
  async paperPage(file, page) {
    if (file.ext !== '.pdf' || !Number.isInteger(page) || page < 1) return undefined;
    const bucket = join(this.coverDir, 'pages', createHash('sha1').update(`${file.id}:${file.mtime}`).digest('hex').slice(0, 20));
    const target = join(bucket, `${page}.png`);
    const cached = await fs.readFile(target).catch(() => undefined);
    if (cached !== undefined && cached.length > 0) return cached;
    const key = `${bucket}:${page}`;
    const running = this.paperPages.get(key);
    if (running !== undefined) return await running;
    const job = (async () => {
      await fs.mkdir(bucket, { recursive: true }).catch(() => {});
      const bytes = await renderPdfPage(file, page, target);
      if (bytes !== undefined) void this.trimPageCache();
      return bytes;
    })();
    this.paperPages.set(key, job);
    try {
      return await job;
    } finally {
      this.paperPages.delete(key);
    }
  }

  /**
   * Keep the page cache from growing without bound.
   *
   * Reading a 500 page paper page by page would otherwise leave the whole book
   * on disk as images, several times over after a re-extract.
   * @returns nothing.
   */
  async trimPageCache() {
    if (this.trimmingPages === true) return;
    this.trimmingPages = true;
    try {
      const root = join(this.coverDir, 'pages');
      const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
      const files = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
        const full = join(entry.parentPath ?? entry.path ?? root, entry.name);
        const stat = await fs.stat(full).catch(() => undefined);
        if (stat !== undefined) files.push({ full, at: stat.mtimeMs });
      }
      if (files.length <= TRANSLATE_MAX_PAGES_CACHED) return;
      files.sort((left, right) => left.at - right.at);
      for (const file of files.slice(0, files.length - TRANSLATE_MAX_PAGES_CACHED)) {
        await fs.rm(file.full, { force: true }).catch(() => {});
      }
    } finally {
      this.trimmingPages = false;
    }
  }

  /**
   * Rename one library file in place, keeping its extension.
   * @param file - the indexed file.
   * @param stem - the new name without extension.
   * @returns the new absolute path.
   */
  async renameFile(file, stem) {
    const ext = extname(file.name);
    const target = join(dirname(file.path), `${stem}${ext}`);
    if (resolve(target) === resolve(file.path)) return file.path;
    const taken = await fs.stat(target).then(() => true, () => false);
    if (taken) throw new Error('同目录下已经有同名文件');
    await fs.rename(file.path, target);
    return target;
  }

  /**
   * Move one library file into the library's own trash folder.
   *
   * Deleting outright would be a data loss the panel cannot make good on; the
   * file stays on disk under `.trash/`, which the scanner skips.
   * @param file - the indexed file.
   * @returns where the file went.
   */
  async trashFile(file) {
    const dir = join(dirname(file.path), '.trash');
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(dir, `${stamp}-${file.name}`);
    await fs.rename(file.path, target);
    return target;
  }

  findFile(fileId) {
    if (typeof fileId !== 'string') return undefined;
    return this.library.files.find((file) => file.id === fileId);
  }

  /**
   * The reader payload for one book, preferring an ISBN match.
   * @param subjectId - the book.
   * @returns the payload, or a reason it is unavailable.
   */
  async readForBook(subjectId) {
    const book = this.shelf.books.find((entry) => entry.subjectId === subjectId);
    if (book === undefined) throw new Error('书架上没有这本书');
    const matches = this.matchesFor(book);
    const best = matches.find((match) => match.file.readable);
    if (best === undefined) {
      throw new Error(matches.length > 0
        ? '这本书的本地文件不支持在线阅读，可在文件夹中打开'
        : '这本书还没有本地文件');
    }
    const payload = await readBook(this.validatePath(best.file));
    return { ...payload, book: { subjectId: book.subjectId, title: book.title }, file: publicFile(best.file) };
  }

  /**
   * Pair shelf books with the indexed files.
   * @param book - one shelf row.
   * @returns matches, best first.
   */
  matchesFor(book) {
    if (this.library.files.length === 0) return [];
    const map = matchLibrary([{ id: book.subjectId, title: book.title, isbn: book.detail?.isbn }], this.library.files);
    return map.get(book.subjectId) ?? [];
  }

  /**
   * Assert that a path really sits inside the configured library directory.
   * @param file - an indexed entry.
   * @returns the same entry.
   */
  validatePath(file) {
    const base = resolve(this.library.dir);
    const target = resolve(file.path);
    if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error('文件不在书库目录中');
    return file;
  }

  /**
   * The payload the panel renders.
   * @returns the shelf state.
   */
  state() {
    // One pass for the whole shelf: with a large library, matching each book on
    // its own would normalize every filename once per book on every poll.
    const matchMap = this.library.files.length === 0
      ? new Map()
      : matchLibrary(
        this.shelf.books.map((book) => ({ id: book.subjectId, title: book.title, isbn: book.detail?.isbn })),
        this.library.files,
      );
    const books = this.shelf.books.map((book) => {
      const matches = matchMap.get(book.subjectId) ?? [];
      return {
        subjectId: book.subjectId,
        title: book.title,
        url: book.url,
        shelf: book.shelf === 'do' ? 'do' : 'wish',
        shelfDate: book.shelfDate,
        intro: book.intro,
        detail: book.detail === undefined ? undefined : {
          authors: book.detail.authors,
          translators: book.detail.translators,
          publisher: book.detail.publisher,
          year: book.detail.year,
          pages: book.detail.pages,
          price: book.detail.price,
          binding: book.detail.binding,
          isbn: book.detail.isbn,
          series: book.detail.series,
          subtitle: book.detail.subtitle,
          originTitle: book.detail.originTitle,
          rating: book.detail.rating,
          votes: book.detail.votes,
          summary: book.detail.summary,
          hasCover: typeof (book.detail.cover ?? book.cover) === 'string',
        },
        coverUrl: (book.detail?.cover ?? book.cover) === undefined
          ? undefined
          : `${API}/cover?subject=${encodeURIComponent(book.subjectId)}`,
        rating: book.detail?.rating ?? book.rating,
        local: matches.map((match) => ({ ...publicFile(match.file), reason: match.reason, readable: match.file.readable })),
        status: book.detail !== undefined ? 'ready' : book.detailError === undefined ? 'pending' : 'failed',
        detailError: book.detailError,
      };
    });
    const readable = this.library.files.filter((file) => file.readable).length;
    // Which file belongs to which shelf book: a file without an owner is a
    // document of its own (a paper, a manual), not part of the wish-list shelf.
    const owner = new Map();
    for (const [subjectId, matches] of matchMap) {
      for (const match of matches) owner.set(match.file.id, subjectId);
    }
    return {
      translation: { ready: true, service: this.canTranslate() },
      prefs: {
        doubanUserId: this.prefs.doubanUserId,
        libraryDir: this.prefs.libraryDir,
        defaults: this.defaults,
      },
      member: this.shelf.member,
      userId: this.shelf.userId === '' ? this.prefs.doubanUserId : this.shelf.userId,
      total: books.length,
      totals: this.shelf.totals,
      updatedAt: this.shelf.updatedAt || undefined,
      notice: this.lastError ?? this.takeMigrationNotice() ?? (this.prefs.doubanUserId === ''
        ? '先在「设置」里填上你的豆瓣 ID（豆瓣个人主页 /people/<ID>/wish 里的那串数字）'
        : undefined),
      progress: { ...this.fillProgress },
      blocked: this.blockedUntil > Date.now(),
      books,
      library: {
        dir: this.library.dir !== undefined && this.library.dir !== '' ? this.library.dir : this.prefs.libraryDir,
        isDefault: this.library.isDefault === true,
        count: this.library.files.length,
        readable,
        scannedAt: this.library.scannedAt || undefined,
        skipped: this.library.skipped,
        error: this.library.error,
        // Only the files no shelf book claims: those are the documents of their
        // own. Matched files already travel with their book, and keeping the
        // whole index out of every state call keeps the payload small.
        documents: this.library.files
          .filter((file) => !owner.has(file.id))
          .map((file) => ({
            ...publicFile(file),
            mtime: file.mtime,
            readable: file.readable === true,
            // Known once the panel asked for it; the card shows the file name
            // until the real title arrives.
            title: this.paperMeta.get(`${file.id}:${file.mtime}`)?.title,
            cover: file.ext === '.pdf' ? `${API}/paper/cover?fileId=${encodeURIComponent(file.id)}&v=${file.mtime}` : undefined,
          })),
      },
      api: API,
    };
  }
}

/** Name of the agent-facing tool. */
const TOOL_NAME = 'bookshelf';

/** Most books the list action prints. */
const TOOL_LIST_LIMIT = 80;

/** Characters the read action may return in one call. */
const TOOL_READ_CHARS = 6000;

const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'info', 'search', 'read'],
      description: 'list: the whole shelf with what exists locally. info: one book. search: find a phrase inside the local books. read: the text of one local book or one of its chapters.',
    },
    query: { type: 'string', description: 'Phrase to find inside the local books (action=search).' },
    title: { type: 'string', description: 'Book title, or part of it (action=info, read).' },
    subjectId: { type: 'string', description: 'Douban subject id, when a previous call returned it (action=info, read).' },
    fileId: { type: 'string', description: 'Local file id from list, info or search; the exact file to read (action=read).' },
    chapter: { type: 'integer', description: '0-based chapter index (action=read on an EPUB). Omit to get the chapter list instead of text.' },
    limit: { type: 'integer', description: 'list: books to print, at most 80. search: hits, at most 20. read: characters, at most 6000.' },
  },
  required: ['action'],
};

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string', description: 'Human-readable answer.' } },
  required: ['text'],
};

const TOOL_DESCRIPTION = [
  'Read the user\u2019s bookshelf: the Douban \u60f3\u8bfb (want to read) and \u5728\u8bfb (currently reading) lists, which of those books exist as',
  'local files, and the text inside those local EPUB and TXT files.',
  'Use it whenever a question is about their books or the contents of a book —',
  'for example \u201cwhich of my books covers X\u201d, \u201cwhat is on my shelf\u201d, \u201cread chapter 3 of this one\u201d.',
  'PDF files are listed but their text is not available.',
  'Quote what it returns; never invent a book, a chapter or a passage.',
].join(' ');

/**
 * Build the model-facing tool over one shelf instance.
 * @param shelf - the plugin's store.
 * @returns a raw ToolDefinition for `tools.register`.
 */
function buildTool(shelf) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    presentCall(args) {
      const action = typeof args?.action === 'string' ? args.action : 'list';
      const labels = { list: '查看书架', info: '查看一本书', search: '在本地书中检索', read: '阅读本地书' };
      const detail = args?.query ?? args?.title ?? '';
      const label = labels[action] ?? '书架';
      return { card: 'generic', title: detail === '' ? label : `${label}：${detail}`, kind: 'fetch' };
    },
    async execute(args, exec) {
      await shelf.ensureLoaded();
      if (shelf.library.scannedAt === 0) {
        await shelf.scan().catch(() => {});
      }
      const action = typeof args?.action === 'string' ? args.action : 'list';
      const signal = exec?.signal;
      if (action === 'list') return { text: describeShelf(shelf, args) };
      if (action === 'info') return { text: describeBook(shelf, args) };
      if (action === 'search') return { text: await searchLocalBooks(shelf, args, signal) };
      if (action === 'read') return { text: await readLocalBook(shelf, args, signal) };
      throw new Error(`未知的 action：${action}`);
    },
  };
}

/**
 * Find one shelf entry by subject id, or by a title fragment.
 * @param shelf - the store.
 * @param args - tool arguments.
 * @returns the book, or undefined.
 */
function findBook(shelf, args) {
  const subjectId = typeof args?.subjectId === 'string' ? args.subjectId.trim() : '';
  if (subjectId !== '') return shelf.shelf.books.find((book) => book.subjectId === subjectId);
  const title = typeof args?.title === 'string' ? args.title.trim().toLowerCase() : '';
  if (title === '') return undefined;
  return shelf.shelf.books.find((book) => book.title.toLowerCase().includes(title));
}

/**
 * One line describing the files a book matched.
 * @param files - matched index entries.
 * @returns the description.
 */
function describeFiles(files) {
  if (files.length === 0) return '本地：无';
  return `本地：${files.map((file) => `${file.ext.replace('.', '').toUpperCase()}${file.readable ? '' : '（面板不能读）'}`).join('、')}`;
}

/**
 * The `list` action.
 * @param shelf - the store.
 * @param args - tool arguments.
 * @returns the answer text.
 */
function describeShelf(shelf, args) {
  const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(args.limit, TOOL_LIST_LIMIT) : TOOL_LIST_LIMIT;
  const books = shelf.shelf.books;
  if (books.length === 0) {
    return shelf.lastError === undefined
      ? '书架还是空的：豆瓣书单没有读到，可以稍后刷新一次。'
      : `书架还是空的。豆瓣那边：${shelf.lastError}`;
  }
  const local = books.filter((book) => shelf.matchesFor(book).length > 0).length;
  const wish = books.filter((book) => book.shelf !== 'do').length;
  const reading = books.filter((book) => book.shelf === 'do').length;
  const counts = reading > 0 ? `（想读 ${wish} 本 · 在读 ${reading} 本）` : '';
  const lines = [
    `豆瓣书单共 ${books.length} 本${counts}，其中 ${local} 本在你的本地书库里。`,
  ];
  if (shelf.fillProgress.running) {
    lines.push(`（详情还在后台补全：${shelf.fillProgress.done}/${shelf.fillProgress.total}）`);
  }
  books.slice(0, limit).forEach((book, index) => {
    const detail = book.detail;
    const meta = [
      detail?.authors?.join(' / '),
      detail?.publisher,
      detail?.year,
      book.shelfDate === undefined ? undefined : `${book.shelf === 'do' ? '在读' : '想读'} ${book.shelfDate}`,
      describeFiles(shelf.matchesFor(book).map((match) => match.file)),
    ].filter(Boolean).join(' · ');
    lines.push(`${index + 1}. 《${book.title}》${meta === '' ? '' : ` — ${meta}`}`);
  });
  if (books.length > limit) lines.push(`……还有 ${books.length - limit} 本没有列出。`);
  const matchedIds = new Set();
  for (const book of books) for (const match of shelf.matchesFor(book)) matchedIds.add(match.file.id);
  const loose = shelf.library.files.filter((file) => file.readable && !matchedIds.has(file.id));
  if (loose.length > 0) {
    lines.push('', `书库里还有 ${loose.length} 个没有和豆瓣书目对上的文件（可以用 fileId 直接读）：`);
    loose.slice(0, 12).forEach((file) => lines.push(`- ${file.name}（fileId=${file.id}）`));
    if (loose.length > 12) lines.push(`- ……还有 ${loose.length - 12} 个`);
  }
  return lines.join('\n');
}

/**
 * The `info` action.
 * @param shelf - the store.
 * @param args - tool arguments.
 * @returns the answer text.
 */
function describeBook(shelf, args) {
  const book = findBook(shelf, args);
  if (book === undefined) return '没有在书架上找到这本书。先用 action=list 看看书架里有什么。';
  const detail = book.detail;
  const lines = [`《${book.title}》`];
  const push = (label, value) => { if (value !== undefined && value !== '') lines.push(`${label}：${value}`); };
  push('作者', detail?.authors?.join(' / '));
  push('译者', detail?.translators?.join(' / '));
  push('出版社', detail?.publisher);
  push('出版年', detail?.year);
  push('ISBN', detail?.isbn);
  push('评分', detail?.rating === undefined ? undefined : `${detail.rating}（${detail.votes ?? '?'} 人评价）`);
  push(book.shelf === 'do' ? '在读' : '想读于', book.shelfDate);
  push('豆瓣', book.url);
  if (detail?.summary !== undefined) push('简介', `${detail.summary.slice(0, 260)}${detail.summary.length > 260 ? '…' : ''}`);
  const files = shelf.matchesFor(book).map((match) => match.file);
  if (files.length === 0) lines.push('本地：无');
  else {
    lines.push('本地文件：');
    for (const file of files) lines.push(`- ${file.name}（${file.ext.replace('.', '').toUpperCase()}，fileId=${file.id}）`);
  }
  return lines.join('\n');
}

/**
 * A short excerpt around one match.
 * @param text - the chapter text.
 * @param index - match offset.
 * @param length - match length.
 * @returns the excerpt.
 */
function snippetAround(text, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Split a local book into searchable, title-bearing sections.
 * @param parsed - the result of `readBook`.
 * @returns sections, or an empty list for a format without text.
 */
function sectionsOf(parsed) {
  if (parsed.kind === 'epub') return parsed.chapters;
  if (parsed.kind === 'text') return [{ title: '正文', paragraphs: parsed.text.split('\n') }];
  return [];
}

/**
 * The `search` action: look inside every readable local book.
 * @param shelf - the store.
 * @param args - tool arguments.
 * @param signal - caller cancellation.
 * @returns the answer text.
 */
async function searchLocalBooks(shelf, args, signal) {
  const needle = typeof args?.query === 'string' ? args.query.trim() : '';
  if (needle === '') return '请给出要在本地书里查找的文字（action=search 需要 query）。';
  if (shelf.library.files.length === 0) return '本地书库还没有索引到文件：先在书架设置里选一个目录。';
  const readable = shelf.library.files.filter((file) => file.readable && file.ext !== '.pdf');
  const maxHits = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 20) : 12;
  const deadline = Date.now() + 20000;
  const groups = [];
  let scanned = 0;
  let skipped = 0;
  let found = 0;
  const lower = needle.toLowerCase();
  for (const file of readable) {
    if (found >= maxHits || signal?.aborted === true || Date.now() > deadline) break;
    let parsed;
    try {
      parsed = await readBook(file);
    } catch {
      skipped += 1;
      continue;
    }
    scanned += 1;
    const hits = [];
    for (const section of sectionsOf(parsed)) {
      const text = section.paragraphs.join('\n');
      const haystack = text.toLowerCase();
      let index = haystack.indexOf(lower);
      while (index >= 0) {
        hits.push(`${section.title}：${snippetAround(text, index, needle.length)}`);
        found += 1;
        if (found >= maxHits) break;
        index = haystack.indexOf(lower, index + needle.length);
      }
      if (found >= maxHits) break;
    }
    if (hits.length > 0) groups.push(`《${file.name}》（fileId=${file.id}）\n  ${hits.map((hit, index) => `${index + 1}. ${hit}`).join('\n  ')}`);
  }
  if (groups.length === 0) {
    return `在 ${scanned} 本可搜索的本地书里没有找到「${needle}」。${skipped > 0 ? `（${skipped} 个文件读取失败）` : ''}`;
  }
  return [
    `在 ${scanned} 本本地书里找到 ${found} 处「${needle}」：`,
    ...groups,
    '（要把某本书的某章读出来，用 action=read 加 fileId。）',
  ].join('\n');
}

/**
 * The `read` action.
 * @param shelf - the store.
 * @param args - tool arguments.
 * @param signal - caller cancellation.
 * @returns the answer text.
 */
async function readLocalBook(shelf, args, signal) {
  const fileId = typeof args?.fileId === 'string' ? args.fileId.trim() : '';
  let file = fileId === '' ? undefined : shelf.findFile(fileId);
  if (file === undefined) {
    const book = findBook(shelf, args);
    if (book !== undefined) {
      file = shelf.matchesFor(book).map((match) => match.file).find((entry) => entry.readable);
    }
  }
  if (file === undefined) {
    const title = typeof args?.title === 'string' ? args.title.trim() : '';
    if (title === '') return '没找到要读的文件：给出 title 或 fileId，先用 action=list 确认书名。';
    file = shelf.library.files.find((entry) => entry.readable && entry.name.toLowerCase().includes(title.toLowerCase()));
  }
  if (file === undefined) {
    const candidates = shelf.library.files.filter((entry) => entry.readable).slice(0, 10);
    if (candidates.length === 0) return '本地书库里没有可读的文件：先选中书库目录并扫描一次。';
    return [
      '没有和这个书名对上的本地文件。可读的文件有：',
      ...candidates.map((entry) => `- ${entry.name}（fileId=${entry.id}）`),
      '用 action=read 配 fileId 可以直接读其中一本。',
    ].join('\n');
  }
  if (!file.readable) return `${file.name} 的格式（${file.ext}）在这里读不了。`;
  if (file.ext === '.pdf') return `${file.name} 是 PDF，面板可以看，但我没法在这里提取文字。`;
  if (signal?.aborted === true) return '已取消。';
  let parsed;
  try {
    parsed = await readBook(file);
  } catch (error) {
    return `${file.name} 读取失败：${error instanceof Error ? error.message : String(error)}`;
  }
  const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(args.limit, TOOL_READ_CHARS) : TOOL_READ_CHARS;
  const sections = sectionsOf(parsed);
  if (sections.length === 0) return `${file.name} 里没有可提取的文字。`;
  const requested = typeof args?.chapter === 'number' && args.chapter >= 0 && args.chapter < sections.length
    ? args.chapter
    : undefined;
  if (requested === undefined && parsed.kind === 'epub') {
    const list = sections.map((section, index) => `${index}. ${section.title}`).slice(0, 60).join('\n');
    return `${file.name} 共 ${sections.length} 章：\n${list}\n\n用 action=read 加 chapter=<序号> 读其中一章。`;
  }
  const section = requested === undefined ? sections[0] : sections[requested];
  const text = section.paragraphs.join('\n\n');
  return `《${file.name}》${section.title}\n\n${text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text}`;
}

/**
 * The public shape of an indexed file.
 * @param file - an index entry.
 * @returns the fields the panel may see.
 */
function publicFile(file) {
  return {
    fileId: file.id,
    name: file.name,
    rel: file.rel,
    ext: file.ext,
    size: file.size,
    title: file.title,
    author: file.author,
    mtime: file.mtime,
  };
}

/**
 * Register the Host half.
 * @param ctx - the plugin's Host context.
 * @param config - the row's config.
 */
export function apply(ctx, config = {}) {
  const shelf = new Shelf(config);

  /**
   * Wrap one route so a thrown error becomes the shared error envelope.
   * @param handler - route body.
   * @returns a Fetch handler.
   */
  const route = (handler) => async (request) => {
    try {
      return await handler(request, await shelf.ensureLoaded());
    } catch (error) {
      return fail(error, 500);
    }
  };

  // A model-facing tool, so the user can ask about the shelf and about the
  // contents of their own books in the conversation instead of the panel.
  ctx.inject(['tools'], (scope) => {
    const tools = scope.get('tools');
    // The tool is a convenience: a profile without the tool registry still gets
    // the panel.
    if (typeof tools?.register !== 'function') return;
    scope.effect(() => tools.register(buildTool(shelf)), 'bookshelf: tool');
  });

  // The Host's own translation routing (anonymous Google/Bing, or the account's
  // paid route). Optional: a profile without it still gets a working reader.
  ctx.inject(['translator'], (scope) => {
    const translator = scope.get('translator');
    if (typeof translator?.translate !== 'function') return;
    shelf.translator = translator;
    scope.effect(() => () => {
      if (shelf.translator === translator) shelf.translator = undefined;
    }, 'bookshelf: translator');
  });

  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection');
    if (typeof connection?.fetch?.register !== 'function') {
      ctx.logger?.warn?.('bookshelf: no connection.fetch service; the panel will not reach the host');
      return;
    }
    const register = (path, methods, handler) => {
      scope.effect(() => connection.fetch.register({
        path: `${API}/${path}`,
        methods,
        requestBody: 'buffered',
        fetch: handler,
      }), `bookshelf: ${path}`);
    };

    register('state', ['POST'], route(async (request, store) => {
      const body = await jsonBody(request);
      const cooling = store.blockedUntil > Date.now();
      const wanted = body.refresh === true || store.shelf.userId !== store.prefs.doubanUserId;
      // Any Douban failure is reported through `notice` on the payload rather
      // than as a 500: the panel must still show the cached shelf, the library
      // and the settings form.
      if (wanted) await store.refresh().catch((error) => store.recordFailure(error));
      else if (store.shelf.books.length === 0 && !cooling) await store.refresh().catch((error) => store.recordFailure(error));
      if (store.library.scannedAt === 0) {
        await store.scan().catch(() => {});
      }
      // A restart interrupts the queue; the next panel load picks it up again.
      if (store.prefs.doubanUserId !== ''
        && store.blockedUntil <= Date.now()
        && store.shelf.books.some((book) => book.detail === undefined)) {
        store.startFilling();
      }
      return ok(store.state());
    }));

    // Translating on demand, chapter by chapter: the panel only ever sends the
    // paragraphs the reader is looking at, so opening a book costs one chapter.
    register('translate', ['POST'], route(async (request, store) => {
      const body = await jsonBody(request);
      if (!Array.isArray(body.texts)) throw new Error('缺少要翻译的段落');
      if (body.texts.length > TRANSLATE_MAX_TEXTS) throw new Error(`一次最多翻译 ${TRANSLATE_MAX_TEXTS} 段`);
      const texts = body.texts
        .filter((text) => typeof text === 'string')
        .map((text) => text.trim())
        .filter((text) => text !== '');
      if (texts.length === 0) return ok({ translations: [], provider: '', failed: 0, cached: 0, pending: 0 });
      const chars = texts.reduce((total, text) => total + text.length, 0);
      if (chars > TRANSLATE_MAX_BATCH_CHARS) throw new Error('这一批文字太多，请分批翻译');
      const target = textField(body, 'target') ?? (looksChinese(texts.join('')) ? 'en' : 'zh-CN');
      return ok(await store.translateTexts(texts, target));
    }));

    register('refresh', ['POST'], route(async (_request, store) => {
      // Skip the cover pass when the shelf already has art for every book: a
      // repeat refresh then costs a single request.
      const covered = store.shelf.books.every((book) => book.cover !== undefined);
      const summary = await store.refresh({ userId: store.prefs.doubanUserId, withCovers: !covered })
        .catch((error) => { store.recordFailure(error); return { error: store.lastError }; });
      if (store.library.scannedAt > 0) await store.scan().catch(() => {});
      return ok({ ...summary, state: store.state() });
    }));

    register('prefs', ['POST'], route(async (request, store) => {
      const body = await jsonBody(request);
      const patch = {};
      if (body.doubanUserId !== undefined) {
        const value = textField(body, 'doubanUserId');
        if (value === undefined || !/^[A-Za-z0-9_-]{2,64}$/.test(value)) throw new Error('豆瓣 ID 格式不正确');
        patch.doubanUserId = value;
      }
      if (body.libraryDir !== undefined) {
        const value = textField(body, 'libraryDir');
        patch.libraryDir = value ?? '';
      }
      await store.writePrefs(patch);
      // Both are best effort from here: the preferences are already on disk, so
      // a refused Douban read or an unreadable folder must not report failure.
      if (patch.doubanUserId !== undefined) {
        await store.refresh({ userId: patch.doubanUserId }).catch((error) => store.recordFailure(error));
      }
      if (patch.libraryDir !== undefined) await store.scan().catch(() => {});
      return ok(store.state());
    }));

    register('detail', ['POST'], route(async (request, store) => {
      const body = await jsonBody(request);
      const subjectId = textField(body, 'subjectId');
      const book = store.shelf.books.find((entry) => entry.subjectId === subjectId);
      if (book === undefined) throw new Error('书架上没有这本书');
      if (book.detail === undefined) {
        // Do not spend a request on a page that just failed: repeat clicks would
        // otherwise keep Douban's rate limiter angry.
        const recent = book.detailError !== undefined
          && typeof book.detailTriedAt === 'number'
          && Date.now() - book.detailTriedAt < DETAIL_RETRY_MS;
        if (recent && store.blockedUntil <= Date.now()) throw new Error(book.detailError);
        if (!recent) await store.fetchDetail(book);
      }
      await store.writeShelf();
      return ok(store.state());
    }));

    register('library/scan', ['POST'], route(async (_request, store) => {
      await store.scan();
      return ok(store.state());
    }));

    register('library/read', ['POST'], route(async (request, store) => {
      const body = await jsonBody(request);
      const subjectId = textField(body, 'subjectId');
      const fileId = textField(body, 'fileId');
      if (subjectId !== undefined) return ok(await store.readForBook(subjectId));
      const file = store.findFile(fileId);
      if (file === undefined) throw new Error('找不到这个文件，请重新扫描书库');
      const target = store.validatePath(file);
      // A PDF can be read as the original page or as extracted text; the text
      // form is what makes translation possible, so it is a separate request.
      if (textField(body, 'mode') === 'text') {
        if (file.ext !== '.pdf') throw new Error('只有 PDF 需要提取文字');
        const key = `${file.id}:${file.mtime}`;
        const cached = store.pdfText.get(key);
        const extracted = cached ?? await readPdfText(target);
        if (cached === undefined) {
          store.pdfText.set(key, extracted);
          if (store.pdfText.size > 8) store.pdfText.delete(store.pdfText.keys().next().value);
        }
        return ok({ ...extracted, file: publicFile(file) });
      }
      const payload = await readBook(target);
      return ok({ ...payload, file: publicFile(file) });
    }));

    register('library/upload', ['POST'], route(async (request, store) => {
      const body = await jsonBody(request);
      const name = textField(body, 'filename');
      const data = textField(body, 'data');
      if (name === undefined || data === undefined) throw new Error('缺少文件名或内容');
      const ext = extname(name).toLowerCase();
      if (!isReadable(ext)) throw new Error('只支持 EPUB、PDF、TXT 三种格式');
      // Buffer.from never throws on bad base64: a truncated body would be
      // written as a corrupt book, so the encoding is checked up front.
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) throw new Error('文件内容不是有效的 base64');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length === 0) throw new Error('文件是空的');
      if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('文件超过 80 MB，请直接放进书库目录');
      const stem = safeFileStem(textField(body, 'title') ?? name, ext);
      const dir = await store.libraryTarget();
      const target = await writeUnique(dir, stem, ext, bytes);
      await store.scan();
      return ok({ saved: target, state: store.state() });
    }));

    // Cards need a title before the user can tell one paper from another; the
    // panel asks for the ones it is about to draw.
    register('paper/meta', ['POST'], route(async (request, store) => {
      const body = await jsonBody(request);
      const ids = Array.isArray(body.fileIds) ? body.fileIds.filter((id) => typeof id === 'string').slice(0, 40) : [];
      const meta = {};
      for (const id of ids) {
        const file = store.findFile(id);
        if (file === undefined) continue;
        meta[id] = await store.paperInfo(store.validatePath(file));
      }
      return ok({ meta });
    }));

    register('paper/page', ['GET'], route(async (request, store) => {
      const url = new URL(request.url);
      const file = store.findFile(url.searchParams.get('fileId') ?? '');
      if (file === undefined) return new Response('no file', { status: 404 });
      const page = Number(url.searchParams.get('page'));
      const bytes = await store.paperPage(store.validatePath(file), page);
      if (bytes === undefined) return new Response('no page', { status: 404 });
      return new Response(bytes, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'private, max-age=86400',
          'x-content-type-options': 'nosniff',
        },
      });
    }));

    register('paper/cover', ['GET'], route(async (request, store) => {
      const url = new URL(request.url);
      const file = store.findFile(url.searchParams.get('fileId') ?? '');
      if (file === undefined) return new Response('no file', { status: 404 });
      const bytes = await store.paperCover(store.validatePath(file));
      if (bytes === undefined) return new Response('no cover', { status: 404 });
      return new Response(bytes, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'private, max-age=86400',
          'x-content-type-options': 'nosniff',
        },
      });
    }));

    register('library/rename', ['POST'], route(async (request, store) => {
      const body = await jsonBody(request);
      const file = store.findFile(textField(body, 'fileId'));
      if (file === undefined) throw new Error('找不到这个文件');
      store.validatePath(file);
      const wanted = textField(body, 'name');
      if (wanted === undefined) throw new Error('文件名不能为空');
      // Same rules a file manager applies: no separators, no control
      // characters, and never a leading dot — the scanner skips dot entries,
      // so `..foo` would rename the file out of existence.
      const stem = wanted
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/[\u0000-\u001f]/g, '')
        .trim()
        .replace(/^\.+/, '')
        .trim();
      if (stem === '') throw new Error('文件名不能为空');
      const saved = await store.renameFile(file, stem);
      await store.scan();
      // The id is derived from the path, so a rename changes it: the panel
      // needs both sides to carry the reading position across.
      const next = store.library.files.find((entry) => entry.path === saved);
      return ok({ saved, from: file.id, to: next?.id, state: store.state() });
    }));

    register('library/delete', ['POST'], route(async (request, store) => {
      const body = await jsonBody(request);
      const file = store.findFile(textField(body, 'fileId'));
      if (file === undefined) throw new Error('找不到这个文件');
      store.validatePath(file);
      const moved = await store.trashFile(file);
      await store.scan();
      return ok({ moved, from: file.id, state: store.state() });
    }));

    register('library/reveal', ['POST'], route(async (request, store) => {
      const body = await jsonBody(request);
      if (body.dir === true) {
        const target = await store.libraryTarget();
        if (process.platform !== 'darwin') throw new Error('当前系统暂不支持一键打开');
        await new Promise((resolveOpen, rejectOpen) => {
          execFile('open', [target], (error) => {
            if (error === null) resolveOpen(undefined);
            else rejectOpen(new Error(`打开失败：${error.message}`));
          });
        });
        return ok({ opened: true, dir: target });
      }
      const file = store.findFile(textField(body, 'fileId'));
      if (file === undefined) throw new Error('找不到这个文件');
      store.validatePath(file);
      if (process.platform !== 'darwin') throw new Error('当前系统暂不支持一键打开');
      await new Promise((resolveOpen, rejectOpen) => {
        execFile('open', ['-R', file.path], (error) => {
          if (error === null) resolveOpen(undefined);
          else rejectOpen(new Error(`打开失败：${error.message}`));
        });
      });
      return ok({ opened: true });
    }));

    register('sources/search', ['POST'], route(async (request, store) => {
      const body = await jsonBody(request);
      const subjectId = textField(body, 'subjectId');
      const book = store.shelf.books.find((entry) => entry.subjectId === subjectId);
      if (book === undefined) throw new Error('书架上没有这本书');
      const authors = book.detail?.authors ?? [];
      const result = await searchSources({ title: book.title, authors });
      return ok(result);
    }));

    register('sources/download', ['POST'], route(async (request, store) => {
      const body = await jsonBody(request);
      const dir = await store.libraryTarget();
      const saved = await downloadGutenberg({
        id: textField(body, 'id'),
        title: textField(body, 'title'),
        url: textField(body, 'url'),
      }, dir);
      await store.scan();
      return ok({ ...saved, state: store.state() });
    }));

    /**
     * Covers are read from the on-disk cache: the panel can then load them with
     * a plain `<img src>` and no request ever reaches Douban twice.
     */
    register('cover', ['GET'], route(async (request, store) => {
      const url = new URL(request.url);
      const subjectId = url.searchParams.get('subject') ?? '';
      if (!/^\d{3,20}$/.test(subjectId)) return new Response('bad subject', { status: 400 });
      const cached = await store.readCover(subjectId);
      if (cached === undefined) {
        const book = store.shelf.books.find((entry) => entry.subjectId === subjectId);
        const cover = book?.detail?.cover ?? book?.cover;
        if (typeof cover !== 'string') return new Response('no cover', { status: 404 });
        await store.cacheCover(subjectId, cover);
        const retried = await store.readCover(subjectId);
        if (retried === undefined) return new Response('no cover', { status: 404 });
        return new Response(retried.bytes, {
          headers: {
            'content-type': COVER_TYPES.has(retried.contentType) ? retried.contentType : 'image/jpeg',
            'cache-control': 'private, max-age=86400',
            'x-content-type-options': 'nosniff',
          },
        });
      }
      return new Response(cached.bytes, {
        headers: {
          'content-type': COVER_TYPES.has(cached.contentType) ? cached.contentType : 'image/jpeg',
          'cache-control': 'private, max-age=86400',
          'x-content-type-options': 'nosniff',
        },
      });
    }));

    /**
     * A PDF is streamed as bytes; the panel renders it in a viewer frame because
     * a PDF page cannot be expressed as React elements.
     */
    register('file', ['GET'], route(async (request, store) => {
      const url = new URL(request.url);
      const fileId = url.searchParams.get('fileId') ?? '';
      const file = store.findFile(fileId);
      if (file === undefined) return new Response('not found', { status: 404 });
      store.validatePath(file);
      const stats = await fs.stat(file.path);
      const headers = {
        'content-type': contentTypeFor(file.ext),
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        // The bytes come from a user file, so the viewer must never sniff.
        'x-content-type-options': 'nosniff',
      };
      // The browser's PDF viewer asks for byte ranges; honouring them is what
      // keeps a 300 MB book from being read into the Host's memory.
      const range = request.headers.get('range');
      if (range !== null) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match !== null) {
          const size = stats.size;
          const hasStart = match[1] !== '';
          let start = hasStart ? Number.parseInt(match[1], 10) : Math.max(0, size - Number.parseInt(match[2], 10));
          let end = hasStart && match[2] !== '' ? Number.parseInt(match[2], 10) : size - 1;
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
            return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
          }
          end = Math.min(end, size - 1);
          const length = end - start + 1;
          const handle = await fs.open(file.path, 'r');
          try {
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, start);
            return new Response(buffer, {
              status: 206,
              headers: {
                ...headers,
                'content-range': `bytes ${start}-${end}/${size}`,
                'content-length': String(length),
              },
            });
          } finally {
            await handle.close();
          }
        }
      }
      const bytes = await fs.readFile(file.path);
      return new Response(bytes, { headers: { ...headers, 'content-length': String(bytes.length) } });
    }));
  });
}