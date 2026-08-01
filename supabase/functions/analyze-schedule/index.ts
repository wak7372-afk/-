import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
const secretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
const appOrigin = Deno.env.get('APP_ORIGIN') ?? '';
const geminiApiKey = Deno.env.get('GEMINI_API_KEY') ?? '';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': appOrigin || 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  };
}

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

function isAllowedOrigin(request: Request) {
  return Boolean(appOrigin && request.headers.get('Origin') === appOrigin);
}

function sanitizeAssignments(value: unknown, students: Array<{ id: string; full_name: string }>) {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { assignments?: unknown; summary?: unknown; recommendations?: unknown };
  if (!Array.isArray(raw.assignments)) return null;
  const studentIds = new Set(students.map(student => student.id));
  const assignments = raw.assignments.slice(0, 500).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const assignment = item as Record<string, unknown>;
    const studentId = String(assignment.student_id || '');
    const type = assignment.type === 'murajaa' ? 'murajaa' : assignment.type === 'hifz' ? 'hifz' : '';
    const date = String(assignment.date || '');
    const content = String(assignment.content || '').trim();
    if (!studentIds.has(studentId) || !type || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !content || content.length > 1000) return [];
    const student = students.find(candidate => candidate.id === studentId);
    return [{
      student_id: studentId,
      student_name: student?.full_name || 'طالب',
      type,
      content,
      date,
    }];
  });
  const recommendations = Array.isArray(raw.recommendations)
    ? raw.recommendations.slice(0, 8).map(item => String(item).slice(0, 300))
    : [];
  return {
    assignments,
    summary: String(raw.summary || 'تم تحليل الجدول.').slice(0, 1000),
    recommendations,
  };
}

async function authenticate(request: Request) {
  const authorization = request.headers.get('Authorization');
  if (!authorization || !supabaseUrl || !publishableKey || !secretKey) return null;

  const caller = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return null;

  const admin = createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: profile } = await admin
    .from('users')
    .select('id, role, is_active')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (!profile?.is_active || !['teacher', 'admin'].includes(profile.role)) return null;
  return { admin, profile };
}

async function analyzeWithGemini(tableData: unknown[], students: Array<{ id: string; full_name: string }>) {
  if (!geminiApiKey) throw new Error('خدمة الذكاء الاصطناعي غير مهيأة بعد.');
  const prompt = `
أنت مساعد ذكي لمركز تحفيظ قرآن كريم. حلل جدول المقررات التالي ووزعه فقط على الطلاب الموجودين في القائمة.
أخرج JSON فقط بالشكل:
{"assignments":[{"student_id":"uuid","type":"hifz أو murajaa","content":"...","date":"YYYY-MM-DD"}],"summary":"...","recommendations":["..."]}
الطلاب: ${JSON.stringify(students)}
الجدول: ${JSON.stringify(tableData)}
`;
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
  const result = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!result.ok) throw new Error('تعذر الحصول على نتيجة التحليل الذكي.');
  const data = await result.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('نتيجة الذكاء الاصطناعي غير صالحة.');
  return sanitizeAssignments(JSON.parse(match[0]), students);
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  if (!isAllowedOrigin(request)) return response({ error: 'Origin not allowed' }, 403);

  try {
    const auth = await authenticate(request);
    if (!auth) return response({ error: 'يجب تسجيل الدخول بحساب معلم نشط.' }, 401);

    const body = await request.json();
    const halaqaId = String(body.halaqaId || '');
    const tableData = Array.isArray(body.tableData) ? body.tableData.slice(0, 500) : [];
    if (!halaqaId || !tableData.length) return response({ error: 'بيانات الحلقة أو الجدول غير مكتملة.' }, 400);

    const { data: halaqa } = await auth.admin
      .from('halaqat')
      .select('id, teacher_id')
      .eq('id', halaqaId)
      .maybeSingle();
    if (!halaqa || (auth.profile.role === 'teacher' && halaqa.teacher_id !== auth.profile.id)) {
      return response({ error: 'لا تملك صلاحية تحليل جدول هذه الحلقة.' }, 403);
    }

    const { data: relations, error: studentsError } = await auth.admin
      .from('halaqa_students')
      .select('student:student_id(id, full_name)')
      .eq('halaqa_id', halaqaId);
    if (studentsError) throw studentsError;
    const students = (relations || []).map(item => item.student).filter(Boolean);
    if (!students.length) return response({ error: 'لا يوجد طلاب في الحلقة المحددة.' }, 400);

    const result = await analyzeWithGemini(tableData, students);
    if (!result) return response({ error: 'تعذر التحقق من نتيجة التحليل.' }, 502);
    return response(result);
  } catch (error) {
    console.error('Schedule analysis failed:', error);
    return response({ error: error instanceof Error ? error.message : 'تعذر تحليل الجدول حالياً.' }, 500);
  }
});
