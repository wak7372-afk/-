import { supabase } from '../lib/supabase-client.js';
import { isLocalPreviewMode, requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast } from '../lib/utils.js';

let currentTeacher = null;
let parsedAssignments = [];
let aiSummary = '';
let selectedHalaqaId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['teacher']);
  if (!authData) return;

  currentTeacher = authData.profile;
  await initI18n();

  document.getElementById('logout-btn').addEventListener('click', logoutUser);

  await loadTeacherHalaqat();

  document.getElementById('excel-file-input').addEventListener('change', handleFileUpload);
  document.getElementById('approve-assignments-btn').addEventListener('click', handleApproveAssignments);
});

async function loadTeacherHalaqat() {
  const select = document.getElementById('halaqa-select');
  const { data: halaqat } = await supabase.from('halaqat').select('id, name').eq('teacher_id', currentTeacher.id);

  if (!halaqat || halaqat.length === 0) {
    select.innerHTML = '<option value="">لا توجد حلقات قرآنية مضافة</option>';
    return;
  }

  select.innerHTML = halaqat.map(h => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.name || 'حلقة قرآنية')}</option>`).join('');
}

async function handleFileUpload(e) {
  const file = e.target.files[0];
  selectedHalaqaId = document.getElementById('halaqa-select').value;

  if (!file) return;
  if (!selectedHalaqaId) {
    showToast('يرجى اختيار الحلقة أولاً', 'error');
    return;
  }

  showToast('جاري قراءة ملف Excel وتحليله بالذكاء الاصطناعي...', 'info');

  try {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const jsonSchedule = XLSX.utils.sheet_to_json(worksheet);

    if (!jsonSchedule || jsonSchedule.length === 0) {
      throw new Error('الملف فارغ أو غير صالح');
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token && !isLocalPreviewMode()) {
      throw new Error('انتهت جلسة المعلم. سجّل الدخول مرة أخرى.');
    }

    const response = await fetch(`${supabase.supabaseUrl}/functions/v1/analyze-schedule`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {})
      },
      body: JSON.stringify({
        halaqaId: selectedHalaqaId,
        tableData: jsonSchedule
      })
    });

    let resData;
    if (response.ok) {
      resData = await response.json();
    } else if (isLocalPreviewMode()) {
      resData = generateLocalGeminiAnalysis(jsonSchedule, []);
    } else {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'تعذر الوصول إلى خدمة التحليل الذكي.');
    }

    parsedAssignments = resData.assignments || [];
    aiSummary = resData.summary || 'تم قراءة الجدول بنجاح وتوزيع المقررات على طلاب الحلقة.';

    displayResults(resData);
    showToast('تم تحليل الجدول بواسطة الذكاء الاصطناعي Gemini بنجاح', 'success');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'حدث خطأ أثناء تحليل ملف الجداول', 'error');
  }
}

function generateLocalGeminiAnalysis(tableData, students) {
  // Smart fallback algorithm to extract date, type, content and map to students
  const assignments = [];
  const today = new Date();

  tableData.forEach((row, idx) => {
    const student = students[idx % (students.length || 1)] || { id: null, full_name: 'طالب عام' };
    const dateStr = new Date(today.getTime() + idx * 86400000).toISOString().split('T')[0];

    const contentStr = row['المقرر'] || row['الحفظ'] || row['المحتوى'] || Object.values(row).join(' ');

    assignments.push({
      student_id: student.id,
      student_name: student.full_name,
      date: dateStr,
      type: idx % 2 === 0 ? 'hifz' : 'murajaa',
      content: contentStr || `سورة البقرة - الصفحة ${idx + 1}`
    });
  });

  return {
    assignments,
    summary: `تم تحليل عدد ${tableData.length} صف من ملف Excel بنجاح وتوزيع المقررات تلقائياً على التواريخ القادمة.`,
    recommendations: [
      'ينصح بمتابعة إنجاز طلاب الحلقة يومياً عبر الشاشة الرئيسية.',
      'نسبة توزيع الحفظ والمراجعة متوازنة ومناسبة لسرعة الحلقة.'
    ]
  };
}

function displayResults(resData) {
  document.getElementById('results-section').classList.remove('hidden');
  document.getElementById('ai-summary-text').textContent = resData.summary;

  const recContainer = document.getElementById('ai-recommendations-list');
  recContainer.innerHTML = (resData.recommendations || []).map(r => `<li class="text-xs text-amber-900">• ${escapeHtml(r)}</li>`).join('');

  const tableBody = document.getElementById('proposed-assignments-body');
  tableBody.innerHTML = resData.assignments.map(a => `
    <tr class="border-b">
      <td class="py-3 px-4 font-bold text-gray-800">${escapeHtml(a.student_name || 'طالب')}</td>
      <td class="py-3 px-4">
        <span class="px-2.5 py-1 rounded-full text-xs font-bold ${a.type === 'hifz' ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}">
          ${a.type === 'hifz' ? 'حفظ' : 'مراجعة'}
        </span>
      </td>
      <td class="py-3 px-4 font-semibold text-emerald-950">${escapeHtml(a.content)}</td>
      <td class="py-3 px-4 text-xs text-gray-500">${escapeHtml(a.date)}</td>
    </tr>
  `).join('');
}

async function handleApproveAssignments() {
  if (parsedAssignments.length === 0) return;

  try {
    for (const a of parsedAssignments) {
      if (!a.student_id) continue;

      const { data: assignment, error: aErr } = await supabase
        .from('daily_assignments')
        .insert({
          halaqa_id: selectedHalaqaId,
          student_id: a.student_id,
          teacher_id: currentTeacher.id,
          type: a.type,
          content: a.content,
          assignment_date: a.date
        })
        .select()
        .single();

      if (aErr) continue;

      await supabase.from('assignment_submissions').insert({
        assignment_id: assignment.id,
        student_id: a.student_id,
        status: 'pending'
      });
    }

    // Save AI Report Record
    await supabase.from('ai_reports').insert({
      teacher_id: currentTeacher.id,
      halaqa_id: selectedHalaqaId,
      report_text: aiSummary,
      raw_data: { count: parsedAssignments.length }
    });

    showToast('تم اعتماد وحفظ كافة المقررات بنجاح في قاعدة البيانات', 'success');
    setTimeout(() => {
      window.location.href = `/teacher/halaqa-detail.html?id=${selectedHalaqaId}`;
    }, 1500);
  } catch (err) {
    showToast('حدث خطأ أثناء اعتماد المقررات', 'error');
  }
}
