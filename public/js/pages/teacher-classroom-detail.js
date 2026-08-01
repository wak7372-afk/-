import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, getSafeExternalUrl, showToast, formatDate } from '../lib/utils.js';

let currentTeacher = null;
let classroomId = null;
let currentClassroom = null;

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['teacher']);
  if (!authData) return;

  currentTeacher = authData.profile;
  await initI18n();

  const urlParams = new URLSearchParams(window.location.search);
  classroomId = urlParams.get('id');

  if (!classroomId) {
    window.location.href = '/teacher/classrooms.html';
    return;
  }

  document.getElementById('logout-btn').addEventListener('click', logoutUser);

  await loadClassroomInfo();
  await loadLessons();
  await loadAssignments();
  await loadClassroomStudents();
  await loadAvailableStudents();
  await loadQuizzes();

  document.getElementById('publish-lesson-form').addEventListener('submit', handlePublishLesson);
  document.getElementById('create-assignment-form').addEventListener('submit', handleCreateAssignment);
  document.getElementById('add-student-btn').addEventListener('click', handleAddStudentToClassroom);
});

async function loadClassroomInfo() {
  const { data, error } = await supabase
    .from('classrooms')
    .select('*, subject:subject_id(name)')
    .eq('id', classroomId)
    .single();

  if (error || !data) {
    showToast('الفصل الافتراضي غير موجود', 'error');
    window.location.href = '/teacher/classrooms.html';
    return;
  }

  currentClassroom = data;
  document.getElementById('classroom-title').textContent = `${data.name} (${data.subject?.name || ''})`;
}

async function loadLessons() {
  const container = document.getElementById('lessons-list');
  const { data: lessons } = await supabase
    .from('lessons')
    .select('*')
    .eq('classroom_id', classroomId)
    .order('created_at', { ascending: false });

  if (!lessons || lessons.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm py-4">لم يتم نشر أي دروس في هذا الفصل بعد.</p>';
    return;
  }

  container.innerHTML = lessons.map(l => {
    const meetLink = getSafeExternalUrl(l.meet_link);
    return `
    <div class="glass-card rounded-2xl p-6 border border-amber-400/20 shadow-md">
      <div class="flex items-center justify-between mb-2">
        <h4 class="font-amiri text-2xl font-bold text-emerald-950">${escapeHtml(l.title || 'درس')}</h4>
        <span class="text-xs text-gray-500">${escapeHtml(formatDate(l.created_at))}</span>
      </div>

      ${l.content ? `<p class="text-sm text-gray-700 leading-relaxed mb-4 whitespace-pre-line">${escapeHtml(l.content)}</p>` : ''}

      ${meetLink ? `
        <div class="pt-3 border-t flex items-center justify-between">
          <span class="text-xs text-emerald-900 font-bold">جلسة بث مباشر (Google Meet)</span>
          <a href="${escapeHtml(meetLink)}" target="_blank" rel="noopener noreferrer" class="btn-gold px-4 py-2 rounded-xl text-xs font-bold flex items-center space-x-1 space-x-reverse">
            <span>الانضمام للاجتماع المباشر</span> ➔
          </a>
        </div>
      ` : ''}
    </div>
  `;
  }).join('');
}

async function handlePublishLesson(e) {
  e.preventDefault();
  const title = document.getElementById('lesson-title').value.trim();
  const content = document.getElementById('lesson-content').value.trim();
  const meetLink = document.getElementById('lesson-meet-link').value.trim();

  try {
    const { error } = await supabase.from('lessons').insert({
      classroom_id: classroomId,
      title,
      content,
      meet_link: meetLink || null
    });

    if (error) throw error;

    showToast('تم نشر الدرس بنجاح في الفصل', 'success');
    document.getElementById('publish-lesson-form').reset();
    await loadLessons();
  } catch (err) {
    showToast(err.message || 'فشل نشر الدرس', 'error');
  }
}

function formatDateTime(value) {
  if (!value) return 'بلا موعد نهائي';
  return new Intl.DateTimeFormat('ar', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

async function loadAssignments() {
  const container = document.getElementById('assignments-list');
  const count = document.getElementById('assignments-count');
  const { data: assignments, error } = await supabase
    .from('assignments_extra')
    .select('*, assignment_extra_submissions(count)')
    .eq('classroom_id', classroomId)
    .order('created_at', { ascending: false });

  if (error) {
    container.innerHTML = '<p class="text-sm text-red-600">تعذر تحميل واجبات الفصل.</p>';
    return;
  }

  count.textContent = `${assignments?.length || 0} واجب`;
  if (!assignments?.length) {
    container.innerHTML = '<p class="text-sm text-gray-500 py-4">لم يُنشر أي واجب في هذا الفصل بعد.</p>';
    return;
  }

  container.innerHTML = assignments.map(assignment => {
    const submittedCount = assignment.assignment_extra_submissions?.[0]?.count || 0;
    const isOverdue = assignment.due_date && new Date(assignment.due_date) < new Date();
    return `
      <article class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="flex flex-wrap items-center gap-2 mb-2">
              <span class="rounded-full px-2.5 py-1 text-[10px] font-bold ${assignment.type === 'file' ? 'bg-sky-100 text-sky-800' : 'bg-emerald-100 text-emerald-800'}">
                ${assignment.type === 'file' ? 'تسليم ملف' : 'إجابة نصية'}
              </span>
              ${isOverdue ? '<span class="rounded-full bg-red-100 px-2.5 py-1 text-[10px] font-bold text-red-700">انتهى الموعد</span>' : ''}
            </div>
            <h4 class="font-amiri text-xl font-bold text-emerald-950">${escapeHtml(assignment.title)}</h4>
            ${assignment.description ? `<p class="mt-2 text-xs leading-6 text-slate-600 whitespace-pre-line">${escapeHtml(assignment.description)}</p>` : ''}
          </div>
          <div class="text-left text-[10px] text-slate-500">
            <p>${submittedCount} تسليم</p>
            <p class="mt-1">${escapeHtml(formatDateTime(assignment.due_date))}</p>
          </div>
        </div>
      </article>`;
  }).join('');
}

async function handleCreateAssignment(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.getElementById('create-assignment-btn');
  const title = document.getElementById('assignment-title').value.trim();
  const description = document.getElementById('assignment-description').value.trim();
  const type = document.getElementById('assignment-submission-type').value;
  const dueInput = document.getElementById('assignment-due-date').value;
  const dueDate = dueInput ? new Date(dueInput) : null;

  if (dueDate && dueDate <= new Date()) {
    showToast('اختر موعد تسليم قادماً.', 'error');
    return;
  }

  button.disabled = true;
  button.textContent = 'جاري نشر الواجب...';
  try {
    const { error } = await supabase.from('assignments_extra').insert({
      classroom_id: classroomId,
      title,
      description: description || null,
      type,
      due_date: dueDate ? dueDate.toISOString() : null,
    });
    if (error) throw error;

    form.reset();
    showToast('تم نشر الواجب وإشعار طلاب الفصل.', 'success');
    await loadAssignments();
  } catch (error) {
    showToast(error.message || 'تعذر نشر الواجب.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'نشر الواجب للطلاب';
  }
}

async function loadClassroomStudents() {
  const container = document.getElementById('classroom-students-list');
  const { data: rels } = await supabase
    .from('classroom_students')
    .select('student:student_id(id, full_name, username)')
    .eq('classroom_id', classroomId);

  if (!rels || rels.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-xs py-3">لا يوجد طلاب مضافين بالفصل.</p>';
    return;
  }

  container.innerHTML = rels.map(r => `
    <div class="p-2.5 bg-white rounded-lg border text-xs flex items-center justify-between">
      <span class="font-bold text-gray-800">${escapeHtml(r.student?.full_name || 'طالب')}</span>
      <span class="text-gray-500 text-[10px]" dir="ltr">@${escapeHtml(r.student?.username || '')}</span>
    </div>
  `).join('');
}

async function loadAvailableStudents() {
  const select = document.getElementById('available-students-select');
  const { data: students } = await supabase.from('users').select('*').eq('role', 'student').eq('is_active', true);
  
  if (!students || students.length === 0) {
    select.innerHTML = '<option value="">لا يوجد طلاب متاحين</option>';
    return;
  }

  select.innerHTML = students.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.full_name || 'طالب')}</option>`).join('');
}

async function handleAddStudentToClassroom() {
  const studentId = document.getElementById('available-students-select').value;
  if (!studentId) return;

  try {
    const { error } = await supabase.from('classroom_students').insert({
      classroom_id: classroomId,
      student_id: studentId
    });
    if (error) throw error;
    showToast('تم إضافة الطالب للفصل', 'success');
    await loadClassroomStudents();
  } catch (err) {
    showToast('فشل إضافة الطالب للفصل', 'error');
  }
}

async function loadQuizzes() {
  const container = document.getElementById('quizzes-list');
  const { data: quizzes } = await supabase.from('quizzes').select('*').eq('classroom_id', classroomId);

  document.getElementById('new-quiz-link').href = `/teacher/quiz-editor.html?classroom_id=${classroomId}`;

  if (!quizzes || quizzes.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-xs py-2">لا توجد اختبارات مضافة.</p>';
    return;
  }

  container.innerHTML = quizzes.map(q => `
    <div class="p-3 bg-amber-50/60 rounded-xl border border-amber-200 flex items-center justify-between text-xs mb-2">
      <span class="font-bold text-emerald-950">${escapeHtml(q.title || 'اختبار')}</span>
      <a href="/teacher/quiz-editor.html?quiz_id=${encodeURIComponent(q.id)}&classroom_id=${encodeURIComponent(classroomId)}" class="text-emerald-800 font-bold underline">تعديل</a>
    </div>
  `).join('');
}
