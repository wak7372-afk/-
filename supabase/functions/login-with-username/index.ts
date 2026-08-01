import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
const secretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const appOrigin = Deno.env.get('APP_ORIGIN') ?? '';

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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  if (!supabaseUrl || !publishableKey || !secretKey || !appOrigin) return response({ error: 'Function configuration is incomplete' }, 500);

  try {
    const { username, password } = await request.json();
    const cleanUsername = normalizeUsername(username);

    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(cleanUsername) || typeof password !== 'string' || password.length < 8) {
      return response({ error: 'بيانات الدخول غير صحيحة.' }, 400);
    }

    const admin = createClient(supabaseUrl, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: profile } = await admin
      .from('users')
      .select('email, is_active')
      .eq('username', cleanUsername)
      .maybeSingle();

    if (!profile?.is_active) return response({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' }, 401);

    const authClient = createClient(supabaseUrl, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await authClient.auth.signInWithPassword({
      email: profile.email,
      password,
    });

    if (error || !data.session) return response({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' }, 401);
    return response({ session: data.session });
  } catch (error) {
    console.error('Username login failed:', error);
    return response({ error: 'تعذر إتمام تسجيل الدخول حالياً.' }, 500);
  }
});
