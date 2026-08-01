import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { showToast, formatDate, escapeHtml } from '../lib/utils.js';

let currentStudent = null;

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['student']);
  if (!authData) return;

  currentStudent = authData.profile;
  await initI18n();

  document.getElementById('student-name').textContent = currentStudent.full_name;
  document.getElementById('logout-btn').addEventListener('click', logoutUser);

  const familyCode = currentStudent.family_link_code || '';
  document.getElementById('family-link-code').textContent = familyCode || 'غير متاح';
  document.getElementById('copy-family-code').addEventListener('click', async () => {
    if (!familyCode) {
      showToast('رمز الربط غير متاح. تواصل مع إدارة المركز.', 'error');
      return;
    }

    try {
      await navigator.clipboard.writeText(familyCode);
      showToast('تم نسخ رمز الربط.', 'success');
    } catch (_) {
      showToast(`رمز الربط: ${familyCode}`, 'info');
    }
  });

  await loadTodayWird();
  await loadJoinedClassrooms();
});

async function loadTodayWird() {
  const container = document.getElementById('today-wird-list');
  container.innerHTML = '<p class="text-gray-500 text-center py-6">جاري تحميل ورد اليوم...</p>';

  const { data: submissions, error } = await supabase
    .from('assignment_submissions')
    .select('*, assignment:assignment_id(*)')
    .eq('student_id', currentStudent.id)
    .order('created_at', { ascending: false });

  if (error) {
    showToast('حدث خطأ أثناء جلب الورد اليومي', 'error');
    return;
  }

  if (!submissions || submissions.length === 0) {
    container.innerHTML = `
      <div class="text-center py-10">
        <p class="text-xl font-bold text-emerald-950 mb-2 font-amiri">لا يوجد ورد مستهدف اليوم 🌸</p>
        <p class="text-xs text-gray-500">سوف يظهر هنا المقررات اليومية عندما يحددها معلم الحلقة.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = submissions.map(sub => {
    const isDone = sub.status === 'done';
    const assign = sub.assignment;
    if (!assign) return '';

    return `
      <div class="glass-card rounded-2xl p-6 border ${isDone ? 'border-emerald-300 bg-emerald-50/20' : 'border-amber-400/40'} shadow-md transition">
        <div class="flex items-center justify-between mb-3">
          <span class="px-3 py-1 rounded-full text-xs font-bold ${assign.type === 'hifz' ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}">
            ${assign.type === 'hifz' ? 'ورد الحفظ اليومي' : 'ورد المراجعة اليومي'}
          </span>
          <span class="text-xs font-semibold ${isDone ? 'text-emerald-700' : 'text-amber-700'}">
            ${isDone ? '✓ تم الإتمام ولله الحمد' : '⏳ قيد الإنجاز'}
          </span>
        </div>

        <h3 class="font-amiri text-2xl font-bold text-emerald-950 mb-3">${escapeHtml(assign.content)}</h3>
        <p class="text-xs text-gray-500 mb-4">التاريخ: ${formatDate(assign.assignment_date)}</p>

        ${sub.teacher_notes ? `
          <div class="p-3 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-900 mb-4">
            <span class="font-bold">ملاحظة المعلم:</span> ${escapeHtml(sub.teacher_notes)}
          </div>
        ` : ''}

        ${!isDone ? `
          <button onclick="markAsCompleted('${sub.id}')" class="w-full btn-emerald py-3 rounded-xl font-bold text-sm shadow">
            تم الحفظ / المراجعة ولله الحمد
          </button>
        ` : `
          <p class="text-center text-xs text-emerald-800 font-bold bg-emerald-100 py-2.5 rounded-xl">
            بارك الله فيك، تم تسجيل الإتمام بتاريخ ${formatDate(sub.submitted_at)}
          </p>
        `}
      </div>
    `;
  }).join('');
}

window.markAsCompleted = async function(subId) {
  try {
    const { error } = await supabase
      .from('assignment_submissions')
      .update({
        status: 'done',
        submitted_at: new Date().toISOString()
      })
      .eq('id', subId);

    if (error) throw error;

    showToast('ما شاء الله! تم تسجيل إتمام الورد بنجاح', 'success');
    await loadTodayWird();
  } catch (err) {
    showToast('حدث خطأ أثناء حفظ الإتمام', 'error');
  }
};

async function loadJoinedClassrooms() {
  const container = document.getElementById('joined-classrooms-list');
  const { data: rels } = await supabase
    .from('classroom_students')
    .select('classroom:classroom_id(*, subject:subject_id(name), teacher:teacher_id(full_name))')
    .eq('student_id', currentStudent.id);

  if (!rels || rels.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm py-4">لم تنضم لأي فصل افتراضي بعد.</p>';
    return;
  }

  container.innerHTML = rels.map(r => {
    const c = r.classroom;
    if (!c) return '';
    return `
      <div class="glass-card rounded-2xl p-5 border border-amber-400/20 shadow flex items-center justify-between">
        <div>
          <span class="text-xs bg-emerald-100 text-emerald-900 font-bold px-2.5 py-1 rounded-full mb-1 inline-block">${c.subject?.name || 'مادة شرعية'}</span>
          <h4 class="font-bold text-lg text-emerald-950">${escapeHtml(c.name)}</h4>
          <p class="text-xs text-gray-500">المعلم: ${escapeHtml(c.teacher?.full_name || '')}</p>
        </div>
        <a href="./classroom.html?id=${encodeURIComponent(c.id)}" class="btn-gold px-4 py-2 rounded-xl text-xs font-bold">
          دخول الفصل
        </a>
      </div>
    `;
  }).join('');
}
