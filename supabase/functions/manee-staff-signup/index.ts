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

function unsafeDisplayText(value: string) {
  return /[<>\u0000-\u001f\u007f]/.test(value)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
    const url = Deno.env.get('SUPABASE_URL') ?? ''
    const secretKey = getKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')
    const publishableKey = getKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY')
    if (!url || !secretKey || !publishableKey) return json({ error: 'server_not_configured' }, 500)

    // Pre-auth enrollment: validate this project's application key here instead of
    // requiring a user JWT before signup. This key never grants store membership.
    if (req.headers.get('apikey') !== publishableKey) {
      return json({ error: 'invalid_application_key' }, 403)
    }

    const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const userClient = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })

    const body = await req.json().catch(() => ({}))
    const username = normalizeUsername(body.username)
    const password = String(body.password ?? '')
    const displayName = String(body.display_name ?? body.name ?? '').normalize('NFKC').trim().slice(0, 50)

    if (!/^[a-z0-9가-힣._-]{4,30}$/.test(username)) {
      return json({ error: 'invalid_username', message: '아이디는 4~30자의 한글, 영문 소문자, 숫자, ., _, - 만 사용할 수 있습니다.' }, 400)
    }
    if (password.length < 8 || password.length > 72) {
      return json({ error: 'invalid_password', message: '비밀번호는 8~72자로 입력해주세요.' }, 400)
    }
    if (!displayName || unsafeDisplayText(displayName)) {
      return json({ error: 'invalid_display_name', message: '이름을 확인해주세요.' }, 400)
    }

    const ipHash = await sha256(clientIp(req))
    const userHash = await sha256(username)
    const { data: ipAllowed, error: ipLimitError } = await admin.rpc('consume_auth_rate_limit', {
      p_action: 'signup_ip', p_key_hash: ipHash, p_window_seconds: 3600, p_max_attempts: 5,
    })
    if (ipLimitError) return json({ error: 'rate_limit_check_failed' }, 500)
    if (!ipAllowed) return json({ error: 'rate_limited', message: '가입 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }, 429)

    const { data: userAllowed, error: userLimitError } = await admin.rpc('consume_auth_rate_limit', {
      p_action: 'signup_username', p_key_hash: userHash, p_window_seconds: 3600, p_max_attempts: 3,
    })
    if (userLimitError) return json({ error: 'rate_limit_check_failed' }, 500)
    if (!userAllowed) return json({ error: 'rate_limited', message: '가입 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }, 429)

    // Server-only lookup covers Auth profiles, legacy owners, and store ownership.
    // Fail closed: do not create an Auth user when reservation lookup is unavailable.
    const { data: usernameReserved, error: reservationError } = await admin.rpc('is_manee_username_reserved', {
      p_username: username,
    })
    if (reservationError || typeof usernameReserved !== 'boolean') {
      return json({ error: 'username_lookup_failed', message: '아이디를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.' }, 503)
    }
    if (usernameReserved) return json({ error: 'username_taken', message: '이미 사용 중인 아이디입니다. 기존 계정은 로그인해주세요.' }, 409)

    const internalEmail = `u-${crypto.randomUUID().replaceAll('-', '')}@auth.manee.local`
    const { data: created, error: createError } = await admin.auth.admin.createUser({ email: internalEmail, password, email_confirm: true })
    if (createError || !created.user) return json({ error: 'auth_create_failed', message: '계정을 만들 수 없습니다. 잠시 후 다시 시도해주세요.' }, 500)

    const { data: staffId, error: bootstrapError } = await admin.rpc('bootstrap_staff_account', {
      p_user_id: created.user.id,
      p_username: username,
      p_display_name: displayName,
    })

    if (bootstrapError || !staffId) {
      // A lost RPC response must not delete an account whose bootstrap committed.
      const { data: recovered, error: recoveryError } = await admin.from('profiles')
        .select('user_id,username,status').eq('user_id', created.user.id).maybeSingle()
      if (recoveryError || recovered) {
        return json({ error: 'signup_result_uncertain', message: '가입 상태를 다시 확인해주세요. 입력한 아이디와 비밀번호로 로그인할 수 있습니다.' }, 503)
      }
      const { error: cleanupError } = await admin.auth.admin.deleteUser(created.user.id)
      if (cleanupError) {
        console.error('staff_signup_cleanup_failed', created.user.id)
        return json({ error: 'signup_cleanup_failed', message: '계정 정리에 실패했습니다. 관리자에게 문의해주세요.' }, 503)
      }
      if (bootstrapError?.code === '23505') return json({ error: 'username_taken', message: '이미 사용 중인 아이디입니다.' }, 409)
      return json({ error: 'account_bootstrap_failed', message: '계정을 만들 수 없습니다. 잠시 후 다시 시도해주세요.' }, 500)
    }

    const { data: loginData } = await userClient.auth.signInWithPassword({ email: internalEmail, password })

    return json({
      ok: true,
      user: { id: created.user.id, username, display_name: displayName || null },
      session: loginData.session ? {
        access_token: loginData.session.access_token,
        refresh_token: loginData.session.refresh_token,
        expires_in: loginData.session.expires_in,
        expires_at: loginData.session.expires_at,
        token_type: loginData.session.token_type,
      } : null,
    }, 201)
  } catch {
    return json({ error: 'unexpected_error', message: '잠시 후 다시 시도해주세요.' }, 500)
  }
})
