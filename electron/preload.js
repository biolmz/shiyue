'use strict';
/* 拾阅 · preload
 *
 * 只做一件小事：把系统剪贴板借给页面用。
 *
 * 为什么需要：macOS 上 Cmd+V 依赖应用菜单里的 paste role，一旦菜单栏
 * 因任何原因没被系统接管（全屏、焦点切换、连续重开窗口后），键就不响应了。
 * 与其去赌键位，不如给页面一条不经过键盘的通道：
 * 弹窗打开时直接把剪贴板里的链接填进去。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shiyue', {
  platform: process.platform,
  clipboard: {
    read: () => ipcRenderer.invoke('clip:read'),
    write: (text) => ipcRenderer.invoke('clip:write', String(text == null ? '' : text)),
  },
});
