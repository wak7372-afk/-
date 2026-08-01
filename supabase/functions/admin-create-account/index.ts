import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
const secretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const appOrigin = Deno.env.get('APP_ORIGIN') ?? '';
const validRoles = new Set(['teacher', 'student', 'parent']);

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

  const authorization = request.headers.get('Authorization');
  if (!authorization) return response({ error: 'Unauthorized' }, 401);

  try {
    const callerClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userData, error: userError } = await callerClient.auth.getUser();
    if (userError || !userData.user) return response({ error: 'Unauthorized' }, 401);

    const admin = createClient(supabaseUrl, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: callerProfile } = await admin
      .from('users')
      .select('role, is_active')
      .eq('id', userData.user.id)
      .maybeSingle();
    if (callerProfile?.role !== 'admin' || !callerProfile.is_active) return response({ error: 'Forbidden' }, 403);

    const { fullName, username, password, role, phone = '' } = await request.json();
    const cleanUsername = normalizeUsername(username);
    const cleanName = String(fullName ?? '').trim();
    const cleanPhone = String(phone ?? '').trim();

    if (!cleanName || !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(cleanUsername)) {
      return response({ error: 'اسم المستخدم يجب أن يتكون من 3 إلى 32 حرفاً أو رقماً إنجليزياً.' }, 400);
    }
    if (typeof password !== 'string' || password.length < 8) {
      return response({ error: 'كلمة المرور يجب أن تتكون من 8 أحرف على الأقل.' }, 400);
    }
    if (!validRoles.has(role)) return response({ error: 'الدور المحدد غير صالح.' }, 400);

    const { data: existing } = await admin
      .from('users')
      .select('id')
      .eq('username', cleanUsername)
      .maybeSingle();
    if (existing) return response({ error: 'اسم المستخدم مستخدم بالفعل.' }, 409);

    const internalEmail = cleanUsername + '.' + crypto.randomUUID().replaceAll('-', '') + '@accounts.zatkhail.invalid';
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: internalEmail,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: cleanName,
        username: cleanUsername,
        phone: cleanPhone,
      },
    });
    if (createError || !created.user) return response({ error: createError?.message ?? 'تعذر إنشاء الحساب.' }, 400);

    const { error: profileError } = await admin
      .from('users')
      .update({
        full_name: cleanName,
        username: cleanUsername,
        phone: cleanPhone || null,
        role,
        is_active: true,
        must_change_password: true,
      })
      .eq('id', created.user.id);

    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);
      return response({ error: 'تعذر إكمال ملف الحساب.' }, 500);
    }

    return response({
      account: {
        id: created.user.id,
        full_name: cleanName,
        username: cleanUsername,
        role,
      },
    }, 201);
  } catch (error) {
    console.error('Managed account creation failed:', error);
    return response({ error: 'تعذر إنشاء الحساب حالياً.' }, 500);
  }
});
