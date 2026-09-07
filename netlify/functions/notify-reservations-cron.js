// netlify/functions/notify-reservations-cron.js
// 매일 자정(KST 00:00)에 자동 실행돼요.
// "오늘 날짜"로 등록된 예약 중 아직 알림을 안 보낸 것들을 매장별로 모아서 푸시 발송해요.
// 스케줄은 netlify.toml에서 설정합니다 (아무도 앱을 안 열어도 실행됨).

const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

function todayKstDateStr(){
  // UTC 기준 서버 시각을 KST(UTC+9)로 변환해서 YYYY-MM-DD 문자열로
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

exports.handler = async () => {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    webpush.setVapidDetails(
      'mailto:admin@example.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const today = todayKstDateStr();

    const { data: reservations, error: resErr } = await supabase
      .from('reservations')
      .select('*')
      .eq('date', today)
      .eq('notified', false);
    if (resErr) throw resErr;

    if (!reservations || reservations.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ sent: 0, message: 'no reservations to notify' }) };
    }

    // 매장별로 묶기
    const byStore = {};
    reservations.forEach(r => {
      if (!byStore[r.store_id]) byStore[r.store_id] = [];
      byStore[r.store_id].push(r);
    });

    let totalSent = 0;
    const notifiedIds = [];

    for (const storeId of Object.keys(byStore)) {
      const list = byStore[storeId];
      const { data: subs, error: subErr } = await supabase
        .from('push_subscriptions')
        .select('*')
        .eq('store_id', storeId);
      if (subErr) continue;

      const body = list.length === 1
        ? (list[0].time ? list[0].time + ' ' : '') + (list[0].customer_name || '예약') + ' · ' + (list[0].party_size || '') + '명'
        : '오늘 예약 ' + list.length + '건이 있어요';

      const payload = JSON.stringify({ title: '오늘 예약 안내', body, tag: 'reservation-today' });

      await Promise.allSettled(
        (subs || []).map(sub =>
          webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          ).then(() => { totalSent++; })
           .catch(async (err) => {
             if (err.statusCode === 410 || err.statusCode === 404) {
               await supabase.from('push_subscriptions').delete().eq('id', sub.id);
             }
           })
        )
      );

      list.forEach(r => notifiedIds.push(r.id));
    }

    if (notifiedIds.length > 0) {
      await supabase.from('reservations').update({ notified: true }).in('id', notifiedIds);
    }

    return { statusCode: 200, body: JSON.stringify({ sent: totalSent, reservations: notifiedIds.length }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
