const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('auraDesktop', {
  beginDrag: (x,y) => ipcRenderer.send('aura:begin-drag',{x,y}),
  moveDrag: (x,y) => ipcRenderer.send('aura:move-drag',{x,y}),
  endDrag: () => ipcRenderer.send('aura:end-drag'),
  resize: scale => ipcRenderer.send('aura:resize',scale),
  setPanelMode: mode => ipcRenderer.send('aura:panel-mode',mode),
  getAssistantSettings: () => ipcRenderer.invoke('aura:settings:get'),
  saveAssistantSettings: settings => ipcRenderer.invoke('aura:settings:save',settings),
  testAssistantConnection: settings => ipcRenderer.invoke('aura:settings:test',settings),
  clearAssistantKey: () => ipcRenderer.invoke('aura:settings:clear-key'),
  sendChat: messages => ipcRenderer.invoke('aura:chat:send',{messages})
});
