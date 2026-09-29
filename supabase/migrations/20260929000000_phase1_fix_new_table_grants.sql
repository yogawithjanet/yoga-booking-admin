-- =====================================================================================
-- 第一階段補丁（可重複執行；不修改任何資料列，不影響舊版網站）
--
-- 原因：Supabase 會自動把 public schema 新建的表 / view 開放給 anon 與 authenticated。
-- 第一階段新建的 admin_users、credit_ledger、audit_log、member_credit_summary 因此對匿名開放讀寫，
-- 加上 Auth 開放註冊時，任何人都能把自己寫進 admin_users 變成管理員。
-- 本檔關閉匿名存取、開啟 RLS，只讓管理員讀取；寫入仍只能透過 RPC（security definer）。
-- 另外修正 complete_past_bookings 的權限判斷（原本用 current_user 判斷，在 security definer 內永遠通過）。
-- 執行後也請到 Authentication → Sign In / Providers → Email 關閉「Allow new users to sign up」。
-- =====================================================================================
revoke all on public.admin_users, public.credit_ledger, public.audit_log, public.member_credit_summary from anon;
revoke insert, update, delete, truncate on public.admin_users, public.credit_ledger, public.audit_log from authenticated;
alter table public.admin_users   enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.audit_log     enable row level security;
grant select on public.admin_users, public.credit_ledger, public.audit_log to authenticated;
drop policy if exists admin_read on public.admin_users;
drop policy if exists admin_read on public.credit_ledger;
drop policy if exists admin_read on public.audit_log;
create policy admin_read on public.admin_users   for select to authenticated using (app.is_admin());
create policy admin_read on public.credit_ledger for select to authenticated using (app.is_admin());
create policy admin_read on public.audit_log     for select to authenticated using (app.is_admin());

-- complete_past_bookings：只有管理員（或直接在資料庫執行）才能呼叫
create or replace function public.complete_past_bookings() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  -- 透過 API 呼叫時（有 JWT）必須是管理員；直接在資料庫執行（SQL Editor、pg_cron，沒有 JWT）則允許。
  -- 注意：security definer 函式內的 current_user 是函式擁有者，不能拿來判斷呼叫者。
  if coalesce(auth.jwt()->>'role', '') <> '' and not app.is_admin() then raise exception '需要管理員權限' using errcode = '42501'; end if;
  -- 只處理格式正確的日期 / 時間；格式不對的舊資料跳過（不讓整個函式失敗），可用 preflight 第 8 段找出來
  update public.bookings set status = 'completed'
   where status = 'active'
     and class_date_iso ~ '^\d{4}-\d{2}-\d{2}$'
     and coalesce(nullif(class_time,''),'00:00') ~ '^\d{1,2}:\d{2}(:\d{2})?$'
     and (class_date_iso::date + coalesce(nullif(class_time,''),'00:00')::time) < app.now_local();
  get diagnostics n = row_count;
  return n;
end $$;
