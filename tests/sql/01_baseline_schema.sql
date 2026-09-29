-- 只給測試用：現行正式資料庫的結構（由唯讀探測的欄位推定），模擬「migration 之前」的狀態，
-- 包含目前寬鬆的權限：anon 可以直接讀寫 members / bookings / credit_batches。
create table members (
  line_user_id text primary key, display_name text, picture_url text,
  remaining_credits int not null default 0, total_credits int not null default 0, credits_expire_at date,
  tags text[] default '{}', registration_name text, registration_contact text,
  registration_answers jsonb default '{}', registration_submitted_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table class_templates (
  id uuid primary key default gen_random_uuid(), title text, teacher text, time text, duration int, cap int,
  weekdays text[], active boolean default true, description text default '', location text default '',
  start_date date, end_date date, created_at timestamptz default now()
);
create table class_overrides (
  id uuid primary key default gen_random_uuid(), type text, date date,
  class_template_id uuid references class_templates(id) on delete cascade,
  title text, teacher text, time text, duration int, cap int, description text default '', location text default '',
  created_at timestamptz default now()
);
create table credit_batches (
  id uuid primary key default gen_random_uuid(), line_user_id text references members(line_user_id) on delete cascade,
  amount int not null, remaining int not null, expires_at date, amount_paid numeric, created_at timestamptz default now()
);
create table bookings (
  id uuid primary key default gen_random_uuid(), line_user_id text references members(line_user_id) on delete cascade,
  class_key text, class_template_id uuid, class_title text, class_date text, class_date_iso text, class_time text,
  teacher text, cap int, status text default 'active',
  credit_batch_id uuid references credit_batches(id), created_at timestamptz default now()
);
create unique index bookings_one_active_per_class on bookings(line_user_id, class_key) where status='active';
create table transactions (
  id uuid primary key default gen_random_uuid(), type text, amount numeric, note text default '',
  line_user_id text, credit_batch_id uuid, occurred_at date default current_date, cost_type text,
  created_at timestamptz default now()
);
create table teachers (id uuid primary key default gen_random_uuid(), name text, specialty text, phone text, created_at timestamptz default now());
create table registration_questions (
  id uuid primary key default gen_random_uuid(), question text, type text, options jsonb default '[]',
  sort_order int default 0, active boolean default true, required boolean default false, created_at timestamptz default now()
);
create table store_settings (
  id int primary key, name text, theme text, available_tags text[] default '{}', tag_colors jsonb default '{}',
  announcement_enabled boolean default false, announcement_title text, announcement_content text, announcement_image text,
  about_image text, about_text text, about_links jsonb default '[]',
  registration_form_status text default 'draft', registration_field_order jsonb default '[]',
  registration_show_name boolean default true, registration_show_contact boolean default true,
  registration_name_required boolean default true, registration_contact_required boolean default true,
  edit_profile_note text
);
create table notify_settings (
  id int primary key, reminder_enabled boolean, reminder_time text, reminder_template text,
  low_credit_enabled boolean, low_credit_threshold int, cancel_deadline_minutes int default 60,
  booking_window_days int default 30, booking_open_start date, booking_open_end date
);
-- 現行的公開 RPC（簽名跟前台呼叫方式一致）
create function get_store_public_settings() returns json language sql security definer as $$ select row_to_json(s) from store_settings s where id=1 $$;
create function get_booking_rules() returns json language sql security definer as $$ select row_to_json(n) from notify_settings n where id=1 $$;
create function get_class_seat_counts() returns table(class_key text, booked_count bigint) language sql security definer as $$
  select class_key, count(*) from bookings where status='active' group by class_key $$;
-- 現行的寬鬆權限（重現目前正式環境的行為）
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
alter table members enable row level security;       create policy "open" on members for all using (true) with check (true);
alter table bookings enable row level security;      create policy "open" on bookings for all using (true) with check (true);
alter table credit_batches enable row level security; create policy "open" on credit_batches for all using (true) with check (true);
alter table class_templates enable row level security; create policy "open" on class_templates for all using (true) with check (true);
alter table class_overrides enable row level security; create policy "open" on class_overrides for all using (true) with check (true);
alter table registration_questions enable row level security; create policy "open" on registration_questions for all using (true) with check (true);
alter table transactions enable row level security;  create policy "auth" on transactions for all to authenticated using (true) with check (true);
alter table store_settings enable row level security; create policy "auth" on store_settings for all to authenticated using (true) with check (true);
alter table notify_settings enable row level security; create policy "auth" on notify_settings for all to authenticated using (true) with check (true);
alter table teachers enable row level security;      create policy "auth" on teachers for all to authenticated using (true) with check (true);
