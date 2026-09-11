import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors })
function key(name: string, legacy: string) {
  try { const parsed = JSON.parse(Deno.env.get(name) || '{}'); if (parsed.default) return String(parsed.default) } catch {}
  return Deno.env.get(legacy) || ''
}
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}
function sessionId(token: string) {
  // Read only after Auth has verified this exact token. Never use an unverified sub.
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).session_id || null } catch { return null }
}
const invalidRecovery = () => reply({ error: 'invalid_recovery', message: '아이디와 복구키를 확인해 주세요. 이미 사용하거나 재발급한 복구키는 사용할 수 없어요.' }, 400)
const uncertain = () => reply({ error: 'recovery_uncertain', message: '처리 결과를 확인하지 못했어요. 새 비밀번호로 먼저 로그인해 주세요. 안 되면 이전 비밀번호를 확인해 주세요. 복구키 재발급은 10분 후 다시 시도할 수 있어요.' }, 503)

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405)
  try {
    const url = Deno.env.get('SUPABASE_URL') || ''
    const publicKey = key('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY')
    const secret = key('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !publicKey || !secret) return reply({ error: 'server_not_configured' }, 503)
    if (req.headers.get('apikey') !== publicKey) return reply({ error: 'invalid_application_key' }, 403)
    // This pilot endpoint cannot be accidentally enabled on production.
    if (url !== 'https://obpkzecgswnfuyhwvncd.supabase.co') return reply({ error: 'staging_only' }, 503)
    const raw = await req.text()
    if (raw.length > 4096) return reply({ error: 'request_too_large' }, 413)
    let body: Record<string, unknown>
    try { body = JSON.parse(raw) } catch { return reply({ error: 'invalid_request' }, 400) }
    if (!body || typeof body !== 'object' || !['issue', 'reset'].includes(String(body.action))) return reply({ error: 'invalid_action' }, 400)
    const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    const admin = createClient(url, secret, opts)
    const client = createClient(url, publicKey, opts)
    const service = async (action: string, payload: Record<string, unknown>) => {
      const { data, error } = await admin.rpc('manee_recovery_service', { p_action: action, p_payload: payload })
      if (error || !data) throw new Error('recovery_service_unavailable')
      return data
    }
    const limit = async (action: string, value: string, seconds: number, max: number) => {
      const { data, error } = await admin.rpc('consume_auth_rate_limit', {
        p_action: action, p_key_hash: await hash(value), p_window_seconds: seconds, p_max_attempts: max,
      })
      if (error || typeof data !== 'boolean') throw new Error('rate_limit_unavailable')
      return data
    }
    const tooMany = () => reply({ error: 'rate_limited', message: '요청이 많아요. 잠시 후 다시 시도해 주세요.' }, 429)
    const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (!await limit('recovery_ip', ip, 3600, 30)) return tooMany()

    if (body.action === 'issue') {
      const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
      if (!token) return reply({ error: 'invalid_session', message: '다시 로그인해 주세요.' }, 401)
      const { data: verified, error: verifyError } = await admin.auth.getUser(token)
      const sid = !verifyError && verified.user ? sessionId(token) : null
      if (!sid || !verified.user) return reply({ error: 'invalid_session', message: '다시 로그인해 주세요.' }, 401)
      const uid = verified.user.id
      if (!await limit('recovery_issue_user', uid, 3600, 5)) return tooMany()
      const credentials = await service('credentials', { user_id: uid, session_id: sid })
      if (!credentials.ok || !credentials.email) return reply({ error: 'invalid_session', message: '다시 로그인해 주세요.' }, 401)
      const password = String(body.current_password || '')
      if (!password || new TextEncoder().encode(password).length > 72) return reply({ error: 'invalid_password', message: '현재 비밀번호를 확인해 주세요.' }, 400)
      const { data: reauth, error: reauthError } = await client.auth.signInWithPassword({ email: credentials.email, password })
      if (reauthError || !reauth.session || reauth.user?.id !== uid) return reply({ error: 'invalid_password', message: '현재 비밀번호를 확인해 주세요.' }, 400)
      let result
      let recoveryKey = ''
      try {
        recoveryKey = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('')
        result = await service('issue', { user_id: uid, session_id: sessionId(reauth.session.access_token), key_hash: await hash(recoveryKey) })
      } finally {
        // Do not replace or expose the temporary reauthentication session.
        const { error } = await client.auth.signOut({ scope: 'local' })
        if (error) throw new Error('reauth_cleanup_failed')
      }
      if (!result?.ok) return reply({ error: 'recovery_in_progress', message: '복구 처리 중이에요. 10분 후 다시 발급해 주세요.' }, 409)
      return reply({ ok: true, recovery_key: recoveryKey.toUpperCase().match(/.{4}/g)?.join('-') })
    }

    const username = String(body.username || '').normalize('NFKC').trim().toLowerCase()
    if (!await limit('recovery_username', username, 900, 5)) return tooMany()
    const recoveryKey = String(body.recovery_key || '').replace(/[\s-]/g, '').toLowerCase()
    const password = String(body.new_password || '')
    if (password.length < 8 || new TextEncoder().encode(password).length > 72) return reply({ error: 'invalid_password', message: '새 비밀번호는 8자 이상, 영문 72자·한글 24자 이내로 입력해 주세요.' }, 400)
    if (!/^[a-z0-9가-힣._-]{4,30}$/.test(username) || !/^[0-9a-f]{32}$/.test(recoveryKey)) return invalidRecovery()
    // One atomic consume wins. Neither a store owner nor a six-digit join code
    // can reset another account, including an account belonging to many stores.
    const consumed = await service('consume', { username, key_hash: await hash(recoveryKey) })
    if (!consumed.ok || !consumed.user_id || !consumed.operation_id) return invalidRecovery()
    const operation = { user_id: consumed.user_id, operation_id: consumed.operation_id }
    try {
      const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(consumed.user_id, { password })
      if (updateError || updated.user?.id !== consumed.user_id) {
        await service('uncertain', operation)
        return uncertain()
      }
      // Supabase's admin password update logs out all sessions. Never create a
      // replacement identity, membership, store or automatic login session.
      const completed = await service('complete', operation)
      if (!completed.ok) return uncertain()
    } catch {
      try { await service('uncertain', operation) } catch {}
      return uncertain()
    }
    return reply({ ok: true })
  } catch {
    return reply({ error: 'recovery_unavailable', message: '복구 서비스를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.' }, 503)
  }
})
