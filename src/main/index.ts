import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc/register'
import { shutdownAllConnections } from './ssh/connection-manager'

const isDev = !!process.env['ELECTRON_RENDERER_URL']
const appOrigin = isDev ? new URL(process.env['ELECTRON_RENDERER_URL'] as string).origin : null

/** The app's own document: the dev server in dev, the packaged bundle in prod. */
function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return appOrigin !== null ? u.origin === appOrigin : u.protocol === 'file:'
  } catch {
    return false
  }
}

/**
 * shell.openExternal hands the URL to the OS dispatcher, which launches apps for
 * schemes like file:/smb:/custom handlers — only browser schemes may cross it.
 */
function openExternalIfWeb(url: string): void {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return
  }
  if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url)
}

/**
 * Cancels any navigation away from the app's own origin: a foreign document in
 * this webContents re-runs the preload and inherits the whole window.api bridge.
 */
function denyIfForeign(details: { url: string; preventDefault: () => void }): boolean {
  if (isAppUrl(details.url)) return false
  details.preventDefault()
  return true
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfWeb(url)
    return { action: 'deny' }
  })

  // will-frame-navigate covers the main frame and every subframe, and will-navigate
  // repeats it for the main frame — only one of the two may reach the browser
  win.webContents.on('will-frame-navigate', (details) => {
    if (denyIfForeign(details)) openExternalIfWeb(details.url)
  })
  win.webContents.on('will-navigate', (details) => {
    denyIfForeign(details)
  })
  win.webContents.on('will-redirect', (details) => {
    if (denyIfForeign(details)) openExternalIfWeb(details.url)
  })

  if (isDev) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] as string)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  shutdownAllConnections()
})
