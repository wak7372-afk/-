import { isLocalPreviewMode } from '../lib/auth.js';
import { escapeHtml, showToast } from '../lib/utils.js';
import { createQuranReportImporter } from './quran-report-importer.js';

const TYPE_META = {
  hifz: { label: 'حفظ', icon: 'book-open-check' },
  tathbit: { label: 'تثبيت', icon: 'refresh-cw' },
  murajaa: { label: 'مراجعة', icon: 'library-big' },
};

export function createQuranReportManager({ container, supabase, getContext, refreshIcons }) {
  const state = {
    activeView: defaultView(),
    reportDate: muscatDateKey(),
    consoleData: null,
    reviewPlan: null,
    reviewStartDate: '',
    reviewEndDate: '',
    reviewType: 'all',
    extensionQueue: null,
    history: null,
    selectedStudentId: null,
    exemptAssignmentId: null,
    busy: false,
  };

  container.addEventListener('click', handleClick);
  container.addEventListener('submit', handleSubmit);

  return { render };

  function defaultView() {
    const permissions = getContext().workspace.permissions;
    return permissions.can_create_tasks ? 'create' : 'accounting';
  }

  function availableViews() {
    const permissions = getContext().workspace.permissions;
    const views = [];
    if (permissions.can_create_tasks) views.push({ id: 'create', label: 'إنشاء التقارير', icon: 'file-spreadsheet' });
    if (permissions.can_review_submissions) {
      views.push({ id: 'review', label: 'مراجعة التقارير', icon: 'calendar-search' });
      views.push({ id: 'accounting', label: 'محاسبة الطلاب', icon: 'users-round' });
      views.push({ id: 'extensions', label: 'طلبات التمديد', icon: 'timer-reset' });
    }
    return views;
  }

  function render() {
    const views = availableViews();
    if (!views.some(view => view.id === state.activeView)) state.activeView = views[0]?.id || 'create';
    container.className = 'quran-manager-root';
    container.innerHTML = `
      <div class="quran-manager-tabs" role="tablist" aria-label="إدارة تقارير القرآن">
        ${views.map(view => `<button type="button" role="tab" aria-selected="${state.activeView === view.id}" class="${state.activeView === view.id ? 'is-active' : ''}" data-manager-view="${view.id}"><i data-lucide="${view.icon}"></i><span>${view.label}</span>${view.id === 'extensions' && state.extensionQueue ? `<b>${state.extensionQueue.filter(item => item.status === 'pending').length}</b>` : ''}</button>`).join('')}
      </div>
      <div id="quran-manager-view" class="quran-manager-view"></div>
      ${renderExemptDialog()}`;
    renderActiveView();
    refreshIcons();
  }

  function renderActiveView() {
    const host = container.querySelector('#quran-manager-view');
    if (state.activeView === 'create') {
      createQuranReportImporter({ container: host, supabase, getContext, refreshIcons }).render();
      return;
    }
    if (state.activeView === 'accounting') {
      host.innerHTML = renderAccounting();
      return;
    }
    if (state.activeView === 'review') {
      host.innerHTML = renderReviewPlan();
      return;
    }
    host.innerHTML = renderExtensions();
  }

  function renderReviewPlan() {
    if (!state.reviewPlan) return loadingState('جاري تحميل التقارير المعتمدة...');
    const reports = (state.reviewPlan.reports || []).filter(report => state.reviewType === 'all' || report.task_type === state.reviewType);
    const assigned = reports.reduce((sum, report) => sum + Number(report.assigned_count || 0), 0);
    const completed = reports.reduce((sum, report) => sum + Number(report.completed_count || 0), 0);
    const pending = reports.reduce((sum, report) => sum + Number(report.pending_count || 0), 0);
    return `
      <section class="quran-review-toolbar">
        <div><span>الخطة المعتمدة</span><h3>مراجعة التقارير</h3><p>جميع تقارير الحفظ والتثبيت والمراجعة بعد اعتماد ملف الإكسل.</p></div>
        <form data-review-filter>
          <label><span>من</span><input name="review-start" type="date" value="${escapeHtml(state.reviewStartDate)}"></label>
          <label><span>إلى</span><input name="review-end" type="date" value="${escapeHtml(state.reviewEndDate)}"></label>
          <label><span>النوع</span><select name="review-type"><option value="all" ${state.reviewType === 'all' ? 'selected' : ''}>جميع الأنواع</option><option value="hifz" ${state.reviewType === 'hifz' ? 'selected' : ''}>الحفظ</option><option value="tathbit" ${state.reviewType === 'tathbit' ? 'selected' : ''}>التثبيت</option><option value="murajaa" ${state.reviewType === 'murajaa' ? 'selected' : ''}>المراجعة</option></select></label>
          <button type="submit"><i data-lucide="search"></i><span>عرض</span></button>
        </form>
      </section>
      <section class="quran-accounting-metrics" aria-label="ملخص التقارير المعتمدة">
        ${metric('calendar-range', 'التقارير', reports.length)}
        ${metric('users-round', 'التعيينات', assigned, 'gold')}
        ${metric('circle-check-big', 'منجز', completed, 'green')}
        ${metric('clock-3', 'قيد الإنجاز', pending, 'red')}
      </section>
      <section class="quran-approved-plan-list">
        <div class="quran-approved-plan-head"><span>التاريخ والنوع</span><span>محتوى التقرير</span><span>حالة الطلاب</span></div>
        ${reports.map(approvedReportRow).join('') || emptyState('calendar-x-2', 'لا توجد تقارير معتمدة ضمن هذا النطاق.')}
      </section>`;
  }

  function approvedReportRow(report) {
    const meta = TYPE_META[report.task_type] || TYPE_META.hifz;
    return `<article class="quran-approved-report">
      <div class="quran-approved-date"><time>${formatDate(report.report_date)}</time><span><i data-lucide="${meta.icon}"></i>${meta.label}</span></div>
      <div class="quran-approved-content"><strong>${escapeHtml(report.content)}</strong><small>${report.repetitions ? `${Number(report.repetitions)} تكرارات · ` : ''}${Number(report.max_points || 0).toFixed(2)} نقطة${report.notes ? ` · ${escapeHtml(report.notes)}` : ''}</small></div>
      <div class="quran-approved-counts"><span class="is-green"><b>${Number(report.completed_count || 0)}</b> منجز</span><span class="is-gold"><b>${Number(report.pending_count || 0)}</b> قيد الإنجاز</span><span><b>${Number(report.exempted_count || 0)}</b> معفى</span></div>
    </article>`;
  }

  function renderAccounting() {
    if (!state.consoleData) return loadingState('جاري تحميل محاسبة الطلاب...');
    const students = state.consoleData.students || [];
    const assignments = students.flatMap(student => student.assignments || []);
    const completed = assignments.filter(item => item.status === 'completed');
    const late = assignments.filter(item => item.is_overdue || item.completion_band === 'late');
    return `
      <section class="quran-accounting-toolbar">
        <div><span>المتابعة اليومية</span><h3>محاسبة الطلاب</h3><p>حالة الحفظ والتثبيت والمراجعة لكل طالب في التاريخ المحدد.</p></div>
        <div class="quran-accounting-date">
          <button type="button" data-manager-date="-1" title="اليوم السابق"><i data-lucide="chevron-right"></i></button>
          <label><i data-lucide="calendar-days"></i><input id="quran-accounting-date" type="date" value="${state.reportDate}"></label>
          <button type="button" data-manager-date="1" title="اليوم التالي"><i data-lucide="chevron-left"></i></button>
        </div>
      </section>
      <section class="quran-accounting-metrics" aria-label="ملخص المحاسبة">
        ${metric('users-round', 'الطلاب', students.length)}
        ${metric('circle-check-big', 'منجز', completed.length, 'green')}
        ${metric('clock-alert', 'متأخر', late.length, 'red')}
        ${metric('clipboard-list', 'قيد الإنجاز', assignments.filter(item => item.status === 'pending' && !item.is_overdue).length, 'gold')}
      </section>
      <section class="quran-student-accounting-list">
        <div class="quran-accounting-list-head"><span>الطالب</span><span>تقارير اليوم</span><span>الحالة</span><span></span></div>
        ${students.map(studentAccountingRow).join('') || emptyState('users-round', 'لا يوجد طلاب نشطون في الحلقة.')}
      </section>
      ${state.history ? renderStudentHistory() : ''}`;
  }

  function studentAccountingRow(student) {
    const assignments = student.assignments || [];
    const completed = assignments.filter(item => item.status === 'completed').length;
    const status = assignments.length === 0
      ? { label: 'لا توجد تقارير', tone: 'empty' }
      : assignments.some(item => item.is_overdue)
        ? { label: 'متأخر', tone: 'late' }
        : completed === assignments.length
          ? { label: 'مكتمل', tone: 'complete' }
          : completed
            ? { label: 'جزئي', tone: 'partial' }
            : { label: 'لم ينجز', tone: 'pending' };
    return `<article class="quran-accounting-student tone-${status.tone}">
      <div class="quran-accounting-person"><span class="person-avatar">${escapeHtml(firstCharacter(student.full_name))}</span><div><b>${escapeHtml(student.full_name)}</b><small>@${escapeHtml(student.username || '')}</small></div></div>
      <div class="quran-accounting-tasks">${['hifz', 'tathbit', 'murajaa'].map(type => accountingTaskChip(assignments.find(item => item.task_type === type), type)).join('')}</div>
      <div class="quran-accounting-status"><b>${status.label}</b>${Number(student.overdue_count || 0) ? `<small>${student.overdue_count} مهمة فائتة</small>` : '<small>لا يوجد تأخير سابق</small>'}</div>
      <button type="button" data-student-history="${escapeHtml(student.student_id)}" title="عرض سجل الطالب"><i data-lucide="history"></i><span>السجل</span></button>
    </article>`;
  }

  function accountingTaskChip(assignment, type) {
    const meta = TYPE_META[type];
    if (!assignment) return `<span class="is-empty"><i data-lucide="${meta.icon}"></i>${meta.label}<b>ـ</b></span>`;
    const tone = assignment.status === 'completed' ? assignment.completion_band || 'complete' : assignment.status === 'exempted' ? 'exempted' : assignment.is_overdue ? 'late' : 'pending';
    return `<span class="is-${tone}" title="${escapeHtml(assignment.content)}"><i data-lucide="${meta.icon}"></i>${meta.label}<b>${accountingStatusSymbol(assignment)}</b></span>`;
  }

  function renderStudentHistory() {
    const assignments = state.history.assignments || [];
    return `<section class="quran-student-history">
      <div class="quran-history-heading"><div><span>السجل الكامل</span><h3>${escapeHtml(state.history.student?.full_name || '')}</h3><p>@${escapeHtml(state.history.student?.username || '')} · ${Number(state.history.total || 0)} تقرير</p></div><button type="button" data-manager-action="close-history" title="إغلاق السجل"><i data-lucide="x"></i></button></div>
      <div class="quran-history-list">
        ${assignments.map(item => `<article class="history-${historyTone(item)}">
          <time>${formatDate(item.report_date)}</time>
          <span><i data-lucide="${TYPE_META[item.task_type]?.icon || 'book-open'}"></i>${TYPE_META[item.task_type]?.label || item.task_type}</span>
          <div><b>${escapeHtml(item.content)}</b>${item.repetitions ? `<small>${item.repetitions} تكرارات</small>` : ''}</div>
          <strong>${historyStatus(item)}</strong>
          <em>${item.awarded_points === null || item.awarded_points === undefined ? 'ـ' : `${Number(item.awarded_points).toFixed(2)} / ${Number(item.max_points).toFixed(2)}`}</em>
          ${item.status === 'pending' ? `<button type="button" data-exempt-assignment="${escapeHtml(item.id)}"><i data-lucide="shield-minus"></i>إعفاء</button>` : ''}
        </article>`).join('') || emptyState('history', 'لا يوجد سجل تقارير لهذا الطالب.')}
      </div>
    </section>`;
  }

  function renderExtensions() {
    if (!state.extensionQueue) return loadingState('جاري تحميل طلبات التمديد...');
    return `<section class="quran-extension-queue-head"><div><span>القرارات</span><h3>طلبات التمديد</h3><p>يمكن قبول بعض التقارير ورفض بعضها، وتحديد مدة أو وقت انتهاء جديد.</p></div><button type="button" data-manager-action="refresh-extensions"><i data-lucide="refresh-cw"></i><span>تحديث</span></button></section>
      <div class="quran-extension-queue">
        ${state.extensionQueue.map(extensionRequestCard).join('') || emptyState('timer-off', 'لا توجد طلبات تمديد قيد المراجعة.')}
      </div>`;
  }

  function extensionRequestCard(request) {
    const pending = request.status === 'pending';
    return `<article class="quran-extension-request status-${request.status}">
      <header><div class="quran-accounting-person"><span class="person-avatar">${escapeHtml(firstCharacter(request.full_name))}</span><div><b>${escapeHtml(request.full_name)}</b><small>@${escapeHtml(request.username || '')} · ${relativeTime(request.requested_at)}</small></div></div><span>${extensionRequestStatus(request.status)}</span></header>
      <div class="quran-extension-reason"><i data-lucide="message-square-quote"></i><p>${escapeHtml(request.reason)}</p><strong>${formatDuration(request.requested_minutes)} مطلوبة</strong></div>
      <form data-extension-decision="${escapeHtml(request.id)}">
        <div class="quran-extension-items">
          ${(request.items || []).map(item => `<label class="${item.item_status === 'approved' ? 'is-approved' : item.item_status === 'rejected' ? 'is-rejected' : ''}">
            ${pending ? `<input type="checkbox" name="approved-assignment" value="${escapeHtml(item.assignment_id)}" checked>` : ''}
            <i data-lucide="${TYPE_META[item.task_type]?.icon || 'book-open'}"></i>
            <span><b>${TYPE_META[item.task_type]?.label || item.task_type} · ${formatDate(item.report_date)}</b><small>${escapeHtml(item.content)}</small></span>
            <em>${item.item_status === 'pending' ? 'محدد للقبول' : item.item_status === 'approved' ? 'مقبول' : 'مرفوض'}</em>
          </label>`).join('')}
        </div>
        ${pending ? `<div class="quran-extension-decision-controls">
          <fieldset><legend>طريقة التمديد</legend><label><input type="radio" name="decision-mode" value="duration" checked><span>مدة</span></label><label><input type="radio" name="decision-mode" value="until"><span>وقت محدد</span></label></fieldset>
          <label><span>الدقائق</span><input name="granted-minutes" type="number" min="1" max="4320" value="${Number(request.requested_minutes)}"></label>
          <label><span>وقت الانتهاء</span><input name="approved-until" type="datetime-local"></label>
          <label class="decision-note"><span>ملاحظة القرار</span><input name="decision-note" maxlength="2000" placeholder="اختياري"></label>
          <button type="submit"><i data-lucide="badge-check"></i><span>اعتماد القرار</span></button>
        </div>` : ''}
      </form>
    </article>`;
  }

  function renderExemptDialog() {
    return `<dialog id="quran-exempt-dialog" class="quran-exempt-dialog"><form method="dialog" data-exempt-form><div><span><i data-lucide="shield-minus"></i></span><div><small>قرار المعلم</small><h3>إعفاء الطالب من التقرير</h3></div></div><p>الإعفاء يزيل التقرير من قائمة التأخير ويفتح التقارير اللاحقة، ويُحفظ سببه في السجل.</p><label><span>سبب الإعفاء</span><textarea name="exemption-reason" rows="4" maxlength="2000" required></textarea></label><footer><button type="button" data-manager-action="cancel-exempt">إلغاء</button><button type="submit">اعتماد الإعفاء</button></footer></form></dialog>`;
  }

  async function handleClick(event) {
    const viewButton = event.target.closest('[data-manager-view]');
    if (viewButton) {
      state.activeView = viewButton.dataset.managerView;
      render();
      await loadActiveView();
      return;
    }
    const dateButton = event.target.closest('[data-manager-date]');
    if (dateButton) {
      state.reportDate = addDateKey(state.reportDate, Number(dateButton.dataset.managerDate));
      state.history = null;
      await loadAccounting();
      return;
    }
    const historyButton = event.target.closest('[data-student-history]');
    if (historyButton) return loadHistory(historyButton.dataset.studentHistory);
    const exemptButton = event.target.closest('[data-exempt-assignment]');
    if (exemptButton) {
      state.exemptAssignmentId = exemptButton.dataset.exemptAssignment;
      container.querySelector('#quran-exempt-dialog')?.showModal();
      return;
    }
    const action = event.target.closest('[data-manager-action]')?.dataset.managerAction;
    if (action === 'close-history') {
      state.history = null;
      render();
    } else if (action === 'refresh-extensions') {
      await loadExtensions();
    } else if (action === 'cancel-exempt') {
      container.querySelector('#quran-exempt-dialog')?.close();
    }
  }

  async function handleSubmit(event) {
    const reviewForm = event.target.closest('[data-review-filter]');
    if (reviewForm) {
      event.preventDefault();
      const formData = new FormData(reviewForm);
      state.reviewStartDate = String(formData.get('review-start') || '');
      state.reviewEndDate = String(formData.get('review-end') || '');
      state.reviewType = String(formData.get('review-type') || 'all');
      await loadReviewPlan();
      return;
    }
    const extensionForm = event.target.closest('[data-extension-decision]');
    if (extensionForm) {
      event.preventDefault();
      await decideExtension(extensionForm);
      return;
    }
    const exemptForm = event.target.closest('[data-exempt-form]');
    if (exemptForm) {
      event.preventDefault();
      await exemptAssignment(exemptForm);
    }
  }

  async function loadActiveView() {
    if (state.activeView === 'review') await loadReviewPlan();
    if (state.activeView === 'accounting') await loadAccounting();
    if (state.activeView === 'extensions') await loadExtensions();
  }

  async function loadReviewPlan() {
    state.reviewPlan = null;
    render();
    try {
      state.reviewPlan = isLocalPreviewMode() ? previewReviewPlan() : await rpc('get_quran_approved_report_plan', {
        p_circle_id: getContext().circle.id,
        p_start_date: state.reviewStartDate || null,
        p_end_date: state.reviewEndDate || null,
      });
      render();
    } catch (error) {
      showToast(friendlyManagerError(error, 'تعذر تحميل التقارير المعتمدة.'), 'error');
    }
  }

  async function loadAccounting() {
    state.consoleData = null;
    render();
    try {
      state.consoleData = isLocalPreviewMode() ? previewConsole(state.reportDate) : await rpc('get_quran_teacher_console', { p_circle_id: getContext().circle.id, p_report_date: state.reportDate });
      render();
    } catch (error) {
      showToast(friendlyManagerError(error, 'تعذر تحميل محاسبة الطلاب.'), 'error');
    }
  }

  async function loadHistory(studentId) {
    state.selectedStudentId = studentId;
    try {
      state.history = isLocalPreviewMode() ? previewHistory(studentId) : await rpc('get_quran_student_history', { p_circle_id: getContext().circle.id, p_student_id: studentId, p_limit: 60, p_offset: 0 });
      render();
      container.querySelector('.quran-student-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      showToast(friendlyManagerError(error, 'تعذر تحميل سجل الطالب.'), 'error');
    }
  }

  async function loadExtensions() {
    state.extensionQueue = null;
    render();
    try {
      state.extensionQueue = isLocalPreviewMode() ? previewExtensions() : await rpc('get_quran_extension_queue', { p_circle_id: getContext().circle.id, p_status: 'all' });
      render();
    } catch (error) {
      showToast(friendlyManagerError(error, 'تعذر تحميل طلبات التمديد.'), 'error');
    }
  }

  async function decideExtension(form) {
    if (state.busy) return;
    const request = state.extensionQueue.find(item => item.id === form.dataset.extensionDecision);
    if (!request) return;
    const formData = new FormData(form);
    const approved = new Set(formData.getAll('approved-assignment'));
    const mode = formData.get('decision-mode');
    const minutes = Number(formData.get('granted-minutes'));
    const untilInput = formData.get('approved-until');
    if (mode === 'until' && !untilInput) return showToast('حدد وقت انتهاء التمديد.', 'error');
    const decisions = (request.items || []).map(item => approved.has(item.assignment_id) ? {
      assignment_id: item.assignment_id,
      action: 'approve',
      mode,
      ...(mode === 'duration' ? { minutes } : { until: new Date(untilInput).toISOString() }),
      note: formData.get('decision-note') || null,
    } : { assignment_id: item.assignment_id, action: 'reject', note: formData.get('decision-note') || null });
    state.busy = true;
    try {
      if (isLocalPreviewMode()) {
        request.status = approved.size === request.items.length ? 'approved' : approved.size ? 'partially_approved' : 'rejected';
        request.items.forEach(item => { item.item_status = approved.has(item.assignment_id) ? 'approved' : 'rejected'; });
      } else {
        await rpc('decide_quran_report_extension', { p_request_id: request.id, p_decisions: decisions });
        await loadExtensions();
      }
      showToast('تم اعتماد قرار التمديد وإشعار الطالب.', 'success');
      render();
    } catch (error) {
      showToast(friendlyManagerError(error, 'تعذر اعتماد قرار التمديد.'), 'error');
    } finally {
      state.busy = false;
    }
  }

  async function exemptAssignment(form) {
    if (!state.exemptAssignmentId || state.busy) return;
    const reason = new FormData(form).get('exemption-reason')?.trim();
    if (!reason || reason.length < 3) return showToast('اكتب سبب الإعفاء بوضوح.', 'error');
    state.busy = true;
    try {
      if (isLocalPreviewMode()) {
        const assignment = state.history?.assignments?.find(item => item.id === state.exemptAssignmentId);
        if (assignment) { assignment.status = 'exempted'; assignment.exemption_reason = reason; assignment.is_overdue = false; }
      } else {
        await rpc('exempt_quran_report_assignment', { p_assignment_id: state.exemptAssignmentId, p_reason: reason });
        await loadHistory(state.selectedStudentId);
        await loadAccounting();
      }
      container.querySelector('#quran-exempt-dialog')?.close();
      state.exemptAssignmentId = null;
      showToast('تم إعفاء الطالب وفتح تقاريره اللاحقة.', 'success');
      render();
    } catch (error) {
      showToast(friendlyManagerError(error, 'تعذر اعتماد الإعفاء.'), 'error');
    } finally {
      state.busy = false;
    }
  }

  async function rpc(name, parameters) {
    const { data, error } = await supabase.rpc(name, parameters);
    if (error) throw error;
    return data;
  }
}

function previewConsole(date) {
  const today = muscatDateKey();
  const students = [
    previewStudent('student-1', 'محمد بن أحمد الحارثي', 'mohammed.h', date, [
      previewTeacherAssignment('a1', date, 'hifz', 'completed', 'early'),
      previewTeacherAssignment('a2', date, 'tathbit', 'completed', 'middle'),
      previewTeacherAssignment('a3', date, 'murajaa', 'pending'),
    ]),
    previewStudent('student-2', 'وارث بن علي الخياري', 'warith.student', date, [
      previewTeacherAssignment('b1', date, 'hifz', date < today ? 'pending' : 'completed', date < today ? null : 'late_on_time'),
      previewTeacherAssignment('b2', date, 'tathbit', 'pending'),
      previewTeacherAssignment('b3', date, 'murajaa', 'pending'),
    ], date < today ? 2 : 1),
    previewStudent('student-3', 'يحيى بن عبدالله العدوي', 'yahya.a', date, []),
  ];
  return { report_date: date, server_now: new Date().toISOString(), students };
}

function previewReviewPlan() {
  const reports = [];
  for (let day = 0; day < 8; day += 1) {
    const date = addDateKey(muscatDateKey(), day);
    ['hifz', 'tathbit', 'murajaa'].forEach((type, index) => reports.push({
      id: `review-${day}-${type}`,
      report_date: date,
      task_type: type,
      content: type === 'hifz' ? `حفظ سورة الملك، المقطع ${day + 1}` : type === 'tathbit' ? `تثبيت محفوظ اليوم ${day + 1}` : `مراجعة الورد السابق ${day + 1}`,
      repetitions: type === 'tathbit' ? 3 : null,
      notes: index === 2 ? 'العناية بمواضع التشابه.' : null,
      max_points: type === 'hifz' ? 4 : 3,
      assigned_count: 18,
      completed_count: day === 0 ? 12 - index : 0,
      pending_count: day === 0 ? 6 + index : 18,
      exempted_count: 0,
    }));
  }
  return { date_from: reports[0].report_date, date_to: reports.at(-1).report_date, reports };
}

function previewStudent(id, fullName, username, date, assignments, overdueCount = 0) {
  return { student_id: id, membership_id: `membership-${id}`, full_name: fullName, username, report_date: date, assignments, overdue_count: overdueCount };
}

function previewTeacherAssignment(id, date, taskType, status, band = null) {
  return { id, report_date: date, task_type: taskType, content: `نموذج ${TYPE_META[taskType].label} ليوم ${date}`, repetitions: 3, status, starts_at: muscatIso(date, '00:00'), effective_due_at: muscatIso(date, '23:00'), completed_at: status === 'completed' ? muscatIso(date, band === 'early' ? '05:00' : band === 'middle' ? '13:00' : '21:00') : null, awarded_points: status === 'completed' ? (taskType === 'hifz' ? 3.1 : 1.7) : null, max_points: taskType === 'hifz' ? 4 : 3, available_points: status === 'pending' ? 1.8 : 0, completion_band: band, is_overdue: status === 'pending' && date < muscatDateKey() };
}

function previewHistory(studentId) {
  const student = previewConsole(muscatDateKey()).students.find(item => item.student_id === studentId) || previewConsole(muscatDateKey()).students[0];
  const assignments = [];
  for (let day = 0; day < 9; day += 1) {
    const date = addDateKey(muscatDateKey(), -day);
    ['hifz', 'tathbit', 'murajaa'].forEach((type, index) => {
      const late = day === 2 && index === 0;
      const pending = day === 0 && index === 2;
      assignments.push(previewTeacherAssignment(`history-${day}-${type}`, date, type, pending || late ? 'pending' : 'completed', late ? null : day % 3 === 0 ? 'early' : day % 3 === 1 ? 'middle' : 'late_on_time'));
      if (late) assignments.at(-1).is_overdue = true;
    });
  }
  return { student, total: assignments.length, assignments };
}

function previewExtensions() {
  const date = muscatDateKey();
  return [{
    id: 'request-1', student_id: 'student-2', full_name: 'وارث بن علي الخياري', username: 'warith.student', requested_minutes: 60,
    reason: 'لدي موعد عائلي وسأتمكن من إتمام التقارير بعد عودتي.', status: 'pending', requested_at: new Date(Date.now() - 35 * 60000).toISOString(),
    items: [
      { assignment_id: 'extension-a', item_status: 'pending', report_date: date, task_type: 'hifz', content: 'سورة الملك من الآية 9 إلى 15', effective_due_at: muscatIso(date, '23:00') },
      { assignment_id: 'extension-b', item_status: 'pending', report_date: date, task_type: 'murajaa', content: 'مراجعة الصفحات 562 إلى 570', effective_due_at: muscatIso(date, '23:00') },
    ],
  }];
}

function metric(icon, label, value, tone = '') {
  return `<article class="${tone ? `is-${tone}` : ''}"><i data-lucide="${icon}"></i><span>${label}</span><strong>${value}</strong></article>`;
}

function accountingStatusSymbol(assignment) {
  if (assignment.status === 'completed') return '✓';
  if (assignment.status === 'exempted') return 'معفى';
  if (assignment.is_overdue) return '!';
  return '…';
}

function historyTone(item) {
  if (item.status === 'exempted') return 'exempted';
  if (item.is_overdue || item.completion_band === 'late') return 'late';
  return item.completion_band || item.status;
}

function historyStatus(item) {
  if (item.status === 'exempted') return 'معفى';
  if (item.is_overdue) return 'متأخر';
  if (item.status === 'pending') return 'قيد الإنجاز';
  if (item.completion_band === 'early') return 'مبكر';
  if (item.completion_band === 'middle') return 'في الوقت';
  if (item.completion_band === 'late_on_time') return 'قرب النهاية';
  if (item.completion_band === 'late') return 'متأخر';
  return 'منجز';
}

function extensionRequestStatus(status) {
  if (status === 'approved') return 'مقبول';
  if (status === 'partially_approved') return 'مقبول جزئياً';
  if (status === 'rejected') return 'مرفوض';
  return 'قيد المراجعة';
}

function emptyState(icon, text) {
  return `<div class="workspace-empty-state"><i data-lucide="${icon}"></i><p>${text}</p></div>`;
}

function loadingState(text) {
  return `<div class="circle-loading"><span></span><p>${text}</p></div>`;
}

function firstCharacter(value) {
  return String(value || 'ط').trim().charAt(0) || 'ط';
}

function relativeTime(value) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return 'الآن';
  if (minutes < 60) return `منذ ${minutes} دقيقة`;
  return `منذ ${Math.floor(minutes / 60)} ساعة`;
}

function formatDuration(minutes) {
  const value = Number(minutes || 0);
  if (value < 60) return `${value} دقيقة`;
  const hours = Math.floor(value / 60);
  return value % 60 ? `${hours} س ${value % 60} د` : `${hours} ساعة`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ar-OM', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Muscat' }).format(new Date(`${value}T12:00:00+04:00`));
}

function muscatDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Muscat' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseDateKey(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

function addDateKey(value, days) {
  const date = parseDateKey(value);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function muscatIso(date, time) {
  return new Date(`${date}T${time}:00+04:00`).toISOString();
}

function friendlyManagerError(error, fallback) {
  const message = String(error?.message || '');
  if (/within 72 hours/i.test(message)) return 'وقت التمديد يجب أن يكون خلال 72 ساعة.';
  if (/Every requested report/i.test(message)) return 'يجب اتخاذ قرار لكل تقرير في الطلب.';
  if (/Only pending/i.test(message)) return 'تغيّرت حالة التقرير؛ حدّث البيانات وحاول مجدداً.';
  if (/not allowed|permission|42501/i.test(message)) return 'لا تملك صلاحية مراجعة تقارير هذه الحلقة.';
  return fallback;
}
