'use strict';
// 把 supabase-js 的 API（from/select/eq/.../rpc/auth/storage）轉成 SQL，在 PGlite 上以對應的角色 + JWT claims 執行。
// 等同一個迷你 PostgREST：RLS、GRANT、RPC 的 security definer 全部是真的在資料庫裡生效。
const { asRole, STUDENT, ADMIN, ANON } = require('./pg');

const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';

function makeShim(db){
  let session = null; // 後台登入後的 session（管理員）
  const errors = [];   // 所有資料庫錯誤（原程式常把錯誤吞掉只顯示空白，測試用這個抓出來）
  const typeCache = new Map();
  const retsetCache = new Map();

  async function columnTypes(table){
    if(typeCache.has(table)) return typeCache.get(table);
    const r = await db.query(`select column_name, udt_name from information_schema.columns where table_schema='public' and table_name=$1`, [table]);
    const m = Object.fromEntries(r.rows.map(x => [x.column_name, x.udt_name]));
    typeCache.set(table, m); return m;
  }
  function encode(val, udt){
    if(val === undefined) return null;
    if(udt === 'jsonb' || udt === 'json') return val === null ? null : JSON.stringify(val);
    return val;
  }
  function wrapError(e){ return { code: e.code || 'XX000', message: e.message, details: e.detail || null }; }

  function createClient(_url, _key, opts = {}){
    const auth = (((opts.global || {}).headers || {}).Authorization || '');
    const m = /^Bearer student:(.+)$/.exec(auth);
    const who = () => m ? STUDENT(m[1]) : (session ? ADMIN : ANON);

    class Query {
      constructor(table){ this.table = table; this.op = 'select'; this.where = []; this.params = []; this.cols = '*'; this.returning = false; this._order = []; this._single = false; this._limit = null; }
      _p(v){ this.params.push(v); return `$${this.params.length}`; }
      select(cols='*'){ if(this.op === 'select') this.cols = cols; else { this.returning = true; this.cols = cols; } return this; }
      insert(v){ this.op = 'insert'; this.values = v; return this; }
      update(v){ this.op = 'update'; this.values = v; return this; }
      upsert(v, o={}){ this.op = 'upsert'; this.values = v; this.onConflict = o.onConflict || 'id'; return this; }
      delete(){ this.op = 'delete'; return this; }
      eq(c,v){ this.where.push([c,'=',v]); return this; }
      neq(c,v){ this.where.push([c,'<>',v]); return this; }
      gt(c,v){ this.where.push([c,'>',v]); return this; }
      gte(c,v){ this.where.push([c,'>=',v]); return this; }
      lt(c,v){ this.where.push([c,'<',v]); return this; }
      lte(c,v){ this.where.push([c,'<=',v]); return this; }
      in(c,arr){ this.where.push([c,'in',arr]); return this; }
      is(c,v){ this.where.push([c, v===null ? 'is null' : '=', v]); return this; }
      not(c,op,v){ if(op==='is' && v===null) this.where.push([c,'is not null']); else throw new Error('not() unsupported'); return this; }
      order(c,o={}){ this._order.push(`${ident(c)} ${o.ascending===false?'desc':'asc'} nulls ${o.nullsFirst?'first':'last'}`); return this; }
      limit(n){ this._limit = n; return this; }
      single(){ this._single = true; return this; }
      then(res, rej){ return this._run().then(res, rej); }

      _whereSql(){
        if(!this.where.length) return '';
        return ' where ' + this.where.map(([c,op,v]) => {
          if(op === 'is null' || op === 'is not null') return `${ident(c)} ${op}`;
          if(op === 'in') return `${ident(c)}::text = any(${this._p(v.map(String))}::text[])`;
          return `${ident(c)}::text ${op} ${this._p(v === null ? null : String(v))}::text`;
        }).join(' and ');
      }
      _proj(alias='t'){
        if(this.cols === '*' ) return `to_jsonb(${alias})`;
        const cols = this.cols.split(',').map(s=>s.trim()).filter(Boolean);
        return `jsonb_build_object(${cols.map(c=>`'${c}', ${alias}.${ident(c)}`).join(', ')})`;
      }
      async _run(){
        try{
          const types = await columnTypes(this.table);   // 必須在交易外查，PGlite 同時只允許一個交易持有連線
          const rows = await asRole(db, who(), async (tx) => {
            const T = `public.${ident(this.table)}`;
            let sql;
            if(this.op === 'select'){
              sql = `select ${this._proj()} as r from ${T} t${this._whereSql()}${this._order.length ? ' order by ' + this._order.join(', ') : ''}${this._limit ? ' limit ' + Number(this._limit) : ''}`;
            } else if(this.op === 'insert' || this.op === 'upsert'){
              const list = Array.isArray(this.values) ? this.values : [this.values];
              const out = [];
              for(const v of list){
                const cols = Object.keys(v);
                const vals = cols.map(c => this._p(encode(v[c], types[c])));
                let q = `insert into ${T} as t (${cols.map(ident).join(',')}) values (${vals.join(',')})`;
                if(this.op === 'upsert') q += ` on conflict (${ident(this.onConflict)}) do update set ${cols.filter(c=>c!==this.onConflict).map(c=>`${ident(c)} = excluded.${ident(c)}`).join(', ')}`;
                q += ` returning ${this._proj()} as r`;
                out.push(...(await tx.query(q, this.params)).rows);
                this.params = [];
              }
              return out;
            } else if(this.op === 'update'){
              const sets = Object.keys(this.values).map(c => `${ident(c)} = ${this._p(encode(this.values[c], types[c]))}`);
              sql = `update ${T} as t set ${sets.join(', ')}${this._whereSql()} returning ${this._proj()} as r`;
            } else {
              sql = `delete from ${T} as t${this._whereSql()} returning ${this._proj()} as r`;
            }
            return (await tx.query(sql, this.params)).rows;
          });
          const data = rows.map(r => r.r);
          if(this._single){
            if(data.length !== 1) return { data: null, error: { code: 'PGRST116', message: `expected 1 row, got ${data.length}` } };
            return { data: data[0], error: null };
          }
          return { data: (this.op === 'select' || this.returning) ? data : null, error: null };
        }catch(e){ errors.push(e.message); return { data: null, error: wrapError(e) }; }
      }
    }

    async function rpc(name, args = {}){
      try{
        if(!retsetCache.has(name)){
          const r = await db.query(`select proretset from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=$1 limit 1`, [name]);
          retsetCache.set(name, r.rows[0] ? r.rows[0].proretset : false);
        }
        const names = Object.keys(args).filter(k => args[k] !== undefined);
        const call = `public.${ident(name)}(${names.map((n,i)=>`${n} => $${i+1}`).join(', ')})`;
        const sql = retsetCache.get(name)
          ? `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as r from ${call} x`
          : `select to_jsonb(${call}) as r`;
        const vals = names.map(n => (args[n] !== null && typeof args[n] === 'object' && !Array.isArray(args[n])) ? JSON.stringify(args[n]) : args[n]);
        const rows = await asRole(db, who(), tx => tx.query(sql, vals));
        return { data: rows.rows[0].r, error: null };
      }catch(e){ errors.push(e.message); return { data: null, error: wrapError(e) }; }
    }

    return {
      from: (t) => new Query(t),
      rpc,
      auth: {
        getSession: async () => ({ data: { session } }),
        getUser: async () => ({ data: { user: session ? { id: ADMIN.claims.sub } : null } }),
        signInWithPassword: async () => { session = { user: { id: ADMIN.claims.sub } }; return { error: null }; },
        signOut: async () => { session = null; return { error: null }; },
        updateUser: async () => ({ error: null }),
        resetPasswordForEmail: async () => ({ error: null })
      },
      storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: (p) => ({ data: { publicUrl: `https://storage.test/${p}` } }) }) }
    };
  }
  return { createClient, errors, login: () => { session = { user: { id: ADMIN.claims.sub } }; } };
}

module.exports = { makeShim };
