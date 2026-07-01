const express = require('express')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const fetch = require('node-fetch')
const path = require('path')
const fs = require('fs')

// ── CONFIG ───────────────────────────────────────────
const PORT = 3579
const JWT_SECRET = 'diary-secret-key-2024'

// Store DB and key next to the app (works in both dev and built .exe)
const USER_DATA = process.env.APPDATA
  || (process.platform === 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME)
const APP_DIR = path.join(USER_DATA, 'MyDiary')
if (!fs.existsSync(APP_DIR)) fs.mkdirSync(APP_DIR, { recursive: true })

const DB_PATH = path.join(APP_DIR, 'diary.db')
const ANTHROPIC_KEY_PATH = path.join(APP_DIR, '.anthropic_key')

console.log('📁 Data stored at:', APP_DIR)

// ── DATABASE (sql.js — pure JS, no compilation needed) ──
const initSqlJs = require('sql.js')
let db

async function initDB() {
  const SQL = await initSqlJs()

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH)
    db = new SQL.Database(fileBuffer)
    console.log('✦ Loaded existing database')
  } else {
    db = new SQL.Database()
    console.log('✦ Created new database')
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT 'Untitled',
      body TEXT NOT NULL,
      mood TEXT,
      tags TEXT,
      weather TEXT,
      words INTEGER DEFAULT 0,
      ai_summary TEXT,
      ai_mood TEXT,
      iso_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  saveDB()
  startExpress()
}

function saveDB() {
  const data = db.export()
  fs.writeFileSync(DB_PATH, Buffer.from(data))
}

// ── DB HELPERS ───────────────────────────────────────
function dbGet(sql, params = []) {
  try {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const row = stmt.step() ? stmt.getAsObject() : null
    stmt.free()
    return row
  } catch(e) { console.error('dbGet error:', e.message); return null }
}

function dbAll(sql, params = []) {
  try {
    const stmt = db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  } catch(e) { console.error('dbAll error:', e.message); return [] }
}

function dbRun(sql, params = []) {
  try {
    db.run(sql, params)
    const result = db.exec('SELECT last_insert_rowid()')
    const lastId = result[0]?.values[0][0] || null
    saveDB()
    return { lastInsertRowid: lastId }
  } catch(e) { console.error('dbRun error:', e.message); throw e }
}

// ── EXPRESS APP ──────────────────────────────────────
function startExpress() {
  const app = express()
  app.use(cors({ origin: '*' }))
  app.use(express.json())

  // ── AUTH MIDDLEWARE ────────────────────────────────
  function auth(req, res, next) {
    const header = req.headers.authorization
    if (!header) return res.status(401).json({ error: 'No token' })
    try {
      req.user = jwt.verify(header.split(' ')[1], JWT_SECRET)
      next()
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' })
    }
  }

  // ── REGISTER ──────────────────────────────────────
  app.post('/auth/register', (req, res) => {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })
    const existing = dbGet('SELECT id FROM users WHERE email = ?', [email])
    if (existing) return res.status(400).json({ error: 'Email already registered' })
    const hashed = bcrypt.hashSync(password, 10)
    const result = dbRun('INSERT INTO users (email, password) VALUES (?, ?)', [email, hashed])
    const token = jwt.sign({ id: result.lastInsertRowid, email }, JWT_SECRET, { expiresIn: '30d' })
    res.json({ token, email })
  })

  // ── LOGIN ─────────────────────────────────────────
  app.post('/auth/login', (req, res) => {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
    const user = dbGet('SELECT * FROM users WHERE email = ?', [email])
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Invalid email or password' })
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' })
    res.json({ token, email: user.email })
  })

  // ── GET ENTRIES ───────────────────────────────────
  app.get('/', (req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/entries', auth, (req, res) => {
    const entries = dbAll(
      'SELECT * FROM entries WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    )
    res.json(entries.map(e => ({ ...e, tags: e.tags ? JSON.parse(e.tags) : [] })))
  })

  // ── CREATE ENTRY ──────────────────────────────────
  app.post('/entries', auth, (req, res) => {
    const { title, body, mood, tags, weather } = req.body
    if (!body) return res.status(400).json({ error: 'Body is required' })
    const words = body.trim().split(/\s+/).filter(Boolean).length
    const isoDate = new Date().toISOString().slice(0, 10)
    const result = dbRun(
      'INSERT INTO entries (user_id, title, body, mood, tags, weather, words, iso_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, title || 'Untitled', body, mood || null, tags ? JSON.stringify(tags) : null, weather || null, words, isoDate]
    )
    const entry = dbGet('SELECT * FROM entries WHERE id = ?', [result.lastInsertRowid])
    res.json({ ...entry, tags: entry.tags ? JSON.parse(entry.tags) : [] })
  })

  // ── UPDATE ENTRY ──────────────────────────────────
  app.put('/entries/:id', auth, (req, res) => {
    const { title, body } = req.body
    const entry = dbGet('SELECT * FROM entries WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
    if (!entry) return res.status(404).json({ error: 'Entry not found' })
    const words = body.trim().split(/\s+/).filter(Boolean).length
    dbRun(
      "UPDATE entries SET title = ?, body = ?, words = ?, updated_at = datetime('now') WHERE id = ?",
      [title || 'Untitled', body, words, req.params.id]
    )
    const updated = dbGet('SELECT * FROM entries WHERE id = ?', [req.params.id])
    res.json({ ...updated, tags: updated.tags ? JSON.parse(updated.tags) : [] })
  })

  // ── DELETE ENTRY ──────────────────────────────────
  app.delete('/entries/:id', auth, (req, res) => {
    const entry = dbGet('SELECT * FROM entries WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
    if (!entry) return res.status(404).json({ error: 'Entry not found' })
    dbRun('DELETE FROM entries WHERE id = ?', [req.params.id])
    res.json({ success: true })
  })

  // ── AI HELPERS ────────────────────────────────────
  function getApiKey() {
    try { return fs.readFileSync(ANTHROPIC_KEY_PATH, 'utf8').trim() }
    catch { return null }
  }

  async function callClaude(system, user, apiKey) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: user }]
      })
    })
    const data = await r.json()
    if (data.error) throw new Error(data.error.message)
    return data.content[0].text
  }

  // ── SAVE API KEY ──────────────────────────────────
  app.post('/ai/key', auth, (req, res) => {
    const { key } = req.body
    if (!key || !key.startsWith('sk-ant-')) return res.status(400).json({ error: 'Invalid API key format' })
    fs.writeFileSync(ANTHROPIC_KEY_PATH, key)
    res.json({ success: true })
  })

  app.get('/ai/key', auth, (req, res) => {
    res.json({ hasKey: !!getApiKey() })
  })

  // ── AI ANALYSE ────────────────────────────────────
  app.post('/ai/analyse', auth, async (req, res) => {
    const { entryId } = req.body
    const apiKey = getApiKey()
    if (!apiKey) return res.status(400).json({ error: 'No API key set. Add it in Settings.' })
    const entry = dbGet('SELECT * FROM entries WHERE id = ? AND user_id = ?', [entryId, req.user.id])
    if (!entry) return res.status(404).json({ error: 'Entry not found' })
    try {
      const raw = await callClaude(
        'You are a compassionate journaling assistant. Respond ONLY in JSON with keys: summary (1 sentence), mood (one word), insight (1 warm sentence).',
        `Analyse this diary entry:\n\nTitle: ${entry.title}\n\n${entry.body}`,
        apiKey
      )
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim())
      dbRun('UPDATE entries SET ai_summary = ?, ai_mood = ? WHERE id = ?', [parsed.summary, parsed.mood, entryId])
      res.json(parsed)
    } catch (e) {
      res.status(500).json({ error: 'AI error: ' + e.message })
    }
  })

  // ── AI WRITING PROMPT ─────────────────────────────
  app.post('/ai/prompt', auth, async (req, res) => {
    const apiKey = getApiKey()
    if (!apiKey) return res.status(400).json({ error: 'No API key set.' })
    const entries = dbAll('SELECT title, mood FROM entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [req.user.id])
    const context = entries.length
      ? 'Recent moods: ' + entries.map(e => e.mood || 'unknown').join(', ')
      : 'Brand new diary with no entries yet.'
    try {
      const result = await callClaude(
        'You are a thoughtful journaling coach. Give one specific, evocative writing prompt in 1-2 sentences. No preamble.',
        context, apiKey
      )
      res.json({ prompt: result })
    } catch (e) {
      res.status(500).json({ error: 'AI error: ' + e.message })
    }
  })

  // ── AI CHAT ───────────────────────────────────────
  app.post('/ai/chat', auth, async (req, res) => {
    const { message } = req.body
    const apiKey = getApiKey()
    if (!apiKey) return res.status(400).json({ error: 'No API key set.' })
    const entries = dbAll(
      'SELECT title, body, mood, iso_date FROM entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    )
    const context = entries.map(e => `[${e.iso_date}] ${e.title}: ${e.body.slice(0, 200)}`).join('\n')
    try {
      const result = await callClaude(
        `You are a kind, insightful journaling companion. You have access to the user's recent diary entries below. Answer thoughtfully.\n\nEntries:\n${context}`,
        message, apiKey
      )
      res.json({ reply: result })
    } catch (e) {
      res.status(500).json({ error: 'AI error: ' + e.message })
    }
  })

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  // ── START ─────────────────────────────────────────
  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`✦ Diary API running on http://127.0.0.1:${PORT}`)
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`✗ Port ${PORT} is already in use.`)
    } else {
      console.error('Server error:', err)
    }
  })
}

// Boot
initDB().catch(console.error)
