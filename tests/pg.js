'use strict';
// 建一個全新的 PGlite 資料庫：Supabase stub → 現行 schema（migration 前）→ 種子資料 →（可選）套用 migration
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const SQL_DIR = path.join(__dirname, 'sql');
const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');
const ADMIN_UUID = '00000000-0000-4000-8000-000000000001';

// migrate: true=全部、'phase1'=只跑第一階段、false=不跑
async function createDb({ seed, migrate = true } = {}){
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(SQL_DIR, '00_supabase_stub.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SQL_DIR, '01_baseline_schema.sql'), 'utf8'));
  await db.query(`insert into auth.users(id, email) values ($1, 'owner@studio.test')`, [ADMIN_UUID]);
  if(seed) await insertSeed(db, seed);
  if(migrate){
    const files = fs.readdirSync(MIGRATIONS).filter(f=>f.endsWith('.sql')).sort().filter(f => migrate !== 'phase1' || f.includes('phase1'));
    for(const f of files){
      await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    // 只在測試裡：讓「現在時間」可以用 app.fake_now 覆寫（正式環境的函式不含這個開關）
    await db.exec(`create or replace function app.now_local() returns timestamp language sql stable as $$
      select coalesce(nullif(current_setting('app.fake_now', true), '')::timestamp, now() at time zone 'Asia/Taipei') $$;
      create or replace function app.today() returns date language sql stable as $$ select app.now_local()::date $$;`);
  }
  await setNow(db, '2026-09-28T10:00:00');
  return db;
}

async function insertSeed(db, seed){
  const order = ['store_settings','notify_settings','teachers','class_templates','class_overrides','registration_questions','members','credit_batches','bookings','transactions'];
  for(const t of order){
    for(const row of (seed[t]||[])){
      const cols = Object.keys(row);
      const vals = cols.map(c => {
        const v = row[c];
        return (v !== null && typeof v === 'object' && !Array.isArray(v)) || (Array.isArray(v) && ['about_links','registration_field_order','options'].includes(c)) ? JSON.stringify(v) : v;
      });
      await db.query(`insert into public.${t}(${cols.map(c=>`"${c}"`).join(',')}) values (${cols.map((_,i)=>`$${i+1}`).join(',')})`, vals);
    }
  }
}

// 模擬 PostgREST：用指定的角色 + JWT claims 執行一段 SQL（每次呼叫都是獨立交易，跟 PostgREST 一樣）
async function asRole(db, { role = 'anon', claims = {} }, fn){
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role, ...claims })]);
    await tx.query(`set local role ${role}`);
    return fn(tx);
  });
}

const STUDENT = (uid) => ({ role:'authenticated', claims:{ line_user_id: uid, app_role:'student', sub: null } });
const ADMIN = { role:'authenticated', claims:{ sub: ADMIN_UUID, email:'owner@studio.test' } };
const ANON = { role:'anon', claims:{} };

async function setNow(db, localIso){ await db.query(`select set_config('app.fake_now', $1, false)`, [localIso.replace('T',' ')]); }

const BUSINESS_TABLES = ['members','bookings','credit_batches','transactions','class_templates','class_overrides','teachers','registration_questions','store_settings','notify_settings'];
// 把所有既有業務表的每一列（依主鍵排序）序列化，用來比對 migration 前後是否完全相同
async function snapshot(db){
  const out = {};
  for(const t of BUSINESS_TABLES){
    const pk = t==='members' ? 'line_user_id' : 'id';
    out[t] = (await db.query(`select to_jsonb(x) as r from public.${t} x order by ${pk}::text`)).rows.map(r=>r.r);
  }
  return out;
}
async function applyFile(db, file){ await db.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8')); }

module.exports = { snapshot, applyFile, BUSINESS_TABLES, setNow, createDb, asRole, STUDENT, ADMIN, ANON, ADMIN_UUID };
