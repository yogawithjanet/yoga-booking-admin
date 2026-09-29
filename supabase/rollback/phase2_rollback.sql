-- 回滾第二階段：恢復成第一階段（跟目前線上一樣寬鬆的權限），讓舊版前台 / 後台能再運作。
-- 不修改任何資料列。只在新版出問題需要緊急退回舊版時使用。
drop trigger if exists sync_member_credits on public.credit_batches;

do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies where schemaname='public'
            and tablename in ('members','bookings','credit_batches','class_templates','class_overrides','registration_questions',
                              'transactions','store_settings','notify_settings','teachers') loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- 與遷移前相同：學員相關表對 anon / authenticated 開放；設定類表只對登入者開放
do $$
declare t text;
begin
  foreach t in array array['members','bookings','credit_batches','class_templates','class_overrides','registration_questions'] loop
    execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);
    execute format('create policy legacy_open on public.%I for all using (true) with check (true)', t);
  end loop;
  foreach t in array array['transactions','store_settings','notify_settings','teachers'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy legacy_auth on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
-- ⚠️ 若原本的 policy 名稱 / 內容跟這裡不同，請以部署前在 Dashboard 匯出的 policy 為準（見 PR 說明「部署步驟 0」）。
