const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let flaskProc = null;
let mainWindow = null;

const PORT = process.env.EKKU_PORT || 5000;
const FLASK_URL = `http://127.0.0.1:${PORT}`;

function startFlask() {
    // Determine the Python/Flask entry. In dev, run app.py directly.
    const pythonCmd = process.env.EKKU_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const appPath = path.join(__dirname, 'app.py');

    flaskProc = spawn(pythonCmd, [appPath], {
        env: { ...process.env, EKKU_PORT: String(PORT) },
        stdio: 'ignore'
    });

    flaskProc.on('error', (err) => {
        console.error('Failed to start Flask:', err);
    });
    flaskProc.on('exit', (code) => {
        console.log('Flask exited with code', code);
    });
}

function waitForServer(cb, tries = 0) {
    const http = require('http');
    const req = http.get(FLASK_URL, () => {
        req.destroy();
        cb();
    });
    req.on('error', () => {
        if (tries > 40) {
            console.error('Server did not start in time.');
            return;
        }
        setTimeout(() => waitForServer(cb, tries + 1), 300);
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#fbf9f9',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadURL(FLASK_URL);
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
    startFlask();
    waitForServer(() => createWindow());

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (flaskProc) { flaskProc.kill(); flaskProc = null; }
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (flaskProc) { flaskProc.kill(); flaskProc = null; }
});
