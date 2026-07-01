const { app, BrowserWindow, shell } = require('electron')
const path = require('path')
const http = require('http')

let mainWindow

// Start the Express server inline if it isn't already running
async function isServerRunning(retries = 5, delay = 250) {
  return new Promise((resolve) => {
    function attempt(n) {
      const req = http.get('http://127.0.0.1:3579', (res) => {
        let payload = ''
        res.on('data', c => payload += c)
        res.on('end', () => {
          if (res.statusCode === 200 && payload.includes('"status":"ok"')) {
            resolve(true)
          } else if (n <= 0) {
            resolve(false)
          } else {
            setTimeout(() => attempt(n - 1), delay)
          }
        })
      })
      req.on('error', () => {
        if (n <= 0) {
          resolve(false)
        } else {
          setTimeout(() => attempt(n - 1), delay)
        }
      })
      req.end()
    }
    attempt(retries)
  })
}

async function startServer() {
  const running = await isServerRunning()
  if (running) {
    console.log('✦ Server already running on port 3579')
    return
  }

  try {
    require('./server/index.js')
    console.log('✦ Server module loaded')
  } catch(e) {
    console.error('Failed to load server:', e)
  }
}

// Poll until the server is actually listening, then load the app
function waitForServer(retries = 20, delay = 500) {
  return new Promise((resolve) => {
    function attempt(n) {
      const req = http.get('http://127.0.0.1:3579', (res) => {
        let payload = ''
        res.on('data', c => payload += c)
        res.on('end', () => {
          if (res.statusCode === 200 && payload.includes('"status":"ok"')) {
            console.log('✦ Server is ready!')
            resolve()
          } else if (n <= 0) {
            console.log('Server did not start in time, loading anyway')
            resolve()
          } else {
            console.log(`Waiting for server... (${n} attempts left) status=${res.statusCode}`)
            setTimeout(() => attempt(n - 1), delay)
          }
        })
      })
      req.on('error', () => {
        if (n <= 0) {
          console.log('Server did not start in time, loading anyway')
          resolve()
          return
        }
        console.log(`Waiting for server... (${n} attempts left)`)
        setTimeout(() => attempt(n - 1), delay)
      })
      req.end()
    }
    attempt(retries)
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    title: 'My Diary',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  })

  mainWindow.setMenuBarVisibility(false)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(async () => {
  await startServer()
  createWindow()

  // Show a loading message while server boots
  mainWindow.loadURL('data:text/html,<html style="background:#0f0f1a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p style="color:#f0c27f;font-family:Georgia,serif;font-size:1.2rem">Starting My Diary...</p></html>')

  // Wait for server to be ready, then load the real app
  await waitForServer()
  mainWindow.loadFile('index.html')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err) => {
  console.error('✗ App startup failed:', err)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})