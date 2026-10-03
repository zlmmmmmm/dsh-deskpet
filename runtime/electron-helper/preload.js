'use strict';
/** 渲染进程与主进程之间的唯一通道（contextIsolation 开启，只暴露白名单方法） */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpet', {
  /** 取初始化载荷（宠物配置 / 几何 / 工作区 / 行为开关） */
  ready: () => ipcRenderer.invoke('deskpet:ready'),
  /** 请求把窗口移到 (x, y)（DIP 屏幕坐标）；主进程会夹回工作区 */
  moveWindow: (x, y) => ipcRenderer.send('deskpet:move', x, y),
  /** 拖拽/菜单期间锁住穿透翻转 */
  lockInput: (locked) => ipcRenderer.send('deskpet:lock', locked),
  /** 唤起并聚焦 DSH */
  focusDsh: () => ipcRenderer.send('deskpet:focus-dsh'),
  /** 在窗口内 (x, y) 处弹右键菜单 */
  openMenu: (at) => ipcRenderer.send('deskpet:menu', at),
  quit: () => ipcRenderer.send('deskpet:quit'),

  /** 事件订阅（返回取消订阅函数） */
  onInit: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('deskpet:init', h);
    return () => ipcRenderer.off('deskpet:init', h);
  },
  onHover: (cb) => {
    const h = (_e, inside) => cb(inside);
    ipcRenderer.on('deskpet:hover', h);
    return () => ipcRenderer.off('deskpet:hover', h);
  },
  onHome: (cb) => {
    const h = (_e, pos) => cb(pos);
    ipcRenderer.on('deskpet:home', h);
    return () => ipcRenderer.off('deskpet:home', h);
  },
  /** 宿主/菜单切换了形象（物种 + 新几何） */
  onSpecies: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('deskpet:species', h);
    return () => ipcRenderer.off('deskpet:species', h);
  },
  onPush: (cb) => {
    const h = (_e, msg) => cb(msg);
    ipcRenderer.on('deskpet:push', h);
    return () => ipcRenderer.off('deskpet:push', h);
  },
});
