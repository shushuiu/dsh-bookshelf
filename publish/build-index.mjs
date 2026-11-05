#!/usr/bin/env node
/**
 * Build a plugin-market index (format 1) for this bundle.
 *
 * The index is the "upload" in the market model: it is one JSON file served
 * over HTTP that lists package names and exact versions, pointing at npm (the
 * usual case) or at a Git repository pinned to a commit. Hosting the file is
 * all that turns a local plugin into something other people can install from
 * Plugins → Discover.
 *
 * Usage:
 *   node publish/build-index.mjs                          # source: npm
 *   node publish/build-index.mjs --git <repo-url> <sha> [--path <dir>]
 *
 * Writes publish/index.json and prints the install spec the index produces.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

/** The plugin's own display metadata, so the index never drifts from the panel. */
const readMeta = async (language) => JSON.parse(await readFile(join(root, 'locale', `${language}.json`), 'utf8')).meta;
const metaEn = await readMeta('en');
const metaZh = await readMeta('zh');

/** The icon travels inside the index, so the entry renders without extra hosting. */
const iconBytes = await readFile(join(root, manifest.icon ?? 'icon.svg'));
const iconType = (manifest.icon ?? 'icon.svg').endsWith('.svg') ? 'image/svg+xml' : 'image/png';
const icon = `data:${iconType};base64,${iconBytes.toString('base64')}`;

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

const args = process.argv.slice(2);
const gitAt = args.indexOf('--git');
const pathAt = args.indexOf('--path');

/** The metadata this plugin actually satisfies: a name, an exact version, a source. */
const version = manifest.version;
if (!SEMVER.test(version)) {
  throw new Error(`package.json version ${JSON.stringify(version)} is not an exact SemVer version`);
}
if (!PACKAGE_NAME.test(manifest.name)) {
  throw new Error(`package.json name ${JSON.stringify(manifest.name)} is not a valid npm package name`);
}

let source;
let install;
if (gitAt !== -1) {
  const url = args[gitAt + 1];
  const commit = args[gitAt + 2];
  if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/u.test(url)) {
    throw new Error('--git needs a canonical https repository URL, such as https://github.com/you/dsh-bookshelf');
  }
  if (!COMMIT.test(commit ?? '')) {
    throw new Error('--git needs the full lowercase 40-character commit SHA, such as 4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  }
  const directory = pathAt === -1 ? undefined : args[pathAt + 1];
  source = { type: 'git', url, commit, ...(directory === undefined ? {} : { path: directory }) };
  install = `git+${url}.git#${commit}${directory === undefined ? '' : `&path:/${directory}`}`;
} else {
  source = { type: 'npm' };
  install = `${manifest.name}@${version}`;
}

const index = {
  format: 1,
  title: { en: 'My DSH plugin index', zh: '我的 DSH 插件索引' },
  description: {
    en: 'Index of my own DeepSeek Harness plugins.',
    zh: '我自己的 DeepSeek Harness 插件索引。',
  },
  metadata: {
    // Every category a plugin references must be declared here, otherwise the
    // index is rejected as a whole.
    categories: {
      reading: { title: { en: 'Reading & documents', zh: '阅读与文档' } },
    },
  },
  plugins: [
    {
      name: manifest.name,
      // Localized text: a string, or an object keyed by language id that must
      // contain `en`.
      title: { en: metaEn.title, zh: metaZh.title },
      description: { en: metaEn.description, zh: metaZh.description },
      icon,
      author: manifest.author?.name ?? manifest.author ?? undefined,
      homepage: manifest.homepage,
      repository: manifest.repository?.url === undefined ? undefined : { url: manifest.repository.url },
      metadata: { category: 'reading', keywords: manifest.keywords ?? [] },
      versions: [
        {
          version,
          // Unix seconds: the market shows this as the publish date.
          publishTimestamp: Math.floor(Date.now() / 1000),
          source,
          engines: manifest.engines?.dsh === undefined ? {} : { dsh: manifest.engines.dsh },
        },
      ],
    },
  ],
};

/** Drop undefined members so the file stays readable and matches the format. */
const clean = (value) => JSON.parse(JSON.stringify(value, (_key, member) => (member === undefined ? undefined : member)));
const text = JSON.stringify(clean(index), null, 2);

const target = join(here, 'index.json');
await writeFile(target, `${text}\n`, 'utf8');

console.log(`wrote ${target}`);
console.log(`package   ${manifest.name}@${version}`);
console.log(`source    ${JSON.stringify(source)}`);
console.log(`installs  ${install}`);
console.log('');
console.log('Next:');
if (gitAt === -1) {
  console.log('  1. npm login && npm publish          (from the plugin directory)');
  console.log('  2. host publish/index.json over HTTPS (GitHub Pages, jsDelivr over a repo, any static host)');
} else {
  console.log('  1. push the plugin to that repository at that commit');
  console.log('  2. host publish/index.json over HTTPS');
}
console.log('  3. Plugins → Discover → 管理索引源… → paste the index URL → 添加');