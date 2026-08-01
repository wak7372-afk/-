import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast, formatDate } from '../lib/utils.js';

let currentTeacher = null;
let halaqaId = null;
let currentHalaqa = null;
let halaqaStudents = [];

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['teacher']);
  if (!authData) return;

  currentTeacher = authData.profile;
  await initI18n();

  const urlParams = new URLSearchParams(window.location.search);
  halaqaId = urlParams.get('id');

  if (!halaqaId) {
    window.location.href = '/teacher/halaqat.html';
    return;
  }

  document.getElementById('logout-btn').addEventListener('click', logoutUser);

  await loadHalaqaInfo();
  await loadStudents();
  await loadAvailableStudentsForSelect();
  await loadRecentAssignments();

  document.getElementById('add-student-btn').addEventListener('click', handleAddStudent);
  document.getElementById('assignment-form').addEventListener('submit', handleCreateAssignment);
  document.getElementById('assign-target').addEventListener('change', (e) => {
    const studentSelect = document.getElementById('student-select-container');
    if (e.target.value === 'individual') {
      studentSelect.classList.remove('hidden');
    } else {
      studentSelect.classList.add('hidden');
    }
  });
});

async function loadHalaqaInfo() {
  const { data, error } = await supabase
    .from('halaqat')
    .select('*')
    .eq('id', halaqaId)
    .eq('teacher_id', currentTeacher.id)
    .single();

  if (error || !data) {
    showToast('الحلقة غير موجودة أو ليس لديك صلاحية وصول', 'error');
    window.location.href = '/teacher/halaqat.html';
    return;
  }

  currentHalaqa = data;
  document.getElementById('halaqa-title').textContent = data.name;
}

async function loadStudents() {
  const container = document.getElementById('students-list');
  const { data: rels, error } = await supabase
    .from('halaqa_students')
    .select('id, student:student_id(id, full_name, username, phone)')
    .eq('halaqa_id', halaqaId);

  if (error) {
    showToast('فشل جلب طلاب الحلقة', 'error');
    return;
  }

  halaqaStudents = rels ? rels.map(r => r.student).filter(Boolean) : [];

  if (halaqaStudents.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm py-4">لا يوجد طلاب في هذه الحلقة بعد.</p>';
    return;
  }

  container.innerHTML = rels.map(r => `
    <div class="flex items-center justify-between p-3.5 bg-white rounded-xl border border-gray-100 shadow-sm">
      <div>
        <p class="font-bold text-gray-800">${escapeHtml(r.student?.full_name || 'طالب')}</p>
        <p class="text-xs text-gray-500"><span dir="ltr">@${escapeHtml(r.student?.username || '')}</span> ${r.student?.phone ? '• ' + escapeHtml(r.student.phone) : ''}</p>
      </div>
      <button type="button" data-remove-student="${escapeHtml(r.id)}" class="text-xs text-red-600 hover:text-red-800 font-semibold px-2 py-1 bg-red-50 hover:bg-red-100 rounded-lg transition">
        إزالة
      </button>
    </div>
  `).join('');

  container.querySelectorAll('[data-remove-student]').forEach(button => {
    button.addEventListener('click', () => window.removeStudentFromHalaqa(button.dataset.removeStudent));
  });

  // Update Individual Student Select Options
  const targetStudentSelect = document.getElementById('target-student-id');
  targetStudentSelect.innerHTML = halaqaStudents.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.full_name || 'طالب')}</option>`).join('');
}

async function loadAvailableStudentsForSelect() {
  const select = document.getElementById('all-students-select');
  const { data: allStudents } = await supabase.from('users').select('*').eq('role', 'student').eq('is_active', true);
  
  if (!allStudents || allStudents.length === 0) {
    select.innerHTML = '<option value="">لا يوجد طلاب متاحين</option>';
    return;
  }

  select.innerHTML = allStudents.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.full_name || 'طالب')} (@${escapeHtml(s.username || '')})</option>`).join('');
}

async function handleAddStudent() {
  const select = document.getElementById('all-students-select');
  const studentId = select.value;
  if (!studentId) return;

  try {
    const { error } = await supabase.from('halaqa_students').insert({
      halaqa_id: halaqaId,
      student_id: studentId
    });

    if (error) {
      if (error.code === '23505') throw new Error('الطالب مضاف بالفعل في هذه الحلقة');
      throw error;
    }

    showToast('تمت إضافة الطالب للحلقة بنجاح', 'success');
    await loadStudents();
  } catch (err) {
    showToast(err.message || 'فشل إضافة الطالب', 'error');
  }
}

window.removeStudentFromHalaqa = async function(relId) {
  if (!confirm('هل أنت تأكد من إزالة الطالب من هذه الحلقة؟')) return;
  try {
    const { error } = await supabase.from('halaqa_students').delete().eq('id', relId);
    if (error) throw error;
    showToast('تم إزالة الطالب من الحلقة', 'info');
    await loadStudents();
  } catch (err) {
    showToast('حدث خطأ أثناء الإزالة', 'error');
  }
};

async function handleCreateAssignment(e) {
  e.preventDefault();
  const assignTarget = document.getElementById('assign-target').value;
  const type = document.getElementById('assignment-type').value;
  const content = document.getElementById('assignment-content').value.trim();
  const date = document.getElementById('assignment-date').value;

  try {
    let assignmentPayload = {
      teacher_id: currentTeacher.id,
      type,
      content,
      assignment_date: date,
    };

    if (assignTarget === 'collective') {
      assignmentPayload.halaqa_id = halaqaId;
    } else {
      assignmentPayload.student_id = document.getElementById('target-student-id').value;
    }

    const { data: assignment, error: assignErr } = await supabase
      .from('daily_assignments')
      .insert(assignmentPayload)
      .select()
      .single();

    if (assignErr) throw assignErr;

    // Create submissions records
    if (assignTarget === 'collective') {
      const submissions = halaqaStudents.map(s => ({
        assignment_id: assignment.id,
        student_id: s.id,
        status: 'pending'
      }));
      if (submissions.length > 0) {
        await supabase.from('assignment_submissions').insert(submissions);
      }
    } else {
      await supabase.from('assignment_submissions').insert({
        assignment_id: assignment.id,
        student_id: assignmentPayload.student_id,
        status: 'pending'
      });
    }

    showToast('تم تعيين المقرر بنجاح', 'success');
    document.getElementById('assignment-content').value = '';
    await loadRecentAssignments();
  } catch (err) {
    showToast(err.message || 'فشل تعيين المقرر', 'error');
  }
}

async function loadRecentAssignments() {
  const container = document.getElementById('recent-assignments-list');
  const { data: assignments, error } = await supabase
    .from('daily_assignments')
    .select('*, student:student_id(full_name)')
    .or(`halaqa_id.eq.${halaqaId},student_id.in.(${halaqaStudents.map(s=>s.id).join(',') || '00000000-0000-0000-0000-000000000000'})`)
    .order('assignment_date', { ascending: false })
    .limit(10);

  if (error || !assignments || assignments.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm py-4">لا توجد مقررات ملتحقة حديثاً.</p>';
    return;
  }

  container.innerHTML = assignments.map(a => `
    <div class="p-4 bg-white rounded-xl border border-gray-100 shadow-sm mb-3">
      <div class="flex items-center justify-between mb-2">
        <span class="px-2.5 py-1 rounded-full text-xs font-bold ${a.type === 'hifz' ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}">
          ${a.type === 'hifz' ? 'حفظ جديد' : 'مراجعة'}
        </span>
        <span class="text-xs text-gray-500">${escapeHtml(formatDate(a.assignment_date))}</span>
      </div>
      <p class="font-bold text-gray-800 text-sm mb-1">${escapeHtml(a.content)}</p>
      <p class="text-xs text-gray-500">المستهدف: ${escapeHtml(a.student?.full_name || 'كل طلاب الحلقة')}</p>
    </div>
  `).join('');
}
