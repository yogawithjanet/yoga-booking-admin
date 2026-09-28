# 部署步驟（系統已上線：請照順序，每一步都可以停下來觀察）

> 原則：**先加、後切、最後收**。任何一步之前網站都照常運作；第 5 步之前都能直接退回。
> 所有 SQL 都在 Supabase Dashboard → SQL Editor 執行。

## 0. 備份（必要）
1. Dashboard → Database → Backups：確認有今天的備份，或手動建立一份。
2. 匯出目前的 RLS policy，出問題時對照用：
   ```sql
   select tablename, policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2;
   ```

## 1. 上線前檢查（唯讀）
執行 `supabase/preflight/check_before_migration.sql`，每一段應回傳 0 列。
- 第 4 段列出的學員：新版的「可用堂數」會以批次為準，跟目前畫面的數字不同。請逐一確認，必要時先在舊後台修正批次。
- 第 7 段列出的學員：批次扣掉的堂數跟實際預約數對不上（例如舊版後台幫 0 堂學員建立的預約）。**必須在舊版還在線上時處理完**：
  已收費 → 用目前的後台幫他補上對應堂數，舊版載入時會自動把那些預約分配進新批次；未收費 → 先與學員確認後再補堂或取消預約。
  處理後重跑第 7 段，確認回傳 0 列再往下做。新版上線後才補，會變成多送堂數。
- 第 5 段列出的 Auth 帳號：第 2 步會全部登記為管理員。不認識的帳號請先刪除，並到 Authentication → Providers → Email 關閉「Allow new users to sign up」。

## 2. 第一階段 migration（純新增，不改任何既有資料或權限）
執行 `supabase/migrations/20260928000000_phase1_additive.sql`。
- 舊版前台 / 後台照常運作（已由自動測試驗證：所有既有資料表逐列比對完全相同，見測試 PR）。
- 若有 NOTICE 提示「未建立唯一索引 / 約束」，代表有舊資料不符合，依第 1 步結果處理後可重跑（可重複執行）。

## 3. 部署 LINE 登入函式（在 Supabase 網頁後台完成，不需安裝任何工具）
1. Supabase Dashboard → **Edge Functions** → **Deploy a new function** → **Via Editor**。
2. 函式名稱填 `line-auth`，把 `supabase/functions/line-auth/index.ts` 的內容整段貼上 → **Deploy**。
3. Edge Functions → **Secrets**（或 Settings → Edge Functions），新增三個：
   | 名稱 | 值 |
   |---|---|
   | `LINE_CHANNEL_ID` | LINE Developers → LIFF 所屬的 LINE Login channel → Channel ID |
   | `APP_JWT_SECRET` | Supabase Settings → API → JWT Secret（**Legacy HS256**；目前專案的 anon key 就是 HS256，可直接使用） |
   | `ALLOWED_ORIGINS` | `https://yogawithjanet.github.io` |
4. LINE Developers → LIFF 設定 → Scope 勾選 **openid**（前台需要 `liff.getIDToken()`）。

> 若日後在 Supabase 把 JWT 改成新式簽章金鑰（JWT Signing Keys / 非對稱），`line-auth` 的簽章方式需要一起調整，否則學員會無法登入。

### LINE 官方帳號綁定前台網址（GitHub Pages）
前台網址：`https://yogawithjanet.github.io/yoga-booking/`　LIFF ID：`2010908944-FrI4dOOM`（在 `config.js`）

1. **LINE Developers Console** → Provider → LINE Login channel（LIFF 所在的 channel）→ **LIFF** 分頁 → 點 `2010908944-FrI4dOOM`：
   - **Endpoint URL**：`https://yogawithjanet.github.io/yoga-booking/`（結尾要有 `/`，必須是 https）
   - **Scope**：勾選 `openid`、`profile`
   - **Size**：Full
   - **Bot link feature**：On (Aggressive)，學員第一次打開時會提示加官方帳號好友
2. 同一個 channel 的 **Basic settings** → **Linked LINE Official Account**：選你們的官方帳號。
3. **LINE Official Account Manager** → 聊天室相關 → **圖文選單**（Rich menu）→ 新增或編輯按鈕 → 動作選「連結」，網址填 **LIFF 網址**：
   `https://liff.line.me/2010908944-FrI4dOOM`
   （填 LIFF 網址而不是 GitHub Pages 網址，才會在 LINE 內開啟並自動登入。）
4. 也可以在「自動回應訊息」或「歡迎訊息」放同一個 LIFF 網址。
5. 驗證：用手機 LINE 點圖文選單 → 應直接開啟預約頁並顯示自己的名稱與堂數。

GitHub Pages 網址不變，所以只要 Endpoint URL 設定正確，之後合併 PR（網站更新）都不需要再改 LINE 設定。

## 4. 部署新版前台與後台（合併兩個 PR）
- 兩個網站都是 GitHub Pages 直接從 `main` 發佈，**合併 PR 就等於上線**，約 1 分鐘生效，不需要其他步驟。
- 前台只改了 `index.html`；後台只改了 `index.html`（`supabase/` 是在 Supabase 後台貼上執行的檔案，不影響網站）。`config.js` 都不用改。
- 此時資料庫同時支援舊版與新版，合併順序不拘。
- 驗證清單：
  - [ ] 學員從 LINE 開啟：看得到課表、剩餘堂數正確、預約一堂 → 堂數 −1、取消 → 堂數 +1
  - [ ] 後台登入：學員列表的「剩餘可用」與第 1 步確認過的一致
  - [ ] 後台幫學員加 1 堂 / 扣 1 堂 → 重新整理後數字不變
  - [ ] 後台上傳公告圖片成功（使用 Storage）
- 有問題：在 GitHub 的 PR 頁面按 **Revert** 並合併，即可回到舊版；資料庫第一階段不影響舊版。

## 5. 第二階段 migration（收緊權限）
確認第 4 步都正常、且學員已在使用新版後執行。怎麼確認學員在用新版：
- Supabase → **Edge Functions → line-auth → Invocations / Logs**：有持續的成功呼叫（每位學員開啟新版都會呼叫一次）。舊版不會呼叫這個函式。
- `audit_log` 只記錄資料被修改，學員只是開啟 app 不會留下紀錄，不能用來判斷。
- GitHub Pages 的快取約 10 分鐘，觀察一天已經相當保守。

然後執行
`supabase/migrations/20260928000100_phase2_lockdown.sql`。
- 之後匿名金鑰讀不到任何學員資料、也無法改堂數；舊版前台 / 後台將無法寫入。
- 緊急退回：執行 `supabase/rollback/phase2_rollback.sql`（不改資料，只恢復舊權限），再 revert 前端 PR。

## 6. （選用）定期把上完的課標記為完成
後台每次載入都會呼叫 `complete_past_bookings()`。若想不開後台也自動更新，可啟用 pg_cron：
```sql
select cron.schedule('complete-past-bookings', '5 * * * *', $$select public.complete_past_bookings()$$);
```
