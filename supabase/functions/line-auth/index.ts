// LINE 登入 → Supabase 學員 session（修正 S1：前台不再自報 line_user_id）
//
// 流程：前台 liff.getIDToken() → POST 本函式 → 向 LINE 驗證 ID token → 以服務端權限建立 / 更新 members →
//       簽發只帶 line_user_id 的短效 JWT（role=authenticated, app_role=student）→ 前台用它呼叫 RPC。
//
// 需要的 secrets（supabase secrets set ...）：
//   LINE_CHANNEL_ID      LIFF 所屬 LINE Login channel 的 Channel ID
//   APP_JWT_SECRET       專案 Settings → API → JWT Secret（legacy HS256）
//   ALLOWED_ORIGINS      前台網址，逗號分隔，例如 https://yogawithjanet.github.io
// 平台自動提供：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { SignJWT } from 'npm:jose@5.9.6';

const LINE_CHANNEL_ID = Deno.env.get('LINE_CHANNEL_ID')!;
const JWT_SECRET = new TextEncoder().encode(Deno.env.get('APP_JWT_SECRET')!);
const ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TOKEN_TTL_SECONDS = 60 * 60 * 6;

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

function cors(origin: string | null) {
  const allow = origin && ALLOWED.includes(origin) ? origin : ALLOWED[0] ?? '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(origin) });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);
  if (ALLOWED.length && (!origin || !ALLOWED.includes(origin))) return json({ error: 'origin not allowed' }, 403, origin);

  let idToken: string | undefined;
  try { ({ idToken } = await req.json()); } catch { /* fallthrough */ }
  if (!idToken) return json({ error: 'missing idToken' }, 400, origin);

  // 向 LINE 驗證：簽章、有效期限、aud（必須是我們的 channel）都由 LINE 檢查
  const verify = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID }),
  });
  if (!verify.ok) return json({ error: 'invalid LINE token' }, 401, origin);
  const claims = await verify.json() as { sub: string; name?: string; picture?: string; aud: string; exp: number };
  if (!claims.sub || claims.aud !== LINE_CHANNEL_ID) return json({ error: 'invalid LINE token' }, 401, origin);

  // 建立或更新學員（名稱 / 頭像以 LINE 驗證過的資料為準）
  const { error } = await admin.from('members').upsert(
    { line_user_id: claims.sub, display_name: claims.name ?? null, picture_url: claims.picture ?? null, updated_at: new Date().toISOString() },
    { onConflict: 'line_user_id' },
  );
  if (error) return json({ error: 'member upsert failed' }, 500, origin);

  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({
    role: 'authenticated',
    aud: 'authenticated',
    app_role: 'student',
    line_user_id: claims.sub,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL_SECONDS)
    .setIssuer('line-auth')
    .sign(JWT_SECRET);

  return json({ accessToken, expiresAt: now + TOKEN_TTL_SECONDS, profile: { userId: claims.sub, displayName: claims.name ?? '', pictureUrl: claims.picture ?? null } }, 200, origin);
});
