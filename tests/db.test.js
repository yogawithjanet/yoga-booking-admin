'use strict';
// 資料庫層測試：直接在 PGlite 上執行正式 migration，驗證 RLS 權限與每一支 RPC 的金錢 / 堂數行為
process.env.TZ = 'Asia/Taipei';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb, asRole, setNow, STUDENT, ADMIN, ANON } = require('./pg');
const { id, UID, OTHER, T1, B1, CLASS_KEY_0929, baseSeed, booking } = require('./fixtures');

const one = async (db, sql, params=[]) => (await db.query(sql, params)).rows[0];
const credits = async (db, uid=UID) => (await one(db, 'select available from member_credit_summary where line_user_id=$1', [uid])).available;
const batch = async (db, bid=B1) => one(db, 'select * from credit_batches where id=$1', [bid]);
const rpc = (db, who, fn, args={}) => asRole(db, who, async tx => {
  const names = Object.keys(args);
  const r = await tx.query(`select to_jsonb(public.${fn}(${names.map((n,i)=>`${n} => $${i+1}`).join(', ')})) as r`, names.map(n=>args[n]));
  return r.rows[0].r;
});
const rejects = (p, re) => assert.rejects(p, e => { assert.match(e.message, re); return true; });

/* ================= 資安：RLS ================= */
test('資安｜匿名（只有 anon key）完全讀不到學員、預約、堂數、金流', async () => {
  const db = await createDb({ seed: baseSeed({ bookings:[booking()] }) });
  for(const t of ['members','bookings','credit_batches','transactions','credit_ledger','audit_log']){
    await rejects(asRole(db, ANON, tx => tx.query(`select * from ${t}`)), /permission denied/);
  }
});

test('資安｜匿名不能直接改堂數、不能新增預約', async () => {
  const db = await createDb({ seed: baseSeed() });
  await rejects(asRole(db, ANON, tx => tx.query(`update members set remaining_credits = 999`)), /permission denied/);
  await rejects(asRole(db, ANON, tx => tx.query(`update credit_batches set remaining = 999`)), /permission denied/);
  await rejects(asRole(db, ANON, tx => tx.query(`insert into bookings(line_user_id, class_key, status) values ('${UID}','x','active')`)), /permission denied/);
  await rejects(rpc(db, ANON, 'book_class', { p_template_id:T1, p_date:'2026-09-29' }), /permission denied/);
  assert.equal(await credits(db), 5);
});

test('資安｜學員只看得到自己的資料，也不能直接改自己的堂數', async () => {
  const db = await createDb({ seed: baseSeed({ bookings:[booking(), booking({ line_user_id:OTHER, credit_batch_id:null })] }) });
  const mine = await asRole(db, STUDENT(UID), tx => tx.query('select line_user_id from members'));
  assert.deepEqual(mine.rows.map(r=>r.line_user_id), [UID]);
  const bk = await asRole(db, STUDENT(UID), tx => tx.query('select line_user_id from bookings'));
  assert.ok(bk.rows.every(r=>r.line_user_id===UID));
  await rejects(asRole(db, STUDENT(UID), tx => tx.query(`update credit_batches set remaining = 999 where line_user_id='${UID}'`)), /permission denied/);
  const upd = await asRole(db, STUDENT(UID), tx => tx.query(`update members set remaining_credits = 999 where line_user_id='${UID}'`));
  assert.equal(upd.affectedRows ?? 0, 0, 'RLS 讓學員的 update 影響 0 列');
  const tx = await asRole(db, STUDENT(UID), tx => tx.query('select * from transactions'));
  assert.equal(tx.rows.length, 0, '學員看不到任何金流紀錄');
});

test('資安｜學員呼叫管理員 RPC 會被拒絕', async () => {
  const db = await createDb({ seed: baseSeed() });
  await rejects(rpc(db, STUDENT(UID), 'admin_add_credits', { p_line_user_id:UID, p_amount:100 }), /需要管理員權限/);
  await rejects(rpc(db, STUDENT(UID), 'admin_adjust_credits', { p_line_user_id:UID, p_delta:100 }), /需要管理員權限/);
  assert.equal(await credits(db), 5);
});

test('資安｜Auth 新註冊的帳號（不在 admin_users）不是管理員', async () => {
  const db = await createDb({ seed: baseSeed() });
  const stranger = { role:'authenticated', claims:{ sub: id('stranger'), email:'x@evil.test' } };
  await rejects(rpc(db, stranger, 'admin_add_credits', { p_line_user_id:UID, p_amount:100 }), /需要管理員權限/);
  const rows = await asRole(db, stranger, tx => tx.query('select * from members'));
  assert.equal(rows.rows.length, 0);
});

test('資安｜第一階段新建的表（admin_users 等）匿名不能讀寫，新註冊帳號也不能把自己加成管理員', async () => {
  const db = await createDb({ seed: baseSeed(), migrate: 'phase1' });
  const stranger = { role:'authenticated', claims:{ sub: id('stranger') } };
  for(const t of ['admin_users','credit_ledger','audit_log','member_credit_summary']){
    await rejects(asRole(db, ANON, tx => tx.query(`select * from ${t}`)), /permission denied/);
  }
  await rejects(asRole(db, ANON, tx => tx.query(`insert into admin_users(user_id) values ($1)`, [id('stranger')])), /permission denied/);
  await rejects(asRole(db, stranger, tx => tx.query(`insert into admin_users(user_id) values ($1)`, [id('stranger')])), /permission denied/);
  const seen = await asRole(db, stranger, tx => tx.query('select * from admin_users'));
  assert.equal(seen.rows.length, 0);
  const own = await asRole(db, ADMIN, tx => tx.query('select * from admin_users'));
  assert.equal(own.rows.length, 1, '管理員登入檢查仍可運作');
});

test('資安｜公開設定 RPC 不再回傳整列 store_settings', async () => {
  const db = await createDb({ seed: baseSeed() });
  const s = await rpc(db, ANON, 'get_store_public_settings');
  assert.equal(s.name, '測試教室');
  assert.ok(!('available_tags' in s) && !('tag_colors' in s));
});

/* ================= 預約 ================= */
test('預約｜扣 1 堂、預約內容由伺服器決定（不信任前端）、寫入帳本', async () => {
  const db = await createDb({ seed: baseSeed() });
  const bk = await rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-09-29' });
  assert.equal(bk.class_key, CLASS_KEY_0929);
  assert.equal(bk.class_title, '基礎瑜珈'); assert.equal(bk.cap, 6); assert.equal(bk.class_date, '9/29 (週二)');
  assert.equal((await batch(db)).remaining, 4);
  assert.equal(await credits(db), 4);
  assert.equal((await one(db, 'select remaining_credits from members where line_user_id=$1', [UID])).remaining_credits, 4, 'members 快取由 trigger 同步');
  const led = await one(db, 'select delta, kind from credit_ledger where booking_id=$1', [bk.id]);
  assert.deepEqual(led, { delta:-1, kind:'booking' });
});

test('預約｜重複預約、額滿、已開始、未開放、停課日、非上課日 都拒絕且不扣堂', async () => {
  const full = Array.from({length:6}, (_,i)=>booking({ line_user_id:`U_x${i}`, credit_batch_id:null }));
  const db = await createDb({ seed: baseSeed({
    members: ms=>[...ms, ...full.map(b=>({ line_user_id:b.line_user_id, display_name:b.line_user_id }))],
    bookings: full,
    class_overrides: [{ id:id('cancel-1006'), type:'cancel', date:'2026-10-06', class_template_id:T1 }]
  }) });
  await rejects(rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-09-29' }), /額滿/);
  await rejects(rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-09-30' }), /沒有開這堂課/);
  await rejects(rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-10-06' }), /停課/);
  await rejects(rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-11-03' }), /尚未開放/);
  await rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-10-13' });
  await rejects(rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-10-13' }), /已經預約過/);
  await setNow(db, '2026-10-20T20:00:00');
  await rejects(rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-10-20' }), /已經開始/);
  assert.equal(await credits(db), 4, '只有 10/13 那一筆扣堂');
});

test('預約｜最後一席：第 6 人成功、第 7 人被擋（伺服器端鎖 + 計數）', async () => {
  const five = Array.from({length:5}, (_,i)=>booking({ line_user_id:`U_x${i}`, credit_batch_id:null }));
  const db = await createDb({ seed: baseSeed({
    members: ms=>[...ms.map(m=>m.line_user_id===OTHER?m:m), ...five.map(b=>({ line_user_id:b.line_user_id }))],
    bookings: five,
    credit_batches: bs=>[...bs, { id:id('other-batch'), line_user_id:OTHER, amount:3, remaining:3, expires_at:null }]
  }) });
  const results = await Promise.allSettled([
    rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-09-29' }),
    rpc(db, STUDENT(OTHER), 'book_class', { p_template_id:T1, p_date:'2026-09-29' })
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length, 1);
  assert.equal((await one(db, `select count(*)::int c from bookings where class_key=$1 and status='active'`, [CLASS_KEY_0929])).c, 6);
  assert.equal((await credits(db)) + (await credits(db, OTHER)), 5 + 3 - 1, '只有成功的那位被扣 1 堂');
});

test('預約｜效期不涵蓋上課日的批次不會被使用（C8）', async () => {
  const db = await createDb({ seed: baseSeed({
    credit_batches: [
      { id:id('short'), line_user_id:UID, amount:2, remaining:2, expires_at:'2026-10-05' },
      { id:B1, line_user_id:UID, amount:5, remaining:5, expires_at:'2026-12-31' }
    ]}) });
  const early = await rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-09-29' });
  assert.equal(early.credit_batch_id, id('short'), '9/29 的課先用快到期的批次');
  const late = await rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-10-13' });
  assert.equal(late.credit_batch_id, B1, '10/13 的課不能用 10/05 到期的批次');
});

test('預約｜只剩「上課日前就到期」的堂數時，拒絕預約並說明原因', async () => {
  const db = await createDb({ seed: baseSeed({ credit_batches: [{ id:B1, line_user_id:UID, amount:2, remaining:2, expires_at:'2026-10-05' }] }) });
  await rejects(rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-10-13' }), /到期/);
});

test('預約｜單日修改（modify）後的時間與容量由伺服器套用', async () => {
  const db = await createDb({ seed: baseSeed({ class_overrides: [{ id:id('mod'), type:'modify', date:'2026-09-29', class_template_id:T1, title:'進階', teacher:'蓁尼', time:'19:00', cap:1 }] }) });
  const bk = await rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-09-29' });
  assert.equal(bk.class_time, '19:00'); assert.equal(bk.class_title, '進階'); assert.equal(bk.cap, 1);
});

test('回歸｜買 17 堂、約滿 17 堂（含已上完的）→ 剩 0 堂，不會多出 2 堂（9/15–9/17 修過的問題）', async () => {
  const b1 = id('b-9'), b2 = id('b-8');
  const db = await createDb({ seed: baseSeed({ credit_batches: [
    { id:b1, line_user_id:UID, amount:9, remaining:9, expires_at:'2026-10-31', created_at:'2026-08-01T00:00:00Z' },
    { id:b2, line_user_id:UID, amount:8, remaining:8, expires_at:'2026-11-30', created_at:'2026-09-01T00:00:00Z' } ] }) });
  const tuesdays = Array.from({length:17}, (_,i)=>{ const d=new Date(2026, 8, 29 + i*7); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; });
  await db.query(`update notify_settings set booking_open_start='2026-09-28', booking_open_end='2027-02-28'`);
  let lastErr = null;
  for(const d of tuesdays){
    try{ await rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:d }); }catch(e){ lastErr = e; }
  }
  // 效期規則會讓 10/31 之後的課只能用 11/30 那批；超過 11/30 的課則因為沒有有效堂數被拒絕
  const booked = (await one(db, `select count(*)::int c from bookings where status='active'`)).c;
  assert.equal(await credits(db), 17 - booked, '可用堂數 = 購買 − 已預約，不多不少');
  // 把前幾堂標記為已上完（completed），堂數仍不變：以前的 bug 是 completed 不被算作已使用
  await setNow(db, '2026-10-21T10:00:00');
  await rpc(db, ADMIN, 'complete_past_bookings');
  assert.ok((await one(db, `select count(*)::int c from bookings where status='completed'`)).c >= 3);
  assert.equal(await credits(db), 17 - booked);
  // 重複取消、同時搶位等以前會讓數字漂移的操作，現在都不會多退
  const any = (await one(db, `select id from bookings where status='active' order by class_date_iso desc limit 1`)).id;
  await rpc(db, STUDENT(UID), 'cancel_my_booking', { p_booking_id:any });
  await rpc(db, STUDENT(UID), 'cancel_my_booking', { p_booking_id:any });
  assert.equal(await credits(db), 17 - booked + 1, '取消兩次只退一堂');
  const used = (await one(db, `select sum(amount-remaining)::int u from credit_batches where line_user_id=$1`, [UID])).u;
  const bk = (await one(db, `select count(*)::int c from bookings where status in ('active','completed')`)).c;
  assert.equal(used, bk, '批次已使用數 = 有效預約數（上線前檢查第 7 段的條件）');
});

/* ================= 取消 ================= */
test('取消｜退回原批次、會員 +1；重複取消不會退兩次', async () => {
  const bid = id('bk1');
  const db = await createDb({ seed: baseSeed({ bookings:[booking({ id:bid })], credit_batches: bs=>bs.map(b=>({...b, remaining:4})) }) });
  assert.equal(await rpc(db, STUDENT(UID), 'cancel_my_booking', { p_booking_id:bid }), true);
  assert.equal(await rpc(db, STUDENT(UID), 'cancel_my_booking', { p_booking_id:bid }), false);
  assert.equal((await batch(db)).remaining, 5);
  assert.equal(await credits(db), 5);
});

test('取消｜時限內不能自行取消；時限用當天修改後的上課時間（F2）', async () => {
  const bid = id('bk1');
  const db = await createDb({ seed: baseSeed({ bookings:[booking({ id:bid })], credit_batches: bs=>bs.map(b=>({...b, remaining:4})),
    class_overrides: [{ id:id('mod'), type:'modify', date:'2026-09-29', class_template_id:T1, title:'基礎瑜珈', teacher:'蓁尼', time:'18:00', cap:6 }] }) });
  await setNow(db, '2026-09-29T17:30:00');   // 預約快照是 20:00，但當天已改成 18:00 → 只剩 30 分鐘
  await rejects(rpc(db, STUDENT(UID), 'cancel_my_booking', { p_booking_id:bid }), /時限/);
  await setNow(db, '2026-09-29T16:59:00');
  assert.equal(await rpc(db, STUDENT(UID), 'cancel_my_booking', { p_booking_id:bid }), true);
});

test('取消｜不能取消別人的預約', async () => {
  const bid = id('bk1');
  const db = await createDb({ seed: baseSeed({ bookings:[booking({ id:bid })] }) });
  await rejects(rpc(db, STUDENT(OTHER), 'cancel_my_booking', { p_booking_id:bid }), /找不到/);
});

test('取消｜原批次已不存在時退到其他有效批次，不會憑空消失（C7 C9）', async () => {
  const bid = id('bk1');
  const db = await createDb({ seed: baseSeed({ bookings:[booking({ id:bid, credit_batch_id:null })], credit_batches: bs=>bs.map(b=>({...b, remaining:4})) }) });
  await rpc(db, ADMIN, 'admin_cancel_booking', { p_booking_id:bid });
  assert.equal(await credits(db), 5);
});

test('取消｜當初沒扣到堂數的預約（0 堂學員被建立的預約），取消後不會憑空多出堂數', async () => {
  const bid = id('debt');
  const db = await createDb({ seed: baseSeed({ bookings:[booking({ id:bid, line_user_id:OTHER, credit_batch_id:null })] }) });
  assert.equal(await rpc(db, STUDENT(OTHER), 'cancel_my_booking', { p_booking_id:bid }), true);
  assert.equal((await one(db, 'select status from bookings where id=$1', [bid])).status, 'cancelled');
  assert.equal(await credits(db, OTHER), 0, '沒有付過的堂數不會因為取消而變成可用');
  assert.equal((await one(db, 'select count(*)::int c from credit_batches where line_user_id=$1', [OTHER])).c, 0);
  assert.match((await one(db, `select reason from credit_ledger where booking_id=$1`, [bid])).reason, /沒有扣到堂數/);
});

test('取消｜付過堂數但原批次已過期、也沒有其他批次可退時，開 1 堂補償批次', async () => {
  const bid = id('paid');
  const db = await createDb({ seed: baseSeed({
    credit_batches: [{ id:B1, line_user_id:UID, amount:1, remaining:0, expires_at:'2026-09-20' }],
    bookings:[booking({ id:bid, credit_batch_id:B1 })] }) });
  await rpc(db, ADMIN, 'admin_cancel_booking', { p_booking_id:bid });
  assert.equal(await credits(db), 1);
});

/* ================= 過期（C2） ================= */
test('過期｜用台北日期判斷：10/01 07:00 時 9/30 到期的堂數已不可用', async () => {
  const db = await createDb({ seed: baseSeed({ credit_batches:[{ id:B1, line_user_id:UID, amount:3, remaining:3, expires_at:'2026-09-30' }] }) });
  await setNow(db, '2026-09-30T23:59:00');
  assert.equal(await credits(db), 3, '到期日當天仍可用');
  await setNow(db, '2026-10-01T07:00:00');
  assert.equal(await credits(db), 0);
  assert.equal((await one(db, 'select expired from member_credit_summary where line_user_id=$1', [UID])).expired, 3, '過期數量不會因為學員開 app 而消失（F1）');
});

/* ================= 管理員調整堂數（C1） ================= */
test('後台｜扣 1 堂後不會被任何「校正」加回來；帳本有紀錄', async () => {
  const db = await createDb({ seed: baseSeed() });
  assert.equal(await rpc(db, ADMIN, 'admin_adjust_credits', { p_line_user_id:UID, p_delta:-1, p_reason:'線下補課' }), 4);
  // 模擬學員登入與後台重新載入：現在只讀不寫，所以數字不會變
  await rpc(db, STUDENT(UID), 'get_my_account');
  assert.equal(await credits(db), 4);
  const led = await one(db, `select delta, reason from credit_ledger where kind='admin_adjust'`);
  assert.deepEqual(led, { delta:-1, reason:'線下補課' });
});

test('後台｜扣超過可用堂數整筆失敗、不會扣一半', async () => {
  const db = await createDb({ seed: baseSeed() });
  await rejects(rpc(db, ADMIN, 'admin_adjust_credits', { p_line_user_id:UID, p_delta:-6 }), /不足/);
  assert.equal(await credits(db), 5);
});

test('後台｜新增堂數 + 實收金額：批次與收入紀錄在同一交易', async () => {
  const db = await createDb({ seed: baseSeed() });
  const bid = await rpc(db, ADMIN, 'admin_add_credits', { p_line_user_id:UID, p_amount:10, p_expires_at:'2026-10-28', p_amount_paid:3000 });
  assert.equal(await credits(db), 15);
  const tx = await one(db, 'select type, amount::int, credit_batch_id from transactions');
  assert.deepEqual(tx, { type:'income', amount:3000, credit_batch_id:bid });
  await rejects(rpc(db, ADMIN, 'admin_add_credits', { p_line_user_id:UID, p_amount:0 }), /大於 0/);
  await rejects(rpc(db, ADMIN, 'admin_add_credits', { p_line_user_id:UID, p_amount:5, p_amount_paid:-1 }), /負/);
});

test('後台｜設定堂數：往下調會從批次扣、往上調會開新批次', async () => {
  const db = await createDb({ seed: baseSeed() });
  assert.equal(await rpc(db, ADMIN, 'admin_set_credits', { p_line_user_id:UID, p_target:2 }), 2);
  assert.equal((await batch(db)).remaining, 2);
  assert.equal(await rpc(db, ADMIN, 'admin_set_credits', { p_line_user_id:UID, p_target:8 }), 8);
  assert.equal((await one(db, 'select count(*)::int c from credit_batches where line_user_id=$1', [UID])).c, 2);
});

test('後台｜編輯批次不能讓「已用堂數」小於實際預約數', async () => {
  const db = await createDb({ seed: baseSeed({ bookings:[booking(), booking({ class_key:`2026-10-6_${T1}`, class_date_iso:'2026-10-06' })], credit_batches: bs=>bs.map(b=>({...b, remaining:3})) }) });
  await rejects(rpc(db, ADMIN, 'admin_update_batch', { p_batch_id:B1, p_amount:5, p_remaining:4, p_expires_at:'2026-12-31' }), /已有 2 堂/);
  await rpc(db, ADMIN, 'admin_update_batch', { p_batch_id:B1, p_amount:5, p_remaining:1, p_expires_at:'2026-12-31' });
  assert.equal(await credits(db), 1);
});

test('後台｜刪除被引用的批次：只移除未使用部分，不會牽動其他批次（C11）；可一併刪收入（C13）', async () => {
  const other = id('b2');
  const db = await createDb({ seed: baseSeed({ bookings:[booking()],
    credit_batches: bs=>[...bs.map(b=>({...b, remaining:4})), { id:other, line_user_id:UID, amount:3, remaining:3, expires_at:null }],
    transactions:[{ id:id('tx'), type:'income', amount:3000, line_user_id:UID, credit_batch_id:B1, occurred_at:'2026-08-01' }] }) });
  assert.equal(await rpc(db, ADMIN, 'admin_delete_batch', { p_batch_id:B1, p_delete_income:true }), 'trimmed');
  const b = await batch(db);
  assert.deepEqual([b.amount, b.remaining], [1, 0]);
  assert.equal((await batch(db, other)).remaining, 3, '其他批次不受影響');
  assert.equal(await credits(db), 3);
  assert.equal((await one(db, 'select count(*)::int c from transactions')).c, 0);
});

/* ================= 後台幫學員預約（C12） ================= */
test('後台｜幫多位學員約多天：全部成功或全部失敗；0 堂的學員會讓整批失敗', async () => {
  const db = await createDb({ seed: baseSeed() });
  await rejects(rpc(db, ADMIN, 'admin_book', { p_line_user_ids:[UID, OTHER], p_template_id:T1, p_dates:['2026-09-29','2026-10-06'] }), /堂數不足/);
  assert.equal((await one(db, 'select count(*)::int c from bookings')).c, 0, '整批回滾');
  assert.equal(await credits(db), 5);
  const r = await rpc(db, ADMIN, 'admin_book', { p_line_user_ids:[UID], p_template_id:T1, p_dates:['2026-09-29','2026-09-30','2026-10-06'] });
  assert.equal(r.created, 2);
  assert.equal(r.skipped.length, 1, '9/30 不是上課日');
  assert.equal(await credits(db), 3);
});

test('後台｜超收需要明確允許', async () => {
  const full = Array.from({length:6}, (_,i)=>booking({ line_user_id:`U_x${i}`, credit_batch_id:null }));
  const db = await createDb({ seed: baseSeed({ members: ms=>[...ms, ...full.map(b=>({ line_user_id:b.line_user_id }))], bookings: full }) });
  await rejects(rpc(db, ADMIN, 'admin_book', { p_line_user_ids:[UID], p_template_id:T1, p_dates:['2026-09-29'] }), /額滿/);
  const r = await rpc(db, ADMIN, 'admin_book', { p_line_user_ids:[UID], p_template_id:T1, p_dates:['2026-09-29'], p_allow_overcap:true });
  assert.equal(r.created, 1);
});

/* ================= 課程異動 ================= */
test('課程｜停開某天：當天預約全部取消退堂並新增停課紀錄（單一交易）', async () => {
  const ob = id('ob');
  const db = await createDb({ seed: baseSeed({
    bookings: [booking(), booking({ line_user_id:OTHER, credit_batch_id:ob })],
    credit_batches: bs=>[...bs.map(b=>({...b, remaining:4})), { id:ob, line_user_id:OTHER, amount:3, remaining:2, expires_at:null }] }) });
  assert.equal(await rpc(db, ADMIN, 'admin_cancel_occurrence', { p_template_id:T1, p_date:'2026-09-29' }), 2);
  assert.equal(await credits(db), 5);
  assert.equal(await credits(db, OTHER), 3);
  assert.equal((await one(db, `select count(*)::int c from class_overrides where type='cancel'`)).c, 1);
});

test('課程｜固定課改成特別課：原本的預約搬到新場次，不會消失（C5）；再轉回也會搬回（F3）', async () => {
  const bid = id('bk1');
  const db = await createDb({ seed: baseSeed({ bookings:[booking({ id:bid })], credit_batches: bs=>bs.map(b=>({...b, remaining:4})) }) });
  const eid = await rpc(db, ADMIN, 'admin_convert_to_extra', { p_template_id:T1, p_date:'2026-09-29', p_title:'中秋特別班', p_teacher:'蓁尼', p_time:'19:00', p_cap:8 });
  let bk = await one(db, 'select * from bookings where id=$1', [bid]);
  assert.equal(bk.status, 'active');
  assert.equal(bk.class_key, `2026-9-29_extra_${eid}`);
  assert.equal(bk.class_time, '19:00');
  assert.equal(await credits(db), 4, '沒有多退或多扣');
  await rpc(db, ADMIN, 'admin_convert_extra_to_modify', { p_extra_id:eid });
  bk = await one(db, 'select * from bookings where id=$1', [bid]);
  assert.equal(bk.class_key, CLASS_KEY_0929);
  assert.equal(bk.status, 'active');
});

test('課程｜刪除範本是原子操作：未來預約退堂、過去預約標記完成（C3 C10）', async () => {
  const past = id('past'), future = id('future');
  const db = await createDb({ seed: baseSeed({ bookings:[
    booking({ id:past, class_key:`2026-9-22_${T1}`, class_date_iso:'2026-09-22' }), booking({ id:future })],
    credit_batches: bs=>bs.map(b=>({...b, remaining:3})) }) });
  assert.equal(await rpc(db, ADMIN, 'admin_delete_template', { p_template_id:T1 }), 1);
  assert.equal((await one(db, 'select status from bookings where id=$1', [past])).status, 'completed');
  assert.equal((await one(db, 'select status from bookings where id=$1', [future])).status, 'cancelled');
  assert.equal(await credits(db), 4);
  assert.equal((await one(db, 'select count(*)::int c from class_templates')).c, 0);
});

test('課程｜上完的課自動標記 completed，未來的不動（C10）', async () => {
  const past = id('past');
  const db = await createDb({ seed: baseSeed({ bookings:[booking({ id:past, class_key:`2026-9-22_${T1}`, class_date_iso:'2026-09-22' }), booking()] }) });
  await rejects(rpc(db, STUDENT(UID), 'complete_past_bookings'), /需要管理員權限/);
  assert.equal(await rpc(db, ADMIN, 'complete_past_bookings'), 1);
  assert.equal((await one(db, 'select status from bookings where id=$1', [past])).status, 'completed');
  assert.equal((await db.query('select public.complete_past_bookings() as n')).rows[0].n, 0, '直接在資料庫執行（pg_cron）仍可呼叫');
});

test('課程｜時間格式不正確的舊資料不會讓「標記已上完」整個失敗；上線前檢查會列出它', async () => {
  const bad = id('bad-time');
  const db = await createDb({ seed: baseSeed({ bookings:[
    booking({ class_key:`2026-9-22_${T1}`, class_date_iso:'2026-09-22' }),
    booking({ id:bad, class_key:`2026-9-15_${T1}`, class_date_iso:'2026-09-15', class_time:'下午2:00', credit_batch_id:null }) ] }) });
  assert.equal(await rpc(db, ADMIN, 'complete_past_bookings'), 1, '格式正確的那筆照常標記完成');
  assert.equal((await one(db, 'select status from bookings where id=$1', [bad])).status, 'active', '格式不對的跳過，不報錯');
  const fs = require('fs'), path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'preflight', 'check_before_migration.sql'), 'utf8');
  const section8 = sql.slice(sql.indexOf('-- 8.'));
  const rows = (await db.query(section8.split('\n').filter(l=>!l.startsWith('--')).join('\n'))).rows;
  assert.deepEqual(rows.map(r=>r.time_value), ['下午2:00']);
});

/* ================= 金流 ================= */
test('金流｜多位學員一次新增是單一交易；金額 0 / 負數被拒絕；資料庫約束擋直接寫入', async () => {
  const db = await createDb({ seed: baseSeed() });
  assert.equal(await rpc(db, ADMIN, 'admin_add_transactions', { p_type:'income', p_amount:1500, p_occurred_at:'2026-09-10', p_note:'10堂', p_line_user_ids:[UID, OTHER] }), 2);
  await rejects(rpc(db, ADMIN, 'admin_add_transactions', { p_type:'income', p_amount:0, p_occurred_at:'2026-09-10', p_note:'' }), /大於 0/);
  await rejects(asRole(db, ADMIN, tx => tx.query(`update transactions set amount = -5`)), /violates|row-level/);
});

/* ================= 稽核（S6） ================= */
test('稽核｜每一筆異動都記錄操作者', async () => {
  const db = await createDb({ seed: baseSeed() });
  await rpc(db, STUDENT(UID), 'book_class', { p_template_id:T1, p_date:'2026-09-29' });
  await rpc(db, ADMIN, 'admin_adjust_credits', { p_line_user_id:UID, p_delta:-1 });
  const actors = (await db.query(`select distinct actor from audit_log where table_name in ('bookings','credit_batches') order by 1`)).rows.map(r=>r.actor);
  assert.deepEqual(actors, ['admin:owner@studio.test', `student:${UID}`]);
});

/* ================= 刪除學員（F7） ================= */
test('學員｜刪除學員：預約 / 批次 / 帳本一起刪，金流保留並去識別', async () => {
  const db = await createDb({ seed: baseSeed({ bookings:[booking()], transactions:[{ id:id('tx'), type:'income', amount:100, line_user_id:UID, occurred_at:'2026-09-01', note:'' }] }) });
  await rpc(db, ADMIN, 'admin_delete_member', { p_line_user_id:UID });
  assert.equal((await one(db, `select count(*)::int c from members where line_user_id=$1`, [UID])).c, 0);
  const tx = await one(db, 'select line_user_id, note from transactions');
  assert.equal(tx.line_user_id, null);
  assert.match(tx.note, /已刪除學員：測試學員/);
});
