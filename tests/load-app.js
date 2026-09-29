'use strict';
// 把前台 / 後台 index.html 的程式碼（本地 <script src> + inline <script>）載進 Node vm sandbox 執行。
// DOM / LIFF / localStorage 用最小 stub；Date 換成可控時鐘；Supabase 換成打在 PGlite 上的轉接層（supabase-shim.js），
// 所以測試呼叫的是真正的 bookClass、cancelBooking、adminBookFlow… 而且資料庫的 RLS / RPC 都真的生效。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeShim } = require('./supabase-shim');
const { setNow: setDbNow } = require('./pg');

// 後台 HTML 在本 repo；前台 HTML 預設找同層的 ../yoga-booking（兩個 repo 並排 clone），或用 YOGA_FRONT_HTML 指定
const ADMIN_ROOT = path.resolve(__dirname, '..');
const FRONT_HTML = process.env.YOGA_FRONT_HTML || path.resolve(ADMIN_ROOT, '..', 'yoga-booking', 'index.html');
const FILES = { front: FRONT_HTML, admin: path.join(ADMIN_ROOT, 'index.html') };
function frontAvailable(){ return fs.existsSync(FRONT_HTML); }

function extractScripts(html, baseDir){
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m, src = '';
  while((m = re.exec(html))){
    const attrs = m[1]; const srcAttr = /\bsrc="([^"]+)"/.exec(attrs);
    if(srcAttr){
      const ref = srcAttr[1];
      if(/^https?:/.test(ref) || ref === 'config.js') continue; // CDN 與 config.js 由 sandbox 提供
      src += fs.readFileSync(path.join(baseDir, ref), 'utf8') + '\n';
    } else {
      src += m[2] + '\n';
    }
  }
  const start = src.indexOf('(async function init(){');
  if(start<0) throw new Error('init IIFE not found');
  const end = src.lastIndexOf('})();');
  return src.slice(0,start) + 'async function __appInit(){' + src.slice(start+'(async function init(){'.length, end) + '}' + src.slice(end+'})();'.length);
}

function makeElement(id){
  const classes = new Set();
  const el = {
    id, value:'', textContent:'', innerHTML:'', checked:false, disabled:false, files:[], children:[], dataset:{}, style:{},
    nextElementSibling:null, placeholder:'', src:'',
    classList:{ add:(...c)=>c.forEach(x=>classes.add(x)), remove:(...c)=>c.forEach(x=>classes.delete(x)),
      toggle:(c,force)=>{ const on = force===undefined ? !classes.has(c) : !!force; on?classes.add(c):classes.delete(c); return on; },
      contains:c=>classes.has(c), _set:classes },
    addEventListener(){}, removeEventListener(){}, appendChild(){}, scrollIntoView(){}, focus(){}, click(){}, remove(){}, blur(){},
    setAttribute(){}, getAttribute(){ return null; }, insertAdjacentHTML(){},
    querySelector(){ return makeElement(); }, querySelectorAll(){ return []; }, closest(){ return makeElement(); }
  };
  return el;
}

function loadApp(kind, { htmlPath, pg, now='2026-09-28T10:00:00', liffProfile=null, confirmAnswer=true } = {}){
  if(!FILES[kind]) throw new Error('kind must be front|admin');
  // htmlPath：指定其他版本的 index.html（例如舊版，用來做新舊版畫面比對）
  const file = htmlPath || FILES[kind];
  const html = fs.readFileSync(file,'utf8');
  const src = extractScripts(html, path.dirname(file));

  const clock = { now: new Date(now).getTime() };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a){ if(a.length===0) super(clock.now); else super(...a); }
    static now(){ return clock.now; }
  }

  const elements = new Map();
  const queryAll = {};
  const confirms = [];
  const toasts = [];
  const localStore = new Map();
  const shim = makeShim(pg);

  const document = {
    getElementById(id){ if(!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); },
    querySelector(sel){ return sel.includes(':checked') ? null : makeElement(); },
    querySelectorAll(sel){ return queryAll[sel] || []; },
    createElement(){ return makeElement(); },
    addEventListener(){},
    body: makeElement('body'),
    documentElement: { style:{ setProperty(){} } }
  };

  const sandbox = {
    console, document, Date: FakeDate, JSON, Math, Promise, Set, Map,
    setTimeout: ()=>0, clearTimeout(){},
    confirm: (msg)=>{ confirms.push(msg); return typeof confirmAnswer==='function' ? confirmAnswer(msg) : confirmAnswer; },
    alert(){},
    location: { reload(){} },
    localStorage: { getItem:k=>localStore.has(k)?localStore.get(k):null, setItem:(k,v)=>localStore.set(k,String(v)), removeItem:k=>localStore.delete(k) },
    FileReader: function(){ this.readAsDataURL=()=>{}; },
    APP_CONFIG: { SUPABASE_URL:'http://fake', SUPABASE_ANON_KEY:'fake', LIFF_ID:'fake' },
    supabase: { createClient: shim.createClient },
    // 模擬 line-auth Edge Function：驗證通過就回傳學員身分的 token（轉接層看得懂的格式）
    fetch: async (url, init) => ({ ok: !!liffProfile, status: liffProfile ? 200 : 401,
      json: async () => ({ accessToken: `student:${liffProfile.userId}`, profile: liffProfile }) }),
    liff: {
      init: async()=>{ if(!liffProfile) throw new Error('no liff in test'); },
      isLoggedIn: ()=>true, login(){}, getIDToken: ()=>'fake-id-token', getProfile: async()=>liffProfile
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: `${kind}-index.html.js` });
  ctx.__toasts = toasts;
  vm.runInContext(`(function(){ const _o = showToast; showToast = function(m){ __toasts.push(m); return _o(m); }; })()`, ctx);

  return {
    ctx, pg, confirms, toasts, elements, queryAll, dbErrors: shim.errors,
    eval: (code)=>vm.runInContext(code, ctx),
    call: (fn, ...args)=>{ ctx.__args = args; return vm.runInContext(`${fn}(...__args)`, ctx); },
    get: (expr)=>vm.runInContext(expr, ctx),
    setNow: async (iso)=>{ clock.now = new RealDate(iso).getTime(); await setDbNow(pg, iso); },
    setInput: (id, value)=>{ document.getElementById(id).value = String(value); },
    setChecked: (id, v)=>{ document.getElementById(id).checked = !!v; },
    el: (id)=>document.getElementById(id),
    loginAdmin: ()=>shim.login(),
    init: ()=>vm.runInContext('__appInit()', ctx)
  };
}

module.exports = { loadApp, frontAvailable, FRONT_HTML };
