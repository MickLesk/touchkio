const { contextBridge, ipcRenderer } = require("electron");

const validSendChannels = ["button-click", "input-blur", "input-focus", "input-enter"];
const validReceiveChannels = [
  "button-disabled",
  "button-hidden",
  "text-content",
  "input-text",
  "input-readonly",
  "input-select",
  "data-theme",
];

contextBridge.exposeInMainWorld("ipc", {
  send: (channel, data) => {
    if (validSendChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  on: (channel, callback) => {
    if (validReceiveChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
});
