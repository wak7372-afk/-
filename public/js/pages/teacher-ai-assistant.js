import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { escapeHtml, showToast } from '../lib/utils.js';

const state = {
  teacher: null,
  preview: false,
  halaqaId: '',
  fileName: '',
  assignments: [],
  summary: '',
  mode: 'structured',
  issues: [],
};

document.addEventListener('DOMContentLoaded', initializeImportPage);

async function initializeImportPage() {
  const authData = await requireAuth(['teacher']);
  if (!authData) return;
  state.teacher = authData.profile;
  state.preview = Boolean(authData.preview);
  document.getElementById('logout-btn').addEventListener('click', logoutUser);
  document.getElementById('excel-file-input').addEventListener('change', handleFileUpload);
  document.getElementById('approve-assignments-btn').addEventListener('click', publishAssignments);
  document.getElementById('download-template').addEventListener('click', downloadTemplate);
  document.getElementById('proposed-assignments-body').addEventListener('input', updateAssignmentFromTable);
  document.getElementById('proposed-assignments-body').addEventListener('change', updateAssignmentFromTable);
  const templateButton = document.getElementById('download-template');
  const spreadsheetReady = Boolean(window.XLSX);
  templateButton.dataset.libraryReady = String(spreadsheetReady);
  templateButton.disabled = !spreadsheetReady;
  if (!spreadsheetReady) setAnalysisStatus('error', 'قارئ Excel غير متاح');
  await loadTeacherHalaqat();
  refreshIcons();
}

async function loadTeacherHalaqat() {
  const select = document.getElementById('halaqa-select');
  if (state.preview) {
    select.innerHTML = '<option value="preview-halaqa">حلقة الإتقان - معاينة</option>';
    return;
  }
  const { data, error } = await supabase.from('halaqat').select('id, name').eq('teacher_id', state.teacher.id).order('name');
  if (error || !data?.length) {
    select.innerHTML = '<option value="">لا توجد حلقات متاحة</option>';
    return;
  }
  select.innerHTML = data.map(halaqa => `<option value="${escapeHtml(halaqa.id)}">${escapeHtml(halaqa.name)}</option>`).join('');
}

async function handleFileUpload(event) {
  const file = event.target.files?.[0];
  state.halaqaId = document.getElementById('halaqa-select').value;
  if (!file) return;
  if (!state.halaqaId) {
    showToast('اختر الحلقة المستهدفة أولاً.', 'error');
    event.target.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('حجم الملف يتجاوز 5 ميجابايت.', 'error');
    event.target.value = '';
    return;
  }
  state.fileName = file.name;
  document.getElementById('selected-file-name').textContent = `${file.name} · ${formatFileSize(file.size)}`;
  setAnalysisStatus('loading', 'جاري التحليل');

  try {
    const tableData = await readSpreadsheet(file);
    if (!tableData.length) throw new Error('الملف فارغ أو لا يحتوي صفوف بيانات.');
    const result = state.preview ? buildPreviewAnalysis(tableData) : await requestScheduleAnalysis(tableData);
    state.assignments = (result.assignments || []).map(normalizeAssignment);
    state.summary = result.summary || 'تم تجهيز الجدول للمراجعة.';
    state.mode = result.analysis_mode === 'ai' ? 'ai' : 'structured';
    state.issues = result.issues || [];
    if (!state.assignments.length) throw new Error('لم نجد مهام صالحة في الملف.');
    renderAnalysis(result);
    setAnalysisStatus('success', state.mode === 'ai' ? 'تحليل Gemini' : 'تحليل منظم');
    showToast(`تم تجهيز ${state.assignments.length} مهمة للمراجعة.`, 'success');
  } catch (error) {
    console.error(error);
    state.assignments = [];
    setAnalysisStatus('error', 'تعذر التحليل');
    showToast(error.message || 'تعذر تحليل ملف الجدول.', 'error');
  }
}

async function readSpreadsheet(file) {
  if (!window.XLSX) throw new Error('تعذر تحميل أداة قراءة Excel. تحقق من الاتصال ثم حدّث الصفحة.');
  const data = await file.arrayBuffer();
  const workbook = window.XLSX.read(data, { type: 'array', cellDates: true });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  return window.XLSX.utils.sheet_to_json(worksheet, { raw: false, defval: '' }).slice(0, 500);
}

async function requestScheduleAnalysis(tableData) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('انتهت جلسة المعلم. سجّل الدخول مرة أخرى.');
  const response = await fetch(`${supabase.supabaseUrl}/functions/v1/analyze-schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ halaqaId: state.halaqaId, tableData }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'تعذر الوصول إلى خدمة تحليل الجداول.');
  return payload;
}

function normalizeAssignment(assignment) {
  return {
    student_id: String(assignment.student_id || ''),
    student_name: String(assignment.student_name || 'كل طلاب الحلقة'),
    type: assignment.type === 'murajaa' ? 'murajaa' : 'hifz',
    title: String(assignment.title || (assignment.type === 'murajaa' ? 'مراجعة المحفوظ' : 'الحفظ الجديد')).slice(0, 160),
    content: String(assignment.content || '').slice(0, 2000),
    date: String(assignment.date || toDateKey(new Date())),
    period: ['morning', 'evening', 'flexible'].includes(assignment.period) ? assignment.period : 'flexible',
    due_time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(assignment.due_time || '')) ? assignment.due_time : '',
    estimated_minutes: Math.min(480, Math.max(5, Number(assignment.estimated_minutes) || 30)),
    priority: Math.min(3, Math.max(1, Number(assignment.priority) || 2)),
  };
}

function renderAnalysis(result) {
  document.getElementById('results-section').hidden = false;
  document.getElementById('ready-count').textContent = String(state.assignments.length);
  document.getElementById('ai-summary-text').textContent = state.summary;
  document.getElementById('analysis-mode-label').textContent = state.mode === 'ai' ? 'تحليل Gemini' : 'تحليل منظم';
  document.getElementById('approve-assignments-btn').disabled = false;

  const issues = document.getElementById('analysis-issues');
  issues.hidden = !state.issues.length;
  issues.innerHTML = state.issues.length
    ? `<div><i data-lucide="triangle-alert"></i><strong>${state.issues.length} صفوف تحتاج مراجعة</strong></div><ul>${state.issues.map(issue => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`
    : '';
  document.getElementById('ai-recommendations-list').innerHTML = (result.recommendations || [])
    .map(item => `<span><i data-lucide="circle-check"></i>${escapeHtml(item)}</span>`).join('');
  renderAssignmentRows();
  document.getElementById('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  refreshIcons();
}

function renderAssignmentRows() {
  document.getElementById('proposed-assignments-body').innerHTML = state.assignments.map((assignment, index) => `
    <tr>
      <td><strong class="import-student-name">${escapeHtml(assignment.student_name)}</strong><small>${assignment.student_id ? 'مهمة فردية' : 'كل الحلقة'}</small></td>
      <td><select data-index="${index}" data-field="type"><option value="hifz" ${assignment.type === 'hifz' ? 'selected' : ''}>حفظ</option><option value="murajaa" ${assignment.type === 'murajaa' ? 'selected' : ''}>مراجعة</option></select></td>
      <td class="import-content-cell"><input data-index="${index}" data-field="title" maxlength="160" value="${escapeHtml(assignment.title)}" aria-label="عنوان المهمة"><textarea data-index="${index}" data-field="content" maxlength="2000" rows="2" aria-label="محتوى المهمة">${escapeHtml(assignment.content)}</textarea></td>
      <td><input data-index="${index}" data-field="date" type="date" value="${escapeHtml(assignment.date)}" aria-label="تاريخ المهمة"></td>
      <td><select data-index="${index}" data-field="period"><option value="morning" ${assignment.period === 'morning' ? 'selected' : ''}>صباحي</option><option value="evening" ${assignment.period === 'evening' ? 'selected' : ''}>مسائي</option><option value="flexible" ${assignment.period === 'flexible' ? 'selected' : ''}>مرن</option></select></td>
      <td><input data-index="${index}" data-field="due_time" type="time" value="${escapeHtml(assignment.due_time)}" aria-label="وقت التسليم"></td>
      <td><input data-index="${index}" data-field="estimated_minutes" type="number" min="5" max="480" step="5" value="${assignment.estimated_minutes}" aria-label="المدة بالدقائق"></td>
    </tr>`).join('');
}

function updateAssignmentFromTable(event) {
  const field = event.target.dataset.field;
  const index = Number(event.target.dataset.index);
  if (!field || !Number.isInteger(index) || !state.assignments[index]) return;
  state.assignments[index][field] = field === 'estimated_minutes' ? Number(event.target.value) : event.target.value;
}

async function publishAssignments() {
  if (!state.assignments.length || !state.halaqaId) return;
  const invalid = state.assignments.find(item => !item.title.trim() || !item.content.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(item.date));
  if (invalid) {
    showToast('يوجد صف ناقص. راجع العنوان والمحتوى والتاريخ.', 'error');
    return;
  }
  const button = document.getElementById('approve-assignments-btn');
  button.disabled = true;
  const original = button.innerHTML;
  button.textContent = 'جاري نشر الدفعة...';
  try {
    const payload = state.assignments.map(item => ({
      student_id: item.student_id,
      type: item.type,
      title: item.title.trim(),
      content: item.content.trim(),
      date: item.date,
      period: item.period,
      scheduled_at: item.period === 'morning' ? localIso(item.date, '06:00') : item.period === 'evening' ? localIso(item.date, '15:00') : '',
      due_at: item.due_time ? localIso(item.date, item.due_time) : '',
      estimated_minutes: Math.min(480, Math.max(5, Number(item.estimated_minutes) || 30)),
      priority: item.priority,
    }));
    const { data, error } = await supabase.rpc('publish_task_batch', {
      p_halaqa_id: state.halaqaId,
      p_assignments: payload,
      p_source: state.mode === 'ai' ? 'ai' : 'excel',
      p_file_name: state.fileName,
      p_metadata: { analysis_mode: state.mode, issues_count: state.issues.length },
    });
    if (error) throw error;

    await supabase.from('ai_reports').insert({
      teacher_id: state.teacher.id,
      halaqa_id: state.halaqaId,
      report_text: state.summary,
      raw_data: { batch_id: data?.batch_id, rows: state.assignments.length, mode: state.mode },
    }).then(({ error: reportError }) => {
      if (reportError) console.warn('Task batch published without optional report record.', reportError);
    });
    showToast(`نُشرت ${data?.assignments_count || state.assignments.length} مهمة إلى ${data?.recipients_count || 0} طالب.`, 'success');
    setTimeout(() => { window.location.href = `/teacher/tasks.html?halaqa=${encodeURIComponent(state.halaqaId)}`; }, 1200);
  } catch (error) {
    console.error(error);
    button.disabled = false;
    showToast(error.message || 'تعذر نشر دفعة المهام.', 'error');
  } finally {
    button.innerHTML = original;
    refreshIcons();
  }
}

function downloadTemplate() {
  if (!window.XLSX) {
    showToast('تعذر تحميل أداة Excel. حدّث الصفحة ثم حاول مرة أخرى.', 'error');
    return;
  }
  const rows = [
    { 'اسم المستخدم': 'student.01', 'النوع': 'حفظ', 'عنوان المهمة': 'الحفظ الجديد', 'المحتوى': 'سورة الملك من الآية 1 إلى 8', 'التاريخ': toDateKey(new Date()), 'الفترة': 'صباحي', 'وقت التسليم': '18:00', 'المدة بالدقائق': 30, 'الأولوية': 2 },
    { 'اسم المستخدم': '', 'النوع': 'مراجعة', 'عنوان المهمة': 'مراجعة جماعية', 'المحتوى': 'سورة القلم كاملة', 'التاريخ': toDateKey(addDays(new Date(), 1)), 'الفترة': 'مسائي', 'وقت التسليم': '20:00', 'المدة بالدقائق': 25, 'الأولوية': 2 },
  ];
  const worksheet = window.XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 24 }, { wch: 42 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 10 }];
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, 'المهام');
  window.XLSX.writeFile(workbook, 'قالب-مهام-ذات-خيل.xlsx');
}

function buildPreviewAnalysis(rows) {
  const today = toDateKey(new Date());
  return {
    analysis_mode: 'structured',
    summary: `تمت قراءة ${rows.length} صف وتجهيز نموذج معاينة قابل للتعديل.`,
    recommendations: ['راجع التواريخ وأوقات التسليم قبل النشر.', 'يمكن ترك اسم الطالب فارغاً لإسناد المهمة إلى الحلقة كاملة.'],
    issues: [],
    assignments: rows.slice(0, 6).map((row, index) => ({
      student_id: index % 2 ? '00000000-0000-4000-8000-000000000003' : '',
      student_name: index % 2 ? 'طالب تجريبي' : 'كل طلاب الحلقة',
      type: index % 2 ? 'murajaa' : 'hifz',
      title: row['عنوان المهمة'] || (index % 2 ? 'مراجعة المحفوظ' : 'الحفظ الجديد'),
      content: row['المحتوى'] || row['المقرر'] || `سورة الملك - المقطع ${index + 1}`,
      date: row['التاريخ'] || today,
      period: index % 2 ? 'evening' : 'morning',
      due_time: index % 2 ? '20:00' : '11:30',
      estimated_minutes: 30,
      priority: 2,
    })),
  };
}

function setAnalysisStatus(status, label) {
  const badge = document.getElementById('analysis-badge');
  badge.className = `task-draft-badge import-status-${status}`;
  badge.innerHTML = `<i data-lucide="${status === 'loading' ? 'loader-circle' : status === 'success' ? 'badge-check' : status === 'error' ? 'circle-x' : 'shield-check'}"></i> ${escapeHtml(label)}`;
  refreshIcons();
}

function localIso(date, time) { return new Date(`${date}T${time}:00`).toISOString(); }
function toDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function addDays(date, days) { const result = new Date(date); result.setDate(result.getDate() + days); return result; }
function formatFileSize(bytes) { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} كيلوبايت` : `${(bytes / 1024 / 1024).toFixed(1)} ميجابايت`; }
function refreshIcons() { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } }); }
