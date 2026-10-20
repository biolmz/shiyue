# 拾阅

把公众号文章、论文页面、arXiv、DOI、PDF **粘进去**，抓成干净的正文，然后划线、写批注、导出。
PDF 直接拖进来就能读，**文字层可以划高亮**，批注按页记，缩放不跑位。

界面是 Zotero 那种三栏布局：左边分类，中间条目列表，右边详情。批注、标签、BibTeX 都能跟 Zotero 对接。

支持 **Windows / macOS**，同一份数据格式，文库可以整个目录拷来拷去。

---

## 安装

三个平台的安装包都在 [Releases](https://github.com/biolmz/shiyue/releases) 里，
按自己的机器选。文件名是 ASCII（`shiyue-…`），因为 GitHub 会把资产名里的中文剥掉。

### Windows

运行 **`shiyue-Setup-1.2.1.exe`**，装完桌面和开始菜单都有「拾阅」。
装在用户目录，不需要管理员权限；卸载不会删文库。

### macOS

| 机器 | 装哪个 |
|---|---|
| Apple Silicon（M1/M2/M3/M4…） | **`shiyue-1.2.1-arm64.dmg`** |
| Intel 芯片 | **`shiyue-1.2.1-x64.dmg`** |

打开 dmg，把「拾阅」拖进 Applications 就行。

> **第一次打开**会被 macOS 拦下（应用没有 Apple 开发者签名，属于正常现象）：
> 在「拾阅」上**右键 → 打开 → 再点「打开」**，之后就不会再问了。
> 如果提示「已损坏，无法打开」，在终端跑一句 `xattr -dr com.apple.quarantine /Applications/拾阅.app`。

### Android 平板

装 **`shiyue-1.2.1-android.apk`**，Android 7.0 以上。文件管理器里点开就能装，
系统会问「是否安装未知来源应用」——允许一次即可。

平板横屏是左边分类、中间列表、右边详情的三栏；竖屏和手机会把分类栏收起来。

> APK 里没有 Node，后端换成了 `public/mobile/boot.js`：
> 同样的路由名与返回结构，实现是 IndexedDB + CapacitorHttp。
> 数据全在设备本机，**卸载应用会连文库一起删掉**，重要内容先导出 Markdown。

两边桌面版都不用装 Node.js，不联网也能用（只有抓取内容时需要网络）。
卸载时文库不会被删，重装还认得。

---

## 重新打包

### 打 mac 包

`.dmg` 要靠 macOS 的 `hdiutil` 和 `codesign`，所以只能在 Mac 或云 Mac 上打。

本机是 Mac：双击 **`打包-mac.command`**，或

```bash
npm install
npm run dist:mac        # → dist/shiyue-<版本>-{arm64,x64}.dmg
```

没有 Mac：让 GitHub Actions 代劳。推一个 `v*` 标签即可，
`.github/workflows/build-mac.yml` 会在 `macos-14` 上跑完并把 dmg 挂到 Release。

### 打 APK

```bash
npm install
node tools/make-mobile-extract.js   # lib/extract.js → public/mobile/extract.js
npx cap add android                 # 生成原生工程（不入库）
npx cap sync android
cd android && ./gradlew assembleDebug
```

需要 JDK 17 和 Android SDK（`local.properties` 里写 `sdk.dir=`）。
CI 上由 `.github/workflows/build-android.yml` 全自动做，产物是 debug 签名的 APK。

### 打 Windows 包

```bash
npm run dist:win        # → dist/shiyue-Setup-<版本>.exe
```

CI 上由 `.github/workflows/build-win.yml` 做。

> 三个工作流都带 `--publish never`：环境里存在 `GITHUB_REPOSITORY` 时
> electron-builder 会误以为要发 Release 并索要 `GH_TOKEN`。
> 发 Release 另走 `softprops/action-gh-release`，需要 `permissions: contents: write`。

## 不想装？直接跑源码

需要本机有 Node.js。

- Windows：双击 **`启动.bat`**
- macOS：双击 **`启动.command`**
  （首次若双击没反应，终端里执行 `chmod +x 启动.command`，或在「终端」里 `./启动.command`）

浏览器会打开 http://127.0.0.1:7788 —— 功能一样，只是没有独立窗口。

---

## 怎么用

### 存东西进来

| 想做的事 | 怎么做 |
|---|---|
| 存一篇文章 | 复制链接 → 在拾阅里按 **粘贴**（`Ctrl+V` / `⌘V`，任意位置粘贴，自动弹窗） |
| 批量存 | 点「添加链接」，一行一个，最多 6 条 |
| 存本地 PDF | 点「上传 PDF」，或者**直接把文件拖进窗口**（可多选） |
| 换 Zotero 里已有的库 | 侧栏底部 **BIB** 导出整库 BibTeX，Zotero 里「文件 → 导入」 |

### 读文献（PDF）

- **划线**：鼠标选中 PDF 文字 → 浮出四个色点 → 点一个颜色，高亮立即落在原位
- **批注**：划线后右侧批注框直接打字，自动保存
- **缩放**：`A− A+` 或「适宽」，缩放重排后**高亮不会漂**
- **翻页**：左侧缩略图点一下直达；滚轮连续翻
- **摘要 / PDF 切换**：顶栏一键切，题录和摘要跟正文都在一起

### 读长文（公众号 / 网页）

- **划线**：选中正文 → 选颜色
- **回到位置**：点右侧批注条目，或点正文里的高亮
- **整篇的想法**：右侧「笔记」标签页
- **加标签**：标题下方「+ 标签」，逗号隔开

### 导出

| 目的地 | 操作 |
|---|---|
| 给别人看 | 详情页下载图标 → Markdown（含题录、我的笔记、划线摘录、原文） |
| 进 Zotero / EndNote | 侧栏底部 **BIB** → BibTeX |
| 备份 / 迁移 | 菜单「文件 → 打开数据目录」，整个文件夹拷走即可 |

**四种颜色约定**（自己定也行）：黄=重点 · 绿=方法/数据 · 蓝=结论 · 粉=存疑

快捷键（Windows 用 `Ctrl`，macOS 用 `⌘`）：`V` 粘贴链接 · `N` 添加链接 · `O` 上传 PDF · `K` 搜索 · `Esc` 关闭浮层

---

## 支持什么链接

| 类型 | 效果 |
|---|---|
| 微信公众号 `mp.weixin.qq.com/s/...` | 抓正文 + 配图下载到本地（离线能看），表格保留 |
| arXiv `arxiv.org/abs/xxxx` | 题录 + 摘要 + 自动下 PDF |
| DOI `doi.org/10.xxxx/...` | 走 Crossref 拿题录摘要；有开放全文就抓正文 |
| PDF 直链 `xxx.pdf` | 下载后进 PDF 阅读器 |
| 普通网页 / 博客 | 自动抽正文，去导航和广告 |

粘贴整段分享文字也行——会自动把链接抠出来。

---

## 数据在哪

纯本地，不经过任何服务器。

| 平台 | 路径 |
|---|---|
| Windows（安装版） | `%APPDATA%\shiyue\library\` |
| macOS（安装版） | `~/Library/Application Support/shiyue/library/` |
| 源码运行 | 项目下的 `data/` |

```
library/
  library.json          文库索引
  items/<id>.json       正文 / 题录
  items/<id>.anno.json  批注（文字版按段落+字符偏移，PDF 版按页+归一化矩形）
  media/<id>/           配图、PDF 原件
```

菜单「文件 → 打开数据目录」直接定位（macOS 会在访达里选中这个文件夹）。

---

## 网络

- 抓取优先**直连**，超时才切代理，不会卡住。
- 自动探测本机常见代理端口（Clash 7897 / 7890、V2Ray 10809、Surge 6152 等），也读 `HTTPS_PROXY`。
- 同一个站点直连失败过就记 5 分钟，避免反复等超时。

---

## 已知边界

- **公众号偶尔被拦**（微信风控返回「环境异常」）。过一会儿再试，或用浏览器另存网页。
- **付费墙论文**只能存题录和摘要，全文抓不到——版权限制，绕不过去。要点写在「笔记」里。
- **扫描版 PDF 没有文字层**，划不了高亮（需要 OCR，未做）。
- 纯 JS 渲染的站点（部分知乎、小红书）可能抽不出正文。
- macOS 版是 **ad-hoc 签名**：自己用完全没问题，但发给别人仍会被 Gatekeeper 提示。要彻底消掉得买 Apple 开发者证书。

---

## 自己改

```
拾阅/
  electron/
    main.js        桌面壳（起本地服务、跨平台菜单、外链跳浏览器）
    icon.ico       Windows 图标
    icon.icns      macOS 图标
    icon.png       Linux / 开发态 Dock
  下载页.html      单文件下载页（双击就能看，零外部依赖）
  server.js        本地服务（零依赖，纯 http 模块）
  lib/
    net.js         网络出口（直连 / 代理自动切换）
    importer.js    抓取 → 提取 → 入库
    extract.js     正文提取引擎（结构识别、表格、导航过滤）
    pdfmeta.js     PDF 题录抽取（不依赖第三方库）
    store.js       文件存储
  public/
    index.html     三栏布局
    app.js         文库、详情、阅读器、批注
    pdfview.js     PDF 渲染 + 文本层高亮（基于 pdf.js）
    style.css
    vendor/pdfjs/  pdf.js 4.10
  tools/
    make-icon.js      图标生成（同时出 ico / icns / png）
    after-pack-mac.js macOS ad-hoc 签名钩子
```

### 打包

```bash
npm install

npm run dist:win     # Windows → dist/拾阅-Setup-1.2.0.exe
npm run dist:mac     # macOS   → dist/拾阅-1.2.0-arm64.dmg + -x64.dmg
```

注意：

- **macOS 包只能在 Mac 上打**，Windows 上做不出 dmg（这是 Apple 工具链的限制）。
- 国内下载 Electron 慢的话先设镜像：

  ```bash
  export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
  ```

- 改图标：编辑 `tools/make-icon.js` 里的配色和版式，然后 `npm run icon`，两个平台的图标一起换掉。
