import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
const secretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const appOrigin = Deno.env.get('APP_ORIGIN') ?? '';

const trustedOrigins = new Set([
  appOrigin,
  'https://zat-khail.vercel.app',
  'https://thatkail.vercel.app',
].filter(Boolean));

function isTrustedOrigin(origin: string) {
  if (trustedOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function corsHeaders(request: Request) {
  const origin = request.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': isTrustedOrigin(origin) ? origin : appOrigin || 'https://zat-khail.vercel.app',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function response(request: Request, body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
  });
}

function validPassword(password: unknown) {
  return typeof password === 'string'
    && password.length >= 8
    && /\p{L}/u.test(password)
    && /\p{N}/u.test(password);
}

function normalizeUsernameConfirmation(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/^@+/, '');
}

function isMissingAuthUser(error: { status?: number; code?: string; message?: string } | null) {
  if (!error) return false;
  return error.status === 404
    || error.code === 'user_not_found'
    || /user.*not found/i.test(error.message ?? '');
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ''));
}

async function removeStoredFiles(admin: ReturnType<typeof createClient>, paths: unknown) {
  const cleanPaths = Array.isArray(paths)
    ? [...new Set(paths.map(path => String(path ?? '').trim()).filter(Boolean))]
    : [];
  for (let index = 0; index < cleanPaths.length; index += 100) {
    const { error } = await admin.storage.from('circle-files').remove(cleanPaths.slice(index, index + 100));
    if (error) throw error;
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) });
  if (request.method !== 'POST') return response(request, { error: 'Method not allowed' }, 405);
  if (!supabaseUrl || !publishableKey || !secretKey || !appOrigin) {
    return response(request, { error: 'Function configuration is incomplete' }, 500);
  }

  const authorization = request.headers.get('Authorization');
  if (!authorization) return response(request, { error: 'يجب تسجيل الدخول.' }, 401);

  try {
    const callerClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userData, error: userError } = await callerClient.auth.getUser();
    if (userError || !userData.user) return response(request, { error: 'جلسة الدخول غير صالحة.' }, 401);

    const admin = createClient(supabaseUrl, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: callerProfile } = await admin
      .from('users')
      .select('role, is_active')
      .eq('id', userData.user.id)
      .maybeSingle();
    if (callerProfile?.role !== 'admin' || !callerProfile.is_active) {
      return response(request, { error: 'هذه العملية متاحة للمدير فقط.' }, 403);
    }

    const { action, accountId, circleId, password, confirmation } = await request.json();

    if (action === 'delete_circle_impact') {
      if (!isUuid(circleId)) return response(request, { error: 'الحلقة المحددة غير صالحة.' }, 400);
      const { data, error } = await callerClient.rpc('get_circle_hard_delete_impact', { p_circle_id: circleId });
      if (error) return response(request, { error: 'تعذر حساب أثر حذف الحلقة.' }, 400);
      return response(request, { success: true, impact: data });
    }

    if (action === 'delete_circle') {
      if (!isUuid(circleId)) return response(request, { error: 'الحلقة المحددة غير صالحة.' }, 400);
      const { data: prepared, error: prepareError } = await admin.rpc('hard_delete_learning_circle', {
        p_circle_id: circleId,
        p_actor_id: userData.user.id,
        p_confirmation: String(confirmation ?? '').trim(),
      });
      if (prepareError || !prepared?.job_id) {
        console.error('Circle hard deletion preparation failed:', prepareError);
        return response(request, { error: 'تعذر حذف الحلقة. تأكد من اسم الحلقة ثم أعد المحاولة.' }, 400);
      }
      try {
        await removeStoredFiles(admin, prepared.storage_paths);
        await admin.rpc('complete_platform_deletion_job', {
          p_job_id: prepared.job_id, p_actor_id: userData.user.id, p_success: true, p_error: null,
        });
        return response(request, { success: true, deleted: true, impact: prepared.impact });
      } catch (cleanupError) {
        await admin.rpc('complete_platform_deletion_job', {
          p_job_id: prepared.job_id,
          p_actor_id: userData.user.id,
          p_success: false,
          p_error: cleanupError instanceof Error ? cleanupError.message : 'Storage cleanup failed',
        });
        return response(request, {
          success: true,
          deleted: true,
          cleanupPending: true,
          warning: 'حُذفت الحلقة، وتعذر حذف بعض ملفاتها الآن. سُجلت العملية لاستكمال التنظيف.',
        });
      }
    }

    const targetId = String(accountId ?? '');
    if (!isUuid(targetId)) return response(request, { error: 'الحساب المحدد غير صالح.' }, 400);
    if (targetId === userData.user.id) return response(request, { error: 'لا يمكنك تنفيذ هذه العملية على حسابك الحالي.' }, 403);

    const { data: target } = await admin
      .from('users')
      .select('id, full_name, username, role')
      .eq('id', targetId)
      .maybeSingle();
    if (!target) return response(request, { error: 'الحساب غير موجود.' }, 404);
    if (target.role === 'admin') return response(request, { error: 'الحسابات الإدارية محمية من هذه العملية.' }, 403);

    if (action === 'delete_account_impact') {
      const { data, error } = await callerClient.rpc('get_account_hard_delete_impact', { p_target_id: targetId });
      if (error) return response(request, { error: 'تعذر حساب أثر حذف الحساب.' }, 400);
      return response(request, { success: true, impact: data });
    }

    if (action === 'reset_password') {
      if (!validPassword(password)) {
        return response(request, { error: 'كلمة المرور المؤقتة يجب أن تتكون من 8 أحرف على الأقل وتحتوي حرفاً ورقماً.' }, 400);
      }
      const { error: authError } = await admin.auth.admin.updateUserById(targetId, { password });
      if (authError) return response(request, { error: 'تعذر تحديث كلمة المرور.' }, 400);

      const { error: profileError } = await admin
        .from('users')
        .update({ must_change_password: true })
        .eq('id', targetId);
      if (profileError) return response(request, { error: 'تم تحديث كلمة المرور وتعذر تفعيل طلب تغييرها.' }, 500);

      await admin.from('admin_audit_logs').insert({
        actor_id: userData.user.id,
        target_user_id: targetId,
        action: 'account.password_reset',
        metadata: { username: target.username },
      });
      return response(request, { success: true, mustChangePassword: true });
    }

    if (action === 'delete_account') {
      if (normalizeUsernameConfirmation(confirmation) !== normalizeUsernameConfirmation(target.username)) {
        return response(request, { error: 'اكتب اسم المستخدم كما هو لتأكيد الحذف.' }, 400);
      }

      const { data: prepared, error: prepareError } = await admin.rpc('prepare_account_hard_delete', {
        p_target_id: targetId,
        p_actor_id: userData.user.id,
        p_confirmation: confirmation,
      });
      if (prepareError || !prepared?.job_id) {
        console.error('Account hard deletion preparation failed:', prepareError);
        return response(request, { error: 'تعذر تجهيز الحساب للحذف. أعد المحاولة.' }, 500);
      }

      let cleanupError: unknown = null;
      try {
        await removeStoredFiles(admin, prepared.storage_paths);
      } catch (error) {
        cleanupError = error;
      }

      const { error: authDeleteError } = await admin.auth.admin.deleteUser(targetId, false);
      if (authDeleteError && !isMissingAuthUser(authDeleteError)) {
        await admin.rpc('complete_platform_deletion_job', {
          p_job_id: prepared.job_id,
          p_actor_id: userData.user.id,
          p_success: false,
          p_error: authDeleteError.message,
        });
        return response(request, { error: 'حُذف سجل الطالب وتعذر حذف بيانات الدخول. أعد المحاولة لإكمال العملية.' }, 500);
      }
      if (authDeleteError && isMissingAuthUser(authDeleteError)) {
        const { error: profileDeleteError } = await admin.from('users').delete().eq('id', targetId);
        if (profileDeleteError) {
          await admin.rpc('complete_platform_deletion_job', {
            p_job_id: prepared.job_id,
            p_actor_id: userData.user.id,
            p_success: false,
            p_error: profileDeleteError.message,
          });
          return response(request, { error: 'تعذر حذف ملف الحساب النهائي.' }, 500);
        }
      }

      await admin.rpc('complete_platform_deletion_job', {
        p_job_id: prepared.job_id,
        p_actor_id: userData.user.id,
        p_success: !cleanupError,
        p_error: cleanupError instanceof Error ? cleanupError.message : cleanupError ? 'Storage cleanup failed' : null,
      });
      return response(request, {
        success: true,
        deleted: true,
        cleanupPending: Boolean(cleanupError),
        warning: cleanupError ? 'حُذف الحساب، وتعذر حذف بعض ملفاته الآن. سُجلت لاستكمال التنظيف.' : null,
      });
    }

    return response(request, { error: 'العملية المطلوبة غير مدعومة.' }, 400);
  } catch (error) {
    console.error('Admin account action failed:', error);
    return response(request, { error: 'تعذر إتمام عملية الحساب حالياً.' }, 500);
  }
});
