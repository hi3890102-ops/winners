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
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).session_id || null } catch { return null }
}
const invalidReset = () => reply({ error: 'invalid_recovery', message: '아이디와 재설정 코드를 확인해 주세요. 코드는 발급 후 15분 동안 한 번만 사용할 수 있어요.' }, 400)
const uncertain = () => reply({ error: 'recovery_uncertain', message: '처리 결과를 확인하지 못했어요. 새 비밀번호로 먼저 로그인해 주세요. 안 되면 본사에 새 코드를 요청해 주세요.' }, 503)

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405)
  try {
    const url = Deno.env.get('SUPABASE_URL') || ''
    const publicKey = key('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY')
    const secret = key('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !publicKey || !secret) return reply({ error: 'server_not_configured' }, 503)
    if (req.headers.get('apikey') !== publicKey) return reply({ error: 'invalid_application_key' }, 403)
    if (url !== 'https://bhwuuxcrzxespkjlmqxr.supabase.co') return reply({ error: 'production_only' }, 503)
    const raw = await req.text()
    if (raw.length > 4096) return reply({ error: 'request_too_large' }, 413)
    let body: Record<string, unknown>
    try { body = JSON.parse(raw) } catch { return reply({ error: 'invalid_request' }, 400) }
    const action = String(body?.action || '')
    if (!['request', 'issue_code', 'reject', 'reset', 'change_password'].includes(action)) return reply({ error: 'invalid_action' }, 400)

    const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    const admin = createClient(url, secret, opts)
    const client = createClient(url, publicKey, opts)
    const service = async (serviceAction: string, payload: Record<string, unknown>) => {
      const { data, error } = await admin.rpc('manee_support_recovery_service', { p_action: serviceAction, p_payload: payload })
      if (error || !data) throw new Error('recovery_service_unavailable')
      return data
    }
    const limit = async (limitAction: string, value: string, seconds: number, max: number) => {
      const { data, error } = await admin.rpc('consume_auth_rate_limit', {
        p_action: limitAction, p_key_hash: await hash(value), p_window_seconds: seconds, p_max_attempts: max,
      })
      if (error || typeof data !== 'boolean') throw new Error('rate_limit_unavailable')
      return data
    }
    const tooMany = () => reply({ error: 'rate_limited', message: '요청이 많아요. 잠시 후 다시 시도해 주세요.' }, 429)
    const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (!await limit('support_recovery_ip', ip, 3600, 40)) return tooMany()

    if (action === 'request') {
      const username = String(body.username || '').normalize('NFKC').trim().toLowerCase()
      const affiliation = String(body.affiliation || '').normalize('NFKC').trim()
      if (!await limit('support_recovery_request', `${username}:${affiliation}`, 3600, 5)) return tooMany()
      await service('request', { username, affiliation })
      return reply({ ok: true, message: '입력한 정보와 일치하는 계정이 있으면 재설정 요청이 접수돼요.' })
    }

    if (action === 'reset') {
      const username = String(body.username || '').normalize('NFKC').trim().toLowerCase()
      const code = String(body.reset_code || '').replace(/\D/g, '')
      const password = String(body.new_password || '')
      if (!await limit('support_recovery_username', username, 900, 8)) return tooMany()
      if (password.length < 8 || new TextEncoder().encode(password).length > 72) return reply({ error: 'invalid_password', message: '새 비밀번호는 8자 이상, 영문 72자·한글 24자 이내로 입력해 주세요.' }, 400)
      if (!/^[a-z0-9가-힣._-]{4,30}$/.test(username) || !/^\d{6}$/.test(code)) return invalidReset()
      const consumed = await service('consume', { username, code_hash: await hash(code) })
      if (!consumed.ok || !consumed.user_id || !consumed.request_id || !consumed.operation_id) return invalidReset()
      const operation = { request_id: consumed.request_id, user_id: consumed.user_id, operation_id: consumed.operation_id }
      try {
        const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(consumed.user_id, { password })
        if (updateError || updated.user?.id !== consumed.user_id) {
          await service('uncertain', operation)
          return uncertain()
        }
        const completed = await service('complete', operation)
        if (!completed.ok) return uncertain()
      } catch {
        try { await service('uncertain', operation) } catch {}
        return uncertain()
      }
      return reply({ ok: true })
    }

    const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
    if (!token) return reply({ error: 'invalid_session', message: '다시 로그인해 주세요.' }, 401)
    const { data: verified, error: verifyError } = await admin.auth.getUser(token)
    const sid = !verifyError && verified.user ? sessionId(token) : null
    if (!sid || !verified.user) return reply({ error: 'invalid_session', message: '다시 로그인해 주세요.' }, 401)
    const uid = verified.user.id

    if (action === 'issue_code' || action === 'reject') {
      if (!await limit('support_recovery_reviewer', uid, 3600, 40)) return tooMany()
      const requestId = String(body.request_id || '')
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) return reply({ error: 'invalid_request' }, 400)
      if (action === 'reject') {
        const result = await service('reject', { actor_user_id: uid, session_id: sid, request_id: requestId })
        if (!result.ok) return reply({ error: result.error || 'request_unavailable', message: '이 요청을 처리할 권한이 없거나 이미 처리됐어요.' }, 403)
        return reply({ ok: true })
      }
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0')
      const result = await service('issue', { actor_user_id: uid, session_id: sid, request_id: requestId, code_hash: await hash(code) })
      if (!result.ok) return reply({ error: result.error || 'request_unavailable', message: '이 요청을 처리할 권한이 없거나 이미 처리됐어요.' }, 403)
      return reply({ ok: true, reset_code: code, expires_in_minutes: 15 })
    }

    if (!await limit('password_change_user', uid, 3600, 5)) return tooMany()
    const credentials = await service('credentials', { user_id: uid, session_id: sid })
    if (!credentials.ok || !credentials.email) return reply({ error: 'invalid_session', message: '다시 로그인해 주세요.' }, 401)
    const currentPassword = String(body.current_password || '')
    const newPassword = String(body.new_password || '')
    if (newPassword.length < 8 || new TextEncoder().encode(newPassword).length > 72) return reply({ error: 'invalid_password', message: '새 비밀번호는 8자 이상, 영문 72자·한글 24자 이내로 입력해 주세요.' }, 400)
    const { data: reauth, error: reauthError } = await client.auth.signInWithPassword({ email: credentials.email, password: currentPassword })
    if (reauthError || !reauth.session || reauth.user?.id !== uid) return reply({ error: 'invalid_password', message: '현재 비밀번호를 확인해 주세요.' }, 400)
    try {
      const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(uid, { password: newPassword })
      if (updateError || updated.user?.id !== uid) throw new Error('password_update_failed')
    } finally {
      try { await client.auth.signOut({ scope: 'local' }) } catch {}
    }
    return reply({ ok: true })
  } catch {
    return reply({ error: 'recovery_unavailable', message: '비밀번호 서비스를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.' }, 503)
  }
})
