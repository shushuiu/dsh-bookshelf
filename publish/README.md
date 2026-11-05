# 发布给别人装（插件市场）

DSH 的「发现」页不是应用商店，而是**一组索引文件**：你把自己的插件包发布到 npm 或 Git，再用一个 `index.json` 列出「包名 + 精确版本 + 来源」，把这份 JSON 放在 HTTPS 上，别人把 URL 加进「索引源」就能在「发现」里看到、点「安装」。整个格式是 **format 1**，由 `@deepseek-ai/dsh-plugin-market-index` 校验（必填项写错会导致整份索引被拒绝，而不只是那一条）。

本目录里的 `index.json` 已经用它校验通过。

## 三条路

| 路线 | 别人怎么装 | 状态 |
| --- | --- | --- |
| **A. Git + Release tarball** | 加索引 → 发现里点安装（索引里钉 commit，或指向 Release 的 tgz） | ✅ 已就绪，见下方「现在的分享链接」 |
| **B. npm** | 同上，装的是 `dsh-bookshelf@<version>` | ⏸ npm 建号被机房 IP 风控拦住（`PUT /-/user/…` 403），换非机房网络建号后再走 |
| **C. 官方目录** | 出现在插件列表页；npm 发过版的条目才会进「发现」索引 | 分支已备好，等仓库满 1 天开 PR |

（还有 D：直接把 zip 给人，用 `install_bundle` 指向解压目录——不需要索引，但每次更新都要重新发文件。）

## A. 发到 npm

```bash
cd ~/deepseek/workspace/书架/plugin
npm login              # 需要 npm 账号，第一次用
npm publish            # 80 KB / 11 个文件，无依赖、无构建脚本
node publish/build-index.mjs            # 生成 publish/index.json（含版本号、时间戳、engines）
```

发布后再把 `publish/index.json` 放到任意 HTTPS 位置，例如：

- GitHub Pages：仓库里放 `index.json`，URL 形如 `https://<user>.github.io/<repo>/index.json`
- jsDelivr 转发 GitHub：`https://cdn.jsdelivr.net/gh/<user>/<repo>@main/index.json`
- Gist raw、自己的静态站都行

**每次发新版**：改 `package.json` 的 `version` → `npm publish` → 重跑 `build-index.mjs` → 覆盖上传 `index.json`。索引里多版本可以并存（`versions` 是数组），插件面板会挑兼容的版本。

## B. 发到 Git（没有 npm 账号）

```bash
git init && git add -A && git commit -m "dsh-bookshelf 1.0.0" && git remote add origin <仓库>
git push -u origin main
git rev-parse HEAD          # 记下 40 位 commit（必须完整 40 位）
node publish/build-index.mjs --git https://github.com/<user>/<repo> <40位commit>
node publish/build-index.mjs --git https://github.com/<user>/<repo> <40位commit> --path plugin   # 包在子目录时
```

索引里的 `source` 变成 `{ "type": "git", "url": …, "commit": … }`，安装时 pnpm 会拉 `git+https://…git#<commit>`（对方机器需要能访问该仓库和 `git`）。

## C. 进官方目录（awesome-dsh-plugin 的 PR）

「发现」页默认索引就是 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：列表由 `data/plugins/*.yml` 生成，收录靠 **GitHub PR**，不需要 npm 账号。

**一个 PR 只加一个文件**：`data/plugins/<owner>__<repo>.yml`（本目录的 `catalog-entry.yml` 就是填好的模板）。

要求（CI 自动查）：

- 仓库 `package.json` 声明 `dsh.bundle`（我们已经有 `dsh.bundle.patch` ✓；只有 `dsh.client` 会被拒）
- 仓库**创建满 1 天**才会通过，刚建的仓库今天提会被拦（不含对插件的评价，稍后再提即可）
- 给仓库加 `dsh-plugin` topic
- 描述必须与代码一致（会被逐条核对，夸大是主要打回原因），一句话、无营销词、以句号结尾
- `icon` 用 GitHub 托管的**位图**（本目录已生成 `../assets/icon-180.png`，180×180，直接提交进仓库即可）

**不发 npm 也能收录**：仓库能 `dsh plugin add`（从源码装）即可；想让人少一步构建授权，可以把 `npm pack` 出的 `dsh-bookshelf-<version>.tgz` 挂到 GitHub Release，并在条目里写可选的 `tarball:`。本包无依赖、无构建脚本，两种情况都能装。

**注意范围差异**：「列表」收录 ≠ 进「发现」的市场索引。索引只收**npm 上有版本**的插件（`source.type: npm`），GitHub-only 条目在列表页显示的是安装命令，不在「发现」里可点安装。要「发现」里一键装，仍需路线 A。

步骤：

```bash
# 1. 建仓库并推上去（仓库名建议 dsh-bookshelf）
cd ~/deepseek/workspace/书架/plugin
git init && git add -A && git commit -m "dsh-bookshelf 1.0.0"
git remote add origin https://github.com/<owner>/dsh-bookshelf.git
git push -u origin main
#    然后在 GitHub 仓库页 → About 齿轮 → Topics 填 dsh-plugin

# 2. fork awesome-dsh-plugin，把 catalog-entry.yml 改名放进去（记得替换 <owner>）
#    data/plugins/<owner>__dsh-bookshelf.yml

# 3. 提 PR，等 CI 与维护者评审
```

## D. 自己留档

「发现」默认索引是 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（发布为 npm 包 `dsh-plugin-catalog`，读 `index.json`）。把插件发布到 npm 后向该仓库提交收录，进入由他们生成的目录，所有人不用加索引就能看到。这条路要求先完成 A。

## 现在的分享链接（不需要 npm）

```
https://cdn.jsdelivr.net/gh/shushuiu/dsh-bookshelf@f53c3bc/publish/index.json
```

- 索引里的 `source` 是 git，钉在 commit `afcf9d1`，安装 spec 为
  `git+https://github.com/shushuiu/dsh-bookshelf.git#afcf9d171626cc03d8aa1375dabf71ff07c2c128`
- 预构建包：<https://github.com/shushuiu/dsh-bookshelf/releases/download/v1.0.0/dsh-bookshelf-1.0.0.tgz>（81 KB，两种安装方式都用 pnpm 实测装通过）
- 换版本时：push 新 commit → `node publish/build-index.mjs --git <repo> <new-sha>` → 上传/提交 `publish/index.json`

## 别人那边怎么操作

1. 打开 **插件** 页 → **发现** 标签
2. 点 **管理索引源…**（没有索引时是 **添加索引源**）
3. 在 **索引 URL** 里填 `https://…/index.json` → **添加**
4. 回到「发现」，刷新，搜「书架」→ 点 **安装**
5. 页面会提示「索引由第三方提供」，装完插件以你的权限运行——所以只加信任的索引

装完不需要备份或迁移：每个用户的数据都在自己的 `~/.dsh/storages/bookshelf/` 下。

## 这份索引里有什么

- `format: 1`、`title`（必须含 `en`）、`description`
- `metadata.categories` 里声明了 `reading`，插件条目用 `metadata.category: "reading"` 引用（引用了没声明的 id 会整份被拒）
- `plugins[0]`：`name`（npm 包名）、`title`/`description`（中英）、`icon`（内联 `data:` SVG，≤32 KiB，所以不用额外托管图片）、`metadata.keywords`
- `versions[0]`：精确 SemVer、`publishTimestamp`（Unix 秒）、`source`、`engines.dsh`（决定「发现」里的兼容性提示）