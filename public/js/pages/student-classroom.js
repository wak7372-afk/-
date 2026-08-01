import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, getSafeExternalUrl, showToast, formatDate } from '../lib/utils.js';

let currentStudent = null;
let classroomId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['student']);
  if (!authData) return;

  currentStudent = authData.profile;
  await initI18n();

  const urlParams = new URLSearchParams(window.location.search);
  classroomId = urlParams.get('id');

  if (!classroomId) {
    window.location.href = '/student/dashboard.html';
    return;
  }

  document.getElementById('logout-btn').addEventListener('click', logoutUser);

  await loadClassroom();
  await loadLessons();
  await loadAssignments();
  await loadQuizzes();

  document.getElementById('assignments-list').addEventListener('submit', handleAssignmentSubmit);
});

async function loadClassroom() {
  const { data } = await supabase.from('classrooms').select('*, subject:subject_id(name), teacher:teacher_id(full_name)').eq('id', classroomId).single();
  if (data) {
    document.getElementById('classroom-title').textContent = `${data.name} (${data.subject?.name || ''})`;
    document.getElementById('teacher-name').textContent = data.teacher?.full_name || '';
  }
}

async function loadLessons() {
  const container = document.getElementById('lessons-list');
  const { data: lessons } = await supabase.from('lessons').select('*').eq('classroom_id', classroomId).order('created_at', { ascending: false });

  if (!lessons || lessons.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm py-4">لا توجد دروس منشورة في هذا الفصل بعد.</p>';
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
          <span class="text-xs text-emerald-900 font-bold">جلسة مباشر (Google Meet)</span>
          <a href="${escapeHtml(meetLink)}" target="_blank" rel="noopener noreferrer" class="btn-gold px-4 py-2 rounded-xl text-xs font-bold">
            الانضمام للبث المباشر ➔
          </a>
        </div>
      ` : ''}
    </div>
  `;
  }).join('');
}

function formatDateTime(value) {
  if (!value) return 'لا يوجد موعد نهائي';
  return new Intl.DateTimeFormat('ar', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

async function createSubmissionFileUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return getSafeExternalUrl(path);
  const { data, error } = await supabase.storage
    .from('assignment-submissions')
    .createSignedUrl(path, 300);
  return error ? '' : data?.signedUrl || '';
}

async function loadAssignments() {
  const container = document.getElementById('assignments-list');
  const count = document.getElementById('assignments-count');
  const { data: assignments, error } = await supabase
    .from('assignments_extra')
    .select('*')
    .eq('classroom_id', classroomId)
    .order('due_date', { ascending: true, nullsFirst: false });

  if (error) {
    container.innerHTML = '<p class="text-sm text-red-600">تعذر تحميل الواجبات.</p>';
    return;
  }

  count.textContent = `${assignments?.length || 0} واجب`;
  if (!assignments?.length) {
    container.innerHTML = '<p class="text-sm text-gray-500 py-4">لا توجد واجبات مطلوبة حالياً.</p>';
    return;
  }

  const assignmentIds = assignments.map(item => item.id);
  const { data: submissions, error: submissionsError } = await supabase
    .from('assignment_extra_submissions')
    .select('*')
    .eq('student_id', currentStudent.id)
    .in('assignment_extra_id', assignmentIds);

  if (submissionsError) {
    container.innerHTML = '<p class="text-sm text-red-600">تعذر تحميل حالة التسليم.</p>';
    return;
  }

  const submissionsByAssignment = new Map((submissions || []).map(item => [item.assignment_extra_id, item]));
  const rendered = await Promise.all(assignments.map(async assignment => {
    const submission = submissionsByAssignment.get(assignment.id);
    const fileUrl = await createSubmissionFileUrl(submission?.file_url);
    return renderAssignment(assignment, submission, fileUrl);
  }));
  container.innerHTML = rendered.join('');
}

function renderAssignment(assignment, submission, fileUrl) {
  const isGraded = Boolean(submission?.graded_at);
  const isSubmitted = Boolean(submission?.submitted_at);
  const isOverdue = assignment.due_date && new Date(assignment.due_date) < new Date();
  const statusLabel = isGraded ? 'تم التصحيح' : isSubmitted ? 'تم التسليم' : isOverdue ? 'متأخر' : 'مطلوب';
  const statusClass = isGraded
    ? 'bg-emerald-100 text-emerald-800'
    : isSubmitted
      ? 'bg-sky-100 text-sky-800'
      : isOverdue
        ? 'bg-red-100 text-red-700'
        : 'bg-amber-100 text-amber-800';

  return `
    <article class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="flex flex-wrap items-center gap-2 mb-2">
            <span class="rounded-full px-2.5 py-1 text-[10px] font-bold ${statusClass}">${statusLabel}</span>
            <span class="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-700">
              ${assignment.type === 'file' ? 'رفع ملف' : 'إجابة نصية'}
            </span>
          </div>
          <h4 class="font-amiri text-xl font-bold text-emerald-950">${escapeHtml(assignment.title)}</h4>
          ${assignment.description ? `<p class="mt-2 whitespace-pre-line text-xs leading-6 text-slate-600">${escapeHtml(assignment.description)}</p>` : ''}
        </div>
        <p class="text-[10px] text-slate-500">${escapeHtml(formatDateTime(assignment.due_date))}</p>
      </div>

      ${isGraded ? `
        <div class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div class="flex items-center justify-between gap-3">
            <strong class="text-sm text-emerald-900">الدرجة</strong>
            <span class="text-xl font-extrabold text-emerald-900">${escapeHtml(submission.grade ?? '—')} / 100</span>
          </div>
          ${submission.teacher_feedback ? `<p class="mt-3 text-xs leading-6 text-emerald-800">${escapeHtml(submission.teacher_feedback)}</p>` : ''}
          ${fileUrl ? `<a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener noreferrer" class="mt-3 inline-block text-xs font-bold text-emerald-800 underline">فتح الملف المسلّم</a>` : ''}
        </div>
      ` : `
        <form data-assignment-submit="${escapeHtml(assignment.id)}" data-assignment-type="${escapeHtml(assignment.type)}" data-previous-file="${escapeHtml(submission?.file_url || '')}" class="mt-4 space-y-3 border-t border-slate-100 pt-4">
          ${assignment.type === 'file' ? `
            <div>
              <label class="mb-1 block text-xs font-bold text-slate-700">الملف المطلوب</label>
              <input type="file" name="submission_file" ${isSubmitted ? '' : 'required'} accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.txt"
                class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs">
              <p class="mt-1 text-[10px] text-slate-500">PDF أو Word أو صورة أو ملف نصي، بحد أقصى 10 ميجابايت.</p>
              ${fileUrl ? `<a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener noreferrer" class="mt-2 inline-block text-xs font-bold text-emerald-800 underline">فتح التسليم الحالي</a>` : ''}
            </div>
          ` : `
            <div>
              <label class="mb-1 block text-xs font-bold text-slate-700">إجابتك</label>
              <textarea name="submission_content" required maxlength="10000" rows="4" placeholder="اكتب إجابتك هنا..."
                class="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none">${escapeHtml(submission?.content || '')}</textarea>
            </div>
          `}
          <button type="submit" class="btn-emerald px-5 py-2.5 rounded-xl text-xs font-bold">
            ${isSubmitted ? 'تحديث التسليم' : 'تسليم الواجب'}
          </button>
        </form>
      `}
    </article>`;
}

function getAllowedFileExtension(file) {
  const extensions = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'text/plain': 'txt',
  };
  return extensions[file.type] || '';
}

async function uploadAssignmentFile(file, assignmentId) {
  if (file.size > 10 * 1024 * 1024) throw new Error('حجم الملف يتجاوز 10 ميجابايت.');
  const extension = getAllowedFileExtension(file);
  if (!extension) throw new Error('نوع الملف غير مدعوم.');
  const path = `${currentStudent.id}/${assignmentId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage
    .from('assignment-submissions')
    .upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return path;
}

async function handleAssignmentSubmit(event) {
  const form = event.target.closest('[data-assignment-submit]');
  if (!form) return;
  event.preventDefault();

  const assignmentId = form.dataset.assignmentSubmit;
  const assignmentType = form.dataset.assignmentType;
  const previousFile = form.dataset.previousFile || '';
  const button = form.querySelector('button[type="submit"]');
  let uploadedPath = '';

  button.disabled = true;
  button.textContent = 'جاري حفظ التسليم...';
  try {
    let content = null;
    let filePath = previousFile || null;
    if (assignmentType === 'file') {
      const file = form.elements.submission_file.files[0];
      if (!file && !previousFile) throw new Error('اختر ملفاً للتسليم.');
      if (file) {
        uploadedPath = await uploadAssignmentFile(file, assignmentId);
        filePath = uploadedPath;
      }
    } else {
      content = form.elements.submission_content.value.trim();
      if (!content) throw new Error('اكتب إجابتك قبل التسليم.');
    }

    const { error } = await supabase
      .from('assignment_extra_submissions')
      .upsert({
        assignment_extra_id: assignmentId,
        student_id: currentStudent.id,
        content,
        file_url: filePath,
      }, { onConflict: 'assignment_extra_id,student_id' });
    if (error) throw error;

    if (uploadedPath && previousFile && !/^https?:\/\//i.test(previousFile)) {
      await supabase.storage.from('assignment-submissions').remove([previousFile]);
    }
    showToast('تم حفظ تسليم الواجب بنجاح.', 'success');
    await loadAssignments();
  } catch (error) {
    if (uploadedPath) await supabase.storage.from('assignment-submissions').remove([uploadedPath]);
    showToast(error.message || 'تعذر حفظ التسليم.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'تسليم الواجب';
  }
}

async function loadQuizzes() {
  const container = document.getElementById('quizzes-list');
  const { data: quizzes } = await supabase.from('quizzes').select('*').eq('classroom_id', classroomId);

  if (!quizzes || quizzes.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-xs py-2">لا توجد اختبارات مضافة.</p>';
    return;
  }

  container.innerHTML = quizzes.map(q => `
    <div class="p-3 bg-amber-50/60 rounded-xl border border-amber-200 flex items-center justify-between text-xs mb-2">
      <span class="font-bold text-emerald-950">${escapeHtml(q.title || 'اختبار')}</span>
      <a href="/student/quiz.html?id=${encodeURIComponent(q.id)}" class="btn-emerald text-[11px] px-3 py-1 rounded-lg font-bold">أداء الاختبار</a>
    </div>
  `).join('');
}
