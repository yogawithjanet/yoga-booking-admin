'use strict';
// 共用測試資料。時間基準：2026-09-28（一）10:00 台北時間。
// T1 = 每週二 20:00 的固定課「基礎瑜珈」，容量 6；最近一次上課日 2026-09-29（二）。
const crypto = require('crypto');
// 把可讀名稱轉成固定的 UUID，測試裡可以寫 id('bk1') 而不用記一串亂碼
function id(name){
  const h = crypto.createHash('sha1').update(String(name)).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
const UID = 'U_test_student';
const OTHER = 'U_other_student';
const T1 = id('template-T1');
const B1 = id('batch-B1');
const CLASS_KEY_0929 = `2026-9-29_${T1}`;

function baseSeed(over={}){
  const seed = {
    store_settings: [{ id:1, name:'測試教室', theme:'sage', registration_form_status:'draft', announcement_enabled:false,
      available_tags:[], tag_colors:{}, about_links:[], registration_field_order:[] }],
    notify_settings: [{ id:1, cancel_deadline_minutes:60, booking_window_days:30, booking_open_start:null, booking_open_end:null,
      reminder_enabled:true, reminder_time:'18:00', reminder_template:'', low_credit_enabled:true, low_credit_threshold:2 }],
    teachers: [{ id:id('teacher-1'), name:'蓁尼', specialty:'—', phone:'—', created_at:'2026-01-01T00:00:00Z' }],
    class_templates: [{ id:T1, title:'基礎瑜珈', teacher:'蓁尼', time:'20:00', duration:60, cap:6, weekdays:['二'], active:true,
      description:'', location:'', start_date:null, end_date:null, created_at:'2026-01-01T00:00:00Z' }],
    class_overrides: [],
    registration_questions: [],
    members: [
      { line_user_id:UID, display_name:'測試學員', picture_url:null, remaining_credits:5, total_credits:5, tags:[],
        registration_submitted_at:null, registration_name:null, registration_contact:null, registration_answers:{},
        created_at:'2026-08-01T00:00:00Z', updated_at:'2026-08-01T00:00:00Z' },
      { line_user_id:OTHER, display_name:'別的學員', picture_url:null, remaining_credits:0, total_credits:0, tags:[],
        registration_submitted_at:null, registration_answers:{}, created_at:'2026-08-01T00:00:00Z', updated_at:'2026-08-01T00:00:00Z' }
    ],
    credit_batches: [
      { id:B1, line_user_id:UID, amount:5, remaining:5, expires_at:'2026-12-31', created_at:'2026-08-01T00:00:00Z' }
    ],
    bookings: [],
    transactions: []
  };
  for(const [k,v] of Object.entries(over)) seed[k] = typeof v==='function' ? v(seed[k]) : v;
  return seed;
}

let seq = 0;
function booking(over={}){
  const { id: givenId, ...rest } = over;
  return { id: givenId || id(`booking-${++seq}`), line_user_id:UID, class_key:CLASS_KEY_0929, class_template_id:T1,
    class_title:'基礎瑜珈', class_date:'9/29 (週二)', class_date_iso:'2026-09-29', class_time:'20:00', teacher:'蓁尼', cap:6,
    status:'active', credit_batch_id:B1, created_at:'2026-09-20T00:00:00Z', ...rest };
}

module.exports = { id, UID, OTHER, T1, B1, CLASS_KEY_0929, baseSeed, booking };
