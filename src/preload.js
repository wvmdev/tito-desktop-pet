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
    onLift: cb => ipcRenderer.on('pet:lift', (_e, px) => cb(px)),
    // Main polls the real cursor and asks whether that point is over Tito's body.
    onHover: cb => ipcRenderer.on('pet:hover', (_e, p) => cb(p)),
  },
  // Popups are reused; this fires each time one is shown.
  onPopupOpen: cb => ipcRenderer.on('popup:open', () => cb()),
  menu: {
    close: () => ipcRenderer.send('menu:close'),
    openSettings: () => ipcRenderer.send('menu:settings'),
    openChat: () => ipcRenderer.send('menu:chat'),
    feed: () => ipcRenderer.send('menu:feed'),
    onNote: cb => ipcRenderer.on('popup:note', (_e, t) => cb(t)),
  },
  chat: {
    get: () => ipcRenderer.invoke('chat:get'),
    send: text => ipcRenderer.send('chat:send', text),
    stop: () => ipcRenderer.send('chat:stop'),
    clear: () => ipcRenderer.invoke('chat:clear'),
    openSettings: () => ipcRenderer.send('chat:open-settings'),
    onDelta: cb => ipcRenderer.on('chat:delta', (_e, d) => cb(d)),
    onDone: cb => ipcRenderer.on('chat:done', (_e, d) => cb(d)),
    onError: cb => ipcRenderer.on('chat:error', (_e, d) => cb(d)),
    onAction: cb => ipcRenderer.on('chat:action', (_e, a) => cb(a)),
    onIdle: cb => ipcRenderer.on('chat:idle', () => cb()),
    onStatus: cb => ipcRenderer.on('chat:status', (_e, s) => cb(s)),
    setExpanded: on => ipcRenderer.send('chat:set-expanded', !!on),
    onExpanded: cb => ipcRenderer.on('chat:expanded', (_e, on) => cb(on)),
  },
  size: {
    get: () => ipcRenderer.invoke('size:get'),
    set: value => ipcRenderer.send('size:set', value),
    close: () => ipcRenderer.send('size:close'),
  },
  companion: {
    get: () => ipcRenderer.invoke('companion:get'),
    feed: () => ipcRenderer.invoke('companion:feed'),
    onChange: cb => ipcRenderer.on('settings:companion', (_e, c) => cb(c)),
  },
  tasks: {
    add: task => ipcRenderer.invoke('tasks:add', task),
    remove: id => ipcRenderer.invoke('tasks:remove', id),
    toggle: (id, on) => ipcRenderer.invoke('tasks:toggle', id, !!on),
    onChange: cb => ipcRenderer.on('settings:tasks', (_e, list) => cb(list)),
  },
  confirm: {
    onShow: cb => ipcRenderer.on('confirm:show', (_e, r) => cb(r)),
    answer: (id, allow) => ipcRenderer.send('confirm:answer', id, allow === true),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    onChanged: cb => ipcRenderer.on('settings:changed', (_e, all) => cb(all)),
    onMood: cb => ipcRenderer.on('settings:mood', (_e, m) => cb(m)),
  },
  ai: {
    saveKey: (provider, key) => ipcRenderer.invoke('ai:save-key', provider, key),
    removeKey: provider => ipcRenderer.invoke('ai:remove-key', provider),
    test: () => ipcRenderer.invoke('ai:test'),
    listModels: () => ipcRenderer.invoke('ai:list-models'),
    openKeyPage: id => ipcRenderer.invoke('ai:open-key-page', id),
  },
});
