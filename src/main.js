// Client Clusters — main process
// Creates the window; the modules in ./main handle files, geocoding, Google pages and backups.
const { app, BrowserWindow, ipcMain, shell, Menu, session, screen } = require('electron');
const path = require('path');
const { APP_UA, ui, dailyBackup } = require('./main/paths');
require('./main/files');
const { geoCache, townCache } = require('./main/geocode');
require('./main/google');
require('./main/backup');

const isWebUrl = url => /^https?:\/\//.test(url);

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = ui.win = new BrowserWindow({
    width: Math.min(1400, width),
    height: Math.min(880, height),
    minWidth: Math.min(640, width),
    minHeight: Math.min(480, height),
    show: false,
    title: 'Client Clusters',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#edf0f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged, // developer tools only when running from source
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Open external links in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (isWebUrl(url)) shell.openExternal(url);
  });
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const { win } = ui;
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    // Map tile servers ask apps to identify themselves (OpenStreetMap tile usage policy).
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['https://tile.openstreetmap.org/*', 'https://data.geopf.fr/*'] },
      (details, cb) => { details.requestHeaders['User-Agent'] = APP_UA; cb({ requestHeaders: details.requestHeaders }); });
    dailyBackup();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  // Addresses found in the last second or two are still waiting to be written to the cache files.
  app.on('will-quit', () => { geoCache.flush(); townCache.flush(); });
}

ipcMain.handle('app:openExternal', (_e, url) => {
  if (isWebUrl(url)) shell.openExternal(url);
});
