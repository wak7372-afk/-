import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast } from '../lib/utils.js';

let currentUser = null;

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['teacher', 'admin']);
  if (!authData) return;

  currentUser = authData.profile;
  await initI18n();

  document.getElementById('logout-btn').addEventListener('click', logoutUser);

  await loadSubjects();
  await loadClassrooms();

  document.getElementById('create-classroom-form').addEventListener('submit', handleCreateClassroom);
});

async function loadSubjects() {
  const select = document.getElementById('subject-select');
  const { data: subjects } = await supabase.from('subjects').select('*');

  if (!subjects || subjects.length === 0) {
    select.innerHTML = '<option value="">لا توجد مواد دراسية مضافة</option>';
    return;
  }

  select.innerHTML = subjects.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name || 'مادة شرعية')}</option>`).join('');
}

async function loadClassrooms() {
  const container = document.getElementById('classrooms-grid');

  let query = supabase.from('classrooms').select('*, subject:subject_id(name), teacher:teacher_id(full_name), classroom_students(count)');
  if (currentUser.role !== 'admin') {
    query = query.eq('teacher_id', currentUser.id);
  }

  const { data: classrooms, error } = await query;

  if (error) {
    showToast('حدث خطأ أثناء جلب الفصول الافتراضية', 'error');
    return;
  }

  if (!classrooms || classrooms.length === 0) {
    container.innerHTML = `
      <div class="col-span-full glass-card text-center py-12 rounded-2xl border border-dashed border-emerald-300">
        <h4 class="text-xl font-bold text-emerald-950 mb-2">لا توجد فصول افتراضية مضافة بعد</h4>
        <p class="text-gray-500 text-sm mb-4">أنشئ الفصل الافتراضي لمواد الفقه أو العقيدة أو السيرة لنشر الدروس والواجبات والاختبارات.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = classrooms.map(c => `
    <div class="glass-card rounded-2xl p-6 border border-amber-400/30 shadow-md flex flex-col justify-between">
      <div>
        <div class="flex items-center justify-between mb-3">
          <span class="bg-amber-100 text-amber-900 text-xs font-bold px-3 py-1 rounded-full">${escapeHtml(c.subject?.name || 'مادة شرعية')}</span>
          <span class="text-xs text-gray-500 font-semibold">${escapeHtml(c.classroom_students[0]?.count || 0)} طالب</span>
        </div>
        <h3 class="font-amiri text-2xl font-bold text-emerald-950 mb-2">${escapeHtml(c.name || 'فصل دراسي')}</h3>
        <p class="text-xs font-bold text-amber-800 mb-4">المعلم المسؤول: ${escapeHtml(c.teacher?.full_name || 'غير محدد')}</p>
      </div>
      <a href="/teacher/classroom-detail.html?id=${encodeURIComponent(c.id)}" class="btn-emerald text-center py-2.5 rounded-xl font-bold text-sm">
        إدارة الفصل والدروس
      </a>
    </div>
  `).join('');
}

async function handleCreateClassroom(e) {
  e.preventDefault();
  const subjectId = document.getElementById('subject-select').value;
  const name = document.getElementById('classroom-name').value.trim();

  try {
    const { error } = await supabase.from('classrooms').insert({
      subject_id: subjectId,
      name,
      teacher_id: currentUser.id
    });

    if (error) throw error;

    showToast('تم إنشاء الفصل الافتراضي بنجاح', 'success');
    document.getElementById('classroom-name').value = '';
    await loadClassrooms();
  } catch (err) {
    showToast(err.message || 'فشل إنشاء الفصل', 'error');
  }
}
