import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast, formatDate } from '../lib/utils.js';

let currentTeacher = null;

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['teacher']);
  if (!authData) return;

  currentTeacher = authData.profile;
  await initI18n();

  document.getElementById('logout-btn').addEventListener('click', logoutUser);
  document.getElementById('date-input').valueAsDate = new Date();

  await loadTeacherSessions();

  document.getElementById('load-students-btn').addEventListener('click', loadSessionStudents);
  document.getElementById('save-attendance-form').addEventListener('submit', handleSaveAttendance);
});

async function loadTeacherSessions() {
  const select = document.getElementById('session-select');
  const { data: halaqat } = await supabase.from('halaqat').select('id, name').eq('teacher_id', currentTeacher.id);
  const { data: classrooms } = await supabase.from('classrooms').select('id, name').eq('teacher_id', currentTeacher.id);

  let optionsHTML = '';
  if (halaqat) {
    optionsHTML += halaqat.map(h => `<option value="halaqa:${escapeHtml(h.id)}">حلقة قرآن: ${escapeHtml(h.name || 'حلقة قرآنية')}</option>`).join('');
  }
  if (classrooms) {
    optionsHTML += classrooms.map(c => `<option value="classroom:${escapeHtml(c.id)}">فصل مادة: ${escapeHtml(c.name || 'فصل دراسي')}</option>`).join('');
  }

  select.innerHTML = optionsHTML || '<option value="">لا توجد حلقات أو فصول</option>';
}

async function loadSessionStudents() {
  const sessionVal = document.getElementById('session-select').value;
  const dateVal = document.getElementById('date-input').value;
  if (!sessionVal) return;

  const [type, refId] = sessionVal.split(':');
  const container = document.getElementById('attendance-table-body');
  container.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-gray-500">جاري تحميل قائمة الطلاب...</td></tr>';

  let students = [];
  if (type === 'halaqa') {
    const { data } = await supabase.from('halaqa_students').select('student:student_id(id, full_name)').eq('halaqa_id', refId);
    students = data ? data.map(d => d.student) : [];
  } else {
    const { data } = await supabase.from('classroom_students').select('student:student_id(id, full_name)').eq('classroom_id', refId);
    students = data ? data.map(d => d.student) : [];
  }

  if (students.length === 0) {
    container.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-gray-500">لا يوجد طلاب في الجلسة المختارة.</td></tr>';
    return;
  }

  // Load existing attendance
  const { data: existing } = await supabase
    .from('attendance')
    .select('*')
    .eq('session_type', type)
    .eq('session_ref_id', refId)
    .eq('attendance_date', dateVal);

  const existingMap = {};
  if (existing) {
    existing.forEach(e => { existingMap[e.student_id] = e.status; });
  }

  container.innerHTML = students.map(s => {
    const currentStatus = existingMap[s.id] || 'present';
    return `
      <tr class="border-b student-row" data-student-id="${escapeHtml(s.id)}">
        <td class="py-3 px-4 font-bold text-gray-800">${escapeHtml(s.full_name || 'طالب')}</td>
        <td class="py-3 px-4">
          <label class="inline-flex items-center space-x-1 space-x-reverse cursor-pointer">
            <input type="radio" name="att_${s.id}" value="present" ${currentStatus === 'present' ? 'checked' : ''} class="w-4 h-4 text-emerald-600">
            <span class="text-xs font-bold text-emerald-800">حاضر</span>
          </label>
        </td>
        <td class="py-3 px-4">
          <label class="inline-flex items-center space-x-1 space-x-reverse cursor-pointer">
            <input type="radio" name="att_${s.id}" value="absent" ${currentStatus === 'absent' ? 'checked' : ''} class="w-4 h-4 text-red-600">
            <span class="text-xs font-bold text-red-700">غائب</span>
          </label>
        </td>
        <td class="py-3 px-4">
          <label class="inline-flex items-center space-x-1 space-x-reverse cursor-pointer">
            <input type="radio" name="att_${s.id}" value="excused" ${currentStatus === 'excused' ? 'checked' : ''} class="w-4 h-4 text-amber-600">
            <span class="text-xs font-bold text-amber-700">معذور</span>
          </label>
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('attendance-table-container').classList.remove('hidden');
}

async function handleSaveAttendance(e) {
  e.preventDefault();
  const sessionVal = document.getElementById('session-select').value;
  const dateVal = document.getElementById('date-input').value;
  const [type, refId] = sessionVal.split(':');

  const rows = document.querySelectorAll('.student-row');
  const payload = [];

  rows.forEach(row => {
    const studentId = row.dataset.studentId;
    const statusRadio = row.querySelector(`input[name="att_${studentId}"]:checked`);
    if (statusRadio) {
      payload.push({
        session_type: type,
        session_ref_id: refId,
        student_id: studentId,
        status: statusRadio.value,
        attendance_date: dateVal,
        recorded_by: currentTeacher.id
      });
    }
  });

  try {
    const { error } = await supabase.from('attendance').upsert(payload, {
      onConflict: 'session_type,session_ref_id,student_id,attendance_date'
    });

    if (error) throw error;
    showToast('تم حفظ الحضور والغياب بنجاح', 'success');
  } catch (err) {
    showToast(err.message || 'فشل حفظ سجل الحضور والغياب', 'error');
  }
}
