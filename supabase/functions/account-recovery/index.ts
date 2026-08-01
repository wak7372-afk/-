import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
const secretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const appOrigin = Deno.env.get('APP_ORIGIN') ?? '';
const resendApiKey = Deno.env.get('RESEND_API_KEY') ?? '';
const resendFromEmail = Deno.env.get('RESEND_FROM_EMAIL') ?? '';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': appOrigin || 'null',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

function normalizeUsername(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  if (!local || !domain) return 'البريد المرتبط';
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

function createOtp() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return String(values[0] % 1_000_000).padStart(6, '0');
}

async function hashText(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function getAccount(admin: ReturnType<typeof createClient>, username: string) {
  const { data, error } = await admin
    .from('users')
    .select('id, username, full_name, is_active')
    .eq('username', username)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getLinkedGoogleEmail(admin: ReturnType<typeof createClient>, userId: string) {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error) throw error;
  const identity = data.user?.identities?.find(item => item.provider === 'google');
  return identity?.identity_data?.email || '';
}

async function sendOtpEmail(email: string, code: string) {
  if (!resendApiKey || !resendFromEmail) throw new Error('Email delivery is not configured.');
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: resendFromEmail,
      to: [email],
      subject: 'رمز استعادة حساب منصة ذات خيل',
      html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8"><h2>رمز التحقق</h2><p>رمز استعادة حسابك هو:</p><p style="font-size:28px;font-weight:700;letter-spacing:8px">${code}</p><p>تنتهي صلاحية الرمز خلال 10 دقائق. إذا لم تطلب الاستعادة فتجاهل هذه الرسالة.</p></div>`,
    }),
  });
  if (!result.ok) throw new Error('Email delivery failed.');
}

async function requestRecovery(admin: ReturnType<typeof createClient>, username: string) {
  const account = await getAccount(admin, username);
  if (!account?.is_active) return response({ sent: true });

  const googleEmail = await getLinkedGoogleEmail(admin, account.id);
  if (!googleEmail) return response({ sent: true });

  const recentSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await admin
    .from('password_recovery_codes')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', account.id)
    .gte('created_at', recentSince);
  if ((count || 0) >= 3) return response({ sent: true });

  const code = createOtp();
  const codeHash = await hashText(code);
  await admin
    .from('password_recovery_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('user_id', account.id)
    .is('consumed_at', null);

  const { error: insertError } = await admin.from('password_recovery_codes').insert({
    user_id: account.id,
    code_hash: codeHash,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (insertError) throw insertError;

  try {
    await sendOtpEmail(googleEmail, code);
  } catch (error) {
    await admin
      .from('password_recovery_codes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('user_id', account.id)
      .eq('code_hash', codeHash);
    throw error;
  }

  return response({ sent: true, maskedEmail: maskEmail(googleEmail) });
}

async function verifyRecovery(admin: ReturnType<typeof createClient>, username: string, code: string, password: string) {
  if (!/^\d{6}$/.test(code) || password.length < 8) return response({ error: 'رمز التحقق أو كلمة المرور غير صالح.' }, 400);
  const account = await getAccount(admin, username);
  if (!account?.is_active) return response({ error: 'تعذر التحقق من الرمز.' }, 400);

  const { data: recovery } = await admin
    .from('password_recovery_codes')
    .select('id, code_hash, attempts, expires_at')
    .eq('user_id', account.id)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .lt('attempts', 5)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!recovery) return response({ error: 'الرمز غير صالح أو منتهي الصلاحية.' }, 400);

  const codeHash = await hashText(code);
  if (codeHash !== recovery.code_hash) {
    await admin.from('password_recovery_codes').update({ attempts: (recovery.attempts || 0) + 1 }).eq('id', recovery.id);
    return response({ error: 'رمز التحقق غير صحيح.' }, 400);
  }

  const { error: passwordError } = await admin.auth.admin.updateUserById(account.id, { password });
  if (passwordError) throw passwordError;
  const { error: profileError } = await admin.from('users').update({ must_change_password: false }).eq('id', account.id);
  if (profileError) throw profileError;
  await admin.from('password_recovery_codes').update({ consumed_at: new Date().toISOString() }).eq('id', recovery.id);

  return response({ updated: true });
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  if (!supabaseUrl || !publishableKey || !secretKey || !appOrigin) return response({ error: 'Function configuration is incomplete' }, 500);

  try {
    const { action, username: rawUsername, code, password } = await request.json();
    const username = normalizeUsername(rawUsername);
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return response({ error: 'بيانات الاستعادة غير صحيحة.' }, 400);

    const admin = createClient(supabaseUrl, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
    if (action === 'request') return await requestRecovery(admin, username);
    if (action === 'verify') return await verifyRecovery(admin, username, String(code || ''), String(password || ''));
    return response({ error: 'طلب غير صالح.' }, 400);
  } catch (error) {
    console.error('Account recovery failed:', error);
    return response({ error: 'تعذر إتمام الاستعادة حالياً.' }, 500);
  }
});
