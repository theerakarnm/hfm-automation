import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { loginPage } from './views/login'
import { reportPage } from './views/report'
import * as XLSX from 'xlsx'

// ─── Config ───────────────────────────────────────────────────────────────────

const HFM_BASE       = 'https://api.hfaffiliates.com'
const ADMIN_USERNAME = Bun.env.ADMIN_USERNAME ?? 'admin'
const ADMIN_PASSWORD = Bun.env.ADMIN_PASSWORD ?? 'admin123'
const SESSION_SECRET = Bun.env.SESSION_SECRET ?? 'dev-secret-CHANGE-ME-in-production'
const PORT           = Number(Bun.env.PORT ?? 3000)

// ─── Session helpers ──────────────────────────────────────────────────────────

async function importKey(usage: 'sign' | 'verify') {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}

/** Create a signed session token: base64url(payload).base64url(hmac) */
async function signSession(username: string): Promise<string> {
  const expires = Date.now() + 8 * 3_600_000   // 8 hours
  const payload = `${username}|${expires}`
  const key     = await importKey('sign')
  const raw     = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const sig     = Buffer.from(raw).toString('base64url')
  return `${Buffer.from(payload).toString('base64url')}.${sig}`
}

/** Verify token; returns username or null */
async function verifySession(token: string): Promise<string | null> {
  try {
    const [b64, sig] = token.split('.')
    if (!b64 || !sig) return null

    const payload  = Buffer.from(b64, 'base64url').toString()
    const [username, expStr] = payload.split('|')
    if (!username || Date.now() > Number(expStr)) return null

    const key   = await importKey('verify')
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      Buffer.from(sig, 'base64url'),
      new TextEncoder().encode(payload),
    )
    return valid ? username : null
  } catch {
    return null
  }
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono()

// Auth guard middleware
const guard = async (c: any, next: () => Promise<void>) => {
  const token = getCookie(c, 'session')
  if (!token) return c.redirect('/login')
  const user = await verifySession(token)
  if (!user) {
    deleteCookie(c, 'session', { path: '/' })
    return c.redirect('/login')
  }
  c.set('user', user)
  return next()
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/** Root: redirect based on session */
app.get('/', async (c) => {
  const token = getCookie(c, 'session')
  if (token && (await verifySession(token))) return c.redirect('/report')
  return c.redirect('/login')
})

/** Login page */
app.get('/login', (c) => c.html(loginPage()))

/** Login submit */
app.post('/login', async (c) => {
  const body = await c.req.parseBody<{ username: string; password: string }>()
  const { username, password } = body

  if (username?.trim() === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = await signSession(username.trim())
    setCookie(c, 'session', token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 28800,   // 8 h
    })
    return c.redirect('/report')
  }

  return c.html(loginPage('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'))
})

/** Logout */
app.post('/logout', (c) => {
  deleteCookie(c, 'session', { path: '/' })
  return c.redirect('/login')
})

/** Authenticate with HFM API — returns api_key */
app.post('/api/authenticate', async (c) => {
  const body = await c.req.parseBody<{ wallet_id: string; password: string }>()
  const { wallet_id, password } = body

  if (!wallet_id || !password) {
    return c.json({ error: 'กรุณากรอก Wallet ID และ Password' }, 400)
  }

  try {
    const authRes = await fetch(`${HFM_BASE}/api/auth/key`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet_id: Number(wallet_id), password }),
    })

    if (!authRes.ok) {
      const msg = authRes.status === 401
        ? 'Wallet ID หรือรหัสผ่านไม่ถูกต้อง'
        : `HFM Authentication Error: ${authRes.status}`
      return c.json({ error: msg }, authRes.status)
    }

    const { api_key } = await authRes.json() as { api_key: string }
    if (!api_key) {
      return c.json({ error: 'HFM API ไม่ส่ง api_key กลับมา' }, 502)
    }

    return c.json({ api_key })
  } catch (err) {
    console.error('[authenticate] error:', err)
    return c.json({ error: 'เกิดข้อผิดพลาดในการเชื่อมต่อ' }, 500)
  }
})

/** Report page (protected) */
app.get('/report', guard, (c) =>
  c.html(reportPage(c.req.query('error')))
)

/** Export handler (protected) */
app.post('/report/export', guard, async (c) => {
  const body = await c.req.parseBody<{
    wallet_id: string
    password:  string
    from_date: string
    to_date:   string
  }>()

  const { wallet_id, password, from_date, to_date } = body

  // Basic validation
  if (!wallet_id || !password || !from_date || !to_date) {
    return c.redirect(`/report?error=${encode('กรุณากรอกข้อมูลให้ครบทุกช่อง')}`)
  }

  try {
    // ── Step 1: Authenticate with HFM API ──
    const authRes = await fetch(`${HFM_BASE}/api/auth/key`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet_id: Number(wallet_id), password }),
    })

    if (!authRes.ok) {
      const msg = authRes.status === 401
        ? 'Wallet ID หรือรหัสผ่านไม่ถูกต้อง (HFM 401 Unauthorized)'
        : `HFM Authentication Error: ${authRes.status}`
      return c.redirect(`/report?error=${encode(msg)}`)
    }

    const { api_key } = await authRes.json() as { api_key: string }
    if (!api_key) {
      return c.redirect(`/report?error=${encode('HFM API ไม่ส่ง api_key กลับมา')}`)
    }

    // ── Step 2: Fetch client performance ──
    const qs = new URLSearchParams({
      from_date: `${from_date}T00:00:00`,
      to_date:   `${to_date}T23:59:59`,
    })

    const perfRes = await fetch(
      `${HFM_BASE}/api/performance/client-performance?${qs}`,
      { headers: { Authorization: `Bearer ${api_key}` } },
    )

    if (!perfRes.ok) {
      return c.redirect(
        `/report?error=${encode(`ดึงข้อมูล client performance ไม่สำเร็จ (${perfRes.status})`)}`,
      )
    }

    const data = await perfRes.json() as { clients: Record<string, unknown>[] }
    const clients = data.clients ?? []

    if (clients.length === 0) {
      return c.redirect(
        `/report?error=${encode('ไม่พบข้อมูล Trading Lots ในช่วงวันที่ที่เลือก')}`,
      )
    }

    // ── Step 3: Build XLSX ──
    const rows = clients.map((cl) => ({
      'Wallet ID':    cl.client_id,
      'Account ID':   cl.account_id,
      'Account Type': cl.account_type,
      'Trading Lots': cl.volume,
    }))

    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 16 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Performance')

    const buf      = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const filename = `hfm_performance_${from_date}_to_${to_date}.xlsx`

    console.log(`[export] wallet=${wallet_id} from=${from_date} to=${to_date} rows=${rows.length}`)

    return new Response(buf, {
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      String(buf.byteLength),
      },
    })

  } catch (err) {
    console.error('[export] unexpected error:', err)
    return c.redirect(`/report?error=${encode('เกิดข้อผิดพลาดที่ไม่คาดคิด กรุณาลองใหม่อีกครั้ง')}`)
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────

const encode = (s: string) => encodeURIComponent(s)

console.log(`🚀  HFM Report running on http://localhost:${PORT}`)

export default { port: PORT, fetch: app.fetch }
