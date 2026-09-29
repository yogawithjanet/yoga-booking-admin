-- 上線前檢查（純唯讀，只有 SELECT）。在 Supabase SQL Editor 執行，看結果再決定是否跑 migration。
-- 每一段都應該回傳 0 列；有資料就表示有舊資料需要人工確認。

-- 1. 重複的 active 預約（第一階段會因此跳過建立唯一索引）
select line_user_id, class_key, count(*) as n
from public.bookings where status = 'active'
group by line_user_id, class_key having count(*) > 1;

-- 2. 批次數字不合理（會讓 remaining 約束跳過）
select id, line_user_id, amount, remaining from public.credit_batches
where remaining < 0 or amount < 0 or remaining > amount;

-- 3. 金額 <= 0 或類型不正確的收支（會讓 transactions 約束跳過）
select id, type, amount from public.transactions where amount <= 0 or type not in ('income','expense');

-- 4. 新版改用「未過期批次剩餘加總」當可用堂數。列出跟目前 members.remaining_credits 不一致的學員，
--    這些人在新版上線後看到的堂數會跟現在不同，請逐一確認哪個才對。
with t as (select (now() at time zone 'Asia/Taipei')::date as today)
select m.line_user_id, m.display_name, m.remaining_credits as current_value,
       coalesce(sum(b.remaining) filter (where b.expires_at is null or b.expires_at >= t.today), 0) as new_value
from public.members m cross join t
left join public.credit_batches b on b.line_user_id = m.line_user_id
group by m.line_user_id, m.display_name, m.remaining_credits
having m.remaining_credits <> coalesce(sum(b.remaining) filter (where b.expires_at is null or b.expires_at >= t.today), 0);

-- 5. 會被登記為管理員的 Auth 帳號（第一階段會把目前全部 Auth 使用者視為管理員）。不認識的請先刪除。
select id, email, created_at, last_sign_in_at from auth.users order by created_at;

-- 6. class_key 格式無法解析的預約（取消時限會退回用預約當時的時間）
select id, class_key from public.bookings
where class_key !~ '^\d{4}-\d{1,2}-\d{1,2}_(extra_)?[0-9a-f-]{36}$';

-- 7. 批次剩餘與實際預約是否吻合（9/15–9/17 曾以「從預約紀錄反推」修正過堂數多算的問題）。
--    新版不再每次載入時改寫堂數，而是直接以批次剩餘為準，所以上線前要確認每位學員：
--    所有批次的「原始 − 剩餘」加總 ＝ 已使用（active + completed）的預約數。應回傳 0 列。
select m.line_user_id, m.display_name,
       coalesce(b.used_by_batches, 0) as used_by_batches,
       coalesce(k.used_by_bookings, 0) as used_by_bookings
from public.members m
left join (select line_user_id, sum(amount - remaining) as used_by_batches
             from public.credit_batches where amount > 0 group by line_user_id) b on b.line_user_id = m.line_user_id
left join (select line_user_id, count(*) as used_by_bookings
             from public.bookings where status in ('active','completed') group by line_user_id) k on k.line_user_id = m.line_user_id
where coalesce(b.used_by_batches, 0) <> coalesce(k.used_by_bookings, 0);

-- 8. 日期 / 時間格式不是 YYYY-MM-DD / HH:MM 的資料（新版遇到會跳過或請學員聯繫老師，建議先修正）。應回傳 0 列。
select 'bookings' as source, id::text, class_date_iso::text as date_value, class_time as time_value from public.bookings
 where status = 'active' and (class_date_iso::text !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(class_time,'') !~ '^\d{1,2}:\d{2}(:\d{2})?$')
union all
select 'class_templates', id::text, null, time from public.class_templates where coalesce(time,'') !~ '^\d{1,2}:\d{2}(:\d{2})?$'
union all
select 'class_overrides', id::text, date::text, time from public.class_overrides
 where type in ('extra','modify') and time is not null and time !~ '^\d{1,2}:\d{2}(:\d{2})?$';
