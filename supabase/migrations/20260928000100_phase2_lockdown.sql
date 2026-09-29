-- =====================================================================================
-- 第二階段：收緊權限（在新版前台 + 後台 + line-auth Edge Function 都上線、並驗證正常之後才執行）
--
-- ⚠️ 執行後舊版前台 / 後台會無法寫入（這正是要修的漏洞），所以務必確認新版已經部署。
-- ✅ 本檔同樣不修改任何既有資料列：只改權限、policy、公開 RPC 的回傳欄位，並掛上堂數快取 trigger。
--    members.remaining_credits / total_credits 從此只在該學員的批次有異動時才由 trigger 重算；
--    新版程式讀的是 member_credit_summary，不再讀這兩個欄位。
-- 回滾：supabase/rollback/phase2_rollback.sql（恢復為第一階段狀態）
-- =====================================================================================

drop trigger if exists sync_member_credits on public.credit_batches;
create trigger sync_member_credits after insert or update or delete on public.credit_batches
  for each row execute function app.batches_changed();

-- =====================================================================================
-- 公開 RPC（前台未登入前也要用到的設定）：只回傳前台需要的欄位
-- =====================================================================================
drop function if exists public.get_store_public_settings();
create function public.get_store_public_settings() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'name', s.name, 'theme', s.theme,
    'registration_form_status', s.registration_form_status, 'registration_field_order', s.registration_field_order,
    'registration_show_name', s.registration_show_name, 'registration_show_contact', s.registration_show_contact,
    'registration_name_required', s.registration_name_required, 'registration_contact_required', s.registration_contact_required,
    'announcement_enabled', s.announcement_enabled, 'announcement_title', s.announcement_title,
    'announcement_content', s.announcement_content, 'announcement_image', s.announcement_image,
    'edit_profile_note', s.edit_profile_note, 'about_image', s.about_image, 'about_text', s.about_text, 'about_links', s.about_links)
  from public.store_settings s where s.id = 1 $$;

drop function if exists public.get_booking_rules();
create function public.get_booking_rules() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('booking_window_days', n.booking_window_days, 'cancel_deadline_minutes', n.cancel_deadline_minutes,
                            'booking_open_start', n.booking_open_start, 'booking_open_end', n.booking_open_end,
                            'today', app.today())
  from public.notify_settings n where n.id = 1 $$;

drop function if exists public.get_class_seat_counts();
create function public.get_class_seat_counts() returns table(class_key text, booked_count bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.class_key, count(*) from public.bookings b
   where b.status = 'active' and b.class_date_iso::date >= app.today() group by b.class_key $$;

-- =====================================================================================
-- 權限（RLS）：先清掉所有舊 policy，再依角色重建
-- =====================================================================================
do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
            where schemaname = 'public' and tablename in ('members','bookings','credit_batches','transactions','store_settings','notify_settings',
              'class_templates','class_overrides','teachers','registration_questions','admin_users','credit_ledger','audit_log') loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['members','bookings','credit_batches','transactions','store_settings','notify_settings',
    'class_templates','class_overrides','teachers','registration_questions','admin_users','credit_ledger','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- 管理員：一般設定表可直接讀寫（非金錢相關）
do $$
declare t text;
begin
  foreach t in array array['store_settings','notify_settings','class_templates','class_overrides','teachers','registration_questions','members'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (app.is_admin()) with check (app.is_admin())', t);
  end loop;
end $$;
-- members 管理員可改標籤 / 清除註冊資料；堂數欄位由 trigger 維護，直接改會被下一次 trigger 覆寫
-- 金錢相關表：管理員只能讀；寫入只能透過 RPC
grant select on public.bookings, public.credit_batches, public.transactions, public.credit_ledger, public.audit_log, public.admin_users to authenticated;
grant update (type, amount, note, occurred_at, cost_type, line_user_id), delete on public.transactions to authenticated;
create policy admin_read on public.bookings        for select to authenticated using (app.is_admin());
create policy admin_read on public.credit_batches  for select to authenticated using (app.is_admin());
create policy admin_read on public.transactions    for select to authenticated using (app.is_admin());
create policy admin_edit on public.transactions    for update to authenticated using (app.is_admin()) with check (app.is_admin() and amount > 0);
create policy admin_del  on public.transactions    for delete to authenticated using (app.is_admin());
create policy admin_read on public.credit_ledger   for select to authenticated using (app.is_admin());
create policy admin_read on public.audit_log       for select to authenticated using (app.is_admin());
create policy admin_read on public.admin_users     for select to authenticated using (app.is_admin());

-- 學員：只能讀自己的資料；課表與啟用中的註冊問題可讀
create policy student_self on public.members        for select to authenticated using (line_user_id = app.line_user_id());
create policy student_self on public.bookings       for select to authenticated using (line_user_id = app.line_user_id());
create policy student_self on public.credit_batches for select to authenticated using (line_user_id = app.line_user_id());
create policy student_read on public.class_templates for select to authenticated using (app.line_user_id() is not null and active);
create policy student_read on public.class_overrides for select to authenticated using (app.line_user_id() is not null);
create policy student_read on public.registration_questions for select to authenticated using (app.line_user_id() is not null and active);

grant select on public.member_credit_summary to authenticated;
-- anon（沒有登入 / 沒有經過 LINE 驗證）什麼表都不能碰，只能呼叫公開 RPC
