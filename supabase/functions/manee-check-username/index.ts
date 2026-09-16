import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors })
}

function getKey(envName: string, legacyName: string) {
  const raw = Deno.env.get(envName)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed?.default) return parsed.default as string
    } catch {}
  }
  return Deno.env.get(legacyName) ?? ''
}

async function sha256(value: string) {
  const data = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function clientIp(req: Request) {
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

function normalizeUsername(input: unknown) {
  return String(input ?? '').normalize('NFKC').trim().toLowerCase()
}

// Availability check only, not a signup attempt: no account is created or touched here.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
    const url = Deno.env.get('SUPABASE_URL') ?? ''
    const secretKey = getKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')
    const publishableKey = getKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY')
    if (!url || !secretKey || !publishableKey) return json({ error: 'server_not_configured' }, 500)

    // Pre-auth check: validate this project's application key instead of requiring a user JWT.
    if (req.headers.get('apikey') !== publishableKey) {
      return json({ error: 'invalid_application_key' }, 403)
    }

    const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })

    const body = await req.json().catch(() => ({}))
    const username = normalizeUsername(body.username)

    if (!/^[a-z0-9가-힣._-]{4,30}$/.test(username)) {
      return json({ error: 'invalid_username', message: '아이디는 4~30자의 한글, 영문 소문자, 숫자, ., _, - 만 사용할 수 있습니다.' }, 400)
    }

    // Separate, generous rate limit bucket: this is a UX availability probe, not a
    // signup attempt, but still IP-limited to blunt username enumeration.
    const ipHash = await sha256(clientIp(req))
    const { data: ipAllowed, error: ipLimitError } = await admin.rpc('consume_auth_rate_limit', {
      p_action: 'username_check_ip', p_key_hash: ipHash, p_window_seconds: 60, p_max_attempts: 20,
    })
    if (ipLimitError) return json({ error: 'rate_limit_check_failed' }, 500)
    if (!ipAllowed) return json({ error: 'rate_limited', message: '너무 많이 확인했어요. 잠시 후 다시 시도해주세요.' }, 429)

    const { data: usernameReserved, error: reservationError } = await admin.rpc('is_manee_username_reserved', {
      p_username: username,
    })
    if (reservationError || typeof usernameReserved !== 'boolean') {
      return json({ error: 'username_lookup_failed', message: '아이디를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.' }, 503)
    }

    return json({ ok: true, username, available: !usernameReserved }, 200)
  } catch {
    return json({ error: 'unexpected_error', message: '잠시 후 다시 시도해주세요.' }, 500)
  }
})
