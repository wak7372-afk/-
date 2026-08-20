import { supabase } from '../lib/supabase-client.js';
import { isLocalPreviewMode, requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast } from '../lib/utils.js';

let currentParent = null;
let isLoading = false;
let previewChildLinked = true;

const grid = document.getElementById('children-dashboard-grid');
const linkForm = document.getElementById('link-child-form');
const linkButton = document.getElementById('link-child-btn');

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function formatShortDate(value) {
  if (!value) return 'غير محدد';
  return new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(value));
}

function percentage(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 100);
}

function showEmptyState() {
  grid.innerHTML = `
    <div class="col-span-full rounded-lg border border-dashed border-amber-300 bg-white px-6 py-12 text-center">
      <div class="brand-mark-shell mx-auto h-12 w-12" aria-hidden="true"><img class="brand-emblem" src="/assets/brand/zat-khail-emblem.png" alt=""></div>
      <h3 class="mt-4 font-amiri text-2xl font-bold text-emerald-950">لا توجد حسابات أبناء مرتبطة</h3>
      <p class="mx-auto mt-2 max-w-lg text-xs leading-6 text-slate-500">اطلب رمز الربط من الطالب بعد تفعيل حسابه، ثم أدخله في الحقل أعلاه لعرض المتابعة.</p>
    </div>`;
}

function showLoadError(message) {
  grid.innerHTML = `
    <div class="col-span-full rounded-2xl border border-red-200 bg-red-50 p-8 text-center">
      <p class="text-sm font-bold text-red-800">تعذر تحميل بيانات المتابعة</p>
      <p class="mt-2 text-xs leading-6 text-red-600">${escapeHtml(message)}</p>
    </div>`;
}

function renderChildCard(student, data) {
  const attendance = data.attendance;
  const presentCount = attendance.filter(item => item.status === 'present').length;
  const absentCount = attendance.filter(item => item.status === 'absent').length;
  const excusedCount = attendance.filter(item => item.status === 'excused').length;
  const attendanceRate = percentage(presentCount, attendance.length);
  const completedCount = data.dailySubmissions.filter(item => item.status === 'done').length;
  const latestSubmission = data.dailySubmissions[0];
  const quizScores = data.quizSubmissions
    .map(item => Number(item.score))
    .filter(Number.isFinite);
  const quizAverage = quizScores.length
    ? Math.round(quizScores.reduce((sum, score) => sum + score, 0) / quizScores.length)
    : null;
  const extraGrades = data.extraSubmissions
    .map(item => Number(item.grade))
    .filter(Number.isFinite);
  const extraAverage = extraGrades.length
    ? Math.round(extraGrades.reduce((sum, score) => sum + score, 0) / extraGrades.length)
    : null;

  const latestAssignmentHtml = latestSubmission
    ? `
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-xs font-bold text-slate-800">${escapeHtml(latestSubmission.assignment?.content || 'ورد قرآني')}</p>
          <p class="mt-1 text-[10px] text-slate-500">${formatShortDate(latestSubmission.assignment?.assignment_date || latestSubmission.created_at)}</p>
        </div>
        <span class="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${latestSubmission.status === 'done' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">
          ${latestSubmission.status === 'done' ? 'مكتمل' : 'قيد المتابعة'}
        </span>
      </div>
      ${latestSubmission.teacher_notes ? `<p class="mt-3 rounded-lg bg-white p-2 text-[10px] leading-5 text-amber-800">ملاحظة المعلم: ${escapeHtml(latestSubmission.teacher_notes)}</p>` : ''}`
    : '<p class="text-[11px] text-slate-500">لا يوجد ورد مسجل حتى الآن.</p>';

  const quizRows = data.quizSubmissions.length
    ? data.quizSubmissions.slice(0, 3).map(item => `
      <div class="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-[11px]">
        <span class="truncate pl-3 text-slate-600">${escapeHtml(item.quiz?.title || 'اختبار')}</span>
        <span class="font-extrabold text-amber-700">${Number.isFinite(Number(item.score)) ? `${Math.round(Number(item.score))}%` : '—'}</span>
      </div>`).join('')
    : '<p class="text-[11px] text-slate-500">لا توجد نتائج اختبارات بعد.</p>';

  return `
    <article class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm" data-child-id="${escapeHtml(student.id)}">
      <div class="flex items-center justify-between gap-4 border-b border-slate-100 bg-gradient-to-l from-emerald-50 to-white p-5">
        <div class="flex min-w-0 items-center gap-3">
          <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-800 font-amiri text-xl font-bold text-amber-300">${escapeHtml(student.full_name?.trim().charAt(0) || 'ط')}</div>
          <div class="min-w-0">
            <h3 class="truncate font-amiri text-xl font-bold text-emerald-950">${escapeHtml(student.full_name)}</h3>
            <p class="truncate text-[10px] text-slate-500" dir="ltr">@${escapeHtml(student.username || '')}</p>
          </div>
        </div>
        <button type="button" data-action="unlink" data-student-id="${escapeHtml(student.id)}" class="rounded-lg border border-red-200 px-3 py-2 text-[10px] font-bold text-red-600 transition hover:bg-red-50">إلغاء الربط</button>
      </div>

      <div class="space-y-5 p-5">
        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="rounded-xl border border-emerald-100 bg-emerald-50 p-3"><p class="text-[9px] text-emerald-700">الحضور</p><p class="mt-1 text-lg font-extrabold text-emerald-900">${attendanceRate === null ? '—' : `${attendanceRate}%`}</p></div>
          <div class="rounded-xl border border-amber-100 bg-amber-50 p-3"><p class="text-[9px] text-amber-700">متوسط الاختبارات</p><p class="mt-1 text-lg font-extrabold text-amber-900">${quizAverage === null ? '—' : `${quizAverage}%`}</p></div>
          <div class="rounded-xl border border-sky-100 bg-sky-50 p-3"><p class="text-[9px] text-sky-700">الواجبات</p><p class="mt-1 text-lg font-extrabold text-sky-900">${extraAverage === null ? '—' : `${extraAverage}%`}</p></div>
        </div>

        <section>
          <div class="mb-2 flex items-center justify-between"><h4 class="text-xs font-bold text-emerald-950">آخر ورد قرآني</h4><span class="text-[10px] text-slate-400">${completedCount} مكتمل</span></div>
          <div class="rounded-xl border border-slate-100 bg-slate-50 p-4">${latestAssignmentHtml}</div>
        </section>

        <section>
          <div class="mb-2 flex items-center justify-between"><h4 class="text-xs font-bold text-emerald-950">سجل الحضور</h4><span class="text-[10px] text-slate-400">${attendance.length} جلسة</span></div>
          <div class="grid grid-cols-3 gap-2 text-center text-[10px]">
            <div class="rounded-lg bg-emerald-50 p-2 text-emerald-800">حاضر <strong class="block text-sm">${presentCount}</strong></div>
            <div class="rounded-lg bg-red-50 p-2 text-red-800">غائب <strong class="block text-sm">${absentCount}</strong></div>
            <div class="rounded-lg bg-slate-100 p-2 text-slate-700">بعذر <strong class="block text-sm">${excusedCount}</strong></div>
          </div>
        </section>

        <section>
          <h4 class="mb-2 text-xs font-bold text-emerald-950">أحدث الاختبارات</h4>
          <div class="space-y-2">${quizRows}</div>
        </section>
      </div>
    </article>`;
}

async function fetchChildrenData(studentIds) {
  const [dailyResult, quizResult, attendanceResult, extraResult] = await Promise.all([
    supabase
      .from('assignment_submissions')
      .select('id, student_id, status, teacher_notes, created_at, assignment:assignment_id(content, type, assignment_date)')
      .in('student_id', studentIds)
      .order('created_at', { ascending: false }),
    supabase
      .from('quiz_submissions')
      .select('id, student_id, score, submitted_at, quiz:quiz_id(title)')
      .in('student_id', studentIds)
      .order('submitted_at', { ascending: false }),
    supabase
      .from('attendance')
      .select('id, student_id, status, attendance_date')
      .in('student_id', studentIds)
      .order('attendance_date', { ascending: false }),
    supabase
      .from('assignment_extra_submissions')
      .select('id, student_id, grade, graded_at')
      .in('student_id', studentIds)
      .not('grade', 'is', null)
      .order('graded_at', { ascending: false }),
  ]);

  const failed = [dailyResult, quizResult, attendanceResult, extraResult].find(result => result.error);
  if (failed?.error) throw failed.error;

  return {
    daily: dailyResult.data || [],
    quizzes: quizResult.data || [],
    attendance: attendanceResult.data || [],
    extras: extraResult.data || [],
  };
}

function updateOverallStats(students, records) {
  const present = records.attendance.filter(item => item.status === 'present').length;
  const attendanceRate = percentage(present, records.attendance.length);
  const quizScores = records.quizzes.map(item => Number(item.score)).filter(Number.isFinite);
  const quizAverage = quizScores.length
    ? Math.round(quizScores.reduce((sum, score) => sum + score, 0) / quizScores.length)
    : null;
  const completed = records.daily.filter(item => item.status === 'done').length;

  setText('stat-children', String(students.length));
  setText('stat-attendance', attendanceRate === null ? '—' : `${attendanceRate}%`);
  setText('stat-quizzes', quizAverage === null ? '—' : `${quizAverage}%`);
  setText('stat-completed', String(completed));
  setText('last-updated', `آخر تحديث: ${new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date())}`);
}

async function loadLinkedChildren() {
  if (isLoading) return;
  isLoading = true;
  grid.innerHTML = '<div class="col-span-full rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">جاري تحميل بيانات الأبناء...</div>';

  try {
    if (isLocalPreviewMode()) {
      const students = previewChildLinked ? [{ id: 'preview-child', full_name: 'عبدالله بن محمد', username: 'student.preview' }] : [];
      const records = previewParentRecords();
      updateOverallStats(students, records);
      grid.innerHTML = students.length ? students.map(student => renderChildCard(student, {
        dailySubmissions: records.daily,
        quizSubmissions: records.quizzes,
        attendance: records.attendance,
        extraSubmissions: records.extras,
      })).join('') : '';
      if (!students.length) showEmptyState();
      return;
    }

    const { data: relations, error } = await supabase
      .from('parent_student')
      .select('student:student_id(id, full_name, username)')
      .eq('parent_id', currentParent.id);

    if (error) throw error;
    const students = (relations || []).map(item => item.student).filter(Boolean);

    if (!students.length) {
      updateOverallStats([], { daily: [], quizzes: [], attendance: [], extras: [] });
      showEmptyState();
      return;
    }

    const records = await fetchChildrenData(students.map(student => student.id));
    updateOverallStats(students, records);

    grid.innerHTML = students.map(student => renderChildCard(student, {
      dailySubmissions: records.daily.filter(item => item.student_id === student.id),
      quizSubmissions: records.quizzes.filter(item => item.student_id === student.id),
      attendance: records.attendance.filter(item => item.student_id === student.id),
      extraSubmissions: records.extras.filter(item => item.student_id === student.id),
    })).join('');
  } catch (error) {
    console.error('Parent dashboard load error:', error);
    showLoadError(error.message || 'حدث خطأ غير متوقع.');
  } finally {
    isLoading = false;
  }
}

async function handleLinkChild(event) {
  event.preventDefault();
  if (!linkForm.reportValidity()) return;

  const input = document.getElementById('child-link-code');
  const code = input.value.trim().toUpperCase();
  linkButton.disabled = true;
  linkButton.classList.add('cursor-not-allowed', 'opacity-60');
  linkButton.textContent = 'جاري الربط...';

  try {
    if (isLocalPreviewMode()) {
      previewChildLinked = true;
    } else {
      const { error } = await supabase.rpc('link_child_by_code', { p_code: code });
      if (error) {
        if ((error.message || '').includes('Invalid child link code')) {
          throw new Error('رمز الربط غير صحيح أو أن حساب الطالب غير مفعّل.');
        }
        throw error;
      }
    }

    input.value = '';
    showToast('تم ربط حساب الطالب بنجاح.', 'success');
    await loadLinkedChildren();
  } catch (error) {
    showToast(error.message || 'تعذر ربط حساب الطالب.', 'error');
  } finally {
    linkButton.disabled = false;
    linkButton.classList.remove('cursor-not-allowed', 'opacity-60');
    linkButton.textContent = 'ربط الحساب';
  }
}

async function unlinkChild(studentId) {
  if (!window.confirm('هل تريد إلغاء ربط هذا الحساب؟ يمكن إعادة الربط لاحقاً باستخدام الرمز الخاص.')) return;

  if (isLocalPreviewMode()) {
    previewChildLinked = false;
    showToast('تم إلغاء ربط الحساب.', 'success');
    await loadLinkedChildren();
    return;
  }

  const { error } = await supabase
    .from('parent_student')
    .delete()
    .eq('parent_id', currentParent.id)
    .eq('student_id', studentId);

  if (error) {
    showToast('تعذر إلغاء الربط.', 'error');
    return;
  }

  showToast('تم إلغاء ربط الحساب.', 'success');
  await loadLinkedChildren();
}

async function initialize() {
  const authData = await requireAuth(['parent']);
  if (!authData) return;

  currentParent = authData.profile;
  await initI18n();
  setText('parent-name', currentParent.full_name);

  document.getElementById('logout-btn').addEventListener('click', logoutUser);
  document.getElementById('refresh-btn').addEventListener('click', loadLinkedChildren);
  linkForm.addEventListener('submit', handleLinkChild);
  grid.addEventListener('click', event => {
    const button = event.target.closest('[data-action="unlink"]');
    if (button) unlinkChild(button.dataset.studentId);
  });

  await loadLinkedChildren();
}

document.addEventListener('DOMContentLoaded', initialize);

function previewParentRecords() {
  const now = new Date().toISOString();
  return {
    daily: [{
      id: 'preview-daily', student_id: 'preview-child', status: 'done', created_at: now,
      teacher_notes: 'أداء متقن، بارك الله فيك.',
      assignment: { content: 'حفظ سورة الملك من الآية 1 إلى 8', type: 'hifz', assignment_date: now },
    }],
    quizzes: [{ id: 'preview-quiz', student_id: 'preview-child', score: 92, submitted_at: now, quiz: { title: 'أحكام النون الساكنة' } }],
    attendance: [
      { id: 'preview-attendance-1', student_id: 'preview-child', status: 'present', attendance_date: now },
      { id: 'preview-attendance-2', student_id: 'preview-child', status: 'present', attendance_date: now },
      { id: 'preview-attendance-3', student_id: 'preview-child', status: 'excused', attendance_date: now },
    ],
    extras: [{ id: 'preview-extra', student_id: 'preview-child', grade: 88, graded_at: now }],
  };
}
