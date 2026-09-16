const { blockExternalService } = require("./lib/manee-environment.cjs");
// netlify/functions/notify-reservation-reminders-cron.js
// 10분마다 자동 실행돼요 (netlify.toml 스케줄).
// 오늘 예약 중 "약 30분 뒤" 시작하는 예약을 찾아서, 그 매장의 매니저 전원 +
// 현재 출근 중인 직원에게 1회만 리마인드 푸시를 보내요.

const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

function kstNow(){
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function kstDateStr(d){
  return d.toISOString().slice(0, 10);
}
function minutesToHHMM(totalMinutes){
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

exports.handler = async () => {
  const blocked = blockExternalService();
  if (blocked) return blocked;
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

    const now = kstNow();
    const today = kstDateStr(now);
    const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    // 20~40분 뒤 시작하는 예약을 대상으로 (10분 주기 크론이라 겹치게 잡아서 놓치지 않게)
    const windowStart = minutesToHHMM(nowMinutes + 20);
    const windowEnd = minutesToHHMM(nowMinutes + 40);

    const { data: reservations, error: resErr } = await supabase
      .from('reservations')
      .select('*')
      .eq('date', today)
      .eq('reminder_sent', false)
      .gte('time', windowStart)
      .lt('time', windowEnd);
    if (resErr) throw resErr;

    if (!reservations || reservations.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ sent: 0, message: 'no reservations in reminder window' }) };
    }

    let totalSent = 0;
    const remindedIds = [];

    for (const r of reservations) {
      const { data: managers } = await supabase
        .from('push_subscriptions').select('*').eq('store_id', r.store_id).eq('is_manager', true);
      const { data: openAttendance } = await supabase
        .from('attendance').select('crew_id').eq('store_id', r.store_id).eq('date', today).is('check_out', null);
      const workingCrewIds = new Set((openAttendance || []).map(a => a.crew_id));
      const { data: staffSubs } = workingCrewIds.size
        ? await supabase.from('push_subscriptions').select('*').eq('store_id', r.store_id).in('crew_id', Array.from(workingCrewIds))
        : { data: [] };

      const seen = new Set();
      const targets = [...(managers || []), ...(staffSubs || [])].filter(sub => {
        if (seen.has(sub.id)) return false;
        seen.add(sub.id);
        return true;
      });

      const body = (r.time ? r.time + ' ' : '') + (r.customer_name || '예약') + ' · ' + (r.party_size || '') + '명 (약 30분 뒤)';
      const payload = JSON.stringify({ title: '곧 예약 시간이에요', body, tag: 'reservation-reminder' });

      await Promise.allSettled(
        targets.map(sub =>
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

      remindedIds.push(r.id);
    }

    if (remindedIds.length > 0) {
      await supabase.from('reservations').update({ reminder_sent: true }).in('id', remindedIds);
    }

    return { statusCode: 200, body: JSON.stringify({ sent: totalSent, reservations: remindedIds.length }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
