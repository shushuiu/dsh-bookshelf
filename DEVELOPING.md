# 开发与发布

面向维护者；用户文档在 [README.md](README.md)。

## 结构

```
plugin/
├── index.js            Host 半：/api/bookshelf/* 路由、缓存、后台抓详情
├── client.js           浏览器半：书架页、详情、阅读器、设置
├── lib/douban.js       豆瓣页面抓取与解析
├── lib/library.js      书目扫描、配对、EPUB(ZIP) 解析、纯文本解码
├── lib/sources.js      Gutenberg / Open Library 检索与下载、正版链接
├── cordis.patch.yml    Loader row（配置入口）
├── locale/{zh,en}.json 插件管理器里的标题与描述
├── icon.svg            插件图标
├── assets/icon-180.png 收录用的 180×180 位图（市场卡片）
└── publish/            发布工具与插件市场索引，见 publish/README.md
```

纯 JS，没有构建步骤：源码即产物。

## 本地调试

当前 profile 里已经装好了（以 `link:` 形式依赖这个目录），所以改完不用重装：

- 改 `client.js`（浏览器半）：刷新页面即可，开着的窗口会走 client HMR
- 改 `index.js` / `lib/*.js`（Host 半）：重启 Harness

想验证 Host 半的行为，可以不碰真实 profile，用临时 `DSH_HOME` 直接 import `index.js` 里的 handler 调用。

## 几个实现上的取舍

写在这里，免得以后重新踩一遍：

- **翻译通道**：优先用宿主 `translator` 服务，拿不到就退回插件自带的匿名 Google `translate_a/t` 批量端点（一次最多 20 段 / 5000 字，一章通常一个请求）。不用 `translate_a/single`——它只收单段 `q`，突发几个请求就 429。`translator` 在 profile 级插件里通常是 `undefined`，且默认的 Bing 通道 `edge.microsoft.com/translate/auth` 已经 404，所以不能当唯一通道。
- **PDF 原页而不是把图塞进正文**：论文的图表多是矢量绘制，抽出来只能变低分辨率位图，表头和公式还会被拆散；直接并排显示原页既保真又便宜。
- **栏宽实测**：翻页位置从页码反算绝对位置，再对齐到用 `getClientRects()` 量出来的实际栏宽。Chrome 的栏宽常是小数，按 `clientWidth + gap` 推算每页会差 0.3px，几十页后行首被切字。
- **一次滚动手势只翻一页**：滚动增量累积到 40px 触发一次，同一次手势的余量锁住，滚轮静止 260ms 才解锁。
- **对豆瓣的请求节奏**：刷新按书架各发 2 个请求（列表 + 卡片页取封面），想读和在读两个书架共 4 个，详情后台每 1.5 秒补一本，遇到 302/403 立刻停手，20 分钟后自动接着补。
- **在读（/do）与想读（/wish）同一套页面**：三栏共用 `<li id="list…">` 行和 `<li class="subject-item">` 卡片两种标记；后者是 grid 模式现在常回的形态，封面靠 `parseSubjectListPage` 取。
- **资料区重命名**：只改名字保留扩展名，挡掉路径分隔符和开头的 `.`（否则扫描器当成隐藏文件），阅读进度按文件 id 迁移。

## 测试

没有测试框架，验证靠临时脚本：

- 临时 `DSH_HOME` 起一个 Host 实例，`fetch` 打 `/api/bookshelf/*` 各条路由
- 解析层（EPUB / TXT / 豆瓣页）单独喂样本数据
- 前端改动用无头 Chrome 出图核对（`--no-sandbox --disable-breakpad` 能绕过沙箱限制）

## 发布

插件市场（索引文件）与收录（awesome-dsh-plugin PR）的完整流程见 [publish/README.md](https://github.com/shushuiu/dsh-bookshelf/blob/main/publish/README.md)。要点：

- 改版本：`package.json` 的 `version` → 重新生成索引 → 重新上传索引文件
- 「发现」页读的是索引（format 1），npm 源或 git 源都可以；官方目录只把 npm 上有版本的插件放进索引
- 收录条目用 `publish/catalog-entry.yml`，图标 `assets/icon-180.png` 已备好