import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { escapeHtml, showToast, formatDate } from '../lib/utils.js';

const state = {
  profile: null,
  previewMode: false,
  halaqat: [],
  students: [],
  preview: [],
  recent: [],
};

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
  const authData = await requireAuth(['teacher']);
  if (!authData) return;
  state.profile = authData.profile;
  state.previewMode = Boolean(authData.preview);

  document.getElementById('logout-btn').addEventListener('click', logoutUser);
  document.getElementById('task-form').addEventListener('submit', publishTasks);
  document.getElementById('preview-task').addEventListener('click', buildPreview);
  document.getElementById('task-halaqa').addEventListener('change', handleHalaqaChange);
  document.getElementById('task-target').addEventListener('change', syncTargetField);
  document.getElementById('task-repeat').addEventListener('change', syncRepeatFields);
  document.getElementById('recent-task-list').addEventListener('click', handleRecentAction);
  document.getElementById('task-form').addEventListener('input', invalidatePreview);

  const today = toDateInput(new Date());
  document.getElementById('task-date').value = today;
  document.getElementById('repeat-until').value = toDateInput(addDays(new Date(), 28));

  await loadHalaqat();
  if (window.lucide) window.lucide.createIcons();
}

async function loadHalaqat() {
  const select = document.getElementById('task-halaqa');
  if (state.previewMode) {
    state.halaqat = [{ id: 'preview-halaqa', name: 'حلقة الإتقان - معاينة' }];
    select.innerHTML = '<option value="preview-halaqa">حلقة الإتقان - معاينة</option>';
    await handleHalaqaChange();
    return;
  }
  const { data, error } = await supabase
    .from('halaqat')
    .select('id, name')
    .eq('teacher_id', state.profile.id)
    .order('name');

  if (error) {
    showToast('تعذر تحميل الحلقات.', 'error');
    return;
  }
  state.halaqat = data || [];
  select.innerHTML = state.halaqat.length
    ? state.halaqat.map(halaqa => `<option value="${escapeHtml(halaqa.id)}">${escapeHtml(halaqa.name)}</option>`).join('')
    : '<option value="">أنشئ حلقة أولاً</option>';
  const requestedHalaqa = new URLSearchParams(window.location.search).get('halaqa');
  if (requestedHalaqa && state.halaqat.some(halaqa => halaqa.id === requestedHalaqa)) {
    select.value = requestedHalaqa;
  }
  await handleHalaqaChange();
}

async function handleHalaqaChange() {
  invalidatePreview();
  const halaqaId = document.getElementById('task-halaqa').value;
  const studentSelect = document.getElementById('task-student');
  if (!halaqaId) {
    state.students = [];
    studentSelect.innerHTML = '<option value="">لا توجد حلقة</option>';
    return;
  }

  if (state.previewMode) {
    state.students = [
      { id: 'preview-student-1', full_name: 'محمد سعيد', username: 'mohammed.01' },
      { id: 'preview-student-2', full_name: 'أحمد علي', username: 'ahmed.02' },
    ];
    studentSelect.innerHTML = state.students.map(student => `<option value="${student.id}">${student.full_name} (@${student.username})</option>`).join('');
    await loadRecentTasks();
    return;
  }

  const { data, error } = await supabase
    .from('halaqa_students')
    .select('student:student_id(id, full_name, username)')
    .eq('halaqa_id', halaqaId);
  if (error) {
    showToast('تعذر تحميل طلاب الحلقة.', 'error');
    return;
  }
  state.students = (data || []).map(item => item.student).filter(Boolean);
  studentSelect.innerHTML = state.students.length
    ? state.students.map(student => `<option value="${escapeHtml(student.id)}">${escapeHtml(student.full_name || student.username)} (@${escapeHtml(student.username || '')})</option>`).join('')
    : '<option value="">لا يوجد طلاب في الحلقة</option>';
  await loadRecentTasks();
}

function syncTargetField() {
  const isIndividual = document.getElementById('task-target').value === 'individual';
  document.getElementById('task-student-field').hidden = !isIndividual;
  invalidatePreview();
}

function syncRepeatFields() {
  const repeating = document.getElementById('task-repeat').checked;
  document.getElementById('repeat-until-field').hidden = !repeating;
  document.getElementById('repeat-days').hidden = !repeating;
  invalidatePreview();
}

function invalidatePreview() {
  state.preview = [];
  document.getElementById('publish-task').disabled = true;
  document.getElementById('preview-count').textContent = '0';
  renderPreviewEmpty();
}

function buildPreview() {
  try {
    state.preview = createTaskOccurrences();
    renderPreview();
    document.getElementById('publish-task').disabled = false;
  } catch (error) {
    state.preview = [];
    document.getElementById('publish-task').disabled = true;
    showToast(error.message, 'error');
  }
}

function createTaskOccurrences() {
  const halaqaId = document.getElementById('task-halaqa').value;
  const title = document.getElementById('task-title').value.trim();
  const content = document.getElementById('task-content').value.trim();
  const startDate = parseDateInput(document.getElementById('task-date').value);
  const target = document.getElementById('task-target').value;
  const studentId = target === 'individual' ? document.getElementById('task-student').value : '';
  if (!halaqaId) throw new Error('اختر حلقة أولاً.');
  if (!state.students.length) throw new Error('أضف طلاباً إلى الحلقة قبل نشر المهام.');
  if (target === 'individual' && !studentId) throw new Error('اختر الطالب المستهدف.');
  if (!title || !content || !startDate) throw new Error('أكمل عنوان المهمة ومحتواها وتاريخها.');

  const repeating = document.getElementById('task-repeat').checked;
  let dates = [startDate];
  const seriesId = repeating ? crypto.randomUUID() : '';
  if (repeating) {
    const endDate = parseDateInput(document.getElementById('repeat-until').value);
    const weekdays = [...document.querySelectorAll('#repeat-days input:checked')].map(input => Number(input.value));
    if (!endDate || endDate < startDate) throw new Error('اختر تاريخ نهاية صحيحاً للتكرار.');
    if (!weekdays.length) throw new Error('اختر يوماً واحداً على الأقل للتكرار الأسبوعي.');
    if ((endDate - startDate) / 86400000 > 180) throw new Error('مدة التكرار القصوى ستة أشهر.');
    dates = [];
    for (let cursor = new Date(startDate); cursor <= endDate; cursor = addDays(cursor, 1)) {
      if (weekdays.includes(cursor.getDay())) dates.push(new Date(cursor));
      if (dates.length > 180) throw new Error('عدد المهام المتكررة كبير جداً.');
    }
    if (!dates.length) throw new Error('لا توجد تواريخ مطابقة لأيام التكرار المختارة.');
  }

  return dates.map(date => {
    const dateValue = toDateInput(date);
    const startTime = document.getElementById('task-start-time').value;
    const dueTime = document.getElementById('task-due-time').value;
    const scheduledAt = startTime ? toLocalIso(dateValue, startTime) : '';
    const dueAt = dueTime ? toLocalIso(dateValue, dueTime) : '';
    if (scheduledAt && dueAt && new Date(dueAt) < new Date(scheduledAt)) {
      throw new Error('موعد التسليم يجب أن يكون بعد وقت ظهور المهمة.');
    }
    return {
      student_id: studentId,
      type: document.getElementById('task-type').value,
      title,
      content,
      date: dateValue,
      period: document.getElementById('task-period').value,
      scheduled_at: scheduledAt,
      due_at: dueAt,
      estimated_minutes: Number(document.getElementById('task-duration').value),
      priority: Number(document.getElementById('task-priority').value),
      series_id: seriesId,
    };
  });
}

function renderPreview() {
  const container = document.getElementById('task-preview-list');
  document.getElementById('preview-count').textContent = String(state.preview.length);
  container.innerHTML = state.preview.map(item => `
    <article class="task-preview-item">
      <div class="task-preview-date"><strong>${escapeHtml(dayNumber(item.date))}</strong><span>${escapeHtml(shortMonth(item.date))}</span></div>
      <div class="task-preview-copy">
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(periodLabel(item.period))} · ${escapeHtml(formatClock(item.due_at))}</span>
      </div>
      <span class="task-kind-badge ${item.type}">${item.type === 'hifz' ? 'حفظ' : 'مراجعة'}</span>
    </article>
  `).join('');
}

async function publishTasks(event) {
  event.preventDefault();
  if (!state.preview.length) {
    showToast('عاين الجدول قبل نشره.', 'error');
    return;
  }
  const button = document.getElementById('publish-task');
  button.disabled = true;
  const original = button.innerHTML;
  button.textContent = 'جاري النشر...';
  try {
    let data = { assignments_count: state.preview.length };
    if (!state.previewMode) {
      const result = await supabase.rpc('publish_task_batch', {
        p_halaqa_id: document.getElementById('task-halaqa').value,
        p_assignments: state.preview,
        p_source: 'manual',
        p_file_name: null,
        p_metadata: { target: document.getElementById('task-target').value },
      });
      if (result.error) throw result.error;
      data = result.data;
    }
    showToast(`نُشرت ${data?.assignments_count || state.preview.length} مهمة بنجاح.`, 'success');
    state.preview = [];
    document.getElementById('task-content').value = '';
    document.getElementById('task-title').value = '';
    renderPreviewEmpty();
    await loadRecentTasks();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'تعذر نشر المهام.', 'error');
    button.disabled = false;
  } finally {
    button.innerHTML = original;
    if (window.lucide) window.lucide.createIcons();
  }
}

async function loadRecentTasks() {
  const halaqaId = document.getElementById('task-halaqa').value;
  const container = document.getElementById('recent-task-list');
  container.innerHTML = '<p class="task-loading">جاري تحميل المهام...</p>';
  if (!halaqaId) return;
  if (state.previewMode) {
    const today = toDateInput(new Date());
    state.recent = [
      { id: 'preview-task-1', title: 'الحفظ الجديد', content: 'سورة الملك من الآية 1 إلى 8', type: 'hifz', assignment_date: today, period: 'morning', estimated_minutes: 30, priority: 3 },
      { id: 'preview-task-2', title: 'مراجعة المحفوظ', content: 'سورة القلم كاملة', type: 'murajaa', assignment_date: toDateInput(addDays(new Date(), -1)), period: 'evening', estimated_minutes: 25, priority: 2 },
    ];
    document.getElementById('published-count').textContent = String(state.recent.length);
    renderRecentTasks();
    return;
  }
  const { data, error } = await supabase
    .from('daily_assignments')
    .select('id, title, content, type, assignment_date, period, due_at, estimated_minutes, priority, student_id, created_at')
    .eq('halaqa_id', halaqaId)
    .eq('teacher_id', state.profile.id)
    .order('assignment_date', { ascending: false })
    .limit(12);
  if (error) {
    container.innerHTML = '<p class="task-loading is-error">تعذر تحميل المهام.</p>';
    return;
  }
  state.recent = data || [];
  document.getElementById('published-count').textContent = String(state.recent.length);
  renderRecentTasks();
}

function renderRecentTasks() {
  const container = document.getElementById('recent-task-list');
  if (!state.recent.length) {
    container.innerHTML = '<div class="task-empty-state compact"><i data-lucide="clipboard-list"></i><p>لم تُنشر مهام لهذه الحلقة بعد.</p></div>';
  } else {
    container.innerHTML = state.recent.map(task => `
      <article class="task-recent-item">
        <div>
          <span>${escapeHtml(formatDate(task.assignment_date))} · ${escapeHtml(periodLabel(task.period))}</span>
          <strong>${escapeHtml(task.title)}</strong>
        </div>
        <div class="task-row-actions">
          <button type="button" data-action="duplicate" data-id="${escapeHtml(task.id)}" aria-label="نسخ المهمة" title="نسخ المهمة"><i data-lucide="copy"></i></button>
          <button type="button" data-action="delete" data-id="${escapeHtml(task.id)}" aria-label="حذف المهمة" title="حذف المهمة"><i data-lucide="trash-2"></i></button>
        </div>
      </article>
    `).join('');
  }
  if (window.lucide) window.lucide.createIcons();
}

async function handleRecentAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const task = state.recent.find(item => item.id === button.dataset.id);
  if (!task) return;
  if (button.dataset.action === 'duplicate') {
    document.getElementById('task-title').value = task.title;
    document.getElementById('task-content').value = task.content;
    document.getElementById('task-type').value = task.type;
    document.getElementById('task-period').value = task.period;
    document.getElementById('task-duration').value = String(task.estimated_minutes || 30);
    document.getElementById('task-priority').value = String(task.priority || 2);
    document.getElementById('task-date').value = toDateInput(addDays(new Date(), 1));
    invalidatePreview();
    document.getElementById('task-title').focus();
    showToast('نُسخت بيانات المهمة. راجع التاريخ ثم عاينها.', 'info');
    return;
  }
  if (!window.confirm(`حذف مهمة «${task.title}» وكل سجلاتها؟`)) return;
  if (state.previewMode) {
    state.recent = state.recent.filter(item => item.id !== task.id);
    renderRecentTasks();
    showToast('حُذفت المهمة من المعاينة.', 'success');
    return;
  }
  const { error } = await supabase.from('daily_assignments').delete().eq('id', task.id);
  if (error) showToast('تعذر حذف المهمة.', 'error');
  else {
    showToast('حُذفت المهمة.', 'success');
    await loadRecentTasks();
  }
}

function renderPreviewEmpty() {
  document.getElementById('preview-count').textContent = '0';
  document.getElementById('task-preview-list').innerHTML = '<div class="task-empty-state"><i data-lucide="calendar-clock"></i><p>أدخل التفاصيل ثم اضغط معاينة الجدول.</p></div>';
  document.getElementById('publish-task').disabled = true;
  if (window.lucide) window.lucide.createIcons();
}

function parseDateInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toLocalIso(date, time) {
  return new Date(`${date}T${time}:00`).toISOString();
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function dayNumber(value) {
  return new Intl.DateTimeFormat('ar-OM', { day: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

function shortMonth(value) {
  return new Intl.DateTimeFormat('ar-OM', { month: 'short' }).format(new Date(`${value}T12:00:00`));
}

function periodLabel(value) {
  return value === 'morning' ? 'صباحي' : value === 'evening' ? 'مسائي' : 'مرن';
}

function formatClock(value) {
  if (!value) return 'دون وقت محدد';
  return new Intl.DateTimeFormat('ar-OM', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
