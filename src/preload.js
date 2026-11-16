// Preload bridge: a small, explicit API per window. No raw ipcRenderer is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tito', {
  platform: process.platform,
  pet: {
    ready: () => ipcRenderer.send('pet:ready'),
    setIgnoreMouse: ignore => ipcRenderer.send('pet:ignore-mouse', !!ignore),
    click: () => ipcRenderer.send('pet:click'),
    dblclick: () => ipcRenderer.send('pet:dblclick'),
    dragStart: (ox, oy) => ipcRenderer.send('pet:drag-start', { ox, oy }),
    dragMove: (sx, sy) => ipcRenderer.send('pet:drag-move', { sx, sy }),
    dragEnd: () => ipcRenderer.send('pet:drag-end'),
    onPlay: cb => ipcRenderer.on('pet:play', (_e, anim) => cb(anim)),
    onSize: cb => ipcRenderer.on('pet:size', (_e, s) => cb(s)),
    // Main polls the real cursor and asks whether that point is over Tito's body.
    onHover: cb => ipcRenderer.on('pet:hover', (_e, p) => cb(p)),
  },
  // Popups are reused; this fires each time one is shown.
  onPopupOpen: cb => ipcRenderer.on('popup:open', () => cb()),
  menu: {
    close: () => ipcRenderer.send('menu:close'),
    openSettings: () => ipcRenderer.send('menu:settings'),
  },
  size: {
    get: () => ipcRenderer.invoke('size:get'),
    set: value => ipcRenderer.send('size:set', value),
    close: () => ipcRenderer.send('size:close'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    onChanged: cb => ipcRenderer.on('settings:changed', (_e, all) => cb(all)),
    onMood: cb => ipcRenderer.on('settings:mood', (_e, m) => cb(m)),
  },
});
