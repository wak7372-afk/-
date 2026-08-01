import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, getSafeExternalUrl, showToast, formatDate } from '../lib/utils.js';

let currentTeacher = null;

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['teacher']);
  if (!authData) return;

  currentTeacher = authData.profile;
  await initI18n();

  document.getElementById('logout-btn').addEventListener('click', logoutUser);

  await loadUngradedSubmissions();
});

async function loadUngradedSubmissions() {
  const container = document.getElementById('submissions-list');
  container.innerHTML = '<p class="text-gray-500 text-center py-6">جاري تحميل التسليمات...</p>';

  const { data: classrooms } = await supabase.from('classrooms').select('id').eq('teacher_id', currentTeacher.id);
  const classroomIds = classrooms ? classrooms.map(c => c.id) : [];

  if (classroomIds.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">لا توجد فصول افتراضية مضافة لديك بعد.</p>';
    return;
  }

  const { data: assignments } = await supabase.from('assignments_extra').select('id, title').in('classroom_id', classroomIds);
  const assignmentIds = assignments ? assignments.map(a => a.id) : [];

  if (assignmentIds.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">لا توجد واجبات نصية مضافة بعد.</p>';
    return;
  }

  const { data: subs, error } = await supabase
    .from('assignment_extra_submissions')
    .select('*, student:student_id(full_name), assignment:assignment_extra_id(title)')
    .in('assignment_extra_id', assignmentIds)
    .order('submitted_at', { ascending: false });

  if (error || !subs || subs.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">لا توجد تسليمات بحاجة للتصحيح حالياً 👍</p>';
    return;
  }

  const cards = await Promise.all(subs.map(async s => {
    const safeFileUrl = await createSubmissionFileUrl(s.file_url);
    return `
    <div class="glass-card rounded-2xl p-6 border border-amber-400/30 shadow-md space-y-4">
      <div class="flex items-center justify-between border-b pb-2">
        <div>
          <h4 class="font-bold text-emerald-950 text-base">${escapeHtml(s.student?.full_name || 'طالب')}</h4>
          <p class="text-xs text-gray-500">الواجب: ${escapeHtml(s.assignment?.title || 'واجب')}</p>
        </div>
        <span class="text-xs text-gray-500">${escapeHtml(formatDate(s.submitted_at))}</span>
      </div>

      ${s.content ? `<div class="p-4 bg-slate-50 rounded-xl border text-sm text-gray-800">${escapeHtml(s.content)}</div>` : ''}
      ${safeFileUrl ? `<a href="${escapeHtml(safeFileUrl)}" target="_blank" rel="noopener noreferrer" class="text-xs text-emerald-700 font-bold underline block">تحميل الملف المرفق ➔</a>` : ''}

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
        <div>
          <label class="block text-xs font-bold text-gray-700 mb-1">الدرجة (من 100)</label>
          <input type="number" id="grade_${escapeHtml(s.id)}" value="${escapeHtml(s.grade ?? '')}" min="0" max="100" placeholder="95"
            class="w-full px-3.5 py-2 rounded-xl border text-sm outline-none bg-white">
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-700 mb-1">ملاحظات وتقييم المعلم</label>
          <input type="text" id="feedback_${escapeHtml(s.id)}" value="${escapeHtml(s.teacher_feedback || '')}" placeholder="أحسنت بارك الله فيك..."
            class="w-full px-3.5 py-2 rounded-xl border text-sm outline-none bg-white">
        </div>
      </div>

      <button type="button" data-save-grade="${escapeHtml(s.id)}" class="btn-emerald text-xs px-6 py-2.5 rounded-xl font-bold">
        ${s.graded_at ? 'تحديث التقييم' : 'حفظ التقييم والدرجة'}
      </button>
    </div>
  `;
  }));
  container.innerHTML = cards.join('');

  container.querySelectorAll('[data-save-grade]').forEach(button => {
    button.addEventListener('click', () => window.saveGrade(button.dataset.saveGrade, button));
  });
}

async function createSubmissionFileUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return getSafeExternalUrl(path);
  const { data, error } = await supabase.storage
    .from('assignment-submissions')
    .createSignedUrl(path, 300);
  return error ? '' : data?.signedUrl || '';
}

window.saveGrade = async function(subId, button) {
  const grade = document.getElementById(`grade_${subId}`).value;
  const feedback = document.getElementById(`feedback_${subId}`).value.trim();

  if (grade === '' || Number(grade) < 0 || Number(grade) > 100) {
    showToast('أدخل درجة صحيحة من 0 إلى 100.', 'error');
    return;
  }

  button.disabled = true;
  button.textContent = 'جاري حفظ التقييم...';
  try {
    const { error } = await supabase
      .from('assignment_extra_submissions')
      .update({
        grade: Number(grade),
        teacher_feedback: feedback,
        graded_at: new Date().toISOString()
      })
      .eq('id', subId);

    if (error) throw error;
    showToast('تم حفظ التقييم وإشعار الطالب.', 'success');
    await loadUngradedSubmissions();
  } catch (err) {
    showToast(err.message || 'فشل حفظ التقييم', 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'حفظ التقييم والدرجة';
  }
};
