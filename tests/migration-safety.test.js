'use strict';
// 證明「套用 migration 不會改動任何既有資料」，以及第一階段之後舊版網站的權限不變
process.env.TZ = 'Asia/Taipei';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createDb, asRole, snapshot, applyFile, ANON, STUDENT } = require('./pg');
const { id, UID, OTHER, T1, B1, baseSeed, booking } = require('./fixtures');

// 刻意放進「髒資料」：members 快取跟批次不一致、過期批次、沒綁批次的預約、已取消預約、收支紀錄
function messySeed(){
  return baseSeed({
    members: ms => ms.map(m => m.line_user_id===UID ? { ...m, remaining_credits: 99, total_credits: 7 } : m),
    credit_batches: bs => [...bs, { id:id('expired'), line_user_id:UID, amount:3, remaining:3, expires_at:'2026-01-01', created_at:'2026-01-01T00:00:00Z' }],
    bookings: [booking(), booking({ class_key:`2026-9-22_${T1}`, class_date_iso:'2026-09-22', credit_batch_id:null }),
               booking({ line_user_id:OTHER, status:'cancelled', credit_batch_id:null })],
    transactions: [{ id:id('tx1'), type:'income', amount:3000, line_user_id:UID, occurred_at:'2026-08-01', note:'10堂' }],
    class_overrides: [{ id:id('ov'), type:'cancel', date:'2026-10-06', class_template_id:T1 }]
  });
}

test('安全｜第一階段不修改任何既有資料列', async () => {
  const db = await createDb({ seed: messySeed(), migrate: false });
  const before = await snapshot(db);
  await applyFile(db, '20260928000000_phase1_additive.sql');
  assert.deepEqual(await snapshot(db), before);
});

test('安全｜第二階段也不修改任何既有資料列', async () => {
  const db = await createDb({ seed: messySeed(), migrate: 'phase1' });
  const before = await snapshot(db);
  await applyFile(db, '20260928000100_phase2_lockdown.sql');
  assert.deepEqual(await snapshot(db), before);
});

test('安全｜第一階段可重複執行（idempotent），第二次也不改資料', async () => {
  const db = await createDb({ seed: messySeed(), migrate: 'phase1' });
  const before = await snapshot(db);
  await applyFile(db, '20260928000000_phase1_additive.sql');
  assert.deepEqual(await snapshot(db), before);
});

test('安全｜第一階段之後，舊版前台的直接讀寫仍可運作（線上網站不中斷）', async () => {
  const db = await createDb({ seed: baseSeed(), migrate: 'phase1' });
  const rows = await asRole(db, ANON, tx => tx.query('select * from members'));
  assert.equal(rows.rows.length, 2);
  await asRole(db, ANON, tx => tx.query(`update credit_batches set remaining = remaining - 1 where id = $1`, [B1]));
  const s = await asRole(db, ANON, tx => tx.query('select get_store_public_settings() as s'));
  assert.equal(s.rows[0].s.name, '測試教室');
});

test('安全｜有重複 active 預約時，第一階段不刪不改，只是不建立唯一索引', async () => {
  const db = await createDb({ seed: baseSeed(), migrate: false });
  await db.exec('drop index bookings_one_active_per_class');
  await db.query(`insert into bookings(id, line_user_id, class_key, status, class_date_iso) values ($1,$2,'k','active','2026-10-01'), ($3,$2,'k','active','2026-10-01')`, [id('d1'), UID, id('d2')]);
  const before = await snapshot(db);
  await applyFile(db, '20260928000000_phase1_additive.sql');
  assert.deepEqual(await snapshot(db), before);
  const idx = await db.query(`select 1 from pg_indexes where indexname='bookings_one_active_per_class'`);
  assert.equal(idx.rows.length, 0);
});

test('安全｜第二階段回滾後，舊版權限恢復且資料不變', async () => {
  const db = await createDb({ seed: messySeed() });
  const before = await snapshot(db);
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rollback', 'phase2_rollback.sql'), 'utf8'));
  assert.deepEqual(await snapshot(db), before);
  const rows = await asRole(db, ANON, tx => tx.query('select * from members'));
  assert.equal(rows.rows.length, 2);
});

test('安全｜上線前檢查腳本只有 SELECT / WITH（唯讀）', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'preflight', 'check_before_migration.sql'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);
});

test('安全｜上線前檢查腳本可以在資料庫上執行', async () => {
  const db = await createDb({ seed: messySeed(), migrate: false });
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'preflight', 'check_before_migration.sql'), 'utf8'));
});
