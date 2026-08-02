import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast } from '../lib/utils.js';
import { addPreviewRecord, createPreviewId, loadPreviewCollection } from '../lib/preview-store.js';

let currentUser = null;
let isPreview = false;
let subjectsById = new Map();

const PREVIEW_SUBJECTS = [
  { id: 'preview-subject-fiqh', name: 'فقه' },
  { id: 'preview-subject-aqidah', name: 'عقيدة' },
  { id: 'preview-subject-seerah', name: 'سيرة' },
];

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['teacher', 'admin']);
  if (!authData) return;

  currentUser = authData.profile;
  isPreview = authData.preview === true;
  await initI18n();

  document.getElementById('logout-btn').addEventListener('click', logoutUser);

  await loadSubjects();
  await loadClassrooms();

  document.getElementById('create-classroom-form').addEventListener('submit', handleCreateClassroom);
  document.getElementById('classrooms-grid').addEventListener('click', event => {
    if (!event.target.closest('[data-preview-detail]')) return;
    showToast('تفاصيل الفصل غير متصلة بقاعدة البيانات في وضع المعاينة.', 'info');
  });
});

async function loadSubjects() {
  const select = document.getElementById('subject-select');
  let subjects = PREVIEW_SUBJECTS;

  if (!isPreview) {
    const { data, error } = await supabase.from('subjects').select('*');
    if (error) {
      select.innerHTML = '<option value="">تعذر تحميل المواد الدراسية</option>';
      showToast(getClassroomErrorMessage(error, 'تعذر تحميل المواد الدراسية.'), 'error');
      return;
    }
    subjects = data;
  }

  if (!subjects || subjects.length === 0) {
    select.innerHTML = '<option value="">لا توجد مواد دراسية مضافة</option>';
    return;
  }

  subjectsById = new Map(subjects.map(subject => [subject.id, subject]));
  select.innerHTML = subjects.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name || 'مادة شرعية')}</option>`).join('');
}

async function loadClassrooms() {
  const container = document.getElementById('classrooms-grid');
  container.innerHTML = '<p class="text-gray-500 text-center col-span-3 py-8">جاري تحميل الفصول...</p>';

  if (isPreview) {
    renderClassrooms(loadPreviewCollection('classrooms'));
    return;
  }

  let query = supabase.from('classrooms').select('*, subject:subject_id(name), teacher:teacher_id(full_name), classroom_students(count)');
  if (currentUser.role !== 'admin') {
    query = query.eq('teacher_id', currentUser.id);
  }

  const { data: classrooms, error } = await query;

  if (error) {
    container.innerHTML = '<p class="text-red-700 text-center col-span-3 py-8">تعذر تحميل الفصول. أعد المحاولة بعد التحقق من جلسة الدخول.</p>';
    showToast(getClassroomErrorMessage(error, 'تعذر تحميل الفصول الافتراضية.'), 'error');
    return;
  }

  renderClassrooms(classrooms);
}

function renderClassrooms(classrooms) {
  const container = document.getElementById('classrooms-grid');

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
      ${isPreview
        ? '<button type="button" data-preview-detail class="btn-emerald text-center py-2.5 rounded-xl font-bold text-sm">إدارة الفصل في النظام الفعلي</button>'
        : `<a href="/teacher/classroom-detail.html?id=${encodeURIComponent(c.id)}" class="btn-emerald text-center py-2.5 rounded-xl font-bold text-sm">إدارة الفصل والدروس</a>`}
    </div>
  `).join('');
}

async function handleCreateClassroom(e) {
  e.preventDefault();
  const subjectId = document.getElementById('subject-select').value;
  const name = document.getElementById('classroom-name').value.trim();

  if (!subjectsById.has(subjectId)) {
    showToast('اختر مادة دراسية صالحة.', 'error');
    return;
  }
  if (name.length < 2 || name.length > 120) {
    showToast('اكتب اسماً للفصل بين حرفين و120 حرفاً.', 'error');
    return;
  }

  try {
    if (isPreview) {
      const subject = subjectsById.get(subjectId);
      addPreviewRecord('classrooms', {
        id: createPreviewId('classroom'),
        subject_id: subjectId,
        name,
        teacher_id: currentUser.id,
        subject: { name: subject.name },
        teacher: { full_name: currentUser.full_name },
        classroom_students: [{ count: 0 }],
        created_at: new Date().toISOString(),
      });
      showToast('تمت إضافة الفصل إلى المعاينة فقط.', 'success');
      document.getElementById('classroom-name').value = '';
      await loadClassrooms();
      return;
    }

    const { error } = await supabase.from('classrooms').insert({
      subject_id: subjectId,
      name,
      teacher_id: currentUser.id,
    });

    if (error) throw error;

    showToast('تم إنشاء الفصل الافتراضي بنجاح', 'success');
    document.getElementById('classroom-name').value = '';
    await loadClassrooms();
  } catch (err) {
    showToast(getClassroomErrorMessage(err, 'فشل إنشاء الفصل.'), 'error');
  }
}

function getClassroomErrorMessage(error, fallback) {
  const message = String(error?.message || '').toLowerCase();
  if (error?.code === '42501' || message.includes('row-level security')) {
    return 'لا تملك الجلسة الحالية صلاحية إنشاء الفصل. اخرج من المعاينة وسجّل الدخول بحساب فعلي.';
  }
  if (message.includes('duplicate')) return 'يوجد فصل مماثل بالفعل.';
  return fallback;
}
