'use strict';
// 後台行為測試：執行 yoga-booking-admin/index.html 的真實程式碼，資料庫是套用了 migration 的 PGlite
process.env.TZ = 'Asia/Taipei';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('./pg');
const { loadApp } = require('./load-app');
const { id, UID, OTHER, T1, B1, CLASS_KEY_0929, baseSeed, booking } = require('./fixtures');

const one = async (pg, sql, p=[]) => (await pg.query(sql, p)).rows[0];
const credits = async (pg, uid=UID) => (await one(pg, 'select available from member_credit_summary where line_user_id=$1', [uid])).available;
const batchOf = async (pg, bid=B1) => one(pg, 'select * from credit_batches where id=$1', [bid]);

async function bootAdmin(seedOver={}, opts={}){
  const pg = await createDb({ seed: baseSeed(seedOver) });
  const app = loadApp('admin', { pg, ...opts });
  app.loginAdmin();
  await app.call('loadAdminState');
  return { app, pg };
}

/* ============ 堂數 ============ */
test('後台｜新增堂數 + 實收金額：批次與收入同一交易，列表數字更新', async () => {
  const { app, pg } = await bootAdmin();
  await app.call('openMemberDetail', UID);
  app.setInput('mdCreditAmount', 10); app.setInput('mdCreditExpiryType', 'days'); app.setInput('mdCreditExpiryDays', 30); app.setInput('mdAmountPaid', '3000');
  await app.call('addCreditsForCurrentMember');
  assert.equal(await credits(pg), 15);
  const nb = await one(pg, 'select * from credit_batches where id <> $1', [B1]);
  assert.equal(nb.amount, 10); assert.equal((await one(pg, 'select expires_at::text d from credit_batches where id=$1', [nb.id])).d, '2026-10-28');
  const tx = await one(pg, 'select type, amount::int, credit_batch_id from transactions');
  assert.deepEqual(tx, { type:'income', amount:3000, credit_batch_id:nb.id });
  assert.equal(app.get(`data.members.find(m=>m.line_user_id==='${UID}').remaining_credits`), 15);
});

test('後台｜修正 C1：「扣 1 堂」之後重新載入，不會被加回來', async () => {
  const { app, pg } = await bootAdmin();
  await app.call('adjustMember', UID, -1);
  await app.call('loadAdminState');
  assert.equal(await credits(pg), 4);
  assert.equal((await batchOf(pg)).remaining, 4);
  assert.equal(app.get(`data.members.find(m=>m.line_user_id==='${UID}').remaining_credits`), 4);
});

test('後台｜修正 C1：編輯批次把剩餘改小，重新載入後維持管理員設定的數字', async () => {
  const { app, pg } = await bootAdmin();
  await app.call('openMemberDetail', UID);
  app.setInput(`ebAmount-${B1}`, 5); app.setInput(`ebRemaining-${B1}`, 2); app.setInput(`ebExpiry-${B1}`, '2026-12-31');
  await app.call('saveEditBatch', B1, UID);
  await app.call('loadAdminState');
  assert.equal((await batchOf(pg)).remaining, 2);
  assert.equal(await credits(pg), 2);
});

test('後台｜設定堂數：往下調扣批次、往上調開新批次；扣超過可用堂數會被拒絕', async () => {
  const { app, pg } = await bootAdmin();
  app.setInput(`setCredits-${UID}`, 3);
  await app.call('setMemberCredits', UID);
  assert.equal(await credits(pg), 3);
  app.setInput(`setCredits-${UID}`, 8);
  await app.call('setMemberCredits', UID);
  assert.equal(await credits(pg), 8);
  await app.call('adjustMember', OTHER, -1);
  assert.match(app.toasts.at(-1), /不足/);
  assert.equal(await credits(pg, OTHER), 0);
});

/* ============ 幫學員預約 ============ */
test('後台｜幫學員預約：用效期涵蓋上課日的批次；取消退回；連點不會重複退', async () => {
  const { app, pg } = await bootAdmin({ credit_batches: [
    { id:id('short'), line_user_id:UID, amount:2, remaining:2, expires_at:'2026-09-28' },
    { id:B1, line_user_id:UID, amount:5, remaining:5, expires_at:'2026-12-31' } ] });
  await app.call('openMemberDetail', UID);
  app.setInput('adNewClass', `t:${T1}`);
  app.queryAll['.adDateInput'] = [{ value:'2026-09-29' }];
  await app.call('adminAddBooking', UID);
  const bk = await one(pg, 'select * from bookings where line_user_id=$1', [UID]);
  assert.equal(bk.credit_batch_id, B1);
  assert.equal(await credits(pg), 6);
  await app.call('adminCancelBooking', bk.id);
  await app.call('adminCancelBooking', bk.id);
  assert.equal(await credits(pg), 7);
  assert.equal((await batchOf(pg)).remaining, 5);
});

test('後台｜修正 C12：沒有堂數的學員不能被預約（不再有看不見的欠堂）', async () => {
  const { app, pg } = await bootAdmin();
  await app.call('openMemberDetail', OTHER);
  app.setInput('adNewClass', `t:${T1}`);
  app.queryAll['.adDateInput'] = [{ value:'2026-09-29' }];
  await app.call('adminAddBooking', OTHER);
  assert.equal((await one(pg, 'select count(*)::int c from bookings')).c, 0);
  assert.match(app.toasts.at(-1), /堂數不足/);
});

test('後台｜額滿時需管理員確認才超收；取消確認就不會新增', async () => {
  const full = Array.from({length:6}, (_,i)=>booking({ line_user_id:`U_x${i}`, credit_batch_id:null }));
  const seed = { members: ms=>[...ms, ...full.map(b=>({ line_user_id:b.line_user_id }))], bookings: full };
  { const { app, pg } = await bootAdmin(seed, { confirmAnswer:false });
    await app.call('openMemberDetail', UID);
    app.setInput('adNewClass', `t:${T1}`); app.queryAll['.adDateInput'] = [{ value:'2026-09-29' }];
    await app.call('adminAddBooking', UID);
    assert.equal(await credits(pg), 5); }
  { const { app, pg } = await bootAdmin(seed, { confirmAnswer:true });
    await app.call('openMemberDetail', UID);
    app.setInput('adNewClass', `t:${T1}`); app.queryAll['.adDateInput'] = [{ value:'2026-09-29' }];
    await app.call('adminAddBooking', UID);
    assert.equal(await credits(pg), 4); }
});

/* ============ 課程異動 ============ */
test('後台｜停開某天：預約取消退堂 + 停課紀錄一起完成', async () => {
  const { app, pg } = await bootAdmin({ bookings:[booking()], credit_batches: bs=>bs.map(b=>({...b, remaining:4})) });
  await app.call('quickCancelOccurrence', '2026-09-29', T1);
  assert.equal(app.confirms.length, 1);
  assert.equal(await credits(pg), 5);
  assert.equal((await one(pg, `select count(*)::int c from class_overrides where type='cancel'`)).c, 1);
});

test('後台｜修正 C5：把某天的固定課改成特別課，學員的預約會跟著搬過去', async () => {
  const bid = id('bk1');
  const { app, pg } = await bootAdmin({ bookings:[booking({ id:bid })], credit_batches: bs=>bs.map(b=>({...b, remaining:4})) });
  app.call('quickEditOccurrence', '2026-09-29', T1);
  app.call('toggleInlineEditType', true);
  app.setInput('ovExtraDate','2026-09-29'); app.setInput('ovExtraTitle','中秋特別班'); app.setInput('ovExtraTeacher','蓁尼');
  app.setInput('ovExtraTime','19:00'); app.setInput('ovExtraCap','8'); app.setInput('ovExtraLocation',''); app.setInput('ovExtraDescription','');
  await app.call('saveAsExtra');
  const bk = await one(pg, 'select * from bookings where id=$1', [bid]);
  assert.equal(bk.status, 'active');
  assert.match(bk.class_key, /^2026-9-29_extra_/);
  assert.equal(bk.class_time, '19:00');
  await app.call('loadRoster');
  app.eval(`rosterDate='2026-09-29'`); await app.call('loadRoster');
  assert.match(app.call('pageRoster'), /測試學員/, '名單上看得到這位學員');
  assert.equal(await credits(pg), 4);
});

test('後台｜修正 C3：刪除課程範本是原子操作（未來退堂、過去標記完成）', async () => {
  const past = id('past');
  const { app, pg } = await bootAdmin({ bookings:[booking({ id:past, class_key:`2026-9-22_${T1}`, class_date_iso:'2026-09-22' }), booking()],
    credit_batches: bs=>bs.map(b=>({...b, remaining:3})) });
  await app.call('removeClass', T1);
  assert.equal((await one(pg, 'select status from bookings where id=$1', [past])).status, 'completed');
  assert.equal(await credits(pg), 4);
  assert.equal((await one(pg, 'select count(*)::int c from class_templates')).c, 0);
});

test('後台｜修正 F4：人數上限填 0 或負數會被拒絕，不會默默變成 12', async () => {
  const { app, pg } = await bootAdmin();
  app.eval(`dayOverrideDate='2026-10-03'`);
  app.setInput('ovExtraTitle','特別班'); app.setInput('ovExtraTeacher','蓁尼'); app.setInput('ovExtraTime','10:00');
  app.setInput('ovExtraCap','0'); app.setInput('ovExtraLocation',''); app.setInput('ovExtraDescription','');
  await app.call('addExtraOverride');
  assert.match(app.toasts.at(-1), /人數上限/);
  assert.equal((await one(pg, `select count(*)::int c from class_overrides`)).c, 0);
});

test('後台｜刪除被使用過的批次：只移除未使用部分；可選擇一併刪除收入', async () => {
  const { app, pg } = await bootAdmin({ bookings:[booking()], credit_batches: bs=>bs.map(b=>({...b, remaining:4})),
    transactions:[{ id:id('tx'), type:'income', amount:3000, line_user_id:UID, credit_batch_id:B1, occurred_at:'2026-08-01' }] });
  await app.call('openMemberDetail', UID);
  await app.call('deleteBatch', B1, UID);
  const b = await batchOf(pg);
  assert.deepEqual([b.amount, b.remaining], [1, 0]);
  assert.equal((await one(pg, 'select count(*)::int c from transactions')).c, 0);
});

/* ============ 金流 ============ */
test('後台｜手動收支：多位學員單一交易；0 / 負數拒絕；本月統計正確', async () => {
  const { app, pg } = await bootAdmin();
  app.eval(`txSelectedUids = new Set(['${UID}','${OTHER}'])`);
  app.setInput('txType','income'); app.setInput('txAmount','1500'); app.setInput('txDate','2026-09-10'); app.setInput('txNote','10堂');
  await app.call('submitManualTransaction');
  app.setInput('txAmount','0'); await app.call('submitManualTransaction');
  app.setInput('txAmount','-50'); await app.call('submitManualTransaction');
  assert.equal((await one(pg, 'select count(*)::int c from transactions')).c, 2);
  app.eval('txSelectedUids = new Set()');
  app.setInput('txType','expense'); app.setInput('txAmount','800'); app.setInput('txDate','2026-09-12'); app.setInput('txCostType','fixed');
  await app.call('submitManualTransaction');
  await app.call('loadCashflowData');
  app.eval('financeAmountVisible = true');
  const html = app.call('pageCashflow');
  assert.ok(html.includes('NT$ 3,000')); assert.ok(html.includes('NT$ 800')); assert.ok(html.includes('NT$ 2,200'));
});

/* ============ 名單 / 統計（原【BUG】測試） ============ */
test('後台｜修正 C13：每日名單顯示當天修改後的時間', async () => {
  const { app } = await bootAdmin({
    class_overrides: [{ id:id('mod'), type:'modify', date:'2026-09-29', class_template_id:T1, title:'基礎瑜珈', teacher:'蓁尼', time:'19:00', cap:6 }],
    bookings: [booking({ class_time:'19:00' })] });
  app.eval(`rosterDate = '2026-09-29'`);
  await app.call('loadRoster');
  assert.ok(app.call('pageRoster').includes('19:00　基礎瑜珈'));
});

test('後台｜修正 C13：熱門度額滿率上限 100%，超收另外計算', async () => {
  const { app } = await bootAdmin();
  const rows = Array.from({length:8}, (_,i)=>booking({ line_user_id:`U${i}` }));
  const g = app.call('summarizeClassPopularity', rows);
  assert.equal(g[0].totalActive, 8);
  assert.ok(g[0].avgFillRate <= 1);
  assert.equal(g[0].overbooked, 1);
});

test('後台｜修正 C10：已上完的課標記為完成，名單與統計仍會算進去', async () => {
  const { app, pg } = await bootAdmin({ bookings:[booking({ class_key:`2026-9-22_${T1}`, class_date_iso:'2026-09-22' })] });
  assert.equal((await one(pg, 'select status from bookings')).status, 'completed');
  app.eval(`rosterDate = '2026-09-22'`);
  await app.call('loadRoster');
  assert.match(app.call('pageRoster'), /測試學員/);
});

/* ============ 資安（原【BUG】測試） ============ */
test('後台｜修正 S4：學員可控的名稱 / 註冊答案不會變成可執行的 HTML', async () => {
  const { app } = await bootAdmin({ members: ms=>ms.map(m=>m.line_user_id===UID
    ? {...m, display_name:'<img src=x onerror="alert(1)">', registration_submitted_at:'2026-09-01T00:00:00Z', registration_name:'<svg onload=alert(1)>', registration_contact:'a@b.c', registration_answers:{}}
    : m) });
  const listHtml = app.call('pageMembers');
  assert.ok(!listHtml.includes('<img src=x'));
  await app.call('openMemberDetail', UID);
  const detailHtml = app.call('pageMemberDetail');
  assert.ok(!detailHtml.includes('<svg onload'));
  assert.ok(detailHtml.includes('&lt;svg onload=alert(1)&gt;'));
});

test('後台｜修正 S4：含引號的標籤名稱不能跳出 onclick 字串', async () => {
  const evil = "x');alert(1);('";
  const { app } = await bootAdmin({ store_settings: ss=>ss.map(s=>({...s, available_tags:[evil]})) });
  const html = app.call('pageMembers');
  assert.ok(!html.includes(`'${evil}'`));
  assert.ok(html.includes('removeAvailableTag(&quot;x&#39;);alert(1);(&#39;&quot;)'));
});

test('後台｜修正 S3：不在管理員名單的帳號無法進入後台', async () => {
  const pg = await createDb({ seed: baseSeed() });
  await pg.query('delete from admin_users');
  const app = loadApp('admin', { pg });
  app.setInput('loginEmail', 'x@evil.test'); app.setInput('loginPassword', 'whatever');
  await app.call('tryLogin');
  assert.equal(app.el('loginErr').textContent, '這個帳號沒有後台管理權限');
  assert.notEqual(app.el('app').style.display, 'flex');
});
