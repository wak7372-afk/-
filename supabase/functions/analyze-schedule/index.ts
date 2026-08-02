import { createClient } from 'npm:@supabase/supabase-js@2';

type Student = { id: string; full_name: string; username: string };
type Assignment = {
  student_id: string;
  student_name: string;
  type: 'hifz' | 'murajaa';
  title: string;
  content: string;
  date: string;
  period: 'morning' | 'evening' | 'flexible';
  due_time: string;
  estimated_minutes: number;
  priority: number;
};

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

function normalizeText(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ');
}

function clampInteger(value: unknown, defaultValue: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : defaultValue;
}

function toDateKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function parseDate(value: unknown, offsetIndex: number) {
  if (typeof value === 'number' && value > 1) {
    return toDateKey(new Date(Date.UTC(1899, 11, 30) + value * 86400000));
  }
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    return toDateKey(new Date(Date.UTC(year, month - 1, day)));
  }
  const dayFirst = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (dayFirst) return toDateKey(new Date(Date.UTC(Number(dayFirst[3]), Number(dayFirst[2]) - 1, Number(dayFirst[1]))));
  const parsed = new Date(text);
  if (text && !Number.isNaN(parsed.getTime())) return toDateKey(parsed);
  const inferredDate = new Date();
  inferredDate.setUTCDate(inferredDate.getUTCDate() + offsetIndex);
  return toDateKey(inferredDate);
}

function getRowValue(row: Record<string, unknown>, aliases: string[]) {
  const normalizedAliases = aliases.map(normalizeText);
  const match = Object.entries(row).find(([key]) => normalizedAliases.includes(normalizeText(key)));
  return match?.[1] ?? '';
}

function findStudent(value: unknown, students: Student[]) {
  const needle = normalizeText(value).replace(/^@/, '');
  if (!needle) return null;
  return students.find(student => {
    const username = normalizeText(student.username).replace(/^@/, '');
    return normalizeText(student.id) === needle || username === needle || normalizeText(student.full_name) === needle;
  });
}

function sanitizeRows(value: unknown[]) {
  return value.slice(0, 500).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row: Record<string, string | number> = {};
    Object.entries(item as Record<string, unknown>).slice(0, 40).forEach(([key, cell]) => {
      if (typeof cell === 'number') row[String(key).slice(0, 80)] = cell;
      else row[String(key).slice(0, 80)] = String(cell ?? '').slice(0, 2000);
    });
    return [row];
  });
}

function sanitizeAssignment(item: Record<string, unknown>, students: Student[]): Assignment | null {
  const requestedStudentId = String(item.student_id ?? '').trim();
  const student = requestedStudentId ? students.find(candidate => candidate.id === requestedStudentId) : null;
  if (requestedStudentId && !student) return null;
  const type = item.type === 'murajaa' ? 'murajaa' : item.type === 'hifz' ? 'hifz' : null;
  const date = String(item.date ?? '');
  const title = String(item.title ?? '').trim().slice(0, 160);
  const content = String(item.content ?? '').trim().slice(0, 2000);
  const period = ['morning', 'evening', 'flexible'].includes(String(item.period))
    ? String(item.period) as Assignment['period']
    : 'flexible';
  const dueTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(item.due_time ?? '')) ? String(item.due_time) : '';
  if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !title || !content) return null;
  return {
    student_id: requestedStudentId,
    student_name: student?.full_name || 'كل طلاب الحلقة',
    type,
    title,
    content,
    date,
    period,
    due_time: dueTime,
    estimated_minutes: clampInteger(item.estimated_minutes, 30, 5, 480),
    priority: clampInteger(item.priority, 2, 1, 3),
  };
}

function analyzeStructuredRows(rows: Record<string, string | number>[], students: Student[]) {
  const assignments: Assignment[] = [];
  const issues: string[] = [];
  rows.forEach((row, index) => {
    const studentValue = getRowValue(row, ['اسم الطالب', 'الطالب', 'اسم المستخدم', 'username', 'student']);
    const student = findStudent(studentValue, students);
    if (String(studentValue).trim() && !student) {
      issues.push(`الصف ${index + 2}: لم يُعثر على الطالب «${String(studentValue).slice(0, 80)}».`);
      return;
    }
    const typeValue = normalizeText(getRowValue(row, ['النوع', 'نوع المهمة', 'نوع المقرر', 'type']));
    const type: Assignment['type'] = typeValue.includes('مراجع') || typeValue.includes('muraj') ? 'murajaa' : 'hifz';
    const rawContent = getRowValue(row, ['المحتوى', 'المقرر', 'الحفظ', 'المراجعة', 'التفاصيل', 'content', 'assignment']);
    const content = String(rawContent || Object.values(row).filter(Boolean).join(' | ')).trim().slice(0, 2000);
    if (!content) {
      issues.push(`الصف ${index + 2}: لا يوجد محتوى للمهمة.`);
      return;
    }
    const periodValue = normalizeText(getRowValue(row, ['الفترة', 'الوقت', 'period']));
    const period: Assignment['period'] = periodValue.includes('صباح') || periodValue.includes('morning')
      ? 'morning'
      : periodValue.includes('مساء') || periodValue.includes('evening') ? 'evening' : 'flexible';
    const dueCandidate = String(getRowValue(row, ['وقت التسليم', 'موعد التسليم', 'الساعة', 'due time', 'due_time'])).trim();
    const dueMatch = dueCandidate.match(/(?:^|\s)([0-2]?\d:[0-5]\d)(?:\s|$)/);
    assignments.push({
      student_id: student?.id || '',
      student_name: student?.full_name || 'كل طلاب الحلقة',
      type,
      title: String(getRowValue(row, ['العنوان', 'عنوان المهمة', 'title']) || (type === 'hifz' ? 'الحفظ الجديد' : 'مراجعة المحفوظ')).trim().slice(0, 160),
      content,
      date: parseDate(getRowValue(row, ['التاريخ', 'تاريخ المهمة', 'date']), index),
      period,
      due_time: dueMatch ? dueMatch[1].padStart(5, '0') : '',
      estimated_minutes: clampInteger(getRowValue(row, ['المدة', 'المدة بالدقائق', 'estimated minutes', 'duration']), 30, 5, 480),
      priority: clampInteger(getRowValue(row, ['الأولوية', 'priority']), 2, 1, 3),
    });
  });
  return { assignments, issues };
}

function sanitizeGeminiResult(value: unknown, students: Student[]) {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { assignments?: unknown; summary?: unknown; recommendations?: unknown };
  if (!Array.isArray(raw.assignments)) return null;
  const assignments = raw.assignments.slice(0, 500)
    .map(item => item && typeof item === 'object' ? sanitizeAssignment(item as Record<string, unknown>, students) : null)
    .filter((item): item is Assignment => Boolean(item));
  if (!assignments.length) return null;
  return {
    assignments,
    summary: String(raw.summary || 'تم تحليل الجدول.').slice(0, 1000),
    recommendations: Array.isArray(raw.recommendations)
      ? raw.recommendations.slice(0, 6).map(item => String(item).slice(0, 240))
      : [],
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
  const admin = createClient(supabaseUrl, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: profile } = await admin.from('users').select('id, role, is_active').eq('id', userData.user.id).maybeSingle();
  if (!profile?.is_active || !['teacher', 'admin'].includes(profile.role)) return null;
  return { admin, profile };
}

async function analyzeWithGemini(tableData: Record<string, string | number>[], students: Student[]) {
  if (!geminiApiKey) return null;
  const prompt = `أنت محلل جداول لمركز تعليم القرآن. حوّل الصفوف إلى مهام قابلة للنشر، ولا تخترع طالباً خارج القائمة.
أعد JSON فقط: {"assignments":[{"student_id":"uuid أو فارغ للمجموعة","type":"hifz أو murajaa","title":"عنوان","content":"التفاصيل","date":"YYYY-MM-DD","period":"morning أو evening أو flexible","due_time":"HH:MM أو فارغ","estimated_minutes":30,"priority":2}],"summary":"ملخص","recommendations":["توصية"]}.
تاريخ اليوم: ${toDateKey(new Date())}. الطلاب: ${JSON.stringify(students)}. الجدول: ${JSON.stringify(tableData)}`;
  const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  if (!result.ok) return null;
  const data = await result.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  try {
    return sanitizeGeminiResult(JSON.parse(text), students);
  } catch (_) {
    return null;
  }
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  if (!isAllowedOrigin(request)) return response({ error: 'Origin not allowed' }, 403);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 1_500_000) return response({ error: 'حجم بيانات الجدول كبير جداً.' }, 413);

  try {
    const auth = await authenticate(request);
    if (!auth) return response({ error: 'يجب تسجيل الدخول بحساب معلم نشط.' }, 401);
    const body = await request.json();
    const halaqaId = String(body.halaqaId || '');
    const tableData = sanitizeRows(Array.isArray(body.tableData) ? body.tableData : []);
    if (!halaqaId || !tableData.length) return response({ error: 'بيانات الحلقة أو الجدول غير مكتملة.' }, 400);

    const { data: halaqa } = await auth.admin.from('halaqat').select('id, teacher_id').eq('id', halaqaId).maybeSingle();
    if (!halaqa || (auth.profile.role === 'teacher' && halaqa.teacher_id !== auth.profile.id)) {
      return response({ error: 'لا تملك صلاحية تحليل جدول هذه الحلقة.' }, 403);
    }
    const { data: relations, error: studentsError } = await auth.admin
      .from('halaqa_students')
      .select('student:student_id(id, full_name, username)')
      .eq('halaqa_id', halaqaId);
    if (studentsError) throw studentsError;
    const students = (relations || []).map(item => item.student as unknown as Student).filter(Boolean);
    if (!students.length) return response({ error: 'لا يوجد طلاب في الحلقة المحددة.' }, 400);

    const deterministic = analyzeStructuredRows(tableData, students);
    const aiResult = await analyzeWithGemini(tableData, students);
    if (aiResult) {
      return response({ ...aiResult, issues: deterministic.issues, analysis_mode: 'ai', rows_received: tableData.length });
    }
    if (!deterministic.assignments.length) {
      return response({ error: 'لم نجد صفوفاً صالحة للنشر. راجع أسماء الطلاب وأعمدة المحتوى.' }, 422);
    }
    return response({
      assignments: deterministic.assignments,
      issues: deterministic.issues,
      analysis_mode: 'structured',
      rows_received: tableData.length,
      summary: `تمت قراءة ${tableData.length} صف وتجهيز ${deterministic.assignments.length} مهمة للمراجعة.`,
      recommendations: deterministic.issues.length
        ? ['راجع الصفوف المعلّمة قبل اعتماد الدفعة.', 'استخدم اسم المستخدم لتفادي تشابه أسماء الطلاب.']
        : ['الجدول منظم وجاهز للمراجعة النهائية.'],
    });
  } catch (error) {
    console.error('Schedule analysis failed:', error);
    return response({ error: error instanceof Error ? error.message : 'تعذر تحليل الجدول حالياً.' }, 500);
  }
});
