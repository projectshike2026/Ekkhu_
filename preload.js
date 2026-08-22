// Preload script - safe bridge between Electron main and renderer
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('ekku', {
    platform: process.platform,
    version: require('./package.json').version
});
