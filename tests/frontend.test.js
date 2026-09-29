'use strict';
// 前台行為測試：執行 yoga-booking/index.html 的真實程式碼，資料庫是套用了 migration 的 PGlite（RLS / RPC 真的生效）
process.env.TZ = 'Asia/Taipei';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb, asRole, ADMIN } = require('./pg');
const { loadApp, frontAvailable, FRONT_HTML } = require('./load-app');
const { id, UID, OTHER, T1, B1, CLASS_KEY_0929, baseSeed, booking } = require('./fixtures');

if(!frontAvailable()){
  test(`前台測試略過：找不到前台 index.html（${FRONT_HTML}）。請把 yoga-booking 與本 repo 並排 clone，或設定 YOGA_FRONT_HTML`, { skip: true }, ()=>{});
  return;
}

const PROFILE = { userId: UID, displayName: '測試學員', pictureUrl: null };
const one = async (pg, sql, p=[]) => (await pg.query(sql, p)).rows[0];
const credits = async (pg, uid=UID) => (await one(pg, 'select available from member_credit_summary where line_user_id=$1', [uid])).available;
const batchRemaining = async (pg, bid=B1) => (await one(pg, 'select remaining from credit_batches where id=$1', [bid])).remaining;

async function boot(seedOver={}, opts={}){
  const pg = await createDb({ seed: baseSeed(seedOver) });
  if(opts.now) await require('./pg').setNow(pg, opts.now);
  if(opts.before) await opts.before(pg);
  const app = loadApp('front', { pg, liffProfile: PROFILE, ...opts });
  await app.init();
  return { app, pg };
}
const classOn = (app, dateKey, templateId=T1) =>
  app.get(`state.allClasses.find(c=>c.dateKey==='${dateKey}' && c.templateId==='${templateId}')`);

/* ============ 預約 ============ */
test('前台｜預約成功：扣 1 堂、預約綁到批次、畫面數字更新', async () => {
  const { app, pg } = await boot();
  const c = classOn(app, '2026-9-29');
  assert.ok(c, '課表應該展開出 9/29 的課');
  await app.call('bookClass', c);
  const bk = await one(pg, `select * from bookings where line_user_id=$1`, [UID]);
  assert.equal(bk.status, 'active'); assert.equal(bk.credit_batch_id, B1); assert.equal(bk.class_key, CLASS_KEY_0929);
  assert.equal(await batchRemaining(pg), 4);
  assert.equal(app.get('state.creditsRemaining'), 4);
  assert.match(app.toasts.at(-1), /已預約/);
});

test('前台｜畫面資料過舊時（另一分頁已約過），伺服器擋下重複預約、堂數不變', async () => {
  const { app, pg } = await boot({ bookings: [booking()], credit_batches: bs=>bs.map(b=>({...b, remaining:4})) });
  app.eval('state.myBookings = []');
  await app.call('bookClass', classOn(app, '2026-9-29'));
  assert.equal((await one(pg, `select count(*)::int c from bookings where status='active'`)).c, 1);
  assert.equal(await credits(pg), 4);
  assert.equal(app.toasts.at(-1), '已經預約過這堂課囉');
});

test('前台｜畫面座位數過舊時，伺服器仍會擋下額滿的課（C4）', async () => {
  const full = Array.from({length:6}, (_,i)=>booking({ line_user_id:`U_x${i}`, credit_batch_id:null }));
  const { app, pg } = await boot({ members: ms=>[...ms, ...full.map(b=>({ line_user_id:b.line_user_id }))], bookings: full });
  app.eval('state.seatsMap = {}');   // 畫面以為還有位子
  await app.call('bookClass', classOn(app, '2026-9-29'));
  assert.equal(app.toasts.at(-1), '此堂課已額滿');
  assert.equal(await credits(pg), 5);
});

test('前台｜堂數 0 或已開始的課不能預約', async () => {
  const { app, pg } = await boot({ credit_batches: [] });
  await app.call('bookClass', classOn(app, '2026-9-29'));
  assert.equal(app.toasts.at(-1), '堂數不足，請先加購');
  assert.equal((await one(pg, 'select count(*)::int c from bookings')).c, 0);
});

/* ============ 取消 ============ */
test('前台｜取消：批次 +1、會員 +1；連點兩次只退一次', async () => {
  const bid = id('bk1');
  const { app, pg } = await boot({ bookings: [booking({ id:bid })], credit_batches: bs=>bs.map(b=>({...b, remaining:4})) });
  await app.call('cancelBooking', bid);
  assert.equal((await one(pg, 'select status from bookings where id=$1', [bid])).status, 'cancelled');
  assert.equal(await batchRemaining(pg), 5);
  app.eval(`state.myBookings.find(b=>b.id==='${bid}').status='active'`); // 模擬過舊畫面再按一次
  await app.call('cancelBooking', bid);
  assert.equal(await batchRemaining(pg), 5, '不可重複退堂');
  assert.equal(app.get('state.creditsRemaining'), 5);
});

test('前台｜取消時限：畫面擋、伺服器也擋（繞過畫面直接呼叫也不行，S5）', async () => {
  const bid = id('bk1');
  const { app, pg } = await boot({ bookings: [booking({ id:bid })], credit_batches: bs=>bs.map(b=>({...b, remaining:4})) });
  await app.setNow('2026-09-29T19:30:00');
  app.call('openCancelModal', bid);
  assert.equal(app.el('modalTitle').textContent, '無法取消');
  await app.call('cancelBooking', bid);              // 直接呼叫，跳過畫面檢查
  assert.match(app.toasts.at(-1), /時限/);
  assert.equal((await one(pg, 'select status from bookings where id=$1', [bid])).status, 'active');
});

/* ============ 堂數正確性（原【BUG】測試，現在應全部通過） ============ */
test('前台｜修正 C1：後台手動扣掉的堂數，學員打開 app 後不會被加回來', async () => {
  const { app, pg } = await boot({}, { before: async (pg) => {
    await asRole(pg, ADMIN, tx => tx.query(`select admin_adjust_credits($1, -1, '線下補課')`, [UID]));
  }});
  assert.equal(app.get('state.creditsRemaining'), 4);
  assert.equal(await batchRemaining(pg), 4, '前台載入不再改寫任何資料');
});

test('前台｜修正 C2：用台北日期判斷過期（10/01 07:00 時，9/30 到期的堂數已不可用）', async () => {
  const { app, pg } = await boot({ credit_batches: [{ id:B1, line_user_id:UID, amount:3, remaining:3, expires_at:'2026-09-30' }] }, { now: '2026-10-01T07:00:00' });
  assert.equal(app.get('state.creditsRemaining'), 0);
  const html = app.call('renderCreditExpiryTab');
  assert.match(html, /已過期（2026-09-30）/);
  assert.equal(await batchRemaining(pg), 3, '過期是計算出來的，不會去改資料');
});

test('前台｜修正 C8：預約會避開「上課日前就到期」的批次', async () => {
  const { app, pg } = await boot({ credit_batches: [
    { id:id('short'), line_user_id:UID, amount:2, remaining:2, expires_at:'2026-10-05' },
    { id:B1, line_user_id:UID, amount:5, remaining:5, expires_at:'2026-12-31' } ] });
  await app.call('bookClass', classOn(app, '2026-10-13'));
  assert.equal((await one(pg, 'select credit_batch_id from bookings')).credit_batch_id, B1);
});

/* ============ 課表 ============ */
test('前台｜課表：停課 / 單日修改 / 特別課 / 開課區間 都正確反映；特別課可預約', async () => {
  const extra = id('ov-extra');
  const { app, pg } = await boot({
    class_overrides: [
      { id:id('ov-cancel'), type:'cancel', date:'2026-10-06', class_template_id:T1 },
      { id:id('ov-mod'), type:'modify', date:'2026-10-13', class_template_id:T1, title:'進階瑜珈', teacher:'蓁尼', time:'19:00', cap:4 },
      { id:extra, type:'extra', date:'2026-10-03', title:'中秋特別班', teacher:'蓁尼', time:'10:00', cap:8 }
    ],
    class_templates: ts=>ts.map(t=>({...t, start_date:'2026-09-29', end_date:'2026-10-14'}))
  });
  assert.ok(classOn(app,'2026-9-29'));
  assert.equal(classOn(app,'2026-10-6'), undefined);
  const mod = classOn(app,'2026-10-13');
  assert.equal(mod.time, '19:00'); assert.equal(mod.cap, 4);
  assert.equal(classOn(app,'2026-10-20'), undefined);
  const ex = app.get('state.allClasses.find(c=>c.isExtra)');
  assert.equal(ex.classKey, `2026-10-3_extra_${extra}`);
  await app.call('bookClass', ex);
  assert.equal((await one(pg, 'select class_key from bookings')).class_key, ex.classKey);
});

/* ============ 資安（原【BUG】測試） ============ */
test('前台｜修正 S4：課程名稱等文字會做 HTML 跳脫', async () => {
  const { app } = await boot({ class_templates: ts=>ts.map(t=>({...t, title:'<img src=x onerror=alert(1)>', location:'"><script>x</script>'})) });
  const html = app.call('classCardHTML', classOn(app,'2026-9-29'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('前台｜修正 S4：關於我們的連結不允許 javascript: 協定', async () => {
  const { app } = await boot({ store_settings: ss=>ss.map(s=>({...s, about_links:[{label:'點我', url:'javascript:alert(document.cookie)'}, {label:'IG', url:'https://instagram.com/x'}]})) });
  const html = app.call('renderAboutTab');
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('href="https://instagram.com/x"'));
});

test('前台｜修正 S1：LINE 身分驗證失敗時不會以任何身分存取資料', async () => {
  const pg = await createDb({ seed: baseSeed() });
  const app = loadApp('front', { pg, liffProfile: null });
  await app.init();
  assert.equal(app.get('isDemoMode'), true);
  const { data, error } = await app.eval('db.from("members").select("*")');
  assert.ok(error || (data||[]).length === 0, '匿名讀不到任何學員');
});

test('前台｜會員註冊透過 RPC 儲存，只會寫到自己的資料', async () => {
  const { app, pg } = await boot({ store_settings: ss=>ss.map(s=>({...s, registration_form_status:'published'})) });
  app.setInput('regName', '王小美'); app.setInput('regContact', 'a@b.c');
  await app.call('submitRegistration');
  const m = await one(pg, 'select registration_name, registration_submitted_at from members where line_user_id=$1', [UID]);
  assert.equal(m.registration_name, '王小美');
  assert.ok(m.registration_submitted_at);
  const other = await one(pg, 'select registration_name from members where line_user_id=$1', [OTHER]);
  assert.equal(other.registration_name, null);
});

test('前台｜修正 F5：資料載入失敗時不顯示「0 堂 / 空課表」，改顯示錯誤與重試', async () => {
  const pg = await createDb({ seed: baseSeed() });
  await pg.exec('revoke execute on function public.get_my_account() from authenticated');
  const app = loadApp('front', { pg, liffProfile: PROFILE });
  await app.init();
  assert.equal(app.el('mainContent').innerHTML, '', '沒有渲染出假的 0 堂畫面');
  assert.notEqual(app.el('app').style.display, 'flex');
});
