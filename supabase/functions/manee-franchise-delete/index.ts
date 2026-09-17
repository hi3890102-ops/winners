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

// Permanently deletes a franchise account: the franchise_memberships row
// (cascades from deleting the auth user), the franchises row itself, and
// unassigns any stores that were under it. Only an active platform_admin
// may call this.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
    const url = Deno.env.get('SUPABASE_URL') ?? ''
    const secretKey = getKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')
    const publishableKey = getKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY')
    if (!url || !secretKey || !publishableKey) return json({ error: 'server_not_configured' }, 500)

    if (req.headers.get('apikey') !== publishableKey) {
      return json({ error: 'invalid_application_key' }, 403)
    }

    const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })

    const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
    if (!token) return json({ error: 'invalid_session', message: '다시 로그인해 주세요.' }, 401)
    const { data: verified, error: verifyError } = await admin.auth.getUser(token)
    if (verifyError || !verified.user) return json({ error: 'invalid_session', message: '다시 로그인해 주세요.' }, 401)
    const actorId = verified.user.id

    const { data: isAdmin } = await admin.from('platform_admins').select('user_id').eq('user_id', actorId).eq('status', 'active').maybeSingle()
    if (!isAdmin) return json({ error: 'owner_required', message: '본사 관리자만 삭제할 수 있어요.' }, 403)

    const body = await req.json().catch(() => ({}))
    const franchiseId = String(body.franchise_id ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(franchiseId)) return json({ error: 'invalid_franchise_id' }, 400)

    const { data: membership } = await admin.from('franchise_memberships').select('user_id').eq('franchise_id', franchiseId).maybeSingle()

    await admin.from('stores').update({ franchise_id: null }).eq('franchise_id', franchiseId)
    const { error: deleteFranchiseError } = await admin.from('franchises').delete().eq('id', franchiseId)
    if (deleteFranchiseError) return json({ error: 'delete_failed', message: '삭제에 실패했습니다.' }, 500)

    if (membership?.user_id) {
      const { error: deleteUserError } = await admin.auth.admin.deleteUser(membership.user_id)
      if (deleteUserError) {
        return json({ ok: true, warning: 'franchise_deleted_but_account_remained' }, 200)
      }
    }

    return json({ ok: true }, 200)
  } catch {
    return json({ error: 'unexpected_error', message: '잠시 후 다시 시도해주세요.' }, 500)
  }
})
