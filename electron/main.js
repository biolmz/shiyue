'use strict';
/**
 * Electron 主进程 —— 把本地服务包成一个桌面应用
 *
 * 跨平台要点：
 *   - 数据目录一律走 app.getPath('userData')，安装目录不可写
 *   - macOS 关窗不退出（Dock 图标还在，点一下重开），Cmd+Q 才真退
 *   - macOS 菜单第一项必须是应用菜单（关于/服务/隐藏/退出），Windows 放「文件」里
 *   - 开发态 Dock 图标要手动设，打包后由 .icns 接管
 */
const { app, BrowserWindow, Menu, shell, dialog, screen, clipboard, ipcMain } = require('electron');
const path = require('path');

const IS_MAC = process.platform === 'darwin';

// 数据放用户目录（安装目录在 Program Files / /Applications 下不可写）
const DATA_DIR = path.join(app.getPath('userData'), 'library');
process.env.SHIYUE_DATA = process.env.SHIYUE_DATA || DATA_DIR;

const { start } = require('../server.js');

let win = null;
let serverPort = 0;

const APP_NAME = '拾阅';
const TAGLINE = '本地文献与长文阅读器';

/** 窗口别超出工作区：13 寸 MacBook 扣掉菜单栏和 Dock 只剩 ~830 高 */
function fitSize() {
  let wa = { width: 1440, height: 900 };
  try {
    wa = screen.getPrimaryDisplay().workAreaSize;
  } catch (e) { /* 拿不到就用默认 */ }
  return {
    width: Math.max(940, Math.min(1380, wa.width - 40)),
    height: Math.max(620, Math.min(880, wa.height - 40)),
  };
}

function createWindow(port) {
  const { width, height } = fitSize();

  win = new BrowserWindow({
    width,
    height,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#F3F1EB',
    title: APP_NAME,
    icon: path.join(__dirname, IS_MAC ? 'icon.png' : 'icon.ico'),
    show: false,
    center: true,
    autoHideMenuBar: !IS_MAC,
    // macOS 用系统红绿灯；标题栏照常显示，不抢内容区
    titleBarStyle: IS_MAC ? 'default' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (IS_MAC) win.focus();
  });
  win.loadURL('http://127.0.0.1:' + port + '/');

  // 外链走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url) && !url.startsWith('http://127.0.0.1')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1:' + port)) {
      e.preventDefault();
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    }
  });

  // 右键菜单：键位失灵时的兜底。macOS 上 Cmd+C/V 归应用菜单管，
  // 菜单一旦没被系统接管键就哑了，右键这条路始终在。
  win.webContents.on('context-menu', (e, p) => {
    const items = [];
    if (p.linkURL) {
      items.push({ label: '在浏览器中打开链接', click: () => shell.openExternal(p.linkURL) });
      items.push({ label: '复制链接地址', click: () => clipboard.writeText(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) {
      items.push({ role: 'cut', label: '剪切' });
      items.push({ role: 'copy', label: '复制' });
      items.push({ role: 'paste', label: '粘贴' });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll', label: '全选' });
    } else if (p.selectionText) {
      items.push({ role: 'copy', label: '复制' });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll', label: '全选' });
    }
    while (items.length && items[items.length - 1].type === 'separator') items.pop();
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.on('closed', () => { win = null; });
}

/** 在渲染进程里执行（菜单用） */
function run(js) {
  if (win && !win.isDestroyed()) win.webContents.executeJavaScript(js, true).catch(() => {});
}

function showAbout() {
  if (IS_MAC) return app.showAboutPanel();
  dialog.showMessageBox(win, {
    type: 'info',
    title: '关于' + APP_NAME,
    message: APP_NAME + ' ' + app.getVersion(),
    detail: TAGLINE + '\n\n' +
      '链接抓取 · PDF 阅读 · 划线批注 · 导出 BibTeX / Markdown\n\n' +
      '数据目录：\n' + DATA_DIR,
    buttons: ['好'],
  });
}

/* 剪贴板通道：页面拿它做「从剪贴板粘贴」，不依赖键盘事件 */
ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.handle('clip:write', (e, text) => clipboard.writeText(String(text == null ? '' : text)));

function buildMenu() {
  const fileMenu = {
    label: '文件',
    submenu: [
      { label: '添加链接…', accelerator: 'CmdOrCtrl+N', click: () => run('document.querySelector("#btnImport").click()') },
      { label: '上传 PDF…', accelerator: 'CmdOrCtrl+O', click: () => run('document.querySelector("#fileInput").click()') },
      { type: 'separator' },
      { label: '导出 BibTeX（可导入 Zotero）', click: () => run('document.querySelector("#btnBib").click()') },
      { label: '打开数据目录', click: () => shell.openPath(DATA_DIR) },
      { type: 'separator' },
      IS_MAC
        ? { role: 'close', label: '关闭窗口' }
        : { role: 'quit', label: '退出' },
    ],
  };

  const template = [];

  // macOS：第一项必须是应用菜单
  if (IS_MAC) {
    template.push({
      label: APP_NAME,
      submenu: [
        { role: 'about', label: '关于' + APP_NAME, click: showAbout },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' + APP_NAME },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出' + APP_NAME },
      ],
    });
  }

  template.push(fileMenu);

  template.push({
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      ...(IS_MAC ? [{ role: 'pasteAndMatchStyle', label: '粘贴为纯文本' }] : []),
      { role: 'selectAll', label: '全选' },
    ],
  });

  template.push({
    label: '视图',
    submenu: [
      { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => run('document.querySelector("#fontPlus").click()') },
      { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => run('document.querySelector("#fontMinus").click()') },
      { type: 'separator' },
      { role: 'reload', label: '重新加载' },
      { role: 'toggleDevTools', label: '开发者工具' },
      { type: 'separator' },
      { role: 'resetZoom', label: '重置界面缩放' },
      { role: 'zoomIn', label: '界面放大' },
      { role: 'zoomOut', label: '界面缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: IS_MAC ? '进入全屏幕' : '全屏' },
    ],
  });

  // macOS 惯例：独立的「窗口」菜单
  if (IS_MAC) {
    template.push({
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ],
    });
  }

  template.push({
    label: '帮助',
    submenu: [{ label: '关于' + APP_NAME, click: showAbout }],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (IS_MAC) {
      app.setAboutPanelOptions({
        applicationName: APP_NAME,
        applicationVersion: app.getVersion(),
        version: '',
        copyright: TAGLINE,
        credits: '链接抓取 · PDF 阅读 · 划线批注',
      });
      // 开发态（未打包）Dock 图标是 Electron 默认脸，手动换掉
      if (!app.isPackaged && app.dock) {
        try { app.dock.setIcon(path.join(__dirname, 'icon.png')); } catch (e) { /* 忽略 */ }
      }
    }

    try {
      serverPort = await start(0);      // 端口交给系统分配，避免占用冲突
    } catch (e) {
      dialog.showErrorBox(APP_NAME + '启动失败', String(e.message || e));
      app.quit();
      return;
    }
    buildMenu();
    createWindow(serverPort);

    // macOS：Dock 图标点一下，没有窗口就重开
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(serverPort);
    });
  });

  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();   // macOS 关窗不退出，这是系统惯例
  });
}
