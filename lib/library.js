/**
 * The local book shelf: discovering ebook files on disk, pairing them with a
 * Douban subject, and turning a file into something the panel can render.
 *
 * The reader never ships a file to the browser as a document. An EPUB is parsed
 * here into chapters of plain paragraphs, a text file is decoded here, and only
 * a PDF is streamed as bytes — that keeps one reading surface for the whole
 * panel instead of an embedded document that would lose the app's theme.
 *
 * @module dsh-bookshelf/library
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** Ebook formats the shelf indexes. */
const BOOK_EXTENSIONS = new Set(['.epub', '.pdf', '.txt', '.mobi', '.azw3', '.azw', '.djvu', '.fb2', '.chm']);

/** Formats the panel can render inline. */
const READABLE_EXTENSIONS = new Set(['.epub', '.pdf', '.txt']);

/** Directory depth a scan descends into. */
const MAX_SCAN_DEPTH = 4;

/** Files one scan may index, so a mistaken directory cannot stall the panel. */
const MAX_SCAN_FILES = 4000;

/** Characters of one EPUB chapter the panel keeps. */
const MAX_CHAPTER_CHARS = 40000;

/** Characters of one whole EPUB the panel keeps. */
const MAX_BOOK_CHARS = 900000;

/** Largest file the panel will parse in memory; bigger ones are refused. */
const MAX_READ_BYTES = 48 * 1024 * 1024;

/**
 * Whether the panel can render this file itself.
 * @param ext - lower-case extension with the dot.
 * @returns true for the formats with an inline reader.
 */
export function isReadable(ext) {
  return READABLE_EXTENSIONS.has(String(ext).toLowerCase());
}

/**
 * The HTTP content type for a file the host streams.
 * @param ext - lower-case extension with the dot.
 * @returns a media type.
 */
export function contentTypeFor(ext) {
  switch (String(ext).toLowerCase()) {
    case '.pdf': return 'application/pdf';
    case '.epub': return 'application/epub+zip';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

/**
 * Walk a directory and index every ebook file it contains.
 * @param dir - absolute directory path.
 * @param options - cancellation.
 * @returns the indexed files plus any non-fatal read failure.
 */
export async function scanLibrary(dir, options = {}) {
  const { signal } = options;
  const files = [];
  let skipped = 0;
  const visited = new Set();

  /**
   * Index one directory level.
   * @param current - absolute directory path.
   * @param depth - remaining depth budget.
   */
  const walk = async (current, depth) => {
    if (depth > MAX_SCAN_DEPTH || files.length >= MAX_SCAN_FILES) return;
    if (signal?.aborted === true) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      skipped += 1;
      return;
    }
    const real = await fs.realpath(current).catch(() => current);
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!BOOK_EXTENSIONS.has(ext)) continue;
      let stat;
      try {
        stat = await fs.stat(path);
      } catch {
        skipped += 1;
        continue;
      }
      const rel = relative(dir, path).split(sep).join('/');
      files.push({
        id: createHash('sha1').update(rel).digest('hex').slice(0, 16),
        name: entry.name,
        rel,
        path,
        ext,
        size: stat.size,
        mtime: stat.mtimeMs,
        title: guessTitle(entry.name),
        author: guessAuthor(entry.name),
        readable: isReadable(ext),
      });
    }
  };

  await walk(dir, 0);
  files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hans-CN'));
  return { files, skipped, scannedAt: Date.now() };
}

/**
 * The title a filename most likely carries.
 * @param name - file name including its extension.
 * @returns the cleaned title.
 */
export function guessTitle(name) {
  let title = name.slice(0, name.length - extname(name).length);
  title = title.replace(/^[\s._-]+|[\s._-]+$/g, '');
  title = title.replace(/[（(【\[]\s*(?:epub|pdf|mobi|azw3|精校|全本|完结|校对版|文字版)\s*[)）】\]]/gi, '');
  title = title.replace(/\s*[-–—]\s*(?:epub|pdf|mobi|azw3)\s*$/i, '');
  return title.trim() === '' ? name : title.trim();
}

/**
 * The author a `作者 - 书名` or `书名 - 作者` filename carries, when it is
 * confident enough to display.
 * @param name - file name including its extension.
 * @returns the author, or undefined.
 */
export function guessAuthor(name) {
  const stem = name.slice(0, name.length - extname(name).length);
  const parts = stem.split(/\s+-\s+/);
  if (parts.length !== 2) return undefined;
  const [left, right] = parts.map((part) => part.trim());
  // Chinese names are short; a long side is the title, the short side the author.
  const short = left.length <= right.length ? left : right;
  if (short.length === 0 || short.length > 16) return undefined;
  if (/\d/.test(short)) return undefined;
  return short;
}

/**
 * Normalize text for loose comparison: keep letters, digits and CJK only.
 * @param text - any label.
 * @returns the comparison key.
 */
export function normalizeKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u4e00-\u9fff]/g, (ch) => ch)
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

/**
 * Pair shelf rows with indexed files by ISBN first, then by title.
 * @param books - shelf rows, each with an id and a title.
 * @param files - indexed files.
 * @returns book id → matching files, best first.
 */
export function matchLibrary(books, files) {
  /** bookId → array of matches */
  const matches = new Map();
  const used = new Set();
  const index = files.map((file) => ({
    file,
    nameKey: normalizeKey(file.title),
    pathKey: normalizeKey(file.name),
  }));

  for (const book of books) {
    const found = [];
    const isbn = normalizeKey(book.isbn);
    const titleKey = normalizeKey(book.title);
    for (const entry of index) {
      if (used.has(entry.file.id)) continue;
      if (isbn !== undefined && isbn.length >= 10 && entry.pathKey.includes(isbn)) {
        found.push({ file: entry.file, reason: 'isbn' });
        continue;
      }
      if (titleKey.length < 3) continue;
      if (entry.nameKey.includes(titleKey) || titleKey.includes(entry.nameKey)) {
        if (entry.nameKey.length >= 3) found.push({ file: entry.file, reason: 'title' });
      }
    }
    if (found.length > 0) {
      found.sort((a, b) => Number(b.reason === 'isbn') - Number(a.reason === 'isbn'));
      matches.set(book.id, found);
      used.add(found[0].file.id);
    }
  }
  return matches;
}

/**
 * Render one indexed file for the panel's reader.
 * @param file - an entry produced by {@link scanLibrary}.
 * @returns the reader payload; `kind` tells the client which surface to draw.
 */
export async function readBook(file) {
  if (file.ext === '.epub') return await readEpub(file.path);
  if (file.ext === '.txt') return await readTextFile(file.path);
  if (file.ext === '.pdf') return { kind: 'pdf', fileId: file.id };
  return { kind: 'unsupported', ext: file.ext };
}

/** Where poppler's tools usually live, in the order the panel tries them. */
const POPPLER_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

/** Tool name → resolved path ('' means "looked for it and it is not there"). */
const popplerBinaries = new Map();

/**
 * Locate one of poppler's command line tools.
 *
 * An app started from Finder gets a minimal `PATH` that usually lacks
 * Homebrew, so the common install locations are checked before `PATH`.
 * @param name - `pdftotext`, `pdfinfo` or `pdftoppm`.
 * @returns the binary path, or undefined when poppler is not installed.
 */
async function findPoppler(name) {
  const known = popplerBinaries.get(name);
  if (known !== undefined) return known === '' ? undefined : known;
  for (const dir of POPPLER_DIRS) {
    const candidate = `${dir}/${name}`;
    // 1 is X_OK; the promise API does not re-export the constants object.
    const found = await fs.access(candidate, 1).then(() => true, () => false);
    if (found) {
      popplerBinaries.set(name, candidate);
      return candidate;
    }
  }
  popplerBinaries.set(name, '');
  return undefined;
}

/** Run one poppler tool and return its stdout. */
async function runPoppler(name, args, options = {}) {
  const binary = await findPoppler(name);
  if (binary === undefined) {
    throw new Error(`需要 poppler（${name}）：brew install poppler，装好后重启 Harness`);
  }
  return await new Promise((resolveRun, rejectRun) => {
    execFile(binary, args, { timeout: 30000, maxBuffer: 48 * 1024 * 1024, ...options }, (error, stdout) => {
      if (error === null) {
        resolveRun(stdout);
        return;
      }
      if (error.killed === true) {
        rejectRun(new Error(`${name} 处理这个 PDF 超时`));
        return;
      }
      rejectRun(new Error(`${name} 读取 PDF 失败：${String(error.message).split('\n')[0]}`));
    });
  });
}

/**
 * Run pdftotext over one file.
 * @param path - absolute PDF path.
 * @returns the extracted text, pages separated by a form feed.
 */
async function runPdfToText(path) {
  return await runPoppler('pdftotext', ['-enc', 'UTF-8', path, '-']);
}

/** Median of a numeric list. */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Labels that are not prose: `(a)`, `5.1`, `[12]`, `Fig. 2`. */
const PDF_LABEL = /^[([]?(?:[a-z]|\d{1,3}(?:\.\d{1,3})*|[ivx]{1,4})[)\].:]?$/i;

/** A paragraph longer than this reads as a wall of text and translates badly. */
const PDF_PARAGRAPH_MAX = 900;

/**
 * Break a wall of text into paragraphs at sentence boundaries.
 *
 * A two-column page often reaches the extractor with no blank lines at all, so
 * one "paragraph" becomes an entire page. Cutting at sentence ends keeps every
 * sentence intact while giving the reader and the translator usable units.
 * @param text - the block.
 * @returns one or more paragraphs.
 */
function splitLongParagraph(text) {
  if (text.length <= PDF_PARAGRAPH_MAX) return [text];
  const sentences = text.split(/(?<=[.!?。！？])\s+/);
  const out = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > PDF_PARAGRAPH_MAX) {
      if (current !== '') {
        out.push(current);
        current = '';
      }
      for (let index = 0; index < sentence.length; index += PDF_PARAGRAPH_MAX) {
        out.push(sentence.slice(index, index + PDF_PARAGRAPH_MAX));
      }
      continue;
    }
    if (current !== '' && current.length + sentence.length + 1 > PDF_PARAGRAPH_MAX) {
      out.push(current);
      current = sentence;
      continue;
    }
    current = current === '' ? sentence : `${current} ${sentence}`;
  }
  if (current !== '') out.push(current);
  return out;
}

/**
 * Split one page into paragraphs.
 *
 * `pdftotext` without `-layout` reflows the columns correctly but only leaves a
 * blank line between real paragraphs, while titles, headings and figure captions
 * are separated by a single newline. A line much shorter than the page's typical
 * line is therefore treated as the end of a block.
 * @param page - the page's raw text.
 * @returns paragraphs in reading order.
 */
function pdfParagraphs(page) {
  const lines = page.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim());
  const typical = median(lines.filter((line) => line !== '').map((line) => line.length));
  const limit = Math.min(52, typical * 0.55);
  const out = [];
  let current = [];
  const flush = () => {
    const text = current.join(' ').replace(/\s{2,}/g, ' ').trim();
    current = [];
    if (text === '' || !/[\p{L}\p{N}]/u.test(text)) return;
    if (PDF_LABEL.test(text)) return;
    out.push(...splitLongParagraph(text));
  };
  for (const line of lines) {
    if (line === '') {
      flush();
      continue;
    }
    current.push(line);
    // A table-of-contents line stays with its neighbours instead of splitting.
    const toc = /\.{4,}/.test(line) || /\s\d{1,3}$/.test(line);
    if (!toc && line.length < limit) flush();
  }
  flush();
  return out;
}

/** A document title that is really a file name, or a placeholder. */
const PDF_JUNK_TITLE = /^(untitled|无标题|document|Microsoft Word|powerpoint|slide\s*\d*|幻灯片\s*\d*|book\s*1)$/i;

/**
 * Whether a candidate reads like a real document title.
 *
 * Extracted text is not always trustworthy: scanned or CID-encoded PDFs come out
 * as spaced fragments, exports leave template placeholders such as `＃industryId＃`,
 * and a contract number is not a title. Anything rejected falls back to the file
 * name, which the user typed in the first place.
 * @param title - the candidate.
 * @returns true when it looks usable.
 */
function plausibleTitle(title) {
  const text = title.replace(/\s+/g, ' ').trim();
  if (text.length < 6 || text.length > 200) return false;
  if (PDF_JUNK_TITLE.test(text)) return false;
  if (/\.(docx?|pdf|tex|dvi|pptx?|rtf)$/i.test(text)) return false;
  if (/[＃#]\s*[A-Za-z][A-Za-z0-9]*\s*[＃#]/.test(text)) return false;
  if (/^(?:\(|（)?\s*(?:合同|编号|日期|No\.?|Doc)/i.test(text)) return false;
  if ((text.match(/[\u4e00-\u9fff] [\u4e00-\u9fff]/g) ?? []).length >= 3) return false;
  if (/[|｜]/.test(text)) return false;
  if (/\s{2,}/.test(title)) return false;
  return true;
}

/**
 * The most title-looking lines at the top of page one, before the abstract.
 * @param file - an entry produced by {@link scanLibrary}.
 * @returns the guessed title, or an empty string.
 */
async function titleFromFirstPage(file) {
  const text = await runPoppler('pdftotext', ['-f', '1', '-l', '1', '-enc', 'UTF-8', file.path, '-']).catch(() => '');
  const lines = text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line !== '');
  const stop = lines.findIndex((line) => /^(abstract|summary|摘要|contents|目录|introduction|1\.?\s+introduction)\b/i.test(line));
  const head = (stop > 0 ? lines.slice(0, stop) : lines.slice(0, 6))
    .filter((line) => !/^arxiv:/i.test(line) && !/^https?:/i.test(line) && !line.includes('@') && line.length > 1);
  // A title runs over one or two long lines; the author block under it is short.
  // So once enough of a title is on hand, a short line ends the title.
  const picked = [];
  for (const line of head) {
    if (picked.length > 0 && picked.join(' ').length >= 25 && line.length < 45) break;
    picked.push(line);
    if (picked.length >= 3) break;
  }
  const title = picked.join(' ').replace(/[\s:.,;]+$/, '').trim();
  return plausibleTitle(title) ? title.slice(0, 160) : '';
}

/**
 * Read a PDF's title, authors and page count.
 *
 * Most papers carry no `/Title` in their metadata, so the first page's text is
 * the fallback — that is where the title actually is.
 * @param file - an entry produced by {@link scanLibrary}.
 * @returns `{ title, authors, pages }`; `title` may be empty.
 */
export async function readPdfMeta(file) {
  const meta = { title: '', authors: [], pages: undefined };
  const info = await runPoppler('pdfinfo', ['-enc', 'UTF-8', file.path]).catch(() => '');
  const fields = new Map();
  for (const line of info.split('\n')) {
    const index = line.indexOf(':');
    if (index > 0) fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const pages = Number(fields.get('Pages'));
  if (Number.isFinite(pages) && pages > 0) meta.pages = pages;
  const title = fields.get('Title') ?? '';
  if (plausibleTitle(title) && title.replace(/\.[^.]+$/, '') !== file.name.replace(/\.[^.]+$/, '')) {
    meta.title = title.replace(/\s+/g, ' ').slice(0, 200);
  }
  const author = fields.get('Author') ?? '';
  if (author !== '') {
    meta.authors = author.split(/[;,]/).map((name) => name.trim()).filter(Boolean).slice(0, 3);
  }
  if (meta.title === '') meta.title = await titleFromFirstPage(file);
  return meta;
}

/**
 * Render the first page of a PDF as a card cover.
 * @param file - an entry produced by {@link scanLibrary}.
 * @param outPath - where the PNG should end up (`.png`).
 * @returns true when the image was written.
 */
export async function renderPdfCover(file, outPath) {
  const prefix = outPath.replace(/\.png$/i, '');
  try {
    await runPoppler('pdftoppm', [
      '-png', '-singlefile', '-r', '72', '-f', '1', '-l', '1', '-scale-to', '480',
      file.path, prefix,
    ]);
  } catch {
    return false;
  }
  return await fs.stat(outPath).then((stat) => stat.size > 0, () => false);
}

/**
 * Render one page of a PDF as an image, for the reader's original-page pane.
 *
 * Rendering beats embedding the PDF viewer here: the pane only ever shows the
 * page the text is on, so a still image needs no viewer state, loads instantly
 * from the disk cache, and keeps the panel's own chrome around it.
 * @param file - an entry produced by {@link scanLibrary}.
 * @param page - 1-based page number.
 * @param outPath - where the PNG should end up (`.png`).
 * @returns the PNG bytes, or undefined when it cannot be rendered.
 */
export async function renderPdfPage(file, page, outPath) {
  if (!Number.isInteger(page) || page < 1) return undefined;
  const prefix = outPath.replace(/\.png$/i, '');
  try {
    await runPoppler('pdftoppm', [
      '-png', '-singlefile', '-r', '120', '-f', String(page), '-l', String(page), file.path, prefix,
    ]);
  } catch {
    return undefined;
  }
  const bytes = await fs.readFile(outPath).catch(() => undefined);
  return bytes !== undefined && bytes.length > 0 ? bytes : undefined;
}

/**
 * Turn a PDF's text layer into readable chapters, one per page.
 *
 * A paper is usually two-column, so the extractor runs without `-layout`: the
 * reflowed order is what reads correctly, while a layout-preserving dump would
 * interleave the columns with wide indentation.
 * @param file - an entry produced by {@link scanLibrary}.
 * @returns an EPUB-shaped reader payload with `source: 'pdf'`.
 */
export async function readPdfText(file) {
  await assertReadableSize(file.path, MAX_READ_BYTES);
  const text = await runPdfToText(file.path);
  const chapters = [];
  text.split('\f').forEach((page, index) => {
    const paragraphs = pdfParagraphs(page);
    if (paragraphs.length > 0) chapters.push({ title: `第 ${index + 1} 页`, paragraphs });
  });
  if (chapters.length === 0) throw new Error('这个 PDF 没有文字层（大概是扫描件），提取不出可翻译的正文');
  return { kind: 'epub', source: 'pdf', pageCount: chapters.length, chapters };
}

/**
 * Decode a text file, falling back to GB18030 for legacy Chinese files.
 * @param path - absolute file path.
 * @returns text reader payload.
 */
async function readTextFile(path) {
  await assertReadableSize(path, MAX_READ_BYTES);
  const bytes = await fs.readFile(path);
  let text = new TextDecoder('utf-8').decode(bytes);
  if (countReplacement(text) > text.length / 200) {
    try {
      text = new TextDecoder('gb18030').decode(bytes);
    } catch {
      // Full ICU missing: keep the UTF-8 reading rather than failing.
    }
  }
  return { kind: 'text', text: text.length > MAX_BOOK_CHARS ? `${text.slice(0, MAX_BOOK_CHARS)}\n…` : text };
}

/**
 * Count the replacement characters a wrong decoding produces.
 * @param text - decoded text.
 * @returns the count.
 */
function countReplacement(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 0xfffd) count += 1;
  return count;
}

/**
 * Parse an EPUB into chapters of paragraphs.
 * @param path - absolute .epub path.
 * @returns the reader payload.
 */
export async function readEpub(path) {
  await assertReadableSize(path, MAX_READ_BYTES);
  const zip = openZip(new Uint8Array(await fs.readFile(path)));
  const container = textEntry(zip, 'META-INF/container.xml');
  const opfPath = container === undefined
    ? undefined
    : /<rootfile[^>]*full-path="([^"]+)"/i.exec(container)?.[1];
  if (opfPath === undefined) return { kind: 'unsupported', ext: '.epub', reason: 'missing-opf' };
  const opf = textEntry(zip, opfPath);
  if (opf === undefined) return { kind: 'unsupported', ext: '.epub', reason: 'unreadable-opf' };

  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = new Map();
  for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = match[0];
    const id = /\bid="([^"]+)"/i.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/i.exec(tag)?.[1];
    if (id !== undefined && href !== undefined) manifest.set(id, decodeEntities(href));
  }
  const spineIds = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/gi)].map((match) => match[1]);
  const bookTitle = decodeEntities(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1] ?? '').trim();

  const chapters = [];
  let budget = MAX_BOOK_CHARS;
  const ordered = spineIds.length > 0 ? spineIds.map((id) => manifest.get(id)).filter(Boolean) : [...manifest.values()];
  for (const [index, href] of ordered.entries()) {
    if (budget <= 0) break;
    const name = resolveZipPath(baseDir, href);
    const html = textEntry(zip, name);
    if (html === undefined) continue;
    const paragraphs = htmlToParagraphs(html).slice(0, 400);
    if (paragraphs.length === 0) continue;
    let text = paragraphs.join('\n');
    if (text.length > Math.min(MAX_CHAPTER_CHARS, budget)) {
      text = text.slice(0, Math.min(MAX_CHAPTER_CHARS, budget));
    }
    budget -= text.length;
    const heading = chapterHeading(html) ?? `第 ${chapters.length + 1} 节`;
    chapters.push({ index, title: heading, paragraphs: text.split('\n') });
  }
  if (chapters.length === 0) return { kind: 'unsupported', ext: '.epub', reason: 'empty-spine' };
  return { kind: 'epub', title: bookTitle, chapters };
}

/**
 * Join a href in the OPF against the OPF's own directory.
 * @param baseDir - directory prefix inside the archive.
 * @param href - relative href.
 * @returns the archive entry name.
 */
function resolveZipPath(baseDir, href) {
  const raw = href.split('#')[0];
  // HREFs are URL-encoded ("text/ch%202.xhtml"); archive entry names are not.
  let clean = raw;
  try {
    clean = decodeURIComponent(raw);
  } catch {
    // A stray '%' is not an escape: keep the literal href.
  }
  if (clean.startsWith('/')) return clean.slice(1);
  const parts = `${baseDir}${clean}`.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * The chapter's own heading.
 * @param html - chapter markup.
 * @returns the heading text, or undefined.
 */
function chapterHeading(html) {
  const heading = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
  if (heading !== null) {
    const text = decodeEntities(heading[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (text !== '') return text.slice(0, 120);
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title !== null) {
    const text = decodeEntities(title[1]).replace(/\s+/g, ' ').trim();
    if (text !== '') return text.slice(0, 120);
  }
  return undefined;
}

/**
 * Turn chapter markup into one paragraph per element.
 * @param html - chapter markup.
 * @returns paragraphs of plain text.
 */
export function htmlToParagraphs(html) {
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n?/g, '\n');
  return decodeEntities(text)
    .split(/\n{2,}/)
    .map((part) => part.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((part) => part !== '');
}

/**
 * Read one archive entry as UTF-8 text.
 * @param zip - archive handle.
 * @param name - entry name.
 * @returns the text, or undefined when absent.
 */
function textEntry(zip, name) {
  const bytes = zip.read(name);
  if (bytes === undefined) return undefined;
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Minimal ZIP reader: central-directory walk plus raw inflate.
 * EPUB is a ZIP, and reading one must not add a dependency to this bundle.
 * @param bytes - the archive bytes.
 * @returns an object exposing the entry names and a reader for one entry.
 */
export function openZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('不是有效的 EPUB（缺少中央目录）');
  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  let cursor = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.set(name, { method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return {
    names: [...entries.keys()],
    /**
     * Extract one entry's bytes.
     * @param name - entry name.
     * @returns the bytes, or undefined when the entry is absent.
     */
    read(name) {
      const entry = entries.get(name);
      if (entry === undefined) return undefined;
      const local = entry.localOffset;
      if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) return undefined;
      const nameLength = view.getUint16(local + 26, true);
      const extraLength = view.getUint16(local + 28, true);
      const start = local + 30 + nameLength + extraLength;
      const data = bytes.subarray(start, start + entry.compressedSize);
      if (entry.method === 0) return data;
      if (entry.method === 8) return new Uint8Array(inflateRawSync(data));
      return undefined;
    },
  };
}

/**
 * Locate the end-of-central-directory record.
 * @param view - archive bytes.
 * @returns its offset, or -1.
 */
function findEocd(view) {
  const limit = Math.max(0, view.byteLength - 0xffff - 22);
  for (let offset = view.byteLength - 22; offset >= limit; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

/**
 * Decode the entity forms EPUB XHTML uses.
 * @param text - text containing entities.
 * @returns decoded text.
 */
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

/**
 * A numeric character reference as text, refusing code points String.fromCodePoint
 * would throw on (surrogates, > 0x10FFFF).
 * @param value - parsed code point.
 * @returns the character, or U+FFFD.
 */
function codePoint(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff) return '\uFFFD';
  if (value >= 0xd800 && value <= 0xdfff) return '\uFFFD';
  return String.fromCodePoint(value);
}

/**
 * Refuse books large enough to threaten the Host process, before reading them.
 * @param path - absolute file path.
 * @param limit - bytes allowed.
 * @throws Error with a message meant for the panel.
 */
async function assertReadableSize(path, limit) {
  const stats = await fs.stat(path);
  if (stats.size > limit) {
    throw new Error(`文件过大（${Math.round(stats.size / 1024 / 1024)}MB），超过面板可解析的 ${Math.round(limit / 1024 / 1024)}MB 上限`);
  }
}

/**
 * The on-disk name an attached file is saved under.
 * @param title - book title or uploaded name.
 * @param ext - extension including the dot.
 * @returns a filesystem-safe base name.
 */
export function safeFileStem(title, ext) {
  const stem = basename(String(title ?? 'book'), extname(String(title ?? '')) || ext)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (stem === '' ? 'book' : stem).slice(0, 120);
}