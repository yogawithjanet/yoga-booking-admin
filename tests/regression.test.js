'use strict';
// 副作用檢查：這次的修改有沒有影響到以前的功能
//   1. 新舊版畫面比對：同一份擬真資料，舊版（修改前）與新版逐頁渲染，畫面上的文字 / 按鈕 / 欄位必須完全相同
//   2. 舊功能實際操作：沒有改到的後台功能逐一執行，確認資料真的寫入、沒有被權限擋下
// 兩者都在「第一階段」與「第二階段」兩種權限下執行，並記錄所有資料庫錯誤（原程式常把錯誤吞掉只顯示空白）。
process.env.TZ = 'Asia/Taipei';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createDb } = require('./pg');
const { loadApp, frontAvailable, FRONT_HTML } = require('./load-app');
const { id, UID, OTHER, T1, B1, baseSeed, booking } = require('./fixtures');

// 修改前的版本（這次修正合併之前的最後一個 commit）
const OLD = { front: { repo: path.dirname(FRONT_HTML), commit: '67dd777' }, admin: { repo: path.resolve(__dirname, '..'), commit: '4ca3a75' } };
function oldHtml(kind){
  try{
    const html = execFileSync('git', ['-C', OLD[kind].repo, 'show', `${OLD[kind].commit}:index.html`], { encoding:'utf8', stdio:['ignore','pipe','ignore'] });
    const file = path.join(os.tmpdir(), `yoga-${kind}-old-${OLD[kind].commit}.html`);
    fs.writeFileSync(file, html);
    return file;
  }catch(_){ return null; }
}
const T2 = id('template-T2');

function richSeed(){
  return baseSeed({
    store_settings: ss => ss.map(s => ({ ...s, available_tags:['初學','進階'], tag_colors:{'初學':2},
      announcement_enabled:true, announcement_title:'中秋停課', announcement_content:'10/6 停課一天', about_text:'我們的教室介紹',
      about_links:[{label:'Instagram', url:'https://instagram.com/x'}], registration_form_status:'published', edit_profile_note:'請確認資料' })),
    teachers: ts => [...ts, { id:id('teacher-2'), name:'Amy', specialty:'伸展', phone:'0912', created_at:'2026-02-01T00:00:00Z' }],
    class_templates: ts => [...ts, { id:T2, title:'晨間伸展', teacher:'Amy', time:'08:10', duration:60, cap:8, weekdays:['四','六'], active:true, description:'介紹文字', location:'忠孝教室', start_date:'2026-08-01', end_date:null, created_at:'2026-01-02T00:00:00Z' }],
    class_overrides: [
      { id:id('ov-cancel'), type:'cancel', date:'2026-10-06', class_template_id:T1 },
      { id:id('ov-mod'), type:'modify', date:'2026-10-13', class_template_id:T1, title:'進階瑜珈', teacher:'蓁尼', time:'19:00', cap:4, location:'', description:'' },
      { id:id('ov-extra'), type:'extra', date:'2026-10-03', title:'中秋特別班', teacher:'Amy', time:'10:00', cap:8, location:'大安', description:'特別課介紹' } ],
    registration_questions: [
      { id:id('q1'), question:'生日', type:'date', sort_order:0, active:true, required:false, options:[] },
      { id:id('q2'), question:'年紀', type:'text', sort_order:1, active:true, required:false, options:[] },
      { id:id('q3'), question:'有沒有瑜珈經驗？', type:'choice', sort_order:2, active:true, required:true, options:['有','沒有'] },
      { id:id('q4'), question:'想加強哪裡？', type:'multichoice', sort_order:3, active:true, required:false, options:['肩頸','腰背','核心'] },
      { id:id('q5'), question:'以下資料只有老師看得到', type:'note', sort_order:4, active:true, required:false, options:[] } ],
    members: ms => ms.map(m => m.line_user_id===UID ? { ...m, tags:['初學'], registration_submitted_at:'2026-09-01T00:00:00Z', registration_name:'王小美', registration_contact:'a@b.c',
      registration_answers:{ [id('q3')]:'有', [id('q4')]:['肩頸','核心'], [id('q1')]:'1990-01-01' }, remaining_credits:7, total_credits:10 } : { ...m, tags:['進階'] }),
    credit_batches: [
      { id:B1, line_user_id:UID, amount:8, remaining:5, expires_at:'2026-12-31', created_at:'2026-08-01T00:00:00Z' },
      { id:id('b-exp'), line_user_id:UID, amount:2, remaining:2, expires_at:'2026-09-01', created_at:'2026-06-01T00:00:00Z' },
      { id:id('b-other'), line_user_id:OTHER, amount:5, remaining:4, expires_at:null, created_at:'2026-08-05T00:00:00Z' } ],
    bookings: [
      booking({ id:id('bk-past'), class_key:`2026-9-22_${T1}`, class_date:'9/22 (週二)', class_date_iso:'2026-09-22' }),
      booking({ id:id('bk-future') }),
      booking({ id:id('bk-extra'), class_key:`2026-10-3_extra_${id('ov-extra')}`, class_template_id:null, class_title:'中秋特別班', class_date:'10/3 (週六)', class_date_iso:'2026-10-03', class_time:'10:00', teacher:'Amy', cap:8 }),
      booking({ id:id('bk-cancel'), class_key:`2026-9-15_${T1}`, class_date:'9/15 (週二)', class_date_iso:'2026-09-15', status:'cancelled' }),
      booking({ id:id('bk-other'), line_user_id:OTHER, credit_batch_id:id('b-other'), class_key:`2026-10-1_${T2}`, class_template_id:T2, class_title:'晨間伸展', class_date:'10/1 (週四)', class_date_iso:'2026-10-01', class_time:'08:10', teacher:'Amy', cap:8 }) ],
    transactions: [
      { id:id('tx1'), type:'income', amount:3000, line_user_id:UID, credit_batch_id:B1, occurred_at:'2026-09-05', note:'10堂' },
      { id:id('tx2'), type:'expense', amount:800, occurred_at:'2026-09-10', note:'場地', cost_type:'fixed' },
      { id:id('tx3'), type:'income', amount:1500, line_user_id:OTHER, occurred_at:'2026-08-20', note:'5堂' } ]
  });
}

// 把畫面 HTML 轉成「每一行可見文字」
const visibleText = (html) => (html||'').replace(/<style[\s\S]*?<\/style>/g,'').replace(/<[^>]+>/g,'\n').replace(/&nbsp;/g,' ')
  .split('\n').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);

async function renderAdmin(htmlPath, migrate){
  const pg = await createDb({ seed: richSeed(), migrate });
  const app = loadApp('admin', { htmlPath, pg, confirmAnswer:false });
  app.loginAdmin();
  await app.call('loadAdminState');
  const pages = {};
  const grab = () => visibleText(app.el('mainArea').innerHTML);
  for(const p of ['overview','announcement','about','members','registrants','registration','classes','roster','popularity','teachers','teacherlog','cashflow']){
    await app.call('navigateToPage', p);
    if(p==='cashflow') app.eval('financeAmountVisible=true; render()');
    if(p==='classes') app.eval("selectClassesCalendarDate('2026-10-13')");
    if(p==='roster') await app.call('selectRosterCalendarDate','2026-09-29');
    pages[p] = grab();
  }
  await app.call('navigateToPage','members');
  await app.call('openMemberDetail', UID);
  pages['member-detail'] = grab();
  return { pages, errors: app.dbErrors };
}

async function renderFront(htmlPath, migrate){
  const pg = await createDb({ seed: richSeed(), migrate });
  const app = loadApp('front', { htmlPath, pg, liffProfile:{ userId:UID, displayName:'測試學員', pictureUrl:null } });
  await app.init();
  const pages = {};
  const main = () => visibleText(app.el('mainContent').innerHTML);
  pages['堂數卡'] = [`已預約 ${app.el('creditBooked').textContent}`, `剩餘 ${app.el('creditRemaining').textContent}`];
  app.eval("activeTab='book'; selectedDateKey='2026-9-29'; render()"); pages['預約：一般課 9/29'] = main();
  app.eval("selectedDateKey='2026-10-3'; render()");                  pages['預約：特別課 10/3'] = main();
  app.eval("selectedDateKey='2026-10-13'; render()");                 pages['預約：單日修改 10/13'] = main();
  app.eval("activeTab='mine'; mineSubTab='upcoming'; render()");      pages['我的課程：已預約'] = main();
  app.eval("mineSubTab='completed'; completedFilterYear=2026; completedFilterMonth=9; render()"); pages['我的課程：已完成'] = main();
  app.eval("activeTab='creditExpiry'; render()");                     pages['堂數期限'] = main();
  app.eval("activeTab='about'; render()");                            pages['關於我們'] = main();
  app.eval("openRegistrationScreen(true)");                           pages['會員資料設定'] = visibleText(app.el('registrationContent').innerHTML);
  return { pages, errors: app.dbErrors };
}

function lineDiff(a, b){
  const count = (arr) => arr.reduce((m,x)=>(m[x]=(m[x]||0)+1, m), {});
  const ca = count(a), cb = count(b);
  return {
    onlyOld: Object.keys(ca).filter(k => (ca[k]||0) > (cb[k]||0)),
    onlyNew: Object.keys(cb).filter(k => (cb[k]||0) > (ca[k]||0))
  };
}

async function compareVersions(t, kind, render){
  const oldFile = oldHtml(kind);
  if(!oldFile){ t.skip(`取不到修改前的版本（${OLD[kind].commit}），需要完整的 git 歷史`); return; }
  const newFile = kind === 'front' ? FRONT_HTML : path.join(__dirname, '..', 'index.html');
  const oldR = await render(oldFile, 'phase1');   // 舊版只能在寬鬆權限下運作
  const newP1 = await render(newFile, 'phase1');
  const newP2 = await render(newFile, true);
  await t.test('新版在第一階段權限下沒有資料庫錯誤', () => assert.deepEqual([...new Set(newP1.errors)], []));
  await t.test('新版在第二階段權限下沒有資料庫錯誤', () => assert.deepEqual([...new Set(newP2.errors)], []));
  for(const page of Object.keys(oldR.pages)){
    await t.test(`畫面相同：${page}`, () => {
      assert.ok(oldR.pages[page].length > 0, '舊版畫面不應為空');
      const d = lineDiff(oldR.pages[page], newP2.pages[page] || []);
      assert.deepEqual(d, { onlyOld: [], onlyNew: [] }, `新舊版畫面不同\n只在舊版：${JSON.stringify(d.onlyOld)}\n只在新版：${JSON.stringify(d.onlyNew)}`);
      assert.deepEqual(newP1.pages[page], newP2.pages[page], '新版在第一 / 第二階段權限下畫面不同');
    });
  }
}

/* ================= 1. 新舊版畫面比對 ================= */
test('副作用｜前台：新舊版每個畫面內容相同', { skip: !frontAvailable() && '找不到前台 index.html' }, (t) => compareVersions(t, 'front', renderFront));
test('副作用｜後台：新舊版每個頁面內容相同', (t) => compareVersions(t, 'admin', renderAdmin));

/* ================= 2. 沒改到的後台舊功能實際操作 ================= */
for(const [label, migrate] of [['第一階段權限', 'phase1'], ['第二階段權限', true]]){
  test(`副作用｜後台舊功能實際操作（${label}）`, async (t) => {
    const pg = await createDb({ migrate, seed: baseSeed({
      store_settings: ss=>ss.map(s=>({...s, available_tags:['初學']})),
      members: ms=>ms.map(m=>m.line_user_id===UID?{...m, tags:['初學'], registration_submitted_at:'2026-09-01T00:00:00Z', registration_name:'王'}:m),
      transactions:[{ id:id('tx'), type:'income', amount:100, occurred_at:'2026-09-01', note:'x', line_user_id:UID }] }) });
    const app = loadApp('admin', { pg, confirmAnswer:true });
    app.loginAdmin(); await app.call('loadAdminState');
    const set = (k,v) => app.setInput(k,v);
    const value = async (sql) => { const r = (await pg.query(sql)).rows[0]; return r ? String(Object.values(r)[0]) : null; };
    const step = (name, run, sql, expected) => t.test(name, async () => {
      const before = app.dbErrors.length;
      await run();
      assert.deepEqual(app.dbErrors.slice(before), [], '不應有資料庫錯誤');
      if(sql) assert.equal(await value(sql), String(expected));
    });

    await step('店名儲存', async()=>{ set('stName','新店名'); await app.call('saveStore'); }, `select name from store_settings`, '新店名');
    await step('主題切換', ()=>app.call('pickTheme','ocean'), `select theme from store_settings`, 'ocean');
    await step('公告開關', ()=>app.call('toggleAnnouncementEnabled'), `select announcement_enabled::text from store_settings`, 'true');
    await step('公告儲存', async()=>{ set('annTitle','標題'); set('annContent','內容'); await app.call('saveAnnouncement'); }, `select announcement_title from store_settings`, '標題');
    await step('關於我們文字', async()=>{ set('aboutText','介紹'); await app.call('saveAboutContent'); }, `select about_text from store_settings`, '介紹');
    await step('關於我們連結', async()=>{ app.call('addAboutLink'); set('aboutLinkLabel0','IG'); set('aboutLinkUrl0','https://ig.com'); await app.call('saveOneAboutLink',0); }, `select about_links->0->>'label' from store_settings`, 'IG');
    await step('新增標籤', async()=>{ set('newAvailableTagInput','進階'); await app.call('addAvailableTag'); }, `select array_length(available_tags,1) from store_settings`, 2);
    await step('學員加標籤', ()=>app.call('addMemberTagFromSelect', OTHER, '進階'), `select tags[1] from members where line_user_id='${OTHER}'`, '進階');
    await step('標籤改名（同步到學員）', ()=>app.call('saveTagRename','初學','新手'), `select tags[1] from members where line_user_id='${UID}'`, '新手');
    await step('標籤配色', ()=>app.call('setTagColor','新手',3), `select tag_colors->>'新手' from store_settings`, 3);
    await step('學員移除標籤', ()=>app.call('removeMemberTag', OTHER, '進階'), `select coalesce(array_length(tags,1),0) from members where line_user_id='${OTHER}'`, 0);
    await step('新增老師', async()=>{ set('ntName','Amy'); set('ntPhone','09'); set('ntSpecialty','伸展'); await app.call('addTeacher'); }, `select count(*) from teachers`, 2);
    await step('新增課程範本', async()=>{ set('ncTitle','晚間'); set('ncTeacher','蓁尼'); set('ncLocation',''); set('ncTime','19:00'); set('ncDuration','60'); set('ncCap','10'); app.queryAll['#ncDays .wd-chip.on']=[{dataset:{w:'三'}}]; set('ncDescription',''); set('ncStartDate','2026-09-01'); set('ncEndDate',''); await app.call('saveClassForm'); }, `select count(*) from class_templates`, 2);
    await step('編輯課程範本', async()=>{ app.eval(`editingClassId='${T1}'`); set('ncTitle','基礎瑜珈2'); set('ncCap','7'); app.queryAll['#ncDays .wd-chip.on']=[{dataset:{w:'二'}}]; await app.call('saveClassForm'); }, `select title from class_templates where id='${T1}'`, '基礎瑜珈2');
    await step('開放預約區間', async()=>{ set('bwStart','2026-10-01'); set('bwEnd','2026-10-31'); await app.call('saveBookingWindow'); }, `select booking_open_end::text from notify_settings`, '2026-10-31');
    await step('取消時限', ()=>app.call('updateNotify','cancel_deadline_minutes',120), `select cancel_deadline_minutes from notify_settings`, 120);
    await step('新增註冊題目', async()=>{ set('newRegQText','經驗?'); set('newRegQType','text'); app.setChecked('newRegQRequired',true); await app.call('submitNewRegQuestion'); }, `select count(*) from registration_questions`, 1);
    const qid = async () => (await pg.query('select id from registration_questions limit 1')).rows[0].id;
    await step('題目必填切換', async()=>app.call('toggleRegQuestionRequired', await qid()), `select required::text from registration_questions`, 'false');
    await step('題目顯示切換', async()=>app.call('toggleRegQuestionActive', await qid()), `select active::text from registration_questions`, 'false');
    await step('題目排序', ()=>app.call('moveRegField', 'name', 1), `select registration_field_order->>0 from store_settings`, 'contact');
    await step('姓名欄顯示切換', ()=>app.call('toggleRegistrationShowName'), `select registration_show_name::text from store_settings`, 'false');
    await step('註冊表單啟用', ()=>app.call('publishRegistrationForm'), `select registration_form_status from store_settings`, 'published');
    await step('編輯資料說明文字', async()=>{ set('editProfileNoteInput','請確認'); await app.call('saveEditProfileNote'); }, `select edit_profile_note from store_settings`, '請確認');
    await step('刪除註冊題目', async()=>app.call('deleteRegQuestion', await qid()), `select count(*) from registration_questions`, 0);
    await step('清除學員註冊資料', ()=>app.call('clearMemberRegistration', UID), `select (registration_submitted_at is null)::text from members where line_user_id='${UID}'`, 'true');
    await step('編輯收支', async()=>{ await app.call('loadCashflowData'); const tx=id('tx'); set(`txEditType-${tx}`,'income'); set(`txEditAmount-${tx}`,'250'); set(`txEditDate-${tx}`,'2026-09-02'); set(`txEditMember-${tx}`,UID); set(`txEditNote-${tx}`,'改'); await app.call('saveEditTransaction', tx); }, `select amount::int from transactions where id='${id('tx')}'`, 250);
    await step('刪除收支', ()=>app.call('deleteTransactionRow', id('tx')), `select count(*) from transactions where id='${id('tx')}'`, 0);
    await step('刪除標籤（同步到學員）', async()=>{ const p = app.call('removeAvailableTag','新手'); app.call('resolveAdminConfirm', true); await p; }, `select coalesce(array_length(tags,1),0) from members where line_user_id='${UID}'`, 0);
    await step('刪除老師', async()=>{ const tid=(await pg.query("select id from teachers where name='Amy'")).rows[0].id; await app.call('removeTeacher', tid); }, `select count(*) from teachers`, 1);
    await step('每日名單切換月份', ()=>app.call('changeRosterCalendarMonth', 1));
    await step('老師教學紀錄', ()=>app.call('onTeacherLogChange','蓁尼'));
  });
}
