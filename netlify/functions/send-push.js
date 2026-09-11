const { blockExternalService } = require("./lib/manee-environment.cjs");
// netlify/functions/send-push.js
// 매장의 구독자(사장님/매니저)들에게 푸시알림을 보내는 함수
// 프론트에서 fetch('/.netlify/functions/send-push', { method:'POST', body: JSON.stringify({...}) })로 호출

const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const blocked = blockExternalService();
  if (blocked) return blocked;
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { storeId, title, body, url, tag, excludeCrewId, managerOnly } = JSON.parse(event.body || '{}');
    if (!storeId || !title) {
      return { statusCode: 400, body: JSON.stringify({ error: 'storeId, title 필요' }) };
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
    const { data: subs, error } = await query;
    if (error) throw error;

    const targets = (subs || []).filter(s => !excludeCrewId || String(s.crew_id) !== String(excludeCrewId));

    const payload = JSON.stringify({ title, body: body || '', url: url || '/', tag: tag || undefined });

    const results = await Promise.allSettled(
      targets.map(sub =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
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
    return { statusCode: 200, body: JSON.stringify({ sent, total: targets.length }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};

