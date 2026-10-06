const { blockExternalService } = require("./lib/manee-environment.cjs");
// netlify/functions/send-push.js
// 매장의 구독자(사장님/매니저)들에게 푸시알림을 보내는 함수
// 프론트에서 fetch('/.netlify/functions/send-push', { method:'POST', body: JSON.stringify({...}) })로 호출

const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');
const { createECDH } = require('node:crypto');

// Never return provider bodies, subscription endpoints, or encryption keys.
function failureReason(error) {
  const detail=String(error?.body||error?.message||'').toLowerCase();
  if ([404,410].includes(error?.statusCode)) return 'subscription_expired';
  if (/vapid|jwt|signature|authorization|credential|key mismatch/.test(detail)) return 'push_authentication_rejected';
  if (/public key|private key|p256dh|encrypt|curve/.test(detail)) return 'push_key_invalid';
  if (['ETIMEDOUT','ECONNRESET','ENOTFOUND'].includes(error?.code)) return 'push_network_error';
  return error?.statusCode ? 'push_service_rejected' : 'push_request_failed';
}

exports.handler = async (event) => {
  const blocked = blockExternalService();
  if (blocked) return blocked;
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { storeId, title, body, url, tag, excludeCrewId, managerOnly, ownerOnly,
      targetUserId, targetSubscriptionId, expectedVapidPublicKey } = JSON.parse(event.body || '{}');
    if (!storeId || !title) {
      return { statusCode: 400, body: JSON.stringify({ error: 'storeId, title 필요' }) };
    }

    // A named-account test must keep both the account and device filters.
    const hasTarget=targetUserId!==undefined || targetSubscriptionId!==undefined;
    if (hasTarget &&
        (!ownerOnly || !/^[0-9a-f-]{36}$/i.test(targetUserId||'') || !Number.isSafeInteger(targetSubscriptionId) || targetSubscriptionId<1)) {
      return {statusCode:400,body:JSON.stringify({error:'invalid_target'})};
    }
    if(expectedVapidPublicKey){
      const configured=Buffer.from(process.env.VAPID_PUBLIC_KEY||'','base64url');
      const expected=Buffer.from(expectedVapidPublicKey,'base64url');
      if(!configured.equals(expected)) return {statusCode:503,body:JSON.stringify({error:'vapid_client_key_mismatch',sent:0,total:0})};
      const pair=createECDH('prime256v1');
      pair.setPrivateKey(Buffer.from(process.env.VAPID_PRIVATE_KEY||'','base64url'));
      if(!pair.getPublicKey().equals(configured)) return {statusCode:503,body:JSON.stringify({error:'vapid_key_pair_mismatch',sent:0,total:0})};
    }

    webpush.setVapidDetails(
      'mailto:admin@example.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    let query = supabase.from('push_subscriptions').select('*').eq('store_id', storeId);
    if (managerOnly) query = query.eq('is_manager', true);
    if (ownerOnly) query = query.eq('role', 'storeOwner');
    if (targetUserId) query = query.eq('user_id', targetUserId).eq('id',targetSubscriptionId);
    const { data: subs, error } = await query;
    if (error) throw error;

    const targets = (subs || []).filter(s => !excludeCrewId || String(s.crew_id) !== String(excludeCrewId));

    const payload = JSON.stringify({ title, body: body || '', url: url || '/', tag: tag || undefined });

    const results = await Promise.allSettled(
      targets.map(sub =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          targetUserId ? {TTL:3600,timeout:10000} : {}
        ).catch(async (err) => {
          // 구독이 만료/취소된 경우(410/404) DB에서 정리
          if (err.statusCode === 410 || err.statusCode === 404) {
            await supabase.from('push_subscriptions').delete().eq('id', sub.id);
          }
          throw err;
        })
      )
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failures=results.filter(r=>r.status==='rejected').map(r=>({
      statusCode:Number.isInteger(r.reason?.statusCode)?r.reason.statusCode:null,
      reason:failureReason(r.reason)
    }));
    return { statusCode: 200, body: JSON.stringify({ sent, total: targets.length, failed:failures.length, failures }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: failureReason(e) }) };
  }
};
