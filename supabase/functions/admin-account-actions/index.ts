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

const historyChecks = [
  ['learning_circle_memberships', 'student_id', 'عضويات الحلقات'],
  ['learning_circle_staff', 'teacher_id', 'فريق الحلقات'],
  ['quran_report_assignments', 'student_id', 'التقارير القرآنية'],
  ['daily_assignments', 'student_id', 'المهام اليومية'],
  ['daily_assignments', 'teacher_id', 'المهام المنشأة'],
  ['assignment_submissions', 'student_id', 'تسليمات المهام'],
  ['assignment_extra_submissions', 'student_id', 'تسليمات الفصول'],
  ['quiz_submissions', 'student_id', 'نتائج الاختبارات'],
  ['attendance', 'student_id', 'سجل الحضور'],
  ['attendance', 'recorded_by', 'سجلات حضور أنشأها الحساب'],
  ['classroom_students', 'student_id', 'عضويات الفصول'],
  ['classrooms', 'teacher_id', 'فصول أنشأها الحساب'],
  ['halaqa_students', 'student_id', 'عضويات الحلقات القديمة'],
  ['halaqat', 'teacher_id', 'حلقات أنشأها الحساب'],
  ['parent_student', 'student_id', 'روابط ولي الأمر'],
  ['parent_student', 'parent_id', 'روابط الأبناء'],
  ['messages', 'sender_id', 'رسائل مرسلة'],
  ['messages', 'receiver_id', 'رسائل مستلمة'],
] as const;

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

    const { action, accountId, password, confirmation } = await request.json();
    const targetId = String(accountId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(targetId)) return response(request, { error: 'الحساب المحدد غير صالح.' }, 400);
    if (targetId === userData.user.id) return response(request, { error: 'لا يمكنك تنفيذ هذه العملية على حسابك الحالي.' }, 403);

    const { data: target } = await admin
      .from('users')
      .select('id, full_name, username, role')
      .eq('id', targetId)
      .maybeSingle();
    if (!target) return response(request, { error: 'الحساب غير موجود.' }, 404);
    if (target.role === 'admin') return response(request, { error: 'الحسابات الإدارية محمية من هذه العملية.' }, 403);

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
      if (String(confirmation ?? '').trim().toLowerCase() !== target.username) {
        return response(request, { error: 'اكتب اسم المستخدم كما هو لتأكيد الحذف.' }, 400);
      }

      const history: string[] = [];
      for (const [table, column, label] of historyChecks) {
        const { count, error } = await admin
          .from(table)
          .select('*', { count: 'exact', head: true })
          .eq(column, targetId);
        if (error) throw error;
        if ((count ?? 0) > 0) history.push(label);
      }
      if (history.length) {
        return response(request, {
          error: `لا يمكن حذف الحساب نهائياً لارتباطه بـ: ${history.slice(0, 4).join('، ')}. أوقف الحساب بدلاً من ذلك.`,
          code: 'ACCOUNT_HAS_HISTORY',
        }, 409);
      }

      const { error: deleteError } = await admin.auth.admin.deleteUser(targetId);
      if (deleteError) {
        return response(request, { error: 'تعذر حذف الحساب لوجود بيانات مرتبطة به. أوقف الحساب بدلاً من ذلك.' }, 409);
      }
      await admin.from('admin_audit_logs').insert({
        actor_id: userData.user.id,
        action: 'account.permanently_deleted',
        metadata: { target_id: targetId, username: target.username, role: target.role, full_name: target.full_name },
      });
      return response(request, { success: true });
    }

    return response(request, { error: 'العملية المطلوبة غير مدعومة.' }, 400);
  } catch (error) {
    console.error('Admin account action failed:', error);
    return response(request, { error: 'تعذر إتمام عملية الحساب حالياً.' }, 500);
  }
});
