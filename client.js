/**
 * dsh-bookshelf — Client half (Web UI).
 *
 * Registers two things on the root scope:
 *   - the 书架 page in the layout's `main` keyed slot under the key `bookshelf`;
 *   - its entry in `sidebar.panellist`, whose id addresses that same key.
 *
 * The page holds no data of its own: every read and write goes through the Host
 * half's `/api/bookshelf/*` routes, so the cache, the Douban session and the
 * user's library live in one place.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bookshelf',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** The Client context, kept so a component can reach services the slot props
     * do not carry (the directory picker lives on `ctx.uiWorkspace`). */
    let clientCtx = null;

    /**
     * Ask the user for a directory with the workspace service, when it exists.
     * @returns the picked absolute path, or null.
     */
    function pickDirectory() {
      // Touching an uninjected service can throw, so this stays inside a guard:
      // the settings form falls back to typing the path.
      let workspace;
      try {
        workspace = clientCtx === null ? undefined : (clientCtx.uiWorkspace ?? clientCtx.get?.('uiWorkspace'));
      } catch {
        workspace = undefined;
      }
      if (typeof workspace?.pickDirectory !== 'function') return Promise.resolve(null);
      return Promise.resolve(workspace.pickDirectory()).catch(() => null);
    }

    /** Locale namespace, and the package name that keys the settings card. */
    const NS = 'bookshelf';
    const PKG = 'dsh-bookshelf';
    /** The `main` slot key and the sidebar entry id; they must match. */
    const PANEL_ID = 'bookshelf';

    /** Text used when the locale service has no entry (or is unavailable). */
    const FALLBACK_TEXT = {
      'panel.label': '书架',
      'panel.title': '书架',
      'panel.wishCount': '想读 {n} 本',
      'panel.readingCount': '在读 {n} 本',
      'panel.tabWish': '想读',
      'panel.tabReading': '在读',
      'panel.wishSince': '想读于 {date}',
      'panel.readingSince': '在读 {date}',
      'panel.tabAll': '全部书籍',
      'panel.tabReadable': '可阅读',
      'panel.tabPending': '待补全',
      'panel.filling': '正在补全详情 {done}/{total}',
      'panel.scan': '扫描书库',
      'reader.extract': '提取文字',
      'reader.extractHint': '提取 PDF 的文字层，换成可翻译的文本模式',
      'reader.original': '原文页',
      'reader.originalOn': '收起右侧原页',
      'reader.originalOff': '在右侧显示原 PDF 页（图表、公式看原样）',
      'reader.originalPage': '原文第 {n} 页',
      'reader.zoom': '放大',
      'reader.zoomOut': '整页',
      'reader.zoomHint': '按栏宽放大，可上下滚动',
      'reader.zoomOutHint': '缩回整页显示',
      'reader.restore': '原文 PDF',
      'reader.restoreHint': '回到 PDF 原版页面',
      'papers.title': '资料',
      'papers.pages': '{n} 页',
      'papers.renameTo': '重命名「{name}」',
      'papers.folder': '打开文件夹',
      'papers.import': '导入资料',
      'papers.hint': '目录：{dir} · 没和书单配对的文件会集中在这里',
      'papers.noDir': '还没有设置书库目录',
      'papers.all': '全部',
      'papers.empty': '这里还没有资料：点「导入资料」加入 PDF、EPUB 或 TXT，也可以直接把文件放进上面的目录。',
      'papers.reveal': '显示',
      'papers.rename': '重命名',
      'papers.delete': '删除',
      'papers.confirmDelete': '确认移走',
      'papers.save': '保存',
      'papers.cancel': '取消',
      'papers.renamed': '已重命名为 {name}',
      'papers.deleted': '已把 {name} 移到书库的 .trash 目录',
      'panel.import': '导入本地书',
      'panel.resume': '续读 第 {n} 节',
      'panel.read': '阅读',
      'panel.emptyReadable': '还没有可阅读的本地文件。把书放进书库目录，或在某本书里点「导入本地文件」。',
      'panel.localCount': '本地 {n} 本',
      'panel.refresh': '刷新',
      'panel.settings': '设置',
      'panel.search': '搜索书名、作者或出版社',
      'panel.loading': '正在读取豆瓣书单…',
      'panel.empty': '这本书单还是空的，或者豆瓣 ID 不存在。',
      'panel.emptySearch': '没有匹配的书。',
      'panel.pending': '读取详情中',
      'detail.loading': '正在读取豆瓣详情…',
      'panel.failed': '详情读取失败',
      'panel.localBadge': '本地',
      'panel.retry': '重试',
      'detail.back': '返回',
      'detail.authors': '作者',
      'detail.translators': '译者',
      'detail.publisher': '出版社',
      'detail.year': '出版年',
      'detail.pages': '页数',
      'detail.price': '定价',
      'detail.binding': '装帧',
      'detail.isbn': 'ISBN',
      'detail.series': '丛书',
      'detail.subtitle': '副标题',
      'detail.rating': '豆瓣评分',
      'detail.summary': '内容简介',
      'detail.douban': '豆瓣页面',
      'detail.read': '开始阅读',
      'detail.reveal': '在文件夹中显示',
      'detail.import': '导入本地文件',
      'detail.importing': '导入中…',
      'detail.imported': '已导入 {name}',
      'detail.files': '本地文件',
      'detail.noFiles': '书库里还没有这本书。你可以导入自己已购买的文件，或查找公版版本。',
      'detail.unsupported': '这个格式暂不支持在线阅读',
      'detail.sources': '查找公版 / 正版渠道',
      'detail.sourcesHint': '只搜索公版书库与书商，不接入盗版书源。',
      'sources.title': '公版与正版渠道',
      'sources.gutenberg': 'Project Gutenberg（公版，可直接下载）',
      'sources.openlibrary': 'Open Library（可借阅 / 购买链接）',
      'sources.channels': '正版渠道',
      'sources.download': '下载到书库',
      'sources.downloading': '下载中…',
      'sources.downloaded': '已保存到 {name}',
      'sources.borrow': '查看',
      'sources.empty': '没有找到匹配的条目。',
      'sources.failed': '检索失败：{error}',
      'sources.downloads': '{n} 次下载',
      'sources.readOnline': '在线阅读',
      'reader.back': '返回',
      'reader.chapter': '章节',
      'reader.prev': '上一节',
      'reader.next': '下一节',
      'reader.unsupported': '这个文件格式无法在面板里阅读，可在文件夹中打开。',
      'reader.pdfHint': 'PDF 由浏览器内置阅读器显示。',
      'reader.smaller': '缩小字号',
      'reader.larger': '放大字号',
      'reader.serif': '在宋体与黑体之间切换',
      'reader.font': '宋',
      'reader.page': '第 {index}/{total} 屏',
      'reader.chapterCount': '共 {n} 节',
      'reader.translate': '译',
      'reader.translateOn': '关闭译文，只看原文',
      'reader.translateOff': '显示译文，原文与译文对照',
      'reader.translating': '译中 {done}/{total}',
      'reader.translateFailed': '译文失败',
      'reader.translateRetry': '重试',
      'reader.translatePartial': '{n} 段未译',
      'settings.title': '书架设置',
      'settings.douban': '豆瓣用户 ID',
      'settings.doubanHint': '填豆瓣个人主页地址里 /people/ 后面的那段，例如 154090935。',
      'settings.library': '书库目录',
      'settings.libraryHint': '存放你自己电子书的目录（epub / pdf / txt）。',
      'settings.libraryDefault': '还没选目录。导入的书会先存到 {dir}；也可以填 ~/Downloads，让下载目录里已有的书直接出现在这里。',
      'settings.quickDownloads': '用下载目录',
      'settings.quickDocuments': '用文稿目录',
      'settings.quickDesktop': '用桌面',
      'settings.pick': '选择目录',
      'settings.pickUnavailable': '这个环境打不开目录选择器，请直接粘贴路径',
      'settings.save': '保存',
      'settings.saved': '已保存',
      'settings.rescan': '重新扫描书库',
      'settings.scanned': '已索引 {n} 个文件，其中 {r} 个可在线阅读',
      'settings.noDir': '未设置',
      'settings.policy': '本插件只读取你自己目录里的文件，以及来自公版书库（Project Gutenberg / Open Library）的合法内容；不接入任何盗版书源。',
      'settings.cardTitle': '书架',
      'settings.cardDesc': '豆瓣用户 ID 与本地书库目录；改完即可在书架页使用。',
    };

    const CSS = `
.bks-root{box-sizing:border-box;position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.bks-head{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:28px clamp(20px,4vw,56px) 0}
[data-platform=darwin] .bks-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.bks-headline{display:flex;align-items:baseline;gap:10px;min-width:0}
.bks-title{margin:0;font-size:24px;font-weight:500;line-height:32px;letter-spacing:.2px}
.bks-count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1)}
.bks-sub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bks-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
.bks-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:6px 12px;border-radius:10px;min-width:180px}
.bks-input::placeholder{color:var(--dsw-alias-label-secondary)}
.bks-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.bks-search{min-width:220px;border-radius:999px}
.bks-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:5px 14px;border-radius:999px;cursor:pointer;white-space:nowrap;transition:border-color .15s,color .15s,background .15s}
.bks-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.bks-btn:disabled{opacity:.5;cursor:default}
.bks-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.bks-btn-primary:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:transparent}
.bks-toolbar{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:18px clamp(20px,4vw,56px) 0}
.bks-tabs{display:flex;align-items:center;gap:4px}
.bks-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;padding:5px 12px;border-radius:999px;cursor:pointer}
.bks-tab:hover{color:var(--dsw-alias-label-primary)}
.bks-tab-on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.bks-toolbar-right{display:flex;align-items:center;gap:8px;margin-left:auto;min-width:0}
.bks-note{margin:8px clamp(20px,4vw,56px) 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.bks-note-error{color:var(--dsw-alias-state-error-primary)}
.bks-body{flex:1 1 auto;min-height:0;overflow-y:auto;scrollbar-gutter:stable}
.bks-inner{padding:22px clamp(20px,4vw,56px) 64px}
.bks-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:30px 26px;align-items:start}
.bks-card{display:flex;flex-direction:column;gap:9px;min-width:0}
.bks-cover-btn,.bks-card-info{display:block;box-sizing:border-box;width:100%;padding:0;margin:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0}
.bks-card-info{display:flex;flex-direction:column;gap:4px}
.bks-cover-btn:focus-visible,.bks-card-info:focus-visible{outline:none}
.bks-cover-btn:focus-visible .bks-cover,.bks-card-info:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary);border-radius:6px}
.bks-cover{position:relative;width:100%;aspect-ratio:2/3;border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;text-align:center;box-shadow:0 6px 18px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);transition:transform .18s ease,box-shadow .18s ease}
.bks-card:hover .bks-cover{transform:translateY(-2px);box-shadow:0 10px 26px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.bks-cover img{width:100%;height:100%;object-fit:cover;display:block}
.bks-cover-fallback{padding:14px;font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.bks-book-title{margin:0;font-size:13px;line-height:19px;font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bks-book-meta{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bks-chips{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.bks-chip{font-size:10px;line-height:16px;padding:0 7px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.bks-chip-on{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent);color:var(--dsw-alias-state-success-primary)}
.bks-chip-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,transparent);color:var(--dsw-alias-state-warn-primary)}
.bks-skel{background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-2));background-size:200% 100%;animation:bks-shimmer 1.4s linear infinite;border-radius:4px;display:block}
@keyframes bks-shimmer{0%{background-position:0 0}100%{background-position:-200% 0}}
.bks-skel-cover{width:100%;aspect-ratio:2/3;border-radius:8px}
.bks-overlay{position:absolute;inset:0;z-index:30;display:flex;align-items:stretch;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-bg-base) 78%,transparent);backdrop-filter:blur(2px)}
.bks-sheet{display:flex;flex-direction:column;width:min(920px,100%);margin:24px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);overflow:hidden;min-height:0}
.bks-sheet-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.bks-sheet-title{font-size:14px;font-weight:500;line-height:20px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bks-sheet-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:16px}
.bks-sheet-foot{display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.bks-detail{display:grid;grid-template-columns:180px minmax(0,1fr);gap:20px}
@media (max-width:620px){.bks-detail{grid-template-columns:minmax(0,1fr)}}
.bks-detail-cover{width:180px;aspect-ratio:2/3;border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:12px;box-shadow:0 8px 22px color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent)}
.bks-detail-cover img{width:100%;height:100%;object-fit:cover;display:block}
.bks-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;font-size:12px;line-height:18px;margin:0}
.bks-kv dt{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.bks-kv dd{margin:0;min-width:0;word-break:break-word}
.bks-section{margin-top:16px}
.bks-section h3{margin:0 0 6px;font-size:13px;font-weight:500;line-height:20px}
.bks-prose{margin:0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.bks-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.bks-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.bks-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.bks-row-title{font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bks-row-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bks-links{display:flex;flex-wrap:wrap;gap:8px}
.bks-link{font-size:12px;line-height:18px;padding:3px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);text-decoration:none;background:transparent;cursor:pointer;font-family:inherit}
.bks-link:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.bks-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.bks-paper-grid{margin-top:4px}
.bks-cover-paper img{object-position:top center}
.bks-paper-tag{position:absolute;left:8px;top:8px;padding:0 5px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 84%,transparent);color:var(--dsw-alias-label-secondary);font-size:9px;line-height:15px;letter-spacing:.04em}
.bks-paper-actions{display:flex;gap:10px;flex-wrap:wrap}
.bks-paper-action{padding:0;border:0;background:none;font:inherit;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.bks-paper-action:hover{color:var(--dsw-alias-brand-primary)}
.bks-paper-action:disabled{opacity:.5;cursor:default}
.bks-paper-action-danger{color:var(--dsw-alias-state-error-primary)}
.bks-paper-rename{display:flex;align-items:center;gap:8px;margin:12px 0 4px;flex-wrap:wrap}
.bks-paper-rename .bks-input{flex:1 1 240px;min-width:0}
.bks-lib-head{display:flex;align-items:center;gap:10px;justify-content:space-between;margin:26px 0 6px;padding-top:18px;border-top:1px solid var(--dsw-alias-border-l1)}
.bks-lib-head h3{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;font-weight:500;line-height:20px}
.bks-lib-actions{display:flex;gap:8px}
.bks-lib-empty{margin-top:2px}
.bks-lib-name{padding:0;border:0;background:none;font:inherit;font-size:12px;line-height:18px;color:inherit;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.bks-lib-name:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}
.bks-lib-name-plain{cursor:default;color:var(--dsw-alias-label-secondary)}
.bks-lib-name-plain:hover{color:var(--dsw-alias-label-secondary);text-decoration:none}
.bks-lib-edit{flex-direction:row;align-items:center;gap:6px}
.bks-lib-edit .bks-input{flex:1 1 auto;min-width:0}
.bks-chip-btn{cursor:pointer;background:none;font:inherit;font-size:10px;line-height:16px;padding:0 7px}
.bks-btn-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent);color:var(--dsw-alias-state-error-primary)}
.bks-note{overflow-wrap:anywhere}
.bks-form{display:flex;flex-direction:column;gap:14px}
.bks-field{display:flex;flex-direction:column;gap:5px}
.bks-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.bks-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bks-inline .bks-input{flex:1 1 240px}
.bks-reader{position:absolute;inset:0;z-index:40;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}
.bks-reader-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.bks-reader-title{flex:1 1 auto;min-width:0;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bks-reader-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.bks-icon-btn{box-sizing:border-box;height:26px;min-width:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:24px;cursor:pointer}
.bks-icon-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.bks-icon-btn:disabled{opacity:.4;cursor:default}
.bks-icon-btn-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
/* The side gutters sit on the wrapper, never on the column box: columns then
   start at the scroll origin, so every spread lines up the same way. */
.bks-reader-viewport{flex:1 1 auto;min-height:0;display:flex;padding:0 clamp(18px,3.2vw,52px);overflow:hidden}
.bks-reader-body{flex:1 1 auto;min-width:0;min-height:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
.bks-pages{box-sizing:border-box;height:100%;column-count:2;column-gap:76px;column-fill:auto;column-rule:1px solid var(--dsw-alias-border-l1);
  padding:32px 0 24px;font-size:var(--bks-reader-size,17px);line-height:1.95;color:var(--dsw-alias-label-primary);
  text-align:justify;text-justify:inter-ideograph;word-break:break-word;hyphens:auto}
.bks-pages-serif{font-family:"Songti SC","Noto Serif SC",Georgia,"Times New Roman",serif}
.bks-pages-sans{font-family:-apple-system,"PingFang SC","Noto Sans SC",system-ui,sans-serif}
@media (max-width:880px){.bks-pages{column-count:1;column-rule:0}}
.bks-pages h2{margin:0 0 .9em;font-size:1.16em;line-height:1.5;font-weight:500;text-align:left;text-indent:0}
.bks-pages h2:not(:first-child){margin-top:1.2em}
.bks-pages p{margin:0;text-indent:2em}
.bks-para{margin:0 0 .95em}
/* The translation sits under its paragraph, quieter than the text it explains. */
.bks-trans{margin:.3em 0 0;padding-left:.1em;font-size:.92em;line-height:1.7;text-indent:2em;
  color:color-mix(in srgb, var(--dsw-alias-label-primary) 58%, transparent);
  font-family:-apple-system,"PingFang SC","Noto Sans SC",sans-serif;text-align:justify;
  text-justify:inter-ideograph}
.bks-pages p:first-of-type{text-indent:2em}
.bks-pages pre{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit;text-indent:0}
.bks-foot-right{display:flex;align-items:center;gap:14px;min-width:0}
.bks-foot-partial{margin-right:8px;color:var(--dsw-alias-state-warn-primary);font-size:11px}
.bks-foot-retry{max-width:56%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;border:0;background:transparent;
  color:var(--dsw-alias-state-error-primary);font:inherit;cursor:pointer;padding:0}
.bks-foot-retry:hover{text-decoration:underline}
.bks-reader-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 20px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.bks-reader-foot span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bks-reader-frame{width:100%;height:100%;border:0;background:var(--dsw-alias-bg-layer-1)}
.bks-reader-main{flex:1 1 auto;min-height:0;display:flex;align-items:stretch}
.bks-reader-main-split .bks-reader-viewport{padding-right:clamp(10px,1.4vw,22px)}
.bks-reader-viewport-split{flex:1 1 auto;min-width:0}
.bks-reader-body-single .bks-pages{column-count:1}
.bks-reader-orig{flex:0 0 clamp(280px,42%,540px);min-width:0;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.bks-reader-orig-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.bks-reader-orig-of{opacity:.7}
.bks-reader-orig-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;padding:18px clamp(14px,2.2vw,26px);background:var(--dsw-alias-bg-layer-2);scrollbar-width:thin}
.bks-reader-orig-img{margin:auto;display:block;width:auto;height:auto;max-width:100%;max-height:100%;background:#fff;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);box-shadow:0 4px 18px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);cursor:zoom-in}
.bks-reader-orig-zoomed{align-items:flex-start;justify-content:flex-start}
.bks-reader-orig-zoomed .bks-reader-orig-img{width:100%;max-height:none;margin:0;cursor:zoom-out}
.bks-reader-orig-tools{display:flex;align-items:center;gap:10px}
@media (max-width: 900px){
  .bks-reader-main-split{flex-direction:column}
  .bks-reader-orig{flex:0 0 45%;border-left:0;border-top:1px solid var(--dsw-alias-border-l1)}
  .bks-reader-main-split .bks-reader-viewport{padding-right:clamp(18px,3.2vw,52px)}
}
.bks-empty{padding:60px 0;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.bks-card-note{margin:0 0 12px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
`;

    /**
     * Resolve the translate seat.
     * @param props - slot props.
     * @returns a translate function.
     */
    function translate(props) {
      const t = typeof props?.t === 'function' ? props.t : undefined;
      return (key, vars) => {
        const template = t === undefined ? undefined : t(key);
        const text = typeof template === 'string' && template !== key
          ? template
          : (Object.prototype.hasOwnProperty.call(FALLBACK_TEXT, key) ? FALLBACK_TEXT[key] : key);
        if (vars === undefined) return text;
        return text.replace(/\{(\w+)\}/g, (whole, name) => (
          Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
        ));
      };
    }

    /**
     * Split paragraphs into request-sized batches, by count and by characters.
     * @param paragraphs - the chapter's paragraphs.
     * @returns batches that keep the original order.
     */
    function batchesOf(paragraphs, size = TRANSLATE_BATCH, chars = TRANSLATE_BATCH_CHARS) {
      const batches = [];
      let current = [];
      let used = 0;
      for (const paragraph of paragraphs) {
        if (current.length > 0 && (current.length >= size || used + paragraph.length > chars)) {
          batches.push(current);
          current = [];
          used = 0;
        }
        current.push(paragraph);
        used += paragraph.length;
      }
      if (current.length > 0) batches.push(current);
      return batches;
    }

    /**
     * Whether a run of text is mostly Latin script, i.e. worth translating into
     * Chinese rather than out of it.
     * @param sample - the text to look at.
     * @returns true when Latin letters dominate.
     */
    function prefersEnglish(sample) {
      const text = typeof sample === 'string' ? sample : '';
      let latin = 0;
      let cjk = 0;
      for (const char of text.slice(0, 4000)) {
        if (/[A-Za-z]/.test(char)) latin += 1;
        else if (/[\u4e00-\u9fff]/.test(char)) cjk += 1;
      }
      return latin > cjk;
    }

    /**
     * Call one Host route and unwrap its envelope.
     * @param path - route under /api/bookshelf/.
     * @param body - JSON body for a POST route.
     * @param query - query string for a GET route.
     * @returns the unwrapped value.
     */
    async function api(path, body = {}, query = '') {
      const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      const response = await fetch(`/api/bookshelf/${path}${query}`, init);
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`服务返回了无法解析的内容（HTTP ${response.status}）`);
      }
      if (payload?.ok !== true) throw new Error(typeof payload?.error === 'string' ? payload.error : `请求失败（HTTP ${response.status}）`);
      return payload.value;
    }

    /**
     * A file size in the unit the user thinks in.
     * @param bytes - size in bytes.
     * @returns the formatted size.
     */
    function fmtSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    /**
     * A short, sortable-looking timestamp for a file row.
     * @param ms - epoch milliseconds.
     * @returns `YYYY-MM-DD HH:MM`, or an empty string.
     */
    function fmtDate(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
      const date = new Date(ms);
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /**
     * The one-line metadata under a card's title.
     * @param book - one shelf entry.
     * @returns the text, or an empty string.
     */
    function bookMeta(book) {
      const detail = book.detail;
      const parts = [];
      const authors = detail?.authors ?? [];
      if (authors.length > 0) parts.push(authors[0]);
      if (detail?.publisher !== undefined) parts.push(detail.publisher);
      if (detail?.year !== undefined) parts.push(detail.year);
      if (parts.length === 0 && typeof book.intro === 'string') return book.intro;
      return parts.join(' · ');
    }

    /** The "开始阅读" entry point, shown only when a readable file matched. */
    function readButton(t, book, onRead) {
      const readable = (book.local ?? []).find((file) => file.readable);
      if (readable === undefined) return null;
      return h('button', { type: 'button', className: 'bks-btn bks-btn-primary', onClick: () => onRead(book.subjectId) }, t('detail.read'));
    }

    /**
     * The line under a card's title: whoever the list or the subject page knows
     * about the book, without repeating the title.
     * @param book - one shelf entry.
     * @returns the text, or an empty string.
     */
    function cardSubtitle(book) {
      const detail = book.detail;
      if (detail !== undefined) {
        const parts = [detail.authors?.[0], detail.publisher, detail.year].filter(Boolean);
        if (parts.length > 0) return parts.join(' · ');
      }
      if (typeof book.intro === 'string' && book.intro !== '') {
        return book.intro.split('/').slice(0, 3).join('·').trim();
      }
      return '';
    }

    /**
     * The chips under a card: available formats, the score, a failed read.
     */
    function BookChips({ book, t }) {
      const chips = [];
      for (const file of (book.local ?? []).slice(0, 2)) {
        chips.push({
          key: `f:${file.fileId}`,
          label: file.ext.replace('.', '').toUpperCase(),
          on: file.readable === true,
        });
      }
      if (book.shelf === 'do') chips.push({ key: 'shelf', label: t('panel.tabReading'), on: true });
      const remembered = (book.local ?? [])
        .filter((file) => file.readable === true)
        .map((file) => readProgress(file.fileId))
        .find((position) => position !== undefined);
      const rating = book.detail?.rating ?? book.rating;
      if (rating !== undefined) chips.push({ key: 'r', label: `★ ${Number(rating).toFixed(1)}` });
      if (remembered !== undefined && typeof remembered.chapter === 'number') {
        chips.push({ key: 'w', label: t('panel.resume', { n: remembered.chapter + 1 }), on: true });
      }
      if (book.status === 'failed') chips.push({ key: 'e', label: t('panel.failed'), warn: true });
      if (chips.length === 0) return null;
      return h('span', { className: 'bks-chips' }, chips.map((chip) => h('span', {
        key: chip.key,
        className: `bks-chip${chip.on === true ? ' bks-chip-on' : ''}${chip.warn === true ? ' bks-chip-warn' : ''}`,
      }, chip.label)));
    }

    /**
     * One book on the shelf: the cover opens the book, the text under it opens
     * the sheet with everything else about it.
     */
    function BookCard({ book, t, onOpen, onRead }) {
      const [broken, setBroken] = React.useState(false);
      const cover = book.coverUrl !== undefined && !broken ? book.coverUrl : undefined;
      const subtitle = cardSubtitle(book);
      return h('div', { className: 'bks-card' },
        h('button', {
          type: 'button',
          className: 'bks-cover-btn',
          onClick: () => (onRead === undefined ? onOpen(book) : onRead(book)),
          title: t('panel.read'),
          'aria-label': `${t('panel.read')}《${book.title}》`,
        }, h('span', { className: 'bks-cover' },
          cover === undefined
            ? h('span', { className: 'bks-cover-fallback' }, book.title)
            : h('img', { src: cover, alt: '', loading: 'lazy', onError: () => setBroken(true) }))),
        h('button', { type: 'button', className: 'bks-card-info', onClick: () => onOpen(book) },
          h('span', { className: 'bks-book-title', title: book.title }, book.title),
          subtitle === '' ? null : h('span', { className: 'bks-book-meta' }, subtitle),
          h(BookChips, { book, t })));
    }

    /**
     * The detail sheet, including the local-file and source actions.
     */
    function DetailSheet({ book, t, busy, onClose, onRead, onImport, onReveal, onSources, sources, onDownload, onOpenExternal }) {
      const detail = book.detail;
      const rows = [];
      const push = (label, value) => { if (value !== undefined && value !== '') rows.push([label, value]); };
      push(t('detail.authors'), (detail?.authors ?? []).join(' / '));
      push(t('detail.translators'), (detail?.translators ?? []).join(' / '));
      push(t('detail.publisher'), detail?.publisher);
      push(t('detail.year'), detail?.year);
      push(t('detail.pages'), detail?.pages);
      push(t('detail.price'), detail?.price);
      push(t('detail.binding'), detail?.binding);
      push(t('detail.isbn'), detail?.isbn);
      push(t('detail.series'), detail?.series);
      push(t('detail.rating'), detail?.rating === undefined ? undefined : `${detail.rating}${detail.votes === undefined ? '' : `（${detail.votes} 人评价）`}`);

      return h('div', { className: 'bks-overlay', onClick: onClose },
        h('div', {
          className: 'bks-sheet',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': book.title,
          onClick: (event) => event.stopPropagation(),
        },
        h('div', { className: 'bks-sheet-head' },
          h('button', { type: 'button', className: 'bks-btn', onClick: onClose }, t('detail.back')),
          h('span', { className: 'bks-sheet-title' }, book.title),
          h('a', { className: 'bks-link', href: book.url, target: '_blank', rel: 'noreferrer' }, t('detail.douban'))),
        h('div', { className: 'bks-sheet-body' },
          h('div', { className: 'bks-detail' },
            h('div', { className: 'bks-detail-cover' },
              book.coverUrl === undefined
                ? h('span', null, book.title.slice(0, 20))
                : h('img', { src: book.coverUrl, alt: '' })),
            h('div', null,
              rows.length === 0
                ? h('p', { className: 'bks-hint' }, book.status === 'failed' ? (book.detailError ?? t('panel.failed')) : t('detail.loading'))
                : h('dl', { className: 'bks-kv' }, rows.map(([label, value]) => h(React.Fragment, { key: label },
                  h('dt', null, label),
                  h('dd', null, value)))),
              book.shelfDate !== undefined
                ? h('p', { className: 'bks-hint', style: { marginTop: '8px' } }, t(book.shelf === 'do' ? 'panel.readingSince' : 'panel.wishSince', { date: book.shelfDate }))
                : null)),
          detail?.summary !== undefined
            ? h('section', { className: 'bks-section' },
              h('h3', null, t('detail.summary')),
              h('p', { className: 'bks-prose' }, detail.summary))
            : null,
          h('section', { className: 'bks-section' },
            h('h3', null, t('detail.files')),
            (book.local ?? []).length === 0
              ? h('p', { className: 'bks-hint' }, t('detail.noFiles'))
              : h('ul', { className: 'bks-list' }, book.local.map((file) => h('li', { className: 'bks-row', key: file.fileId },
                h('span', { className: 'bks-row-main' },
                  h('span', { className: 'bks-row-title', title: file.rel }, file.name),
                  h('span', { className: 'bks-row-sub' }, `${file.ext.replace('.', '').toUpperCase()} · ${fmtSize(file.size)}${file.readable ? '' : ` · ${t('detail.unsupported')}`}`)),
                file.readable ? h('button', { type: 'button', className: 'bks-btn bks-btn-primary', onClick: () => onRead(book.subjectId, file.fileId) }, t('detail.read')) : null,
                h('button', { type: 'button', className: 'bks-btn', onClick: () => onReveal(file.fileId) }, t('detail.reveal')))))),
          h('section', { className: 'bks-section' },
            h('h3', null, t('sources.title')),
            h('p', { className: 'bks-hint' }, t('detail.sourcesHint')),
            sources === null
              ? h('button', {
                type: 'button',
                className: 'bks-btn',
                disabled: busy !== '',
                onClick: () => onSources(book.subjectId),
              }, busy === 'sources' ? t('panel.loading') : t('detail.sources'))
              : h(SourceList, { sources, t, busy, onDownload, onOpenExternal })),
        ),
        h('div', { className: 'bks-sheet-foot' },
          readButton(t, book, onRead),
          h('button', { type: 'button', className: 'bks-btn', disabled: busy === 'import', onClick: () => onImport(book.subjectId) }, busy === 'import' ? t('detail.importing') : t('detail.import')))));
    }

    /**
     * The public-domain results and the shop links for one book.
     */
    function SourceList({ sources, t, busy, onDownload, onOpenExternal }) {
      const gutenberg = sources.gutenberg ?? {};
      const openLibrary = sources.openLibrary ?? {};
      return h('div', { className: 'bks-list' },
      h('div', { className: 'bks-section' },
        h('h3', null, t('sources.gutenberg')),
        gutenberg.error !== undefined
          ? h('p', { className: 'bks-hint' }, t('sources.failed', { error: gutenberg.error }))
          : (gutenberg.items ?? []).length === 0
            ? h('p', { className: 'bks-hint' }, t('sources.empty'))
            : h('ul', { className: 'bks-list' }, gutenberg.items.map((item) => h('li', { className: 'bks-row', key: item.id },
              h('span', { className: 'bks-row-main' },
                h('span', { className: 'bks-row-title', title: item.title }, item.title),
                h('span', { className: 'bks-row-sub' }, [
                  item.authors?.join(' / '),
                  item.downloads === undefined ? undefined : t('sources.downloads', { n: item.downloads }),
                ].filter(Boolean).join(' · '))),
              item.readOnline !== undefined
                ? h('button', { type: 'button', className: 'bks-btn', onClick: () => onOpenExternal(item.readOnline) }, t('sources.readOnline'))
                : null,
              item.epub !== undefined
                ? h('button', {
                  type: 'button',
                  className: 'bks-btn bks-btn-primary',
                  disabled: busy !== '',
                  onClick: () => onDownload({ id: item.id, title: item.title, url: item.epub }),
                }, busy === `download:${item.id}` ? t('sources.downloading') : t('sources.download'))
                : null)))),
      h('div', { className: 'bks-section' },
        h('h3', null, t('sources.openlibrary')),
        openLibrary.error !== undefined
          ? h('p', { className: 'bks-hint' }, t('sources.failed', { error: openLibrary.error }))
          : (openLibrary.items ?? []).length === 0
            ? h('p', { className: 'bks-hint' }, t('sources.empty'))
            : h('ul', { className: 'bks-list' }, openLibrary.items.map((item) => h('li', { className: 'bks-row', key: item.page ?? item.title },
              h('span', { className: 'bks-row-main' },
                h('span', { className: 'bks-row-title', title: item.title }, item.title),
                h('span', { className: 'bks-row-sub' }, [item.authors?.join(' / '), item.year, item.access].filter(Boolean).join(' · '))),
              item.page !== undefined
                ? h('button', { type: 'button', className: 'bks-btn', onClick: () => onOpenExternal(item.page) }, t('sources.borrow'))
                : null)))),
      (sources.channels ?? []).length > 0
        ? h('div', { className: 'bks-section' },
          h('h3', null, t('sources.channels')),
          h('div', { className: 'bks-links' }, sources.channels.map((channel) => h('button', {
            type: 'button',
            className: 'bks-link',
            key: channel.id,
            onClick: () => onOpenExternal(channel.url),
          }, channel.label))))
        : null);
    }

    /**
     * Gutter between the two columns, in px. `columnWidth + gap` is the scroll
     * stride of one page, and the horizontal gutters live on a wrapper, so a
     * page turn always lands a column on the same x.
     */
    const COLUMN_GAP = 76;

    /** Where each book was left off: fileId -> { chapter, index, total, at }. */
    const READING_STORE = 'dsh-bookshelf:reading';

    /**
     * The reading positions of every book, as far as this browser remembers.
     * @returns an object keyed by file id.
     */
    function readAllProgress() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(READING_STORE) ?? '{}');
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    /**
     * Where one file was left off.
     * @param fileId - the library file id.
     * @returns the saved position, or undefined.
     */
    function readProgress(fileId) {
      if (typeof fileId !== 'string' || fileId === '') return undefined;
      const saved = readAllProgress()[fileId];
      return saved !== null && typeof saved === 'object' ? saved : undefined;
    }

    /**
     * Remember where a file was left off, keeping the store small.
     * @param fileId - the library file id.
     * @param position - chapter index and page index.
     */
    function writeProgress(fileId, position) {
      if (typeof fileId !== 'string' || fileId === '') return;
      const all = readAllProgress();
      all[fileId] = { ...position, at: Date.now() };
      const entries = Object.entries(all).sort((left, right) => (right[1]?.at ?? 0) - (left[1]?.at ?? 0));
      try {
        window.localStorage.setItem(READING_STORE, JSON.stringify(Object.fromEntries(entries.slice(0, 120))));
      } catch {
        // A blocked storage costs the bookmark, not the reading.
      }
    }

    /**
     * Carry a reading position over to a file's new id.
     * @param from - the id before the rename.
     * @param to - the id after it.
     */
    function moveProgress(from, to) {
      if (typeof from !== 'string' || typeof to !== 'string' || from === to) return;
      const all = readAllProgress();
      if (all[from] === undefined) return;
      all[to] = all[from];
      delete all[from];
      try {
        window.localStorage.setItem(READING_STORE, JSON.stringify(all));
      } catch {
        // A blocked storage costs the bookmark, not the reading.
      }
    }

    /**
     * Forget a reading position for a file that left the library.
     * @param fileId - the library file id.
     */
    function dropProgress(fileId) {
      const all = readAllProgress();
      if (typeof fileId !== 'string' || all[fileId] === undefined) return;
      delete all[fileId];
      try {
        window.localStorage.setItem(READING_STORE, JSON.stringify(all));
      } catch {
        // A blocked storage costs the bookmark, not the reading.
      }
    }

    /**
     * Where a scroll offset sits in the book's column flow.
     * @param input - scroll offset, maximum scroll, chapter offsets and strides.
     * @returns the page number, page count, and the chapter and page inside it.
     */
    function locateInBook({ scrollLeft, maxScroll, offsets, pageStride }) {
      const pages = Math.max(1, Math.round(Math.max(0, maxScroll) / pageStride) + 1);
      const index = Math.min(pages, Math.max(1, Math.round(scrollLeft / pageStride) + 1));
      let chapter = 0;
      for (let position = 0; position < offsets.length; position += 1) {
        if (offsets[position] <= scrollLeft + 4) chapter = position;
      }
      const base = offsets[chapter] ?? 0;
      return { index, pages, chapter, offset: Math.max(0, Math.round((scrollLeft - base) / pageStride)) };
    }

    /**
     * The scroll offset that shows a saved chapter and page again, kept inside
     * that chapter so a type-size change cannot throw the reader into the next
     * one.
     * @param offsets - chapter offsets in the flow.
     * @param chapter - chapter index.
     * @param offset - page index inside that chapter.
     * @param pageStride - pixels one page advances.
     * @returns the offset, or undefined when the chapter is unknown.
     */
    function scrollForPosition(offsets, chapter, offset, pageStride) {
      const base = offsets[chapter];
      if (base === undefined) return undefined;
      const wanted = base + (offset ?? 0) * pageStride;
      const next = offsets[chapter + 1];
      return Math.max(0, next === undefined ? wanted : Math.min(wanted, Math.max(base, next - pageStride)));
    }

    /**
     * Measure the real distance between two columns.
     *
     * A paragraph that crosses a column boundary reports one client rect per
     * fragment, so the difference between two fragment lefts is the column
     * stride — including the fractional part that a formula would lose.
     *
     * @param element - the scrolling element.
     * @returns the stride in pixels, or undefined when no paragraph spans two columns.
     */
    function measureColumnStride(element) {
      if (typeof element.querySelectorAll !== 'function') return undefined;
      const nodes = element.querySelectorAll('p');
      const limit = Math.min(nodes.length, 60);
      for (let index = 0; index < limit; index += 1) {
        const node = nodes[index];
        if (typeof node.getClientRects !== 'function') continue;
        const rects = node.getClientRects();
        for (let position = 1; position < rects.length; position += 1) {
          const step = rects[position].left - rects[position - 1].left;
          if (step > 1) return step;
        }
      }
      return undefined;
    }

    /**
     * Nudge a scroll offset onto a column boundary.
     *
     * Columns land on fractional widths (`709.6667px` is normal), so advancing
     * by a rounded formula loses a fraction of a pixel per page; after a few
     * dozen pages the first characters of every line sit under the edge. Every
     * position this reader scrolls to is therefore snapped to a measured column
     * boundary instead of accumulated.
     *
     * @param position - the wanted scroll offset.
     * @param columnStride - measured distance between two columns.
     * @param maxScroll - the largest offset this book allows.
     * @returns the offset to use.
     */
    function snapToColumn(position, columnStride, maxScroll) {
      if (!(columnStride > 1)) return position;
      const limit = Math.max(0, maxScroll);
      const snapped = Math.min(limit, Math.max(0, Math.round(position / columnStride) * columnStride));
      return Math.abs(snapped - position) > 2 ? snapped : position;
    }

    /**
     * Wheel input, in pixels, that has to accumulate before one page turns. A
     * discrete mouse notch is ~100px and turns immediately; a trackpad sends
     * dozens of small deltas that add up to one page.
     */
    const WHEEL_STEP = 40;

    /** Silence that ends one wheel gesture and re-arms the reader. */
    const WHEEL_IDLE = 260;

    /**
     * Normalise a wheel event to pixels.
     * @param deltaX - horizontal delta.
     * @param deltaY - vertical delta.
     * @param deltaMode - 0 pixels, 1 lines, 2 pages.
     * @returns the dominant delta in pixels.
     */
    function wheelDelta(deltaX, deltaY, deltaMode) {
      const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
      const dominant = Math.abs(deltaY ?? 0) >= Math.abs(deltaX ?? 0) ? deltaY ?? 0 : deltaX ?? 0;
      return dominant * scale;
    }

    /**
     * Decide what one wheel event does to the page.
     *
     * The accumulator absorbs the small deltas a trackpad emits, and `locked`
     * swallows the rest of the gesture, so a single flick is worth one page.
     *
     * @param input - accumulated pixels so far, whether the gesture is locked,
     * and this event's pixels.
     * @returns the next accumulator state and a page turn of -1, 0 or 1.
     */
    function wheelPage({ acc, locked, delta }) {
      if (locked) return { acc, locked: true, turn: 0 };
      const total = acc + delta;
      if (Math.abs(total) < WHEEL_STEP) return { acc: total, locked: false, turn: 0 };
      return { acc: 0, locked: true, turn: total > 0 ? 1 : -1 };
    }

    /** Characters of a plain-text book the reader puts in one DOM tree. */
    const TEXT_RENDER_LIMIT = 300000;

    /** Reading preferences survive the panel being closed, like a real reader. */
    const READER_PREFS = { size: 17, serif: true, original: true };

    /** Paragraphs one translation request carries; the Host accepts 24. */
    const TRANSLATE_BATCH = 18;

    /** Characters one translation batch carries, well under the Host's cap. */
    const TRANSLATE_BATCH_CHARS = 9000;
    const READER_STORE = 'dsh-bookshelf:reader';

    /**
     * Per-book translation choices: file id → whether the reader shows
     * translations. Nothing global lives here: a bilingual run through a
     * foreign novel must not switch translation on for the next Chinese book.
     */
    const TRANSLATE_STORE = 'dsh-bookshelf:translate';

    /**
     * Read every stored per-book translation choice.
     * @returns file id → boolean.
     */
    function readTranslateChoices() {
      try {
        const raw = window.localStorage.getItem(TRANSLATE_STORE);
        const parsed = raw === null ? undefined : JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }

    /**
     * The translation choice the user made for one book, if any.
     * @param fileId - the book's file id.
     * @returns true/false, or undefined when the user never toggled it.
     */
    function readTranslateChoice(fileId) {
      if (typeof fileId !== 'string' || fileId === '') return undefined;
      const value = readTranslateChoices()[fileId];
      return typeof value === 'boolean' ? value : undefined;
    }

    /**
     * Remember one book's translation choice.
     * @param fileId - the book's file id.
     * @param on - whether translations are shown.
     */
    function writeTranslateChoice(fileId, on) {
      if (typeof fileId !== 'string' || fileId === '') return;
      try {
        const all = readTranslateChoices();
        all[fileId] = on === true;
        const entries = Object.entries(all).slice(-200);
        window.localStorage.setItem(TRANSLATE_STORE, JSON.stringify(Object.fromEntries(entries)));
      } catch {
        // A blocked storage only costs the choice, not the reading.
      }
    }

    /**
     * A text sample long enough to tell which language a book is written in.
     * @param reader - the reader payload.
     * @returns the sample, capped at 4000 characters.
     */
    function languageSample(reader) {
      if (reader?.kind === 'epub') {
        let text = '';
        for (const chapter of reader.chapters ?? []) {
          for (const paragraph of chapter?.paragraphs ?? []) {
            text += String(paragraph ?? ' ');
            if (text.length >= 4000) return text;
          }
        }
        return text;
      }
      if (typeof reader?.text === 'string') return reader.text.slice(0, 4000);
      return '';
    }

    /**
     * Whether a book is written in Chinese, read from its own text: 想读 and
     * 在读 books are often Chinese editions, and translating those into English
     * is never what the reader asked for.
     * @param reader - the reader payload.
     * @returns true for Chinese-dominant books.
     */
    function isChineseBook(reader) {
      return !prefersEnglish(languageSample(reader));
    }

    /**
     * Read the saved reading preferences.
     * @returns the preferences, or the defaults.
     */
    function readReaderPrefs() {
      try {
        const raw = window.localStorage.getItem(READER_STORE);
        const parsed = raw === null ? undefined : JSON.parse(raw);
        const size = Number(parsed?.size);
        return {
          size: Number.isFinite(size) && size >= 13 && size <= 26 ? size : READER_PREFS.size,
          serif: parsed?.serif === undefined ? READER_PREFS.serif : parsed.serif === true,
          original: parsed?.original === undefined ? READER_PREFS.original : parsed.original === true,
        };
      } catch {
        return { ...READER_PREFS };
      }
    }

    /**
     * The reading surface. The whole book is laid out as one continuous
     * two-column flow, so a page turn at the end of a chapter simply carries on
     * into the next one — chapters are never something to click at.
     */
    function Reader({ reader, t, busy, onClose, onReveal, onExtract, onRestore }) {
      const initial = readReaderPrefs();
      const [size, setSize] = React.useState(initial.size);
      const [serif, setSerif] = React.useState(initial.serif);
      // Bilingual reading: the translation of the chapter on screen, fetched
      // only when that chapter is actually opened. The user's own choice for
      // this book wins; otherwise only a non-Chinese book starts translated.
      const [bilingual, setBilingual] = React.useState(
        () => readTranslateChoice(reader.file?.fileId) ?? !isChineseBook(reader),
      );
      // The original page next to the text: the extracted text loses every
      // figure, table and formula, so the paper shows both.
      const [original, setOriginal] = React.useState(initial.original);
      // One column when the text pane gets narrow because the page is showing.
      const [single, setSingle] = React.useState(false);
      // The page pane fits the whole page by default; zooming shows it at the
      // pane width so a formula or a table can be read closely.
      const [zoom, setZoom] = React.useState(false);
      const [translated, setTranslated] = React.useState({});
      const [translating, setTranslating] = React.useState({ index: -1, done: 0, total: 0, error: '' });
      // Translation waits until the saved position is restored, otherwise the
      // first chapter of every book would be translated for nothing.
      const [positioned, setPositioned] = React.useState(false);
      const requested = React.useRef(new Set());
      const anchorParagraph = React.useRef('');
      const [spread, setSpread] = React.useState({ index: 1, total: 1 });
      const [activeChapter, setActiveChapter] = React.useState(0);
      const scroller = React.useRef(null);
      const layout = React.useRef({ key: '', offsets: [] });
      const restored = React.useRef(false);
      const lastTurn = React.useRef(0);
      const savedStamp = React.useRef('');
      const fileId = reader.file?.fileId;
      const chapters = reader.kind === 'epub' ? reader.chapters : [];
      const title = reader.book?.title ?? reader.file?.title ?? '';
      const textBody = reader.text ?? '';
      const truncated = textBody.length > TEXT_RENDER_LIMIT;

      /**
       * Everything about the current layout that page turning needs: where each
       * chapter starts, how far two columns are apart, and how far a page turn
       * goes. Measured, not assumed — Chrome lays columns out at fractional
       * widths, so a formula drifts.
       * @param element - the scrolling element.
       * @returns the layout, cached until the type, the window or the book changes.
       */
      const layoutInfo = (element) => {
        const width = element.clientWidth ?? 0;
        const key = [reader.kind, chapters.length, size, serif, width, truncated, single, layoutVersion.current].join('|');
        if (layout.current.key === key) return layout.current;
        const headings = typeof element.querySelectorAll === 'function'
          ? element.querySelectorAll('[data-chapter]')
          : [];
        const offsets = Array.from(headings).map((node) => node.offsetLeft ?? 0);
        const columnStride = measureColumnStride(element) ?? (width + COLUMN_GAP);
        const columnsPerPage = Math.max(1, Math.round((width + COLUMN_GAP) / columnStride));
        const pageStride = columnsPerPage * columnStride;
        layout.current = {
          key,
          offsets,
          columnStride,
          pageStride,
          columnsPerPage,
          maxScroll: Math.max(0, (element.scrollWidth ?? width) - width),
        };
        return layout.current;
      };

      /** The paragraph at the top of the page, used to hold the place across a reflow. */
      const topParagraph = () => {
        const element = scroller.current;
        if (element === null || element === undefined || typeof document?.elementFromPoint !== 'function') return '';
        const rect = element.getBoundingClientRect();
        const node = document.elementFromPoint(rect.left + 12, rect.top + 34);
        return node?.closest?.('[data-p]')?.dataset?.p ?? '';
      };

      /**
       * Translate one chapter, in batches, and let the text appear as it lands.
       *
       * Only the chapter being read is ever sent: an 800-page book costs one
       * chapter of translation, not a book.
       * @param index - chapter index.
       */
      const translateChapter = React.useCallback(async (index) => {
        const chapter = chapters[index];
        if (chapter === undefined) return;
        const paragraphs = (chapter.paragraphs ?? [])
          .map((paragraph) => String(paragraph ?? '').trim())
          .filter((paragraph) => paragraph !== '');
        if (paragraphs.length === 0) return;
        const id = `${fileId}:${index}`;
        if (requested.current.has(id)) return;
        requested.current.add(id);

        let cursor = 0;
        let partial = 0;
        const lines = new Array(paragraphs.length).fill('');
        const target = prefersEnglish(paragraphs.join(' ')) ? 'zh-CN' : 'en';
        setTranslating({ index, done: 0, total: paragraphs.length, error: '' });
        for (const batch of batchesOf(paragraphs)) {
          const offset = cursor;
          cursor += batch.length;
          try {
            const value = await api('translate', { texts: batch, target });
            const got = Array.isArray(value?.translations) ? value.translations : [];
            for (let position = 0; position < batch.length; position += 1) {
              lines[offset + position] = typeof got[position] === 'string' ? got[position] : '';
            }
            // Only an empty answer is a failure: one missing paragraph must not
            // throw away the rest of the page.
            const failedCount = Number(value?.failed ?? 0);
            if (failedCount > 0 && got.every((line) => typeof line !== 'string' || line.trim() === '')) {
              throw new Error(typeof value?.error === 'string' && value.error !== ''
                ? value.error
                : t('reader.translateFailed'));
            }
            if (failedCount > 0) partial += failedCount;
          } catch (error) {
            requested.current.delete(id);
            setTranslating({
              index: -1,
              done: 0,
              total: 0,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          // Commit what arrived so the text fills in from the top down.
          if (anchorParagraph.current === '') anchorParagraph.current = topParagraph();
          layoutVersion.current += 1;
          setTranslated((previous) => ({ ...previous, [index]: { lines: [...lines] } }));
          setTranslating({ index, done: Math.min(paragraphs.length, cursor), total: paragraphs.length, error: '', partial });
        }
        setTranslating({ index: -1, done: 0, total: 0, error: '', partial });
      }, [chapters, fileId, t]);

      // Another book in the same panel: its own saved choice, or its own
      // language, decides whether translation starts on; nothing carries over.
      React.useEffect(() => {
        setBilingual(readTranslateChoice(fileId) ?? !isChineseBook(reader));
        setTranslated({});
        setTranslating({ index: -1, done: 0, total: 0, error: '' });
      }, [fileId]);

      // Only the chapter on screen is translated, and only when bilingual mode
      // is on: moving to the next chapter asks for that one next.
      React.useEffect(() => {
        if (!bilingual || !positioned || reader.kind !== 'epub') return;
        void translateChapter(activeChapter);
      }, [bilingual, positioned, activeChapter, reader, translateChapter]);

      const measure = React.useCallback(() => {
        const element = scroller.current;
        if (element === null || element === undefined) return;
        const width = element.clientWidth ?? 0;
        if (width <= 1) return;
        setSingle(width < 620);
        const info = layoutInfo(element);

        // Translations inserted above the current page reflow every column;
        // holding on to the paragraph that was at the top keeps the reader
        // exactly where they were instead of a page back.
        if (anchorParagraph.current !== '') {
          const node = typeof element.querySelector === 'function'
            ? element.querySelector(`[data-p="${anchorParagraph.current}"]`)
            : null;
          const target = node === null || node === undefined ? undefined : node.offsetLeft;
          anchorParagraph.current = '';
          if (target !== undefined && target !== null) {
            element.scrollLeft = snapToColumn(target, info.columnStride, info.maxScroll);
          }
        }

        if (!restored.current) {
          const saved = readProgress(fileId);
          if (saved !== undefined && typeof saved.chapter === 'number') {
            const target = scrollForPosition(info.offsets, saved.chapter, saved.offset, info.pageStride);
            if (target !== undefined) {
              const snapped = snapToColumn(target, info.columnStride, info.maxScroll);
              element.scrollLeft = snapped;
              // A layout that is not finished yet clamps the assignment, which
              // would silently restart the book at page one: only count it as
              // restored when it stuck.
              if (Math.abs((element.scrollLeft ?? 0) - snapped) > 2) return;
            }
          }
          restored.current = true;
          setPositioned((previous) => (previous ? previous : true));
        }

        const located = locateInBook({
          scrollLeft: element.scrollLeft ?? 0,
          maxScroll: info.maxScroll,
          offsets: info.offsets,
          pageStride: info.pageStride,
        });
        setSpread((previous) => (previous.total === located.pages && previous.index === located.index
          ? previous
          : { total: located.pages, index: located.index }));
        setActiveChapter((previous) => (previous === located.chapter ? previous : located.chapter));
        // Smooth scrolling fires this on every frame; one bookmark per page is
        // enough, and it keeps storage writes off the scroll path.
        const stamp = `${located.chapter}:${located.offset}:${located.pages}`;
        if (stamp !== savedStamp.current) {
          savedStamp.current = stamp;
          writeProgress(fileId, {
            chapter: located.chapter,
            offset: located.offset,
            page: located.index,
            total: located.pages,
          });
        }

        // Once the scroll settles, pull it onto a column boundary: a wheel, a
        // scrollbar drag or a fractional stride otherwise leaves a sliver of the
        // previous column showing.
        if (settle.current !== 0) clearTimeout(settle.current);
        settle.current = setTimeout(() => {
          settle.current = 0;
          // Re-read the column stride: a web font that swapped in after the
          // first layout changes every column boundary, and the cached one
          // would then snap to the wrong places.
          const fresh = measureColumnStride(element);
          if (fresh !== undefined && fresh > 1 && Math.abs(fresh - info.columnStride) > 0.5) {
            const columnsPerPage = Math.max(1, Math.round(((element.clientWidth ?? 0) + COLUMN_GAP) / fresh));
            layout.current = {
              ...info,
              columnStride: fresh,
              columnsPerPage,
              pageStride: columnsPerPage * fresh,
            };
          }
          const current = layout.current;
          const target = snapToColumn(element.scrollLeft ?? 0, current.columnStride, current.maxScroll);
          if (Math.abs(target - (element.scrollLeft ?? 0)) > 2) element.scrollLeft = target;
        }, 240);
      }, [fileId, size, serif, reader]);

      const turn = (direction) => {
        const element = scroller.current;
        if (element === null || element === undefined) return;
        const info = layoutInfo(element);
        const page = Math.round((element.scrollLeft ?? 0) / info.pageStride);
        const target = snapToColumn((page + direction) * info.pageStride, info.columnStride, info.maxScroll);
        lastTurn.current = Date.now();
        if (typeof element.scrollTo === 'function') element.scrollTo({ left: target, behavior: 'smooth' });
        else element.scrollLeft = target;
      };

      const jump = (chapter) => {
        const element = scroller.current;
        if (element === null || element === undefined) return;
        const info = layoutInfo(element);
        const base = info.offsets[chapter];
        if (base === undefined) return;
        const target = snapToColumn(base, info.columnStride, info.maxScroll);
        lastTurn.current = Date.now();
        if (typeof element.scrollTo === 'function') element.scrollTo({ left: target, behavior: 'smooth' });
        else element.scrollLeft = target;
      };

      // One gesture, one page: the first event past the threshold turns a page
      // and everything until the wheel goes quiet is swallowed. A trackpad's
      // momentum burst therefore advances exactly one page, not ten.
      const wheel = React.useRef({ acc: 0, locked: false, timer: 0 });
      const settle = React.useRef(0);
      // Translation changes the height of the flow, so every cached offset has
      // to be thrown away: this counter is part of the layout key.
      const layoutVersion = React.useRef(0);

      const onWheel = (event) => {
        const state = wheel.current;
        // Every event keeps the gesture alive, so the lock lifts only after a
        // real pause rather than after a fixed time.
        if (state.timer !== 0) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state.timer = 0;
          state.locked = false;
          state.acc = 0;
        }, WHEEL_IDLE);
        const delta = wheelDelta(event.deltaX, event.deltaY, event.deltaMode);
        if (delta === 0) return;
        const action = wheelPage({ acc: state.acc, locked: state.locked, delta });
        state.acc = action.acc;
        state.locked = action.locked;
        if (action.turn !== 0) turn(action.turn);
      };

      // Drop the pending timers when the reader closes.
      React.useEffect(() => () => {
        const state = wheel.current;
        if (state.timer !== 0) clearTimeout(state.timer);
        if (settle.current !== 0) clearTimeout(settle.current);
      }, []);

      React.useEffect(() => {
        measure();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => measure());
        // A font that finishes loading reflows every column; measure again so
        // the chapter offsets and the page stride describe the real layout.
        const fonts = typeof document === 'undefined' ? undefined : document.fonts;
        if (fonts?.ready?.then !== undefined) {
          fonts.ready.then(() => {
            layout.current = { key: '', offsets: [] };
            measure();
          }).catch(() => undefined);
        }
        if (typeof window.addEventListener !== 'function') return undefined;
        const onResize = () => measure();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, [measure]);

      // Translations change the height of the flow: measure again and hold the
      // paragraph that was on screen.
      React.useEffect(() => {
        measure();
      }, [translated, measure]);

      // Opening or closing the original-page pane halves the text width, which
      // re-paginates everything: measure again after the browser has laid out.
      React.useEffect(() => {
        layout.current = { key: '', offsets: [] };
        measure();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => measure());
      }, [original, single, measure]);

      React.useEffect(() => {
        if (typeof window.addEventListener !== 'function') return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') { onClose(); return; }
          if (!['ArrowRight', 'PageDown', 'ArrowLeft', 'PageUp'].includes(event.key)) return;
          // A held key repeats fast; one page per repeat is enough.
          if (Date.now() - lastTurn.current < 180) return;
          turn(event.key === 'ArrowRight' || event.key === 'PageDown' ? 1 : -1);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onClose]);

      const savePrefs = (nextSize, nextSerif, nextOriginal = original) => {
        try {
          window.localStorage.setItem(READER_STORE, JSON.stringify({
            size: nextSize,
            serif: nextSerif,
            original: nextOriginal,
          }));
        } catch {
          // A blocked storage only costs the preference, not the reading.
        }
      };

      // One flow for the whole book: chapter headings are just inline blocks in
      // it, so the last page of a chapter is followed by the first page of the
      // next one.
      // Each paragraph is wrapped so its translation can sit right under it,
      // and so a reflow can find the paragraph that was on screen again.
      const pageContent = reader.kind === 'epub'
        ? chapters.map((chapter, index) => [
          h('h2', { key: `h${index}`, 'data-chapter': String(index) }, chapter.title),
          ...(chapter.paragraphs ?? []).map((paragraph, position) => {
            const line = translated[index]?.lines?.[position];
            return h('div', {
              key: `${index}:${position}`,
              className: 'bks-para',
              'data-p': `${index}:${position}`,
            },
            h('p', null, paragraph),
            typeof line === 'string' && line !== '' ? h('p', { className: 'bks-trans' }, line) : null);
          }),
        ])
        : h('pre', null, `${textBody.slice(0, TEXT_RENDER_LIMIT)}${
          truncated ? `\n\n…（已显示前 ${Math.round(TEXT_RENDER_LIMIT / 10000)} 万字）` : ''
        }`);

      const pageBody = h('article', {
        className: `bks-pages ${serif ? 'bks-pages-serif' : 'bks-pages-sans'}`,
        style: { '--bks-reader-size': `${size}px` },
      }, pageContent);

      // The original page is rendered by the Host, one PNG per page: the text
      // keeps the figures' place in the reading flow, and the picture beside it
      // shows what that place actually looks like.
      const showOriginal = reader.source === 'pdf' && original && reader.file?.fileId !== undefined;
      const pageIndex = activeChapter + 1;
      const pageImage = showOriginal
        ? `/api/bookshelf/paper/page?fileId=${encodeURIComponent(reader.file.fileId)}&page=${pageIndex}&v=${reader.file?.mtime ?? 0}`
        : undefined;

      const textPane = h('div', { className: `bks-reader-viewport${showOriginal ? ' bks-reader-viewport-split' : ''}` },
        h('div', {
          className: `bks-reader-body${single ? ' bks-reader-body-single' : ''}`,
          ref: scroller,
          onScroll: measure,
          onWheel,
        }, pageBody));

      const originalPane = showOriginal
        ? h('aside', { className: 'bks-reader-orig' },
          h('div', { className: 'bks-reader-orig-head' },
            h('span', null, t('reader.originalPage', { n: pageIndex })),
            h('div', { className: 'bks-reader-orig-tools' },
              h('button', {
                type: 'button',
                className: 'bks-paper-action',
                title: zoom ? t('reader.zoomOutHint') : t('reader.zoomHint'),
                onClick: () => setZoom(!zoom),
              }, zoom ? t('reader.zoomOut') : t('reader.zoom')),
              h('span', { className: 'bks-reader-orig-of' }, `/ ${chapters.length}`))),
          h('div', { className: `bks-reader-orig-body${zoom ? ' bks-reader-orig-zoomed' : ''}` },
            h('img', {
              className: 'bks-reader-orig-img',
              src: pageImage,
              alt: t('reader.originalPage', { n: pageIndex }),
              title: zoom ? t('reader.zoomOutHint') : t('reader.zoomHint'),
              onClick: () => setZoom(!zoom),
            })))
        : null;

      const body = reader.kind === 'pdf'
        ? h('iframe', {
          className: 'bks-reader-frame',
          src: `/api/bookshelf/file?fileId=${encodeURIComponent(reader.file?.fileId ?? '')}`,
          title,
        })
        : h('div', { className: `bks-reader-main${showOriginal ? ' bks-reader-main-split' : ''}` }, textPane, originalPane);

      const chapterTitle = reader.kind === 'epub'
        ? chapters[activeChapter]?.title ?? title
        : title;

      // The footer carries the reading position and, in bilingual mode, whether
      // the chapter on screen is still being translated.
      const footPartial = bilingual && translating.error === '' && (translating.partial ?? 0) > 0
        ? h('span', { className: 'bks-foot-partial' }, t('reader.translatePartial', { n: translating.partial }))
        : null;

      const footStatus = bilingual && translating.error !== ''
        ? h('button', {
          type: 'button',
          className: 'bks-foot-retry',
          onClick: () => {
            requested.current.delete(`${fileId}:${activeChapter}`);
            setTranslating({ index: -1, done: 0, total: 0, error: '' });
            void translateChapter(activeChapter);
          },
        }, `${t('reader.translateFailed')}：${translating.error}（${t('reader.translateRetry')}）`)
        : bilingual && translating.index === activeChapter && translating.total > 0
          ? h('span', null, t('reader.translating', { done: translating.done, total: translating.total }))
          : null;
      const pageText = `${t('reader.page', { index: spread.index, total: spread.total })}${
        chapters.length > 1 ? ` · ${t('reader.chapterCount', { n: chapters.length })}` : ''
      }`;
      const foot = h('div', { className: 'bks-reader-foot' },
        h('span', null, chapterTitle),
        h('span', { className: 'bks-foot-right' }, footStatus, footPartial, h('span', null, pageText)));

      return h('div', { className: 'bks-reader' },
        h('div', { className: 'bks-reader-head' },
          h('button', { type: 'button', className: 'bks-btn', onClick: onClose }, t('reader.back')),
          h('span', { className: 'bks-reader-title', title }, title),
          h('div', { className: 'bks-reader-tools' },
            chapters.length > 1
              ? h('select', {
                className: 'bks-icon-btn',
                style: { maxWidth: '200px' },
                value: String(Math.min(activeChapter, chapters.length - 1)),
                onChange: (event) => jump(Number(event.target.value)),
                'aria-label': t('reader.chapter'),
              }, chapters.map((chapter, index) => h('option', { value: String(index), key: index }, chapter.title)))
              : null,
            reader.kind === 'epub' && chapters.length > 0
              ? h('button', {
                type: 'button',
                className: `bks-icon-btn${bilingual ? ' bks-icon-btn-on' : ''}`,
                title: bilingual ? t('reader.translateOn') : t('reader.translateOff'),
                onClick: () => {
                  const next = !bilingual;
                  anchorParagraph.current = topParagraph();
                  layoutVersion.current += 1;
                  setBilingual(next);
                  writeTranslateChoice(fileId, next);
                  savePrefs(size, serif);
                  if (!next) setTranslating({ index: -1, done: 0, total: 0, error: '' });
                },
              }, t('reader.translate'))
              : null,
            h('button', {
              type: 'button',
              className: 'bks-icon-btn',
              disabled: size <= 13,
              title: t('reader.smaller'),
              onClick: () => { const next = Math.max(13, size - 1); setSize(next); savePrefs(next, serif); },
            }, 'A-'),
            h('button', {
              type: 'button',
              className: 'bks-icon-btn',
              disabled: size >= 26,
              title: t('reader.larger'),
              onClick: () => { const next = Math.min(26, size + 1); setSize(next); savePrefs(next, serif); },
            }, 'A+'),
            h('button', {
              type: 'button',
              className: `bks-icon-btn${serif ? ' bks-icon-btn-on' : ''}`,
              title: t('reader.serif'),
              onClick: () => { setSerif(!serif); savePrefs(size, !serif); },
            }, t('reader.font')),
            reader.kind === 'pdf' && reader.file?.fileId !== undefined
              ? h('button', {
                type: 'button',
                className: 'bks-icon-btn',
                disabled: busy === 'extract',
                title: t('reader.extractHint'),
                onClick: () => onExtract(reader.file?.fileId),
              }, busy === 'extract' ? '…' : t('reader.extract'))
              : null,
            reader.source === 'pdf' && reader.file?.fileId !== undefined
              ? h('button', {
                type: 'button',
                className: `bks-icon-btn${original ? ' bks-icon-btn-on' : ''}`,
                title: original ? t('reader.originalOn') : t('reader.originalOff'),
                onClick: () => {
                  const next = !original;
                  layoutVersion.current += 1;
                  anchorParagraph.current = topParagraph();
                  setOriginal(next);
                  savePrefs(size, serif, next);
                },
              }, t('reader.original'))
              : null,
            reader.source === 'pdf' && reader.file?.fileId !== undefined
              ? h('button', {
                type: 'button',
                className: 'bks-icon-btn',
                disabled: busy === 'restore',
                title: t('reader.restoreHint'),
                onClick: () => onRestore(reader.file?.fileId),
              }, busy === 'restore' ? '…' : t('reader.restore'))
              : null,
            reader.file !== undefined
              ? h('button', { type: 'button', className: 'bks-icon-btn', onClick: () => onReveal(reader.file.fileId), title: t('detail.reveal') }, '⌘')
              : null)),
        body,
        reader.kind === 'pdf' ? null : foot);
    }

    /**
     * The settings form, shared by the panel's settings sheet and the bundle's
     * page in Settings → Plugins.
     */
    function SettingsForm({ t, data, busy, onSave, onRescan, onPick }) {
      const [doubanId, setDoubanId] = React.useState(data?.prefs?.doubanUserId ?? '');
      const [libraryDir, setLibraryDir] = React.useState(data?.prefs?.libraryDir ?? '');
      React.useEffect(() => {
        setDoubanId(data?.prefs?.doubanUserId ?? '');
        setLibraryDir(data?.prefs?.libraryDir ?? '');
      }, [data?.prefs?.doubanUserId, data?.prefs?.libraryDir]);
      const submit = (event) => {
        event.preventDefault();
        onSave({ doubanUserId: doubanId, libraryDir });
      };
      return h('form', { className: 'bks-form', onSubmit: submit },
        h('div', { className: 'bks-field' },
          h('label', { className: 'bks-label', htmlFor: 'bks-douban' }, t('settings.douban')),
          h('input', {
            id: 'bks-douban',
            className: 'bks-input',
            value: doubanId,
            onChange: (event) => setDoubanId(event.target.value),
            placeholder: '154090935',
            autoComplete: 'off',
            spellCheck: false,
          }),
          h('p', { className: 'bks-hint' }, t('settings.doubanHint'))),
        h('div', { className: 'bks-field' },
          h('label', { className: 'bks-label', htmlFor: 'bks-library' }, t('settings.library')),
          h('div', { className: 'bks-inline' },
            h('input', {
              id: 'bks-library',
              className: 'bks-input',
              value: libraryDir,
              onChange: (event) => setLibraryDir(event.target.value),
              placeholder: t('settings.noDir'),
              autoComplete: 'off',
              spellCheck: false,
            }),
            onPick === undefined ? null : h('button', { type: 'button', className: 'bks-btn', onClick: () => onPick((picked) => setLibraryDir(picked)) }, t('settings.pick'))),
          // Typing an absolute path is fiddly; these three cover the folders
          // books actually arrive in.
          h('div', { className: 'bks-inline' }, [
            { key: 'dl', label: t('settings.quickDownloads'), path: '~/Downloads' },
            { key: 'docs', label: t('settings.quickDocuments'), path: '~/Documents' },
            { key: 'desk', label: t('settings.quickDesktop'), path: '~/Desktop' },
          ].map((entry) => h('button', {
            key: entry.key,
            type: 'button',
            className: 'bks-btn',
            onClick: () => setLibraryDir(entry.path),
          }, entry.label))),
          libraryDir === '' && typeof data?.library?.dir === 'string' && data.library.dir !== ''
            ? h('p', { className: 'bks-hint' }, t('settings.libraryDefault', { dir: data.library.dir }))
            : h('p', { className: 'bks-hint' }, t('settings.libraryHint'))),
        data?.library !== undefined
          ? h('p', { className: 'bks-hint' }, data.library.error !== undefined
            ? data.library.error
            : t('settings.scanned', { n: data.library.count, r: data.library.readable }))
          : null,
        h('div', { className: 'bks-inline' },
          h('button', { type: 'submit', className: 'bks-btn bks-btn-primary', disabled: busy === 'prefs' }, busy === 'prefs' ? '…' : t('settings.save')),
          onRescan === undefined ? null : h('button', { type: 'button', className: 'bks-btn', disabled: busy === 'scan', onClick: onRescan }, busy === 'scan' ? '…' : t('settings.rescan'))),
        h('p', { className: 'bks-hint' }, t('settings.policy')));
    }

    /**
     * The panel page. It owns one state document fetched from the Host and every
     * action that changes it.
     */
    /**
     * One document on the shelf, drawn the way a book is: a first-page cover, a
     * title and a single metadata line. The title comes from the PDF's own first
     * page, so a paper shows its real name instead of the file name.
     * @param props - `{ doc, meta, t, busy, onRead, onRename, onReveal, onDelete }`.
     */
    function PaperCard({ doc, meta, t, busy, onRead, onRename, onReveal, onDelete }) {
      const [broken, setBroken] = React.useState(false);
      const [confirm, setConfirm] = React.useState(false);

      React.useEffect(() => {
        if (!confirm) return undefined;
        const timer = setTimeout(() => setConfirm(false), 5000);
        return () => clearTimeout(timer);
      }, [confirm]);

      const title = doc.title ?? meta?.title ?? doc.name.replace(/\.[^.]+$/, '');
      const pages = meta?.pages;
      const subtitle = [
        pages === undefined ? undefined : t('papers.pages', { n: pages }),
        fmtSize(doc.size),
      ].filter(Boolean).join(' · ');
      const cover = doc.cover !== undefined && !broken ? doc.cover : undefined;
      const open = () => onRead(doc);

      return h('div', { className: 'bks-card bks-paper' },
        h('button', {
          type: 'button',
          className: 'bks-cover-btn',
          onClick: open,
          title: doc.readable === true ? t('panel.read') : t('detail.unsupported'),
          'aria-label': `${t('panel.read')}《${title}》`,
        }, h('span', { className: 'bks-cover bks-cover-paper' },
          cover === undefined
            ? h('span', { className: 'bks-cover-fallback' }, title)
            : h('img', { src: cover, alt: '', loading: 'lazy', onError: () => setBroken(true) }),
          h('span', { className: 'bks-paper-tag' }, doc.ext.replace('.', '').toUpperCase()))),
        h('button', { type: 'button', className: 'bks-card-info', onClick: open, title: doc.name },
          h('span', { className: 'bks-book-title' }, title),
          h('span', { className: 'bks-book-meta' }, subtitle)),
        h('div', { className: 'bks-paper-actions' },
          h('button', { type: 'button', className: 'bks-paper-action', onClick: () => onReveal(doc) }, t('papers.reveal')),
          h('button', { type: 'button', className: 'bks-paper-action', onClick: () => onRename(doc) }, t('papers.rename')),
          h('button', {
            type: 'button',
            className: `bks-paper-action${confirm ? ' bks-paper-action-danger' : ''}`,
            disabled: busy !== '',
            onClick: () => {
              if (!confirm) {
                setConfirm(true);
                return;
              }
              setConfirm(false);
              onDelete(doc);
            },
          }, confirm ? t('papers.confirmDelete') : t('papers.delete'))));
    }

    /**
     * Local documents that are not on the Douban wish list: papers, manuals and
     * whatever else the user drops into the library folder.
     *
     * The shelf only knows about books it matched to a wish-list entry, so an
     * unmatched PDF used to be invisible even though it was on disk. This
     * section is that missing place, with the maintenance actions a folder of
     * papers needs: open, reveal, rename, remove.
     * @param props - `{ t, data, busy, onRead, onRename, onDelete, onImport, onReveal, onRevealDir }`.
     */
    function LibrarySection(props) {
      const { t, data, busy, onRead, onRename, onDelete, onImport, onReveal, onRevealDir } = props;
      const files = data?.library?.documents ?? [];
      const [metas, setMetas] = React.useState({});
      const wanted = files.map((file) => file.fileId).join(',');
      const dir = data?.library?.dir ?? '';
      const [kind, setKind] = React.useState('all');
      const [editing, setEditing] = React.useState(undefined);
      const [draft, setDraft] = React.useState('');
      const [confirming, setConfirming] = React.useState(undefined);

      // Two-step delete: the second click is only live for a few seconds.
      React.useEffect(() => {
        if (confirming === undefined) return undefined;
        const timer = setTimeout(() => setConfirming(undefined), 5000);
        return () => clearTimeout(timer);
      }, [confirming]);

      // Titles and page counts live on the Host (they cost a PDF read), so they
      // are asked for once per visible set instead of on every state poll.
      React.useEffect(() => {
        if (wanted === '') return undefined;
        let live = true;
        const ids = wanted.split(',');
        void (async () => {
          try {
            const value = await api('paper/meta', { fileIds: ids });
            if (live && value?.meta !== undefined) setMetas(value.meta);
          } catch {
            // A title is decoration: the card falls back to the file name.
          }
        })();
        return () => { live = false; };
      }, [wanted]);

      const exts = [...new Set(files.map((file) => file.ext))].sort();
      const shown = (kind === 'all' ? files : files.filter((file) => file.ext === kind))
        .slice()
        .sort((left, right) => (right.mtime ?? 0) - (left.mtime ?? 0));

      const startRename = (file) => {
        setEditing(file.fileId);
        setDraft(file.name.replace(/\.[^.]+$/, ''));
        if (file.title !== undefined) setDraft(file.title);
      };

      const commit = async (file) => {
        const name = draft.trim();
        setEditing(undefined);
        if (name === '') return;
        await onRename(file, name);
      };

      const head = h('div', { className: 'bks-lib-head' },
        h('h3', null, t('papers.title'), files.length > 0 ? h('span', { className: 'bks-count' }, String(files.length)) : null),
        h('div', { className: 'bks-lib-actions' },
          h('button', { type: 'button', className: 'bks-btn', disabled: dir === '', onClick: onRevealDir }, t('papers.folder')),
          h('button', { type: 'button', className: 'bks-btn', disabled: busy === 'import', onClick: onImport }, t('papers.import'))));

      const hint = h('p', { className: 'bks-hint' }, dir === ''
        ? t('papers.noDir')
        : t('papers.hint', { dir }));

      const editingFile = files.find((file) => file.fileId === editing);
      const renameBar = editingFile === undefined ? null : h('div', { className: 'bks-paper-rename' },
        h('span', { className: 'bks-row-sub' }, t('papers.renameTo', { name: editingFile.name })),
        h('input', {
          className: 'bks-input',
          value: draft,
          autoFocus: true,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') void commit(editingFile);
            if (event.key === 'Escape') setEditing(undefined);
          },
        }),
        h('button', { type: 'button', className: 'bks-btn', disabled: busy !== '', onClick: () => void commit(editingFile) }, t('papers.save')),
        h('button', { type: 'button', className: 'bks-btn', onClick: () => setEditing(undefined) }, t('papers.cancel')));

      const filters = exts.length > 1
        ? h('div', { className: 'bks-chips' }, ['all', ...exts].map((id) => h('button', {
          key: id,
          type: 'button',
          className: `bks-chip bks-chip-btn${kind === id ? ' bks-chip-on' : ''}`,
          onClick: () => setKind(id),
        }, id === 'all' ? t('papers.all') : id.replace('.', '').toUpperCase())))
        : null;

      const rows = shown.length === 0
        ? h('p', { className: 'bks-hint bks-lib-empty' }, t('papers.empty'))
        : h('div', { className: 'bks-grid bks-paper-grid' }, shown.map((file) => h(PaperCard, {
          key: file.fileId,
          doc: file,
          meta: metas[file.fileId],
          t,
          busy,
          onRead: (doc) => onRead(doc.fileId),
          onRename: startRename,
          onReveal: (doc) => onReveal(doc.fileId),
          onDelete,
        })));

      return h('section', { className: 'bks-section bks-library' },
        head,
        hint,
        filters,
        renameBar,
        rows);
    }

    function ShelfPage(props) {
      const t = translate(props);
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [query, setQuery] = React.useState('');
      const [tab, setTab] = React.useState('all');
      const [view, setView] = React.useState('shelf');
      const [selectedId, setSelectedId] = React.useState(null);
      const [sources, setSources] = React.useState(null);
      const [reader, setReader] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      const fileInput = React.useRef(null);
      const importFor = React.useRef(null);

      /**
       * Re-read the Host state; failures land in the header notice.
       * @param options - `refresh` asks the Host to re-read Douban first.
       */
      const load = React.useCallback(async (options = {}) => {
        try {
          const value = await api('state', options);
          setData(value);
          setError('');
          return value;
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
          return undefined;
        }
      }, []);

      React.useEffect(() => { void load({}); }, [load]);

      // The Host fills the shelf in the background (one Douban page every few
      // seconds); the panel follows it so covers and details appear by
      // themselves instead of only after a click.
      React.useEffect(() => {
        if (data?.progress?.running !== true) return undefined;
        const timer = setTimeout(() => { void load({}); }, 1600);
        return () => clearTimeout(timer);
      }, [data, load]);

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          if (reader !== null) { setReader(null); return; }
          if (view !== 'shelf') { setView('shelf'); setSelectedId(null); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [reader, view]);

      const run = async (name, action) => {
        setBusy(name);
        setNotice('');
        try {
          return await action();
        } catch (failure) {
          setNotice(failure instanceof Error ? failure.message : String(failure));
          return undefined;
        } finally {
          setBusy('');
        }
      };

      const refresh = () => run('refresh', async () => {
        const value = await api('refresh');
        if (value?.state !== undefined) setData(value.state);
        else await load({});
      });

      /**
       * Clicking a cover opens the book at the page it was left on. With several
       * readable files the sheet is the honest answer, since the user has to
       * pick one.
       * @param book - the shelf entry whose cover was clicked.
       */
      const openRead = (book) => {
        const readable = (book.local ?? []).filter((file) => file.readable === true);
        if (readable.length === 1) {
          void read(book.subjectId, readable[0].fileId);
          return;
        }
        if (readable.length > 1) {
          const remembered = readable.find((file) => readProgress(file.fileId) !== undefined);
          if (remembered !== undefined) {
            void read(book.subjectId, remembered.fileId);
            return;
          }
        }
        void openDetail(book.subjectId);
      };

      const openDetail = async (subjectId) => {
        setSelectedId(subjectId);
        setView('detail');
        setSources(null);
        const book = data?.books.find((entry) => entry.subjectId === subjectId);
        if (book === undefined || book.status === 'ready') return;
        // Subject pages are read on demand: opening a book is the only thing
        // that spends a Douban request on it.
        try {
          setData(await api('detail', { subjectId }));
        } catch (failure) {
          setNotice(failure instanceof Error ? failure.message : String(failure));
        }
      };

      // The sheet can ask for one specific file; the footer button asks for the
      // book and lets the Host pick its best match.
      const read = (subjectId, fileId) => run('read', async () => {
        const payload = await api('library/read', fileId === undefined ? { subjectId } : { fileId });
        setReader(payload);
      });

      const reveal = (fileId) => run('reveal', async () => {
        await api('library/reveal', { fileId });
      });

      const extractPdf = (fileId) => run('extract', async () => {
        setReader(await api('library/read', { fileId, mode: 'text' }));
      });

      const restorePdf = (fileId) => run('restore', async () => {
        setReader(await api('library/read', { fileId }));
      });

      const revealDir = () => run('revealDir', async () => {
        await api('library/reveal', { dir: true });
      });

      const renameFile = (file, name) => run(`rename:${file.fileId}`, async () => {
        const value = await api('library/rename', { fileId: file.fileId, name });
        if (value?.state !== undefined) setData(value.state);
        moveProgress(value?.from, value?.to);
        setNotice(t('papers.renamed', { name: value?.saved ?? name }));
      });

      const removeFile = (file) => run(`delete:${file.fileId}`, async () => {
        const value = await api('library/delete', { fileId: file.fileId });
        if (value?.state !== undefined) setData(value.state);
        dropProgress(value?.from);
        setNotice(t('papers.deleted', { name: file.name }));
      });

      const openSources = (subjectId) => run('sources', async () => {
        setSources(await api('sources/search', { subjectId }));
      });

      const download = (item) => run(`download:${item.id}`, async () => {
        const value = await api('sources/download', item);
        if (value?.state !== undefined) setData(value.state);
        setNotice(t('sources.downloaded', { name: value?.fileName ?? '' }));
      });

      const openExternal = (url) => {
        if (typeof url === 'string' && /^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
      };

      const startImport = (subjectId) => {
        importFor.current = subjectId;
        fileInput.current?.click();
        if (subjectId !== undefined) setView('detail');
      };

      const onFileChosen = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        const subjectId = importFor.current;
        importFor.current = undefined;
        if (file === undefined) return;
        const book = subjectId === undefined ? undefined : data?.books.find((entry) => entry.subjectId === subjectId);
        await run('import', async () => {
          const buffer = new Uint8Array(await file.arrayBuffer());
          let binary = '';
          const chunk = 0x8000;
          for (let index = 0; index < buffer.length; index += chunk) {
            binary += String.fromCharCode.apply(null, buffer.subarray(index, index + chunk));
          }
          const value = await api('library/upload', {
            filename: file.name,
            title: book?.title ?? file.name,
            data: btoa(binary),
          });
          if (value?.state !== undefined) setData(value.state);
          setNotice(t('detail.imported', { name: value?.saved ?? file.name }));
        });
      };

      const chooseDirectory = (setter) => {
        void pickDirectory().then((picked) => {
          if (typeof picked === 'string' && picked !== '') setter(picked);
          else setNotice(t('settings.pickUnavailable'));
        });
      };

      const savePrefs = (patch) => run('prefs', async () => {
        const value = await api('prefs', patch);
        setData(value);
        setNotice(t('settings.saved'));
      });

      const rescan = () => run('scan', async () => {
        setData(await api('library/scan'));
      });

      const books = data?.books ?? [];
      const needle = query.trim().toLowerCase();
      const readable = books.filter((book) => (book.local ?? []).some((file) => file.readable)).length;
      const pending = books.filter((book) => book.detail === undefined).length;
      const wish = books.filter((book) => book.shelf !== 'do').length;
      const reading = books.filter((book) => book.shelf === 'do').length;
      const tabs = [
        { id: 'all', label: t('panel.tabAll'), count: books.length },
        ...(reading > 0 ? [{ id: 'do', label: t('panel.tabReading'), count: reading }] : []),
        ...(wish > 0 ? [{ id: 'wish', label: t('panel.tabWish'), count: wish }] : []),
        { id: 'readable', label: t('panel.tabReadable'), count: readable },
        { id: 'pending', label: t('panel.tabPending'), count: pending },
      ];
      const inTab = (book) => (
        tab === 'do' ? book.shelf === 'do'
          : tab === 'wish' ? book.shelf !== 'do'
            : tab === 'readable' ? (book.local ?? []).some((file) => file.readable)
              : tab === 'pending' ? book.detail === undefined
                : true
      );
      const visible = books
        .filter(inTab)
        .filter((book) => needle === ''
          || [book.title, bookMeta(book), book.detail?.isbn, book.rating, book.intro, ...(book.detail?.authors ?? [])]
            .filter(Boolean).join(' ').toLowerCase().includes(needle));
      const selected = books.find((book) => book.subjectId === selectedId);

      const progress = data?.progress;
      const filling = progress?.running === true;
      const header = h('div', { className: 'bks-head' },
        h('div', { className: 'bks-headline' },
          h('h1', { className: 'bks-title' }, t('panel.title')),
          books.length > 0 ? h('span', { className: 'bks-count' }, String(books.length)) : null),
        h('div', { className: 'bks-sub' },
          data === null
            ? t('panel.loading')
            : [
              data.member === undefined ? `豆瓣 ${data.userId}` : `${data.member}（${data.userId}）`,
              t('panel.wishCount', { n: wish }),
              reading > 0 ? t('panel.readingCount', { n: reading }) : undefined,
              t('panel.localCount', { n: readable }),
              filling ? t('panel.filling', { done: progress.done, total: progress.total }) : undefined,
            ].filter(Boolean).join(' · ')),
        h('div', { className: 'bks-actions' },
          h('button', { type: 'button', className: 'bks-btn', disabled: busy === 'import', onClick: () => startImport(undefined) }, busy === 'import' ? '…' : t('panel.import')),
          h('button', { type: 'button', className: 'bks-btn', disabled: busy === 'scan', onClick: rescan }, busy === 'scan' ? '…' : t('panel.scan')),
          h('button', { type: 'button', className: 'bks-btn', onClick: () => setView('settings') }, t('panel.settings'))));

      const toolbar = h('div', { className: 'bks-toolbar' },
        h('div', { className: 'bks-tabs', role: 'tablist' }, tabs.map((entry) => h('button', {
          key: entry.id,
          type: 'button',
          role: 'tab',
          'aria-selected': tab === entry.id,
          className: `bks-tab${tab === entry.id ? ' bks-tab-on' : ''}`,
          onClick: () => setTab(entry.id),
        }, entry.count > 0 ? `${entry.label} ${entry.count}` : entry.label))),
        h('div', { className: 'bks-toolbar-right' },
          h('input', {
            className: 'bks-input bks-search',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            placeholder: t('panel.search'),
            'aria-label': t('panel.search'),
          }),
          h('button', { type: 'button', className: 'bks-btn', disabled: busy === 'refresh', onClick: refresh }, busy === 'refresh' ? '…' : t('panel.refresh'))));

      const hostNotice = data?.notice;
      const message = error !== '' ? error : (notice !== '' ? notice : hostNotice);
      const noticeLine = typeof message === 'string' && message !== ''
        ? h('p', { className: `bks-note${error !== '' || hostNotice !== undefined ? ' bks-note-error' : ''}` },
          message,
          error !== '' || hostNotice !== undefined
            ? h('button', {
              type: 'button',
              className: 'bks-btn',
              style: { marginLeft: '10px' },
              disabled: busy === 'refresh',
              onClick: refresh,
            }, t('panel.retry'))
            : null)
        : null;

      const shelfGrid = data === null
        ? h('p', { className: 'bks-empty' }, t('panel.loading'))
        : visible.length === 0
          ? h('p', { className: 'bks-empty' }, books.length === 0
            ? t('panel.empty')
            : tab === 'readable' ? t('panel.emptyReadable') : t('panel.emptySearch'))
          : h('div', { className: 'bks-grid' }, visible.map((book) => h(BookCard, {
            key: book.subjectId,
            book,
            t,
            onOpen: (book) => { void openDetail(book.subjectId); },
            onRead: openRead,
          })));

      const body = h('div', { className: 'bks-body' },
        data !== null ? toolbar : null,
        h('div', { className: 'bks-inner' },
          shelfGrid,
          // Unmatched files are the ones the shelf has no place for: a category
          // of their own keeps them from being invisible.
          data !== null
            ? h(LibrarySection, {
              t,
              data,
              busy,
              onRead: (fileId) => read(undefined, fileId),
              onRename: renameFile,
              onDelete: removeFile,
              onImport: () => startImport(undefined),
              onReveal: reveal,
              onRevealDir: revealDir,
            })
            : null));

      return h('div', { className: 'bks-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        header,
        noticeLine,
        body,
        view === 'detail' && selected !== undefined
          ? h(DetailSheet, {
            book: selected,
            t,
            busy,
            onClose: () => { setView('shelf'); setSelectedId(null); setSources(null); },
            onRead: read,
            onImport: startImport,
            onReveal: reveal,
            onSources: openSources,
            onDownload: download,
            onOpenExternal: openExternal,
            sources,
          })
          : null,
        view === 'settings'
          ? h('div', { className: 'bks-overlay', onClick: () => setView('shelf') },
            h('div', { className: 'bks-sheet', onClick: (event) => event.stopPropagation() },
              h('div', { className: 'bks-sheet-head' },
                h('button', { type: 'button', className: 'bks-btn', onClick: () => setView('shelf') }, t('detail.back')),
                h('span', { className: 'bks-sheet-title' }, t('settings.title'))),
              h('div', { className: 'bks-sheet-body' },
                h(SettingsForm, { t, data, busy, onSave: savePrefs, onRescan: rescan, onPick: chooseDirectory }))))
          : null,
        reader !== null
          ? h(Reader, {
            reader,
            t,
            busy,
            onClose: () => setReader(null),
            onReveal: reveal,
            onExtract: extractPdf,
            onRestore: restorePdf,
          })
          : null,
        h('input', {
          ref: fileInput,
          type: 'file',
          accept: '.epub,.pdf,.txt',
          style: { display: 'none' },
          onChange: onFileChosen,
        }));
    }

    /**
     * Sidebar icon: a stack of books, drawn with the current colour so it follows
     * the rail's active state.
     */
    function PanelIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16;
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      },
      h('path', {
        d: 'M2.5 3.2h3.1c.5 0 .9.4.9.9v9.1c0 .4-.3.7-.7.7H3.2c-.4 0-.7-.3-.7-.7V3.2Zm4.4 1.1h3.3v9.2H7.4c-.3 0-.5-.2-.5-.5V4.3Zm4.6.6 2.6-.6c.4-.1.8.2.8.6v8.5c0 .3-.2.6-.5.7l-2.4.5c-.3.1-.6-.2-.6-.5V4.9Z',
        fill: 'currentColor',
      }));
    }

    /**
     * The bundle's own page in Settings → Plugins: the same fields, so the user
     * who looks for "this plugin's settings" there finds them.
     */
    function BundleSettingsCard(props) {
      const t = translate(props);
      const [data, setData] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState('');

      React.useEffect(() => {
        api('state', {}).then(setData).catch((failure) => setNotice(failure instanceof Error ? failure.message : String(failure)));
      }, []);

      const choose = (setter) => {
        void pickDirectory().then((picked) => {
          if (typeof picked === 'string' && picked !== '') setter(picked);
          else setNotice(t('settings.pickUnavailable'));
        });
      };

      const save = (patch) => {
        setBusy('prefs');
        api('prefs', patch)
          .then((value) => { setData(value); setNotice(t('settings.saved')); })
          .catch((failure) => setNotice(failure instanceof Error ? failure.message : String(failure)))
          .finally(() => setBusy(''));
      };

      if (props?.view === 'summary') {
        const id = data?.prefs?.doubanUserId ?? '…';
        return h('span', null, `${t('settings.douban')}：${id}`);
      }
      return h('div', null,
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'bks-card-note' }, t('settings.cardDesc')),
        notice === '' ? null : h('p', { className: 'bks-hint' }, notice),
        h(SettingsForm, { t, data, busy, onSave: save, onPick: choose }));
    }

    /**
     * Register the locale namespace, the page, the sidebar entry and the bundle
     * settings card.
     * @param ctx - the Client context.
     */
    function apply(ctx) {
      clientCtx = ctx;
      ctx.effect(() => ctx.locale.register(NS, {
        zh: FALLBACK_TEXT,
        en: {
          'panel.label': 'Bookshelf',
          'panel.title': 'Bookshelf',
          'panel.wishCount': '{n} to read',
          'panel.readingCount': '{n} reading',
          'panel.tabWish': 'Want to read',
          'panel.tabReading': 'Reading',
          'panel.wishSince': 'Want to read since {date}',
          'panel.readingSince': 'Reading since {date}',
          'panel.tabAll': 'All books',
          'panel.tabReadable': 'Readable',
          'panel.tabPending': 'Loading',
          'panel.filling': 'Loading details {done}/{total}',
          'panel.scan': 'Scan library',
          'reader.extract': 'Text mode',
          'reader.extractHint': 'Extract the PDF text layer and read it as translatable text',
          'reader.original': 'Page',
          'reader.originalOn': 'Hide the original page',
          'reader.originalOff': 'Show the original PDF page beside the text',
          'reader.originalPage': 'Original page {n}',
          'reader.zoom': 'Zoom',
          'reader.zoomOut': 'Fit',
          'reader.zoomHint': 'Zoom to the pane width and scroll',
          'reader.zoomOutHint': 'Back to the whole page',
          'reader.restore': 'Original PDF',
          'reader.restoreHint': 'Back to the original PDF page',
          'papers.title': 'Documents',
          'papers.pages': '{n} pages',
          'papers.renameTo': 'Rename "{name}"',
          'papers.folder': 'Open folder',
          'papers.import': 'Import document',
          'papers.hint': 'Folder: {dir} · files matching no shelf book are collected here',
          'papers.noDir': 'No library folder chosen yet',
          'papers.all': 'All',
          'papers.empty': 'Nothing here yet: use Import document, or drop PDF/EPUB/TXT files into the folder above.',
          'papers.reveal': 'Reveal',
          'papers.rename': 'Rename',
          'papers.delete': 'Delete',
          'papers.confirmDelete': 'Move to .trash',
          'papers.save': 'Save',
          'papers.cancel': 'Cancel',
          'papers.renamed': 'Renamed to {name}',
          'papers.deleted': 'Moved {name} to the library .trash folder',
          'panel.import': 'Import a book',
          'panel.resume': 'Resume ch. {n}',
          'panel.read': 'Read',
          'panel.emptyReadable': 'No readable local files yet. Drop books in the library folder, or import one from a book.',
          'panel.localCount': '{n} on disk',
          'panel.refresh': 'Refresh',
          'panel.settings': 'Settings',
          'panel.search': 'Search title, author or publisher',
          'panel.loading': 'Loading the Douban shelf…',
          'panel.empty': 'This shelf is empty, or that Douban id does not exist.',
          'panel.emptySearch': 'No book matches.',
          'panel.pending': 'loading details',
          'detail.loading': 'Reading the Douban page…',
          'panel.failed': 'details failed',
          'panel.localBadge': 'local',
          'panel.retry': 'Retry',
          'detail.back': 'Back',
          'detail.authors': 'Author',
          'detail.translators': 'Translator',
          'detail.publisher': 'Publisher',
          'detail.year': 'Published',
          'detail.pages': 'Pages',
          'detail.price': 'Price',
          'detail.binding': 'Binding',
          'detail.isbn': 'ISBN',
          'detail.series': 'Series',
          'detail.subtitle': 'Subtitle',
          'detail.rating': 'Rating',
          'detail.summary': 'Summary',
          'detail.douban': 'Douban page',
          'detail.read': 'Read',
          'detail.reveal': 'Show in folder',
          'detail.import': 'Import a file',
          'detail.importing': 'Importing…',
          'detail.imported': 'Imported {name}',
          'detail.files': 'Local files',
          'detail.noFiles': 'No file for this book yet. Import one you own, or look for a public-domain edition.',
          'detail.unsupported': 'cannot be read in the panel',
          'detail.sources': 'Find a public-domain or licensed copy',
          'detail.sourcesHint': 'Searches public-domain catalogs and shops only; no shadow library is wired in.',
          'sources.title': 'Public-domain and licensed sources',
          'sources.gutenberg': 'Project Gutenberg (public domain, downloadable)',
          'sources.openlibrary': 'Open Library (borrow or buy)',
          'sources.channels': 'Licensed channels',
          'sources.download': 'Download to shelf',
          'sources.downloading': 'Downloading…',
          'sources.downloaded': 'Saved as {name}',
          'sources.borrow': 'Open',
          'sources.empty': 'No matching entry.',
          'sources.failed': 'Search failed: {error}',
          'sources.downloads': '{n} downloads',
          'sources.readOnline': 'Read online',
          'reader.back': 'Back',
          'reader.chapter': 'Chapter',
          'reader.prev': 'Previous',
          'reader.next': 'Next',
          'reader.unsupported': 'This format cannot be read here; open it from its folder.',
          'reader.pdfHint': 'The PDF is shown by the browser viewer.',
          'reader.smaller': 'Smaller text',
          'reader.larger': 'Larger text',
          'reader.serif': 'Switch between the serif and the sans typeface',
          'reader.font': 'Aa',
          'reader.translate': 'Tr',
          'reader.translateOn': 'Hide the translation',
          'reader.translateOff': 'Show the translation under each paragraph',
          'reader.translating': 'translating {done}/{total}',
          'reader.translateFailed': 'translation failed',
          'reader.translateRetry': 'retry',
          'reader.translatePartial': '{n} untranslated',
          'reader.page': 'Screen {index}/{total}',
          'reader.chapterCount': '{n} sections',
          'settings.title': 'Bookshelf settings',
          'settings.douban': 'Douban user id',
          'settings.doubanHint': 'The part after /people/ in a Douban profile URL, for example 154090935.',
          'settings.library': 'Library folder',
          'settings.libraryHint': 'The folder holding your own ebooks (epub / pdf / txt).',
          'settings.libraryDefault': 'No folder chosen yet. Imports go to {dir}; or fill in ~/Downloads to see the books you already downloaded.',
          'settings.quickDownloads': 'Use Downloads',
          'settings.quickDocuments': 'Use Documents',
          'settings.quickDesktop': 'Use Desktop',
          'settings.pick': 'Choose folder',
          'settings.pickUnavailable': 'No folder picker here; paste the path instead',
          'settings.save': 'Save',
          'settings.saved': 'Saved',
          'settings.rescan': 'Rescan library',
          'settings.scanned': '{n} files indexed, {r} readable here',
          'settings.noDir': 'not set',
          'settings.policy': 'This plugin only reads files in your own folder and content from public-domain catalogs (Project Gutenberg / Open Library); no shadow library is wired in.',
          'settings.cardTitle': 'Bookshelf',
          'settings.cardDesc': 'The Douban user id and the local library folder; both are used by the shelf page.',
        },
      }), 'bookshelf: dictionaries');

      // The sidebar label is a thunk so it follows the active locale without
      // re-registering when the language changes.
      let bound;
      try {
        bound = ctx.locale.bind(NS);
      } catch {
        bound = undefined;
      }
      const label = () => {
        try {
          const value = bound?.('panel.label');
          if (typeof value === 'string' && value !== '' && value !== 'panel.label') return value;
        } catch {
          // Fall through to the dictionary below.
        }
        return FALLBACK_TEXT['panel.label'];
      };
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, ShelfPage));

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        label,
        locale: NS,
      }, PanelIcon));

      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PKG,
        locale: NS,
      }, BundleSettingsCard));
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply,
      internals: {
        translate,
        bookMeta,
        fmtSize,
        reading: { readProgress, writeProgress },
        paging: { locateInBook, scrollForPosition, snapToColumn, wheelDelta, wheelPage },
        translation: { batchesOf, prefersEnglish, languageSample, isChineseBook, readTranslateChoice, writeTranslateChoice },
        components: { BookCard, DetailSheet, Reader, SettingsForm, LibrarySection, PaperCard, BundleSettingsCard } },
    };
  },
});