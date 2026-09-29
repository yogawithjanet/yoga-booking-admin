-- =====================================================================================
-- 第一階段（純新增，可直接在上線中的資料庫執行）
--
-- ✅ 不修改、不刪除任何既有資料列；不改任何既有表的權限 / RLS；不改既有 RPC。
--    現在線上的舊版前台 / 後台在這一步之後照常運作。
-- ✅ 只新增：admin_users、credit_ledger、audit_log 三張表；app schema 的輔助函式；member_credit_summary view；
--    新的 RPC（book_class、cancel_my_booking、admin_* …）；稽核 trigger（只寫 audit_log）；Storage bucket。
-- ✅ 加欄位 / 加約束 / 加索引都用 if not exists；舊資料不符合約束時跳過並提示，不會改資料。
--
-- 執行前請先跑 supabase/preflight/check_before_migration.sql（唯讀）看報告。
-- 第二階段（收緊權限）在新版前台 / 後台上線並驗證後才執行：20260928000100_phase2_lockdown.sql
-- =====================================================================================
create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

-- ---------- 身分 ----------
create table if not exists public.admin_users (
  user_id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);
-- 保留現有管理員：目前所有能登入後台的 Supabase Auth 帳號都視為管理員。
-- ⚠️ 執行後請到 Dashboard 檢查 admin_users，刪掉不認識的帳號，並關閉 Auth 的公開註冊（Email signups）。
insert into public.admin_users(user_id, email)
  select id, email from auth.users on conflict (user_id) do nothing;

create or replace function app.line_user_id() returns text
language sql stable as $$ select nullif(auth.jwt()->>'line_user_id', '') $$;

create or replace function app.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(auth.jwt()->>'app_role','') <> 'student'
     and exists (select 1 from public.admin_users a where a.user_id::text = auth.jwt()->>'sub')
$$;

create or replace function app.today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Taipei')::date $$;

create or replace function app.now_local() returns timestamp
language sql stable as $$ select (now() at time zone 'Asia/Taipei') $$;

create or replace function app.require_admin() returns void
language plpgsql stable as $$
begin
  if not app.is_admin() then raise exception '需要管理員權限' using errcode = '42501'; end if;
end $$;

-- 前台與後台共用的 class_key 格式：YYYY-M-D（不補零）
create or replace function app.date_key(d date) returns text
language sql immutable as $$
  select extract(year from d)::int || '-' || extract(month from d)::int || '-' || extract(day from d)::int $$;

create or replace function app.weekday_label(d date) returns text
language sql immutable as $$ select (array['日','一','二','三','四','五','六'])[extract(dow from d)::int + 1] $$;

create or replace function app.date_label(d date) returns text
language sql immutable as $$
  select extract(month from d)::int || '/' || extract(day from d)::int || ' (週' || app.weekday_label(d) || ')' $$;

-- ---------- 結構補強 ----------
alter table public.class_overrides add column if not exists class_template_id uuid;
alter table public.transactions   add column if not exists credit_batch_id uuid;

-- 一個學員同一場次只能有一筆有效預約。只在「目前沒有重複資料」時才建立索引；有重複時不改任何資料，只提示。
do $$
begin
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='bookings_one_active_per_class') then
    if exists (select 1 from public.bookings where status='active' group by line_user_id, class_key having count(*) > 1) then
      raise notice '⚠️ bookings 有重複的 active 預約，未建立唯一索引。請先用 supabase/preflight/check_before_migration.sql 查出並人工處理。';
    else
      create unique index bookings_one_active_per_class on public.bookings(line_user_id, class_key) where status='active';
    end if;
  end if;
end $$;

do $$ begin
  alter table public.credit_batches add constraint credit_batches_nonneg check (amount >= 0 and remaining >= 0 and remaining <= amount);
exception when duplicate_object then null; when check_violation then
  raise notice 'credit_batches 有 remaining > amount 或負數的舊資料，請先執行 select * from credit_batches where remaining<0 or remaining>amount 修正後再加約束';
end $$;
do $$ begin
  alter table public.bookings add constraint bookings_status_valid check (status in ('active','cancelled','completed'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.transactions add constraint transactions_amount_positive check (amount > 0 and type in ('income','expense'));
exception when duplicate_object then null; when check_violation then
  raise notice 'transactions 有金額 <= 0 或類型不正確的舊資料，約束未加上';
end $$;

create index if not exists bookings_class_key_active on public.bookings(class_key) where status='active';
create index if not exists bookings_user on public.bookings(line_user_id);
create index if not exists credit_batches_user on public.credit_batches(line_user_id);
create index if not exists transactions_occurred on public.transactions(occurred_at);

-- ---------- 帳本與稽核 ----------
create table if not exists public.credit_ledger (
  id bigint generated always as identity primary key,
  line_user_id text not null,
  batch_id uuid,
  booking_id uuid,
  delta int not null,
  kind text not null check (kind in ('purchase','booking','cancel','admin_adjust','batch_edit','batch_delete','migration')),
  reason text,
  actor text,
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_user on public.credit_ledger(line_user_id, created_at);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  op text not null,
  row_pk text,
  old_row jsonb,
  new_row jsonb,
  actor text,
  created_at timestamptz not null default now()
);

create or replace function app.actor() returns text
language sql stable as $$
  select coalesce(case when auth.jwt()->>'app_role'='student' then 'student:'||(auth.jwt()->>'line_user_id') end,
                  'admin:'||nullif(auth.jwt()->>'email',''),
                  'admin:'||nullif(auth.jwt()->>'sub',''),
                  current_user) $$;

create or replace function app.audit_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare pk text;
begin
  pk := coalesce(to_jsonb(coalesce(new, old))->>'id', to_jsonb(coalesce(new, old))->>'line_user_id');
  insert into public.audit_log(table_name, op, row_pk, old_row, new_row, actor)
  values (tg_table_name, tg_op, pk,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
          app.actor());
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['members','bookings','credit_batches','transactions','class_templates','class_overrides','teachers','store_settings','notify_settings','registration_questions','admin_users'] loop
    execute format('drop trigger if exists zz_audit on public.%I', t);
    execute format('create trigger zz_audit after insert or update or delete on public.%I for each row execute function app.audit_trigger()', t);
  end loop;
end $$;

-- ---------- members 的堂數欄位：第二階段才掛 trigger 自動維護（本階段只定義函式，不執行） ----------
create or replace function app.refresh_member_credits(p_uid text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.members m set
    remaining_credits = coalesce((select sum(b.remaining) from public.credit_batches b
                                  where b.line_user_id = p_uid and (b.expires_at is null or b.expires_at >= app.today())), 0),
    total_credits     = coalesce((select sum(b.amount) from public.credit_batches b where b.line_user_id = p_uid), 0),
    updated_at = now()
  where m.line_user_id = p_uid
$$;

create or replace function app.batches_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op in ('UPDATE','DELETE') then perform app.refresh_member_credits(old.line_user_id); end if;
  if tg_op in ('INSERT','UPDATE') and (tg_op = 'INSERT' or new.line_user_id is distinct from old.line_user_id) then
    perform app.refresh_member_credits(new.line_user_id);
  end if;
  return null;
end $$;
-- 可用堂數 / 累積購買 / 已過期 / 已預約 的單一計算來源（C1 C6 F1）
create or replace view public.member_credit_summary with (security_invoker = true) as
select m.line_user_id,
  coalesce(sum(b.remaining) filter (where b.expires_at is null or b.expires_at >= app.today()), 0)::int as available,
  coalesce(sum(b.remaining) filter (where b.expires_at <  app.today()), 0)::int as expired,
  coalesce(sum(b.amount), 0)::int as purchased,
  (select count(*) from public.bookings k where k.line_user_id = m.line_user_id and k.status in ('active','completed'))::int as booked
from public.members m
left join public.credit_batches b on b.line_user_id = m.line_user_id
group by m.line_user_id;

-- ---------- 課表解析：伺服器端決定一個場次的真實內容（不信任前端傳來的標題 / 時間 / 容量） ----------
create or replace function app.resolve_session(p_template_id uuid, p_date date, p_extra_id uuid)
returns table(class_key text, template_id uuid, title text, teacher text, class_time text, cap int, class_date date, starts_at timestamp)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t record; o record;
begin
  if p_extra_id is not null then
    select * into o from public.class_overrides where id = p_extra_id and type = 'extra';
    if not found then raise exception '找不到這堂特別課' using errcode = 'P0002'; end if;
    return query select app.date_key(o.date) || '_extra_' || o.id, null::uuid, o.title, o.teacher, o.time, o.cap, o.date,
                        (o.date + o.time::time)::timestamp;
    return;
  end if;
  select * into t from public.class_templates where id = p_template_id;
  if not found or not coalesce(t.active, true) then raise exception '找不到這堂課' using errcode = 'P0002'; end if;
  if not (to_jsonb(t.weekdays) ? app.weekday_label(p_date)) then raise exception '這天沒有開這堂課' using errcode = 'P0002'; end if;
  if (t.start_date is not null and p_date < t.start_date) or (t.end_date is not null and p_date > t.end_date) then
    raise exception '這天不在課程期間內' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.class_overrides c where c.type='cancel' and c.date=p_date and c.class_template_id=p_template_id) then
    raise exception '這天已停課' using errcode = 'P0002';
  end if;
  select * into o from public.class_overrides m where m.type='modify' and m.date=p_date and m.class_template_id=p_template_id
    order by m.created_at desc limit 1;
  if found then
    return query select app.date_key(p_date) || '_' || t.id, t.id, coalesce(o.title, t.title), coalesce(o.teacher, t.teacher),
                        coalesce(o.time, t.time), coalesce(o.cap, t.cap), p_date, (p_date + coalesce(o.time, t.time)::time)::timestamp;
  else
    return query select app.date_key(p_date) || '_' || t.id, t.id, t.title, t.teacher, t.time, t.cap, p_date,
                        (p_date + t.time::time)::timestamp;
  end if;
end $$;

-- 從 class_key 反查場次（取消時用，套用當天最新的修改時間，F2）
create or replace function app.session_from_key(p_class_key text)
returns table(class_key text, template_id uuid, title text, teacher text, class_time text, cap int, class_date date, starts_at timestamp)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare parts text[]; d date;
begin
  parts := regexp_match(p_class_key, '^(\d{4})-(\d{1,2})-(\d{1,2})_(extra_)?([0-9a-f-]{36})$');
  if parts is null then return; end if;
  d := make_date(parts[1]::int, parts[2]::int, parts[3]::int);
  begin
    if parts[4] is not null then
      return query select * from app.resolve_session(null, d, parts[5]::uuid);
    else
      return query select * from app.resolve_session(parts[5]::uuid, d, null);
    end if;
  exception when others then return;   -- 已停課 / 已刪除的場次：呼叫端改用預約當時的快照
  end;
end $$;

-- ---------- 堂數內部操作（只給本檔的 RPC 使用，不開放直接呼叫） ----------
-- 選批次：必須「今天未過期」且「效期涵蓋上課日」，最快到期的先用（C8）
create or replace function app.take_credit(p_uid text, p_class_date date) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare bid uuid;
begin
  select id into bid from public.credit_batches
   where line_user_id = p_uid and remaining > 0
     and (expires_at is null or (expires_at >= app.today() and expires_at >= p_class_date))
   order by expires_at asc nulls last, created_at asc
   limit 1 for update;
  if bid is null then raise exception '堂數不足（或剩餘堂數在上課日前就會到期）' using errcode = 'P0001'; end if;
  update public.credit_batches set remaining = remaining - 1 where id = bid;
  return bid;
end $$;

-- 退堂：退回原批次；原批次已不存在 / 已過期 / 已滿，就退到效期最晚且還有空間的批次。
-- 再不行時：只有「這筆預約當初真的扣過批次」才開一批 1 堂永久有效的補償批次（C7 C9 C11）；
-- 當初沒扣過堂數的預約（例如舊版後台幫 0 堂學員建立的預約）不退堂，回傳 null，避免取消後憑空多出免費堂數。
create or replace function app.return_credit(p_uid text, p_batch_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare bid uuid;
begin
  if p_batch_id is not null then
    select id into bid from public.credit_batches
     where id = p_batch_id and remaining < amount and (expires_at is null or expires_at >= app.today()) for update;
  end if;
  if bid is null then
    select id into bid from public.credit_batches
     where line_user_id = p_uid and remaining < amount and (expires_at is null or expires_at >= app.today())
     order by expires_at desc nulls first, created_at desc limit 1 for update;
  end if;
  if bid is null then
    if p_batch_id is null then return null; end if;
    insert into public.credit_batches(line_user_id, amount, remaining, expires_at) values (p_uid, 1, 0, null) returning id into bid;
  end if;
  update public.credit_batches set remaining = remaining + 1 where id = bid;
  return bid;
end $$;

create or replace function app.ledger(p_uid text, p_batch uuid, p_booking uuid, p_delta int, p_kind text, p_reason text)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.credit_ledger(line_user_id, batch_id, booking_id, delta, kind, reason, actor)
  values (p_uid, p_batch, p_booking, p_delta, p_kind, p_reason, app.actor()) $$;

-- 取消一筆 active 預約並退堂（原子；已不是 active 就什麼都不做，防重複退堂）
create or replace function app.cancel_booking_row(p_booking_id uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare b record; bid uuid;
begin
  update public.bookings set status = 'cancelled' where id = p_booking_id and status = 'active' returning * into b;
  if not found then return false; end if;
  bid := app.return_credit(b.line_user_id, b.credit_batch_id);
  if bid is null then
    perform app.ledger(b.line_user_id, null, b.id, 0, 'cancel', coalesce(p_reason,'') || '：這筆預約當初沒有扣到堂數，取消不退堂');
  else
    perform app.ledger(b.line_user_id, bid, b.id, 1, 'cancel', p_reason);
  end if;
  return true;
end $$;

-- =====================================================================================
-- 學員（前台）RPC
-- =====================================================================================
create or replace function public.book_class(p_template_id uuid default null, p_date date default null, p_extra_id uuid default null)
returns public.bookings
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid text := app.line_user_id();
  s record; n record; booked int; bid uuid; bk public.bookings;
  win_start date; win_end date;
begin
  if uid is null then raise exception '請從 LINE 開啟' using errcode = '42501'; end if;
  select * into s from app.resolve_session(p_template_id, p_date, p_extra_id);
  if s.starts_at <= app.now_local() then raise exception '這堂課已經開始，無法預約' using errcode = 'P0001'; end if;

  select * into n from public.notify_settings where id = 1;
  if n.booking_open_start is not null and n.booking_open_end is not null then
    win_start := greatest(n.booking_open_start, app.today()); win_end := n.booking_open_end;
  else
    win_start := app.today() + 1; win_end := app.today() + coalesce(n.booking_window_days, 30);
  end if;
  if s.class_date < win_start or s.class_date > win_end then raise exception '這天尚未開放預約' using errcode = 'P0001'; end if;

  -- 同一場次序列化，避免兩人同時搶最後一席（C4）
  perform pg_advisory_xact_lock(hashtext(s.class_key));
  if exists (select 1 from public.bookings where line_user_id = uid and class_key = s.class_key and status = 'active') then
    raise exception '已經預約過這堂課囉' using errcode = '23505';
  end if;
  select count(*) into booked from public.bookings where class_key = s.class_key and status = 'active';
  if booked >= s.cap then raise exception '此堂課已額滿' using errcode = 'P0001'; end if;

  bid := app.take_credit(uid, s.class_date);
  insert into public.bookings(line_user_id, class_key, class_template_id, class_title, class_date, class_date_iso, class_time, teacher, cap, status, credit_batch_id)
  values (uid, s.class_key, s.template_id, s.title, app.date_label(s.class_date), s.class_date, s.class_time, s.teacher, s.cap, 'active', bid)
  returning * into bk;
  perform app.ledger(uid, bid, bk.id, -1, 'booking', null);
  return bk;
end $$;

create or replace function public.cancel_my_booking(p_booking_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid text := app.line_user_id(); b record; s record; deadline int;
begin
  if uid is null then raise exception '請從 LINE 開啟' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_booking_id and line_user_id = uid for update;
  if not found then raise exception '找不到這筆預約' using errcode = 'P0002'; end if;
  if b.status <> 'active' then return false; end if;
  select * into s from app.session_from_key(b.class_key);
  select coalesce(cancel_deadline_minutes, 60) into deadline from public.notify_settings where id = 1;
  if s.starts_at is null and not (coalesce(b.class_date_iso,'') ~ '^\d{4}-\d{2}-\d{2}$' and coalesce(b.class_time,'') ~ '^\d{1,2}:\d{2}(:\d{2})?$') then
    raise exception '無法判斷這堂課的上課時間，請直接聯繫老師取消' using errcode = 'P0001';
  end if;
  if coalesce(s.starts_at, (b.class_date_iso::date + b.class_time::time)::timestamp) - make_interval(mins => coalesce(deadline, 60)) < app.now_local() then
    raise exception '已超過可自行取消的時限，請直接聯繫老師' using errcode = 'P0001';
  end if;
  return app.cancel_booking_row(b.id, 'student_cancel');
end $$;

-- 學員自己的狀態（一次取回，取代前台原本的 sweep + 三方校正）
create or replace function public.get_my_account() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid text := app.line_user_id();
begin
  if uid is null then raise exception '請從 LINE 開啟' using errcode = '42501'; end if;
  return (select jsonb_build_object(
    'member', (select to_jsonb(m) - 'tags' - 'remaining_credits' - 'total_credits' from public.members m where m.line_user_id = uid),
    'credits', (select to_jsonb(c) from public.member_credit_summary c where c.line_user_id = uid),
    'batches', coalesce((select jsonb_agg(to_jsonb(b) order by b.expires_at nulls last, b.created_at) from public.credit_batches b where b.line_user_id = uid and b.amount > 0), '[]'),
    'bookings', coalesce((select jsonb_agg(to_jsonb(k) order by k.created_at desc) from public.bookings k where k.line_user_id = uid), '[]')
  ));
end $$;

create or replace function public.submit_registration(p_name text, p_contact text, p_answers jsonb) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid text := app.line_user_id(); ts timestamptz := now();
begin
  if uid is null then raise exception '請從 LINE 開啟' using errcode = '42501'; end if;
  if length(coalesce(p_name,'')) > 100 or length(coalesce(p_contact,'')) > 200 or pg_column_size(p_answers) > 20000 then
    raise exception '資料太長' using errcode = '22001';
  end if;
  update public.members set registration_name = p_name, registration_contact = p_contact,
         registration_answers = coalesce(p_answers, '{}'::jsonb), registration_submitted_at = ts, updated_at = now()
   where line_user_id = uid;
  return ts;
end $$;

-- =====================================================================================
-- 管理員（後台）RPC
-- =====================================================================================
create or replace function public.admin_add_credits(p_line_user_id text, p_amount int, p_expires_at date default null,
  p_amount_paid numeric default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare bid uuid;
begin
  perform app.require_admin();
  if p_amount is null or p_amount <= 0 then raise exception '堂數必須大於 0' using errcode = '22023'; end if;
  if p_amount_paid is not null and p_amount_paid < 0 then raise exception '金額不可為負' using errcode = '22023'; end if;
  if not exists (select 1 from public.members where line_user_id = p_line_user_id) then raise exception '找不到學員' using errcode = 'P0002'; end if;
  insert into public.credit_batches(line_user_id, amount, remaining, expires_at, amount_paid)
  values (p_line_user_id, p_amount, p_amount, p_expires_at, p_amount_paid) returning id into bid;
  perform app.ledger(p_line_user_id, bid, null, p_amount, 'purchase', p_note);
  if p_amount_paid is not null and p_amount_paid > 0 then
    insert into public.transactions(type, amount, note, line_user_id, credit_batch_id, occurred_at)
    values ('income', p_amount_paid, coalesce(p_note, '＋' || p_amount || ' 堂'), p_line_user_id, bid, app.today());
  end if;
  return bid;
end $$;

-- 手動加減堂（正數＝開一批新堂數；負數＝從最快到期的未過期批次扣，不足就整筆失敗）
create or replace function public.admin_adjust_credits(p_line_user_id text, p_delta int, p_reason text default null, p_expires_at date default null)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare left_ int; b record; take int; bid uuid;
begin
  perform app.require_admin();
  if p_delta is null or p_delta = 0 then return (select available from public.member_credit_summary where line_user_id = p_line_user_id); end if;
  if p_delta > 0 then
    insert into public.credit_batches(line_user_id, amount, remaining, expires_at) values (p_line_user_id, p_delta, p_delta, p_expires_at) returning id into bid;
    perform app.ledger(p_line_user_id, bid, null, p_delta, 'admin_adjust', p_reason);
  else
    left_ := -p_delta;
    for b in select id, remaining from public.credit_batches
              where line_user_id = p_line_user_id and remaining > 0 and (expires_at is null or expires_at >= app.today())
              order by expires_at asc nulls last, created_at asc for update loop
      exit when left_ = 0;
      take := least(b.remaining, left_);
      update public.credit_batches set remaining = remaining - take where id = b.id;
      perform app.ledger(p_line_user_id, b.id, null, -take, 'admin_adjust', p_reason);
      left_ := left_ - take;
    end loop;
    if left_ > 0 then raise exception '可用堂數不足，無法扣除 % 堂', -p_delta using errcode = 'P0001'; end if;
  end if;
  return (select available from public.member_credit_summary where line_user_id = p_line_user_id);
end $$;

create or replace function public.admin_set_credits(p_line_user_id text, p_target int, p_expires_at date default null, p_reason text default null)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare cur int;
begin
  perform app.require_admin();
  if p_target is null or p_target < 0 then raise exception '堂數不可為負' using errcode = '22023'; end if;
  select available into cur from public.member_credit_summary where line_user_id = p_line_user_id;
  return public.admin_adjust_credits(p_line_user_id, p_target - coalesce(cur, 0), coalesce(p_reason, '設定堂數為 ' || p_target), p_expires_at);
end $$;

create or replace function public.admin_update_batch(p_batch_id uuid, p_amount int, p_remaining int, p_expires_at date, p_reason text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b record; used int;
begin
  perform app.require_admin();
  select * into b from public.credit_batches where id = p_batch_id for update;
  if not found then raise exception '找不到這批堂數' using errcode = 'P0002'; end if;
  if p_amount < 0 or p_remaining < 0 or p_remaining > p_amount then raise exception '剩餘堂數必須介於 0 與原始堂數之間' using errcode = '22023'; end if;
  select count(*) into used from public.bookings where credit_batch_id = p_batch_id and status in ('active','completed');
  if p_amount - p_remaining < used then
    raise exception '這批已有 % 堂被預約使用，原始堂數減剩餘堂數不能小於 %', used, used using errcode = '22023';
  end if;
  update public.credit_batches set amount = p_amount, remaining = p_remaining, expires_at = p_expires_at where id = p_batch_id;
  if p_remaining <> b.remaining then perform app.ledger(b.line_user_id, b.id, null, p_remaining - b.remaining, 'batch_edit', p_reason); end if;
end $$;

-- 刪除批次：有預約引用就把「未使用的部分」移除（amount 縮成已使用數、remaining 歸 0），不會牽動其他批次（C11）；
-- p_delete_income = true 時一併刪掉這批連動的收入紀錄（C13）
create or replace function public.admin_delete_batch(p_batch_id uuid, p_delete_income boolean default false) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare b record; used int;
begin
  perform app.require_admin();
  select * into b from public.credit_batches where id = p_batch_id for update;
  if not found then return 'missing'; end if;
  -- 這裡刻意連「已取消」的預約也算：它們仍以 credit_batch_id 連結這個批次，直接刪除會被外鍵擋下。
  -- 只要有任何預約連結就走「保留批次、只移除未使用部分」；保留時原始堂數設為有效（active + completed）預約數，
  -- 例如 2 筆有效 + 1 筆已取消 → amount = 2、remaining = 0，代表這批實際用掉 2 堂。
  select count(*) into used from public.bookings where credit_batch_id = p_batch_id;
  if b.remaining > 0 then perform app.ledger(b.line_user_id, b.id, null, -b.remaining, 'batch_delete', null); end if;
  if p_delete_income then delete from public.transactions where credit_batch_id = p_batch_id; end if;
  if used > 0 then
    update public.credit_batches set amount = (select count(*) from public.bookings where credit_batch_id = p_batch_id and status in ('active','completed')), remaining = 0 where id = p_batch_id;
    return 'trimmed';
  end if;
  update public.transactions set credit_batch_id = null where credit_batch_id = p_batch_id;
  delete from public.credit_batches where id = p_batch_id;
  return 'deleted';
end $$;

-- 幫學員預約（可一次多個日期）。p_allow_overcap = 管理員確認超收。全部成功或全部失敗。
create or replace function public.admin_book(p_line_user_ids text[], p_template_id uuid, p_dates date[], p_extra_id uuid default null, p_allow_overcap boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid text; d date; s record; booked int; bid uuid; bk public.bookings; created int := 0; skipped jsonb := '[]'::jsonb;
begin
  perform app.require_admin();
  if p_extra_id is not null then p_dates := array[(select date from public.class_overrides where id = p_extra_id)]; end if;
  foreach d in array coalesce(p_dates, '{}') loop
    begin
      select * into s from app.resolve_session(p_template_id, d, p_extra_id);
    exception when others then
      skipped := skipped || jsonb_build_object('date', d, 'reason', sqlerrm); continue;
    end;
    perform pg_advisory_xact_lock(hashtext(s.class_key));
    foreach uid in array p_line_user_ids loop
      if exists (select 1 from public.bookings where line_user_id = uid and class_key = s.class_key and status = 'active') then
        skipped := skipped || jsonb_build_object('line_user_id', uid, 'date', d, 'reason', '已經預約過'); continue;
      end if;
      select count(*) into booked from public.bookings where class_key = s.class_key and status = 'active';
      if booked >= s.cap and not p_allow_overcap then
        raise exception '% % 已額滿（% / % 人）', d, s.title, booked, s.cap using errcode = 'P0001';
      end if;
      bid := app.take_credit(uid, s.class_date);   -- 堂數不足會讓整批失敗（C12：不再有隱性欠堂）
      insert into public.bookings(line_user_id, class_key, class_template_id, class_title, class_date, class_date_iso, class_time, teacher, cap, status, credit_batch_id)
      values (uid, s.class_key, s.template_id, s.title, app.date_label(s.class_date), s.class_date, s.class_time, s.teacher, s.cap, 'active', bid)
      returning * into bk;
      perform app.ledger(uid, bid, bk.id, -1, 'booking', 'admin_book');
      created := created + 1;
    end loop;
  end loop;
  return jsonb_build_object('created', created, 'skipped', skipped);
end $$;

create or replace function public.admin_cancel_booking(p_booking_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_admin();
  return app.cancel_booking_row(p_booking_id, 'admin_cancel');
end $$;

-- 停開某天的固定課：取消當天預約並退堂 + 新增停課紀錄（原子）
create or replace function public.admin_cancel_occurrence(p_template_id uuid, p_date date) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text := app.date_key(p_date) || '_' || p_template_id; r record; n int := 0;
begin
  perform app.require_admin();
  if exists (select 1 from public.class_overrides where type='cancel' and date=p_date and class_template_id=p_template_id) then return 0; end if;
  for r in select id from public.bookings where class_key = k and status = 'active' loop
    if p_date >= app.today() then
      if app.cancel_booking_row(r.id, 'class_cancelled') then n := n + 1; end if;
    else
      update public.bookings set status = 'completed' where id = r.id;
    end if;
  end loop;
  insert into public.class_overrides(type, date, class_template_id) values ('cancel', p_date, p_template_id);
  return n;
end $$;

-- 刪除特別課：未來的預約取消退堂，過去的標記完成（原子）
create or replace function public.admin_delete_override(p_override_id uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare o record; r record; n int := 0; k text;
begin
  perform app.require_admin();
  select * into o from public.class_overrides where id = p_override_id for update;
  if not found then return 0; end if;
  if o.type = 'extra' then
    k := app.date_key(o.date) || '_extra_' || o.id;
    for r in select id from public.bookings where class_key = k and status = 'active' loop
      if o.date >= app.today() then
        if app.cancel_booking_row(r.id, 'class_cancelled') then n := n + 1; end if;
      else
        update public.bookings set status = 'completed' where id = r.id;
      end if;
    end loop;
  end if;
  delete from public.class_overrides where id = p_override_id;
  return n;
end $$;

-- 刪除課程範本（原子，C3）：未來預約取消退堂、過去預約標記完成、再刪範本與它的單日設定
create or replace function public.admin_delete_template(p_template_id uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  perform app.require_admin();
  for r in select id, class_date_iso from public.bookings where class_template_id = p_template_id and status = 'active' loop
    if r.class_date_iso::date >= app.today() then
      if app.cancel_booking_row(r.id, 'class_deleted') then n := n + 1; end if;
    else
      update public.bookings set status = 'completed' where id = r.id;
    end if;
  end loop;
  delete from public.class_overrides where class_template_id = p_template_id and type in ('cancel','modify');
  update public.class_overrides set class_template_id = null where class_template_id = p_template_id;
  delete from public.class_templates where id = p_template_id;
  return n;
end $$;

-- 單日修改固定課（type=modify）：同步更新當天預約的快照，讓名單 / 取消時限一致（F2 C13）
create or replace function public.admin_save_modify(p_template_id uuid, p_date date, p_title text, p_teacher text, p_time text, p_cap int,
  p_location text default '', p_description text default '', p_override_id uuid default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid := p_override_id; k text := app.date_key(p_date) || '_' || p_template_id;
begin
  perform app.require_admin();
  if p_cap is null or p_cap <= 0 then raise exception '人數上限必須大於 0' using errcode = '22023'; end if;
  if oid is null then
    select id into oid from public.class_overrides where type='modify' and date=p_date and class_template_id=p_template_id;
  end if;
  if oid is null then
    insert into public.class_overrides(type, date, class_template_id, title, teacher, time, cap, location, description)
    values ('modify', p_date, p_template_id, p_title, p_teacher, p_time, p_cap, p_location, p_description) returning id into oid;
  else
    update public.class_overrides set type='modify', date=p_date, class_template_id=p_template_id, title=p_title, teacher=p_teacher,
           time=p_time, cap=p_cap, location=p_location, description=p_description where id = oid;
  end if;
  delete from public.class_overrides where type='cancel' and date=p_date and class_template_id=p_template_id;
  update public.bookings set class_title=p_title, teacher=p_teacher, class_time=p_time, cap=p_cap
   where class_key = k and status = 'active';
  return oid;
end $$;

-- 把某天的固定課改成特別課：當天的預約「搬到」新場次，不會消失、不用重約（C5）
create or replace function public.admin_convert_to_extra(p_template_id uuid, p_date date, p_title text, p_teacher text, p_time text, p_cap int,
  p_location text default '', p_description text default '') returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare eid uuid; old_key text := app.date_key(p_date) || '_' || p_template_id; new_key text;
begin
  perform app.require_admin();
  if p_cap is null or p_cap <= 0 then raise exception '人數上限必須大於 0' using errcode = '22023'; end if;
  delete from public.class_overrides where type='modify' and date=p_date and class_template_id=p_template_id;
  if not exists (select 1 from public.class_overrides where type='cancel' and date=p_date and class_template_id=p_template_id) then
    insert into public.class_overrides(type, date, class_template_id) values ('cancel', p_date, p_template_id);
  end if;
  insert into public.class_overrides(type, date, class_template_id, title, teacher, time, cap, duration, location, description)
  values ('extra', p_date, p_template_id, p_title, p_teacher, p_time, p_cap, 60, p_location, p_description) returning id into eid;
  new_key := app.date_key(p_date) || '_extra_' || eid;
  update public.bookings set class_key = new_key, class_template_id = null, class_title = p_title, teacher = p_teacher,
         class_time = p_time, cap = p_cap
   where class_key = old_key and status = 'active';
  return eid;
end $$;

-- 把「由固定課轉來的特別課」轉回固定課的單日修改：預約搬回原場次（F3：用 class_template_id 精準對應，不再猜）
create or replace function public.admin_convert_extra_to_modify(p_extra_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare o record; mid uuid;
begin
  perform app.require_admin();
  select * into o from public.class_overrides where id = p_extra_id and type = 'extra' for update;
  if not found or o.class_template_id is null then raise exception '這堂特別課不是由固定課程轉來的，無法轉回' using errcode = 'P0002'; end if;
  delete from public.class_overrides where type='cancel' and date=o.date and class_template_id=o.class_template_id;
  update public.bookings set class_key = app.date_key(o.date) || '_' || o.class_template_id, class_template_id = o.class_template_id
   where class_key = app.date_key(o.date) || '_extra_' || o.id and status = 'active';
  delete from public.class_overrides where id = p_extra_id;
  mid := public.admin_save_modify(o.class_template_id, o.date, o.title, o.teacher, o.time, o.cap, o.location, o.description, null);
  return mid;
end $$;

-- 修改特別課：同步更新預約快照；改日期時把預約一起搬到新日期（原本改日期會讓預約跟課程脫鉤）
create or replace function public.admin_update_extra(p_extra_id uuid, p_date date, p_title text, p_teacher text, p_time text, p_cap int,
  p_location text default '', p_description text default '') returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o record; old_key text; new_key text;
begin
  perform app.require_admin();
  if p_cap is null or p_cap <= 0 then raise exception '人數上限必須大於 0' using errcode = '22023'; end if;
  select * into o from public.class_overrides where id = p_extra_id and type = 'extra' for update;
  if not found then raise exception '找不到這堂特別課' using errcode = 'P0002'; end if;
  old_key := app.date_key(o.date) || '_extra_' || o.id;
  new_key := app.date_key(p_date) || '_extra_' || o.id;
  update public.class_overrides set date = p_date, title = p_title, teacher = p_teacher, time = p_time, cap = p_cap,
         location = p_location, description = p_description where id = p_extra_id;
  update public.bookings set class_key = new_key, class_date_iso = p_date, class_date = app.date_label(p_date),
         class_title = p_title, teacher = p_teacher, class_time = p_time, cap = p_cap
   where class_key = old_key and status = 'active';
end $$;

-- 刪除學員（原子，F7）：預約、批次、帳本一起刪；金流保留但去識別並在備註記錄原名稱
create or replace function public.admin_delete_member(p_line_user_id text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare nm text;
begin
  perform app.require_admin();
  select display_name into nm from public.members where line_user_id = p_line_user_id;
  update public.transactions set note = trim(coalesce(note,'') || '（已刪除學員：' || coalesce(nm,'?') || '）'), line_user_id = null
   where line_user_id = p_line_user_id;
  delete from public.bookings where line_user_id = p_line_user_id;
  delete from public.credit_batches where line_user_id = p_line_user_id;
  delete from public.credit_ledger where line_user_id = p_line_user_id;
  delete from public.members where line_user_id = p_line_user_id;
end $$;

-- 把已經上完的 active 預約標記為 completed（C10）。後台載入時呼叫；也可用 pg_cron 每小時跑一次。
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

-- 金流：寫入一律檢查（金額 > 0）；多位學員一次新增為單一交易
create or replace function public.admin_add_transactions(p_type text, p_amount numeric, p_occurred_at date, p_note text,
  p_cost_type text default null, p_line_user_ids text[] default null) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid text; n int := 0;
begin
  perform app.require_admin();
  if p_amount is null or p_amount <= 0 then raise exception '金額必須大於 0' using errcode = '22023'; end if;
  if p_type not in ('income','expense') then raise exception '類型錯誤' using errcode = '22023'; end if;
  if p_line_user_ids is null or cardinality(p_line_user_ids) = 0 then
    insert into public.transactions(type, amount, note, occurred_at, cost_type) values (p_type, p_amount, coalesce(p_note,''), coalesce(p_occurred_at, app.today()), case when p_type='expense' then p_cost_type end);
    return 1;
  end if;
  foreach uid in array p_line_user_ids loop
    insert into public.transactions(type, amount, note, line_user_id, occurred_at, cost_type)
    values (p_type, p_amount, coalesce(p_note,''), uid, coalesce(p_occurred_at, app.today()), case when p_type='expense' then p_cost_type end);
    n := n + 1;
  end loop;
  return n;
end $$;

-- RPC 權限
revoke all on all functions in schema app from public, anon, authenticated;
grant execute on function app.line_user_id(), app.is_admin(), app.today(), app.now_local(), app.actor() to anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['book_class(uuid,date,uuid)','cancel_my_booking(uuid)','get_my_account()','submit_registration(text,text,jsonb)',
    'admin_add_credits(text,int,date,numeric,text)','admin_adjust_credits(text,int,text,date)','admin_set_credits(text,int,date,text)',
    'admin_update_batch(uuid,int,int,date,text)','admin_delete_batch(uuid,boolean)','admin_book(text[],uuid,date[],uuid,boolean)',
    'admin_cancel_booking(uuid)','admin_cancel_occurrence(uuid,date)','admin_delete_override(uuid)','admin_delete_template(uuid)',
    'admin_save_modify(uuid,date,text,text,text,int,text,text,uuid)','admin_convert_to_extra(uuid,date,text,text,text,int,text,text)',
    'admin_convert_extra_to_modify(uuid)','admin_update_extra(uuid,date,text,text,text,int,text,text)','admin_delete_member(text)','complete_past_bookings()',
    'admin_add_transactions(text,numeric,date,text,text,text[])'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
grant execute on function public.get_store_public_settings(), public.get_booking_rules(), public.get_class_seat_counts() to anon, authenticated;

-- Supabase 會自動把 public schema 的新表開放給 anon / authenticated，這裡立即收回（詳見 20260929000000_phase1_fix_new_table_grants.sql）
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

-- 公開圖片改放 Storage（公告 / 關於我們），只有管理員能上傳（S7）
insert into storage.buckets(id, name, public) values ('public-assets', 'public-assets', true) on conflict (id) do nothing;
do $$ begin
  create policy "public-assets admin write" on storage.objects for all to authenticated
    using (bucket_id = 'public-assets' and app.is_admin()) with check (bucket_id = 'public-assets' and app.is_admin());
exception when duplicate_object then null; end $$;
