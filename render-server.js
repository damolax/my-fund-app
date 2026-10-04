const http = require('http')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

const recordRequestEmail = require('./api/record-request-email')
const personLedgerEmail = require('./api/person-ledger-email')

const PORT = process.env.PORT || 10000
const root = __dirname
const NEON_AUTH_BASE = process.env.MY_FUND_NEON_AUTH_URL || 'https://ep-cool-lake-b5w5dfc2.neonauth.c-7.us-east-2.aws.neon.tech/author_scout_bot/auth'
const NEON_DATA_BASE = process.env.MY_FUND_DATA_API_URL || 'https://ep-cool-lake-b5w5dfc2.apirest.c-7.us-east-2.aws.neon.tech/my_fund_app/rest/v1'
const TRUSTED_ORIGIN = process.env.MY_FUND_TRUSTED_ORIGIN || 'https://my-fund-app-one.vercel.app'


const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/config.js': ['config.js', 'application/javascript; charset=utf-8'],
  '/cloud-client.js': ['cloud-client.js', 'application/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
}

function jsonResponse(nodeRes) {
  return {
    status(code) {
      nodeRes.statusCode = code
      return this
    },
    setHeader(name, value) {
      nodeRes.setHeader(name, value)
      return this
    },
    json(payload) {
      nodeRes.setHeader('Content-Type', 'application/json; charset=utf-8')
      nodeRes.end(JSON.stringify(payload))
    },
    end(payload = '') {
      nodeRes.end(payload)
    },
  }
}

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Request too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function proxyToNeon(req, res, prefix, baseUrl) {
  const incoming = new URL(req.url, `http://${req.headers.host}`)
  const suffix = incoming.pathname.slice(prefix.length)
  const target = new URL(baseUrl.replace(/\/$/, '') + suffix + incoming.search)

  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value) continue
    const lower = name.toLowerCase()
    if (['host', 'connection', 'content-length', 'origin', 'referer'].includes(lower)) continue
    headers[name] = value
  }
  headers.Origin = TRUSTED_ORIGIN
  headers.Referer = TRUSTED_ORIGIN + '/'

  let body
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    const raw = await readRawBody(req)
    body = raw.length ? raw : undefined
  }

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body,
    redirect: 'manual',
  })

  res.statusCode = upstream.status
  const passHeaders = ['content-type', 'cache-control', 'location']
  for (const name of passHeaders) {
    const value = upstream.headers.get(name)
    if (value) res.setHeader(name, value)
  }

  if (typeof upstream.headers.getSetCookie === 'function') {
    const cookies = upstream.headers.getSetCookie().map(cookie =>
      cookie.replace(/;\s*Domain=[^;]+/ig, ''),
    )
    if (cookies.length) res.setHeader('Set-Cookie', cookies)
  }

  const buffer = Buffer.from(await upstream.arrayBuffer())
  res.end(buffer)
}

async function parseBody(req) {
  return await new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => {
      data += chunk
      if (data.length > 1024 * 1024) {
        reject(new Error('Request too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try { resolve(JSON.parse(data)) }
      catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (url.pathname.startsWith('/neon-auth')) {
      return await proxyToNeon(req, res, '/neon-auth', NEON_AUTH_BASE)
    }

    if (url.pathname.startsWith('/neon-data')) {
      return await proxyToNeon(req, res, '/neon-data', NEON_DATA_BASE)
    }

    if (url.pathname === '/health') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      return res.end(JSON.stringify({ ok: true }))
    }

    if (url.pathname === '/api/record-request-email' || url.pathname === '/api/person-ledger-email') {
      req.body = await parseBody(req)
      const handler = url.pathname.endsWith('record-request-email')
        ? recordRequestEmail
        : personLedgerEmail
      return await handler(req, jsonResponse(res))
    }

    const file = files[url.pathname] || (req.method === 'GET' ? files['/'] : null)
    if (!file) {
      res.statusCode = 404
      return res.end('Not found')
    }

    const [name, type] = file
    const fullPath = path.join(root, name)
    res.statusCode = 200
    res.setHeader('Content-Type', type)
    res.setHeader('Cache-Control', name === 'index.html' ? 'no-cache' : 'public, max-age=300')
    fs.createReadStream(fullPath)
      .on('error', () => {
        res.statusCode = 500
        res.end('Unable to read application file')
      })
      .pipe(res)
  } catch (error) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: error.message || 'Server error' }))
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`My Fund App listening on port ${PORT}`)
})
