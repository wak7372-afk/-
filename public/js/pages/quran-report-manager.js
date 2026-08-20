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
    accountingSearch: '',
    accountingStatus: 'all',
    reviewPlan: null,
    reviewStartDate: '',
    reviewEndDate: '',
    reviewType: 'all',
    extensionQueue: null,
    shiftQueue: null,
    history: null,
    historyPeriod: 30,
    historySection: 'summary',
    historyType: 'all',
    historyStatus: 'all',
    selectedStudentId: null,
    exemptAssignmentId: null,
    planPreview: null,
    planPreviewKey: null,
    reportDetails: null,
    reportManagementPreview: null,
    reportManagementPreviewKey: null,
    busy: false,
  };

  container.addEventListener('click', handleClick);
  container.addEventListener('submit', handleSubmit);
  container.addEventListener('change', handleChange);
  container.addEventListener('input', handleInput);
  container.addEventListener('keydown', handleKeydown);

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
      if (canManageStudentPlan()) views.push({ id: 'shifts', label: 'طلبات الترحيل', icon: 'calendar-arrow-down' });
    }
    return views;
  }

  function render() {
    const views = availableViews();
    if (!views.some(view => view.id === state.activeView)) state.activeView = views[0]?.id || 'create';
    container.className = 'quran-manager-root';
    container.innerHTML = `
      <div class="quran-manager-tabs" role="tablist" aria-label="إدارة تقارير القرآن">
        ${views.map(view => `<button type="button" role="tab" aria-selected="${state.activeView === view.id}" class="${state.activeView === view.id ? 'is-active' : ''}" data-manager-view="${view.id}"><i data-lucide="${view.icon}"></i><span>${view.label}</span>${view.id === 'extensions' && state.extensionQueue ? `<b>${state.extensionQueue.filter(item => item.status === 'pending').length}</b>` : view.id === 'shifts' && state.shiftQueue ? `<b>${state.shiftQueue.filter(item => item.status === 'pending').length}</b>` : ''}</button>`).join('')}
      </div>
      <div id="quran-manager-view" class="quran-manager-view"></div>
      ${renderExemptDialog()}
      ${renderPlanDialog()}
      ${renderReportManagementDialog()}`;
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
    if (state.activeView === 'shifts') {
      host.innerHTML = renderShiftRequests();
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
        <div class="quran-approved-plan-head"><span>التاريخ والنوع</span><span>محتوى التقرير</span><span>حالة الطلاب</span><span>الإدارة</span></div>
        ${reports.map(approvedReportRow).join('') || emptyState('calendar-x-2', 'لا توجد تقارير معتمدة ضمن هذا النطاق.')}
      </section>`;
  }

  function approvedReportRow(report) {
    const meta = TYPE_META[report.task_type] || TYPE_META.hifz;
    const cancelled = report.status === 'cancelled';
    return `<article class="quran-approved-report ${cancelled ? 'is-cancelled' : ''}">
      <div class="quran-approved-date"><time>${formatDate(report.report_date)}</time><span><i data-lucide="${meta.icon}"></i>${meta.label}</span></div>
      <div class="quran-approved-content"><strong>${escapeHtml(report.content)}</strong><small>${report.repetitions ? `${Number(report.repetitions)} تكرارات · ` : ''}${Number(report.max_points || 0).toFixed(2)} نقطة${report.notes ? ` · ${escapeHtml(report.notes)}` : ''}${cancelled ? ' · نسخة تاريخية' : ` · النسخة ${Number(report.current_version || 1)}`}</small></div>
      <div class="quran-approved-counts"><span class="is-green"><b>${Number(report.completed_count || 0)}</b> منجز</span><span class="is-gold"><b>${Number(report.pending_count || 0)}</b> قيد الإنجاز</span><span><b>${Number(report.exempted_count || 0)}</b> معفى</span></div>
      <button type="button" class="quran-report-manage-command" data-manage-report="${escapeHtml(report.id)}" ${!canManageStudentPlan() ? 'hidden' : ''}><i data-lucide="${cancelled ? 'history' : 'file-pen-line'}"></i><span>${cancelled ? 'السجل' : 'إدارة'}</span></button>
    </article>`;
  }

  function renderAccounting() {
    if (!state.consoleData) return loadingState('جاري تحميل محاسبة الطلاب...');
    const allStudents = state.consoleData.students || [];
    const students = allStudents.filter(student => accountingStudentMatches(student)).sort(compareAccountingPriority);
    const summary = state.consoleData.summary || previewAccountingSummary(allStudents);
    return `
      <section class="quran-accounting-toolbar">
        <div class="quran-accounting-heading"><span>المتابعة اليومية</span><h3>محاسبة الطلاب</h3><p>ابدأ بمن يحتاج إلى متابعة، ثم افتح سجل الطالب لاتخاذ الإجراء المناسب.</p></div>
        <div class="quran-accounting-toolbar-actions">
          <div class="quran-accounting-date">
            <button type="button" data-manager-date="-1" title="اليوم السابق" aria-label="اليوم السابق"><i data-lucide="chevron-right"></i></button>
            <label><i data-lucide="calendar-days"></i><input id="quran-accounting-date" aria-label="تاريخ المحاسبة" type="date" value="${state.reportDate}"></label>
            <button type="button" data-manager-date="1" title="اليوم التالي" aria-label="اليوم التالي"><i data-lucide="chevron-left"></i></button>
          </div>
          <details class="quran-accounting-menu">
            <summary title="المزيد من الإجراءات" aria-label="المزيد من الإجراءات"><i data-lucide="ellipsis"></i></summary>
            <div><button type="button" data-accounting-export><i data-lucide="file-spreadsheet"></i><span>تصدير القائمة إلى Excel</span></button></div>
          </details>
        </div>
      </section>
      <section class="quran-accounting-metrics" aria-label="ملخص المحاسبة">
        ${accountingMetricButton('users-round', 'جميع الطلاب', Number(summary.student_count || allStudents.length), 'all')}
        ${accountingMetricButton('clock-alert', 'يحتاج متابعة', Number(summary.attention_students || 0), 'attention', 'red')}
        ${accountingMetricButton('triangle-alert', 'لديه تأخير', allStudents.filter(student => Number(student.overdue_count || 0) > 0).length, 'overdue', 'red')}
        ${accountingMetricButton('circle-check-big', 'مكتمل في الوقت', Number(summary.completed_on_time_students || 0), 'completed', 'green')}
      </section>
      <section class="quran-accounting-workbar">
        <form class="quran-accounting-controls" data-accounting-filter>
          <label class="quran-accounting-search"><i data-lucide="search"></i><input name="accounting-search" value="${escapeHtml(state.accountingSearch)}" placeholder="ابحث باسم الطالب أو اسم المستخدم"><button type="submit" aria-label="بحث"><i data-lucide="arrow-left"></i></button></label>
        </form>
        <div class="quran-accounting-quick-filters" role="group" aria-label="تصفية الطلاب حسب الحالة">
          ${accountingFilterChip('all', 'الكل')}
          ${accountingFilterChip('attention', 'يحتاج متابعة')}
          ${accountingFilterChip('overdue', 'متأخر')}
          ${accountingFilterChip('pending', 'قيد الإنجاز')}
          ${accountingFilterChip('completed', 'مكتمل')}
          ${accountingFilterChip('no_reports', 'بلا تقارير')}
        </div>
        <span class="quran-accounting-result-count">${students.length} من ${allStudents.length} طالباً</span>
      </section>
      <div class="quran-accounting-legend" aria-label="دليل تصنيف وقت الإنجاز"><span class="is-early">مبكر</span><span class="is-middle">متوسط</span><span class="is-late_on_time">قرب النهاية</span><span class="is-late">بعد الموعد</span><small>يُحسب التصنيف وفق الموعد الفعلي بعد أي تمديد.</small></div>
      <section class="quran-student-accounting-list">
        <div class="quran-accounting-list-head"><span>الطالب</span><span>الحالة الآن</span><span>تقارير اليوم</span><span>الإجراء</span></div>
        ${students.map(studentAccountingRow).join('') || emptyState('search-x', 'لا يوجد طلاب يطابقون البحث الحالي.')}
      </section>
      ${state.history ? renderStudentHistory() : ''}`;
  }

  function studentAccountingRow(student) {
    const assignments = student.assignments || [];
    const status = dailyStateMeta(student.daily_state || inferDailyState(student));
    const dueText = student.next_due_at ? formatRemainingUntil(student.next_due_at, state.consoleData.server_now) : '';
    return `<article class="quran-accounting-student tone-${status.tone}">
      <div class="quran-accounting-person"><span class="person-avatar">${escapeHtml(firstCharacter(student.full_name))}</span><div><b>${escapeHtml(student.full_name)}</b><small>@${escapeHtml(student.username || '')}</small></div></div>
      <div class="quran-accounting-status"><span class="quran-status-dot" aria-hidden="true"></span><div><b>${status.label}</b>${Number(student.overdue_count || 0) ? `<button type="button" data-overdue-history="${escapeHtml(student.student_id)}">${student.overdue_count} مهمة فائتة</button>` : `<small>${student.has_extension ? `موعد ممدد${dueText ? ` · ${dueText}` : ''}` : dueText || 'لا يوجد تأخير سابق'}</small>`}</div></div>
      <div class="quran-accounting-tasks">${['hifz', 'tathbit', 'murajaa'].map(type => accountingTaskChip(assignments.find(item => item.task_type === type), type)).join('')}</div>
      <button type="button" class="quran-open-student-command" data-student-history="${escapeHtml(student.student_id)}" title="فتح سجل الطالب"><i data-lucide="panel-left-open"></i><span>فتح السجل</span></button>
    </article>`;
  }

  function accountingTaskChip(assignment, type) {
    const meta = TYPE_META[type];
    if (!assignment) return `<span class="is-empty"><i data-lucide="${meta.icon}"></i>${meta.label}<b>ـ</b></span>`;
    const tone = assignment.status === 'completed' ? assignment.completion_band || 'complete' : assignment.status === 'exempted' ? 'exempted' : assignment.is_overdue ? 'late' : 'pending';
    const extended = assignment.deadline_extended ? ` · ممدد ${formatDuration(assignment.extension_minutes)}` : '';
    return `<span class="is-${tone}" title="${escapeHtml(assignment.content)}${extended}"><i data-lucide="${meta.icon}"></i>${meta.label}<b>${accountingStatusSymbol(assignment)}</b></span>`;
  }

  function accountingMetricButton(icon, label, value, filter, tone = '') {
    return `<button type="button" class="${tone ? `is-${tone}` : ''} ${state.accountingStatus === filter ? 'is-active' : ''}" data-accounting-status-filter="${filter}" aria-pressed="${state.accountingStatus === filter}"><i data-lucide="${icon}"></i><span>${label}</span><strong>${value}</strong><small>عرض الطلاب</small></button>`;
  }

  function accountingFilterChip(value, label) {
    return `<button type="button" class="${state.accountingStatus === value ? 'is-active' : ''}" data-accounting-status-filter="${value}" aria-pressed="${state.accountingStatus === value}">${label}</button>`;
  }

  function compareAccountingPriority(first, second) {
    const rank = { overdue: 0, partial: 1, pending: 2, completed_late: 3, completed: 4, exempted: 5, no_reports: 6 };
    const firstState = first.daily_state || inferDailyState(first);
    const secondState = second.daily_state || inferDailyState(second);
    return Number(second.overdue_count || 0) - Number(first.overdue_count || 0)
      || (rank[firstState] ?? 9) - (rank[secondState] ?? 9)
      || String(first.full_name || '').localeCompare(String(second.full_name || ''), 'ar');
  }

  function accountingStudentMatches(student) {
    const query = state.accountingSearch.trim().toLocaleLowerCase('ar');
    const stateValue = student.daily_state || inferDailyState(student);
    const matchesSearch = !query || `${student.full_name || ''} ${student.username || ''}`.toLocaleLowerCase('ar').includes(query);
    const matchesStatus = state.accountingStatus === 'all'
      || state.accountingStatus === stateValue
      || (state.accountingStatus === 'attention' && ['overdue', 'partial', 'pending'].includes(stateValue))
      || (state.accountingStatus === 'completed' && ['completed', 'completed_late'].includes(stateValue))
      || (state.accountingStatus === 'pending' && ['partial', 'pending'].includes(stateValue))
      || (state.accountingStatus === 'overdue' && Number(student.overdue_count || 0) > 0);
    return matchesSearch && matchesStatus;
  }

  function filteredHistoryAssignments() {
    const assignments = state.history?.assignments || [];
    const startDate = addDateKey(muscatDateKey(), -(Number(state.historyPeriod || 30) - 1));
    return assignments.filter(item => {
      const inPeriod = state.historyStatus === 'overdue'
        ? true
        : item.report_date >= startDate && item.report_date <= muscatDateKey();
      const typeMatch = state.historyType === 'all' || item.task_type === state.historyType;
      const statusMatch = state.historyStatus === 'all'
        || (state.historyStatus === 'overdue' && item.is_overdue)
        || (state.historyStatus !== 'overdue' && item.status === state.historyStatus);
      return inPeriod && typeMatch && statusMatch;
    });
  }

  function renderStudentHistory() {
    const assignments = filteredHistoryAssignments();
    const period = state.history.analytics?.periods?.[String(state.historyPeriod)] || {};
    const progress = state.history.analytics?.latest_progress || {};
    const events = state.history.recent_events || [];
    return `<button type="button" class="quran-history-backdrop" data-manager-action="close-history" aria-label="إغلاق سجل الطالب"></button>
      <aside class="quran-student-history" role="dialog" aria-modal="true" aria-labelledby="quran-history-title">
        <header class="quran-history-heading">
          <div class="quran-history-person"><span class="person-avatar">${escapeHtml(firstCharacter(state.history.student?.full_name || ''))}</span><div><small>السجل التحليلي</small><h3 id="quran-history-title">${escapeHtml(state.history.student?.full_name || '')}</h3><p>@${escapeHtml(state.history.student?.username || '')} · ${escapeHtml(state.history.student?.circle_name || '')}</p></div></div>
          <div class="quran-history-actions">${canManageStudentPlan() ? `<button type="button" class="plan-command" data-manager-action="open-plan-adjustment" title="تعديل خطة الطالب"><i data-lucide="calendar-cog"></i><span>تعديل الخطة</span></button>` : ''}<button type="button" class="close-command" data-manager-action="close-history" title="إغلاق السجل" aria-label="إغلاق سجل الطالب"><i data-lucide="x"></i></button></div>
        </header>
        <nav class="quran-history-sections" role="tablist" aria-label="أقسام سجل الطالب">
          ${historySectionButton('summary', 'الملخص', 'layout-dashboard')}
          ${historySectionButton('reports', `التقارير (${Number(state.history.total || 0)})`, 'clipboard-list')}
          ${historySectionButton('events', `القرارات (${events.length})`, 'logs')}
        </nav>
        <div class="quran-history-body">
          ${state.historySection === 'summary' ? `<section class="quran-history-summary" aria-label="ملخص أداء الطالب">
            ${Number(state.history.overdue_count || 0) ? `<button type="button" class="quran-history-alert" data-history-open-overdue><i data-lucide="triangle-alert"></i><span><b>${Number(state.history.overdue_count)} تقرير متأخر يحتاج إجراء</b><small>افتح التقارير المتأخرة للإعفاء أو المتابعة.</small></span><i data-lucide="chevron-left"></i></button>` : ''}
            <div class="quran-history-periods" role="tablist" aria-label="فترة التحليل">${[7, 30, 90].map(days => `<button type="button" role="tab" aria-selected="${state.historyPeriod === days}" class="${state.historyPeriod === days ? 'is-active' : ''}" data-history-period="${days}">${days} يوماً</button>`).join('')}</div>
            <div class="quran-history-metrics">
              ${historyMetric('chart-no-axes-column-increasing', 'نسبة الإنجاز', `${Number(period.completion_rate || 0).toFixed(1)}%`, 'green')}
              ${historyMetric('timer-reset', 'في الوقت', `${Number(period.on_time_rate || 0).toFixed(1)}%`, 'gold')}
              ${historyMetric('clock-alert', 'متأخر', Number(period.late_count || 0), 'red')}
              ${historyMetric('triangle-alert', 'غير منجز', Number(period.overdue_count || 0), 'red')}
              ${historyMetric('sparkles', 'النقاط', Number(period.earned_points || 0).toFixed(2))}
            </div>
            <div class="quran-history-section-heading"><div><span>المسار الحالي</span><h4>آخر موضع منجز</h4></div><small>${Number(state.history.total || 0)} تقرير في السجل</small></div>
            <div class="quran-history-progress">${['hifz', 'tathbit', 'murajaa'].map(type => latestProgressCard(type, progress[type])).join('')}</div>
          </section>` : ''}
          ${state.historySection === 'reports' ? `<section class="quran-history-reports" aria-label="تقارير الطالب">
            <div class="quran-history-filters">
              <label><span>النوع</span><select name="history-type"><option value="all">الكل</option><option value="hifz" ${state.historyType === 'hifz' ? 'selected' : ''}>الحفظ</option><option value="tathbit" ${state.historyType === 'tathbit' ? 'selected' : ''}>التثبيت</option><option value="murajaa" ${state.historyType === 'murajaa' ? 'selected' : ''}>المراجعة</option></select></label>
              <label><span>الحالة</span><select name="history-status"><option value="all">جميع الحالات</option><option value="overdue" ${state.historyStatus === 'overdue' ? 'selected' : ''}>المتأخرة فقط</option><option value="completed" ${state.historyStatus === 'completed' ? 'selected' : ''}>المنجزة</option><option value="pending" ${state.historyStatus === 'pending' ? 'selected' : ''}>المعلقة</option><option value="exempted" ${state.historyStatus === 'exempted' ? 'selected' : ''}>المعفاة</option><option value="replaced" ${state.historyStatus === 'replaced' ? 'selected' : ''}>المتخطاة</option></select></label>
              <span>${assignments.length} نتيجة ظاهرة</span>
            </div>
            <div class="quran-history-list">${assignments.map(historyAssignmentRow).join('') || emptyState('history', 'لا يوجد سجل تقارير يطابق الفلاتر.')}</div>
          </section>` : ''}
          ${state.historySection === 'events' ? `<section class="quran-history-events" aria-label="سجل القرارات والعمليات"><div class="quran-history-section-heading"><div><span>سجل محمي</span><h4>القرارات والعمليات</h4></div><small>${events.length} عملية حديثة</small></div><div>${events.map(historyEventRow).join('') || '<p>لا توجد عمليات مسجلة.</p>'}</div></section>` : ''}
        </div>
      </aside>`;
  }

  function historySectionButton(value, label, icon) {
    return `<button type="button" role="tab" aria-selected="${state.historySection === value}" class="${state.historySection === value ? 'is-active' : ''}" data-history-section="${value}"><i data-lucide="${icon}"></i><span>${label}</span></button>`;
  }

  function historyAssignmentRow(item) {
    return `<article class="history-${historyTone(item)}">
      <time>${formatDate(item.report_date)}</time>
      <span><i data-lucide="${TYPE_META[item.task_type]?.icon || 'book-open'}"></i>${TYPE_META[item.task_type]?.label || item.task_type}</span>
      <div><b>${escapeHtml(item.content)}</b>${item.repetitions ? `<small>${item.repetitions} تكرارات</small>` : ''}</div>
      <strong>${historyStatus(item)}</strong>
      <em>${item.awarded_points === null || item.awarded_points === undefined ? 'ـ' : `${Number(item.awarded_points).toFixed(2)} / ${Number(item.max_points).toFixed(2)}`}</em>
      ${item.status === 'pending' ? `<button type="button" data-exempt-assignment="${escapeHtml(item.id)}"><i data-lucide="shield-minus"></i>إعفاء</button>` : ''}
    </article>`;
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

  function renderShiftRequests() {
    if (!state.shiftQueue) return loadingState('جاري تحميل طلبات ترحيل التقارير...');
    return `<section class="quran-extension-queue-head quran-shift-queue-head"><div><span>إعادة الجدولة الفردية</span><h3>طلبات ترحيل التقارير</h3><p>حدد تاريخ البداية الجديد؛ ستتحرك جميع التقارير المعلقة ابتداءً من اليوم المطلوب للطالب وحده.</p></div><button type="button" data-manager-action="refresh-shifts"><i data-lucide="refresh-cw"></i><span>تحديث</span></button></section>
      <div class="quran-shift-queue">
        ${state.shiftQueue.map(shiftRequestCard).join('') || emptyState('calendar-x-2', 'لا توجد طلبات ترحيل حالياً.')}
      </div>`;
  }

  function shiftRequestCard(request) {
    const pending = request.status === 'pending';
    const earliestTarget = addDateKey(request.requested_from_date, 1);
    const suggestedTarget = muscatDateKey() > earliestTarget ? muscatDateKey() : earliestTarget;
    return `<article class="quran-shift-request status-${escapeHtml(request.status)}">
      <header><div class="quran-accounting-person"><span class="person-avatar">${escapeHtml(firstCharacter(request.full_name))}</span><div><b>${escapeHtml(request.full_name)}</b><small>@${escapeHtml(request.username || '')} · ${relativeTime(request.requested_at)}</small></div></div><span>${shiftRequestStatus(request.status)}</span></header>
      <div class="quran-shift-request-body">
        <div class="quran-shift-route"><span><small>بداية التقارير المتأخرة</small><b>${escapeHtml(formatDate(request.requested_from_date))}</b></span><i data-lucide="arrow-left"></i><span><small>${pending ? 'يحدده المعلم' : 'البداية الجديدة'}</small><b>${pending ? 'بانتظار القرار' : escapeHtml(formatDate(request.decision_target_date))}</b></span></div>
        <blockquote><i data-lucide="message-square-quote"></i><p>${escapeHtml(request.reason)}</p></blockquote>
        <div class="quran-shift-impact"><span><b>${Number(request.overdue_report_count || 0)}</b> متأخر</span><span><b>${Number(request.pending_report_count || 0)}</b> تقرير سيتحرك</span><span><b>${request.current_start ? `${escapeHtml(formatDate(request.current_start))} - ${escapeHtml(formatDate(request.current_end))}` : 'لا يوجد نطاق'}</b> النطاق الحالي</span></div>
        ${Number(request.pending_extension_count || 0) ? `<p class="quran-shift-warning"><i data-lucide="timer-off"></i>يوجد ${Number(request.pending_extension_count)} طلب تمديد معلق؛ يجب البت فيه أولاً.</p>` : ''}
      </div>
      ${pending ? `<form data-shift-decision-form="${escapeHtml(request.id)}">
        <label><span>تاريخ البداية الجديد</span><input name="shift-target-date" type="date" min="${escapeHtml(earliestTarget)}" value="${escapeHtml(suggestedTarget)}" required></label>
        <label><span>ملاحظة القرار</span><input name="shift-decision-note" maxlength="2000" placeholder="اختياري"></label>
        <div><button type="submit" class="reject" data-shift-decision="reject"><i data-lucide="x"></i><span>رفض الطلب</span></button><button type="submit" class="approve" data-shift-decision="approve" ${Number(request.pending_extension_count || 0) ? 'disabled' : ''}><i data-lucide="badge-check"></i><span>اعتماد الترحيل</span></button></div>
      </form>` : request.decision_note ? `<p class="quran-shift-decision-note"><b>ملاحظة القرار:</b> ${escapeHtml(request.decision_note)}</p>` : ''}
    </article>`;
  }

  function renderExemptDialog() {
    return `<dialog id="quran-exempt-dialog" class="quran-exempt-dialog"><form method="dialog" data-exempt-form><div><span><i data-lucide="shield-minus"></i></span><div><small>قرار المعلم</small><h3>إعفاء الطالب من التقرير</h3></div></div><p>الإعفاء يزيل التقرير من قائمة التأخير ويفتح التقارير اللاحقة، ويُحفظ سببه في السجل.</p><label><span>سبب الإعفاء</span><textarea name="exemption-reason" rows="4" maxlength="2000" required></textarea></label><footer><button type="button" data-manager-action="cancel-exempt">إلغاء</button><button type="submit">اعتماد الإعفاء</button></footer></form></dialog>`;
  }

  function renderPlanDialog() {
    return `<dialog id="quran-plan-dialog" class="quran-plan-dialog">
      <form data-plan-adjustment-form>
        <header><span><i data-lucide="calendar-cog"></i></span><div><small>إدارة المسار الفردي</small><h3>تعديل خطة الطالب</h3></div><button type="button" data-manager-action="cancel-plan-adjustment" title="إغلاق"><i data-lucide="x"></i></button></header>
        <p class="quran-plan-intro">تُطبّق العملية على التقارير المعلقة لهذا الطالب فقط. التقارير المنجزة والمعفاة تبقى كما هي، ويُحفظ سبب التعديل في سجل التدقيق.</p>
        <fieldset class="quran-plan-modes"><legend>نوع التعديل</legend><label><input type="radio" name="plan-action" value="shift" checked><span><i data-lucide="calendar-arrow-down"></i><b>زحزحة التقارير</b><small>نقل كل تقرير إلى الأيام التالية.</small></span></label><label><input type="radio" name="plan-action" value="advance"><span><i data-lucide="list-start"></i><b>البدء من مرحلة متقدمة</b><small>تخطي ما أتمه الطالب سابقاً.</small></span></label></fieldset>
        <div class="quran-plan-fields">
          <label><span data-plan-from-label>زحزحة التقارير ابتداءً من</span><input name="plan-from-date" type="date" required></label>
          <label data-shift-days-field><span>عدد الأيام</span><input name="plan-days" type="number" min="1" max="365" value="1"></label>
          <label data-target-date-field hidden><span>تاريخ بدء المرحلة الجديدة</span><input name="plan-target-date" type="date"></label>
          <label class="quran-plan-reason"><span>سبب التعديل</span><textarea name="plan-reason" rows="3" maxlength="2000" required placeholder="مثال: لم يرسل تقرير اليوم، أو أتم هذه المرحلة سابقاً"></textarea></label>
        </div>
        <div class="quran-plan-preview" data-plan-preview hidden></div>
        <footer><button type="button" data-manager-action="cancel-plan-adjustment">إلغاء</button><button type="submit" class="preview-command" data-plan-submit="preview"><i data-lucide="scan-search"></i><span>معاينة الأثر</span></button><button type="submit" class="apply-command" data-plan-submit="apply" disabled><i data-lucide="badge-check"></i><span>اعتماد التعديل</span></button></footer>
      </form>
    </dialog>`;
  }

  function renderReportManagementDialog() {
    if (!state.reportDetails) return '<dialog id="quran-report-management-dialog" class="quran-report-management-dialog"></dialog>';
    const report = state.reportDetails.report;
    const assignments = state.reportDetails.assignments || [];
    const versions = state.reportDetails.versions || [];
    const meta = TYPE_META[report.task_type] || TYPE_META.hifz;
    const cancelled = report.status === 'cancelled';
    return `<dialog id="quran-report-management-dialog" class="quran-report-management-dialog">
      <form data-report-management-form>
        <header><span><i data-lucide="${meta.icon}"></i></span><div><small>${cancelled ? 'نسخة تاريخية' : 'تقرير معتمد'} · ${meta.label}</small><h3>إدارة التقرير</h3><p>${formatDate(report.report_date)} · ${Number(report.max_points).toFixed(2)} نقطة</p></div><button type="button" data-manager-action="close-report-management" title="إغلاق"><i data-lucide="x"></i></button></header>
        <section class="quran-report-management-stats">
          ${managementMetric('clock-3', 'معلق', assignments.filter(item => item.status === 'pending').length, 'gold')}
          ${managementMetric('circle-check-big', 'منجز', assignments.filter(item => item.status === 'completed').length, 'green')}
          ${managementMetric('shield-minus', 'معفى', assignments.filter(item => item.status === 'exempted').length)}
          ${managementMetric('history', 'نسخ محفوظة', versions.length)}
        </section>
        <div class="quran-report-management-layout">
          <section class="quran-report-edit-fields">
            <div class="quran-report-fixed-meta"><span><i data-lucide="lock-keyhole"></i>نوع التقرير والنقاط ثابتان لحماية السجل</span><b>${meta.label} · ${Number(report.max_points).toFixed(2)} نقطة</b></div>
            <label><span>تاريخ التقرير</span><input name="approved-report-date" aria-label="تاريخ التقرير" type="date" value="${escapeHtml(report.report_date)}" ${cancelled ? 'disabled' : ''} required></label>
            <label><span>المحتوى</span><textarea name="approved-report-content" aria-label="محتوى التقرير" rows="4" maxlength="2000" ${cancelled ? 'disabled' : ''} required>${escapeHtml(report.content)}</textarea></label>
            <label><span>عدد التكرارات</span><input name="approved-report-repetitions" aria-label="عدد التكرارات" type="number" min="1" max="100" value="${report.repetitions || ''}" ${cancelled ? 'disabled' : ''}></label>
            <label><span>ملاحظات المعلم</span><textarea name="approved-report-notes" aria-label="ملاحظات المعلم" rows="3" maxlength="3000" ${cancelled ? 'disabled' : ''}>${escapeHtml(report.notes || '')}</textarea></label>
            <label class="quran-report-change-reason"><span>سبب الإجراء</span><textarea name="approved-report-reason" aria-label="سبب الإجراء" rows="3" maxlength="2000" ${cancelled ? 'disabled' : ''} required placeholder="يظهر في سجل التدقيق ولا يمكن حذفه لاحقاً"></textarea></label>
          </section>
          <aside class="quran-report-recipient-panel">
            <div><span>الطلاب المرتبطون</span><b>${assignments.length}</b></div>
            <div class="quran-report-recipient-list">${assignments.map(reportRecipientRow).join('') || '<p>لا يوجد طلاب مرتبطون.</p>'}</div>
            <details class="quran-report-version-history"><summary><i data-lucide="history"></i><span>سجل النسخ</span><b>${versions.length}</b></summary><div>${versions.map(reportVersionRow).join('') || '<p>لا توجد نسخ محفوظة.</p>'}</div></details>
          </aside>
        </div>
        <div class="quran-report-management-preview" data-report-management-preview hidden></div>
        <footer>
          <button type="button" data-manager-action="close-report-management">إغلاق</button>
          ${cancelled ? '' : `<button type="submit" class="cancel-preview-command" data-report-submit="preview-cancel"><i data-lucide="file-x-2"></i><span>معاينة الإلغاء</span></button><button type="submit" class="edit-preview-command" data-report-submit="preview-edit"><i data-lucide="scan-search"></i><span>معاينة التعديل</span></button><button type="submit" class="cancel-apply-command" data-report-submit="apply-cancel" hidden disabled><i data-lucide="badge-x"></i><span>اعتماد الإلغاء</span></button><button type="submit" class="edit-apply-command" data-report-submit="apply-edit" hidden disabled><i data-lucide="badge-check"></i><span>اعتماد التعديل</span></button>`}
        </footer>
      </form>
    </dialog>`;
  }

  function reportRecipientRow(item) {
    return `<article class="status-${escapeHtml(item.status)}"><span class="person-avatar">${escapeHtml(firstCharacter(item.full_name))}</span><div><b>${escapeHtml(item.full_name)}</b><small>@${escapeHtml(item.username || '')}</small></div><strong>${reportAssignmentStatus(item.status)}</strong></article>`;
  }

  function reportVersionRow(version) {
    return `<article><i data-lucide="${version.change_type === 'created' ? 'file-plus-2' : version.change_type === 'edited' ? 'file-pen-line' : 'file-x-2'}"></i><div><b>${reportVersionLabel(version.change_type)} · ${formatDateTime(version.changed_at)}</b><small>${escapeHtml(version.changed_by_name || '')}${version.change_reason ? ` · ${escapeHtml(version.change_reason)}` : ''}</small></div><em>v${Number(version.version_number)}</em></article>`;
  }

  async function handleClick(event) {
    const viewButton = event.target.closest('[data-manager-view]');
    if (viewButton) {
      state.activeView = viewButton.dataset.managerView;
      if (state.activeView !== 'accounting') state.history = null;
      render();
      await loadActiveView();
      return;
    }
    const accountingStatusButton = event.target.closest('[data-accounting-status-filter]');
    if (accountingStatusButton) {
      state.accountingStatus = accountingStatusButton.dataset.accountingStatusFilter || 'all';
      render();
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
    if (historyButton) {
      state.historySection = 'summary';
      state.historyStatus = 'all';
      state.historyType = 'all';
      return loadHistory(historyButton.dataset.studentHistory);
    }
    const overdueButton = event.target.closest('[data-overdue-history]');
    if (overdueButton) {
      state.historySection = 'reports';
      state.historyStatus = 'overdue';
      state.historyType = 'all';
      return loadHistory(overdueButton.dataset.overdueHistory);
    }
    const historySectionButton = event.target.closest('[data-history-section]');
    if (historySectionButton) {
      state.historySection = historySectionButton.dataset.historySection;
      render();
      return;
    }
    if (event.target.closest('[data-history-open-overdue]')) {
      state.historySection = 'reports';
      state.historyStatus = 'overdue';
      state.historyType = 'all';
      render();
      return;
    }
    const periodButton = event.target.closest('[data-history-period]');
    if (periodButton) {
      state.historyPeriod = Number(periodButton.dataset.historyPeriod);
      render();
      return;
    }
    if (event.target.closest('[data-accounting-export]')) {
      exportAccountingWorkbook();
      return;
    }
    const exemptButton = event.target.closest('[data-exempt-assignment]');
    if (exemptButton) {
      state.exemptAssignmentId = exemptButton.dataset.exemptAssignment;
      container.querySelector('#quran-exempt-dialog')?.showModal();
      return;
    }
    const manageReportButton = event.target.closest('[data-manage-report]');
    if (manageReportButton) {
      await loadReportManagementDetails(manageReportButton.dataset.manageReport);
      return;
    }
    const action = event.target.closest('[data-manager-action]')?.dataset.managerAction;
    if (action === 'close-history') {
      state.history = null;
      render();
    } else if (action === 'refresh-extensions') {
      await loadExtensions();
    } else if (action === 'refresh-shifts') {
      await loadShiftRequests();
    } else if (action === 'cancel-exempt') {
      container.querySelector('#quran-exempt-dialog')?.close();
    } else if (action === 'open-plan-adjustment') {
      openPlanDialog();
    } else if (action === 'cancel-plan-adjustment') {
      container.querySelector('#quran-plan-dialog')?.close();
    } else if (action === 'close-report-management') {
      container.querySelector('#quran-report-management-dialog')?.close();
      state.reportManagementPreview = null;
      state.reportManagementPreviewKey = null;
    }
  }

  function handleChange(event) {
    if (event.target.matches('#quran-accounting-date')) {
      state.reportDate = event.target.value || muscatDateKey();
      state.history = null;
      loadAccounting();
      return;
    }
    if (event.target.matches('[name="history-type"]')) {
      state.historyType = event.target.value;
      render();
      return;
    }
    if (event.target.matches('[name="history-status"]')) {
      state.historyStatus = event.target.value;
      render();
      return;
    }
    if (!event.target.matches('[name="plan-action"]')) return;
    const form = event.target.closest('[data-plan-adjustment-form]');
    const advance = event.target.value === 'advance';
    form.querySelector('[data-shift-days-field]').hidden = advance;
    form.querySelector('[data-target-date-field]').hidden = !advance;
    form.querySelector('[name="plan-target-date"]').required = advance;
    form.querySelector('[data-plan-from-label]').textContent = advance ? 'ابدأ من تقارير هذه المرحلة' : 'زحزحة التقارير ابتداءً من';
    clearPlanPreview(form);
  }

  function handleInput(event) {
    const form = event.target.closest('[data-report-management-form]');
    if (form) clearReportManagementPreview(form);
  }

  async function handleSubmit(event) {
    const accountingForm = event.target.closest('[data-accounting-filter]');
    if (accountingForm) {
      event.preventDefault();
      const formData = new FormData(accountingForm);
      state.accountingSearch = String(formData.get('accounting-search') || '').trim();
      render();
      return;
    }
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
    const shiftForm = event.target.closest('[data-shift-decision-form]');
    if (shiftForm) {
      event.preventDefault();
      await decideShiftRequest(shiftForm, event.submitter?.dataset.shiftDecision || 'approve');
      return;
    }
    const exemptForm = event.target.closest('[data-exempt-form]');
    if (exemptForm) {
      event.preventDefault();
      await exemptAssignment(exemptForm);
      return;
    }
    const planForm = event.target.closest('[data-plan-adjustment-form]');
    if (planForm) {
      event.preventDefault();
      await adjustStudentPlan(planForm, event.submitter?.dataset.planSubmit || 'preview');
      return;
    }
    const reportForm = event.target.closest('[data-report-management-form]');
    if (reportForm) {
      event.preventDefault();
      await manageApprovedReport(reportForm, event.submitter?.dataset.reportSubmit || 'preview-edit');
    }
  }

  function canManageStudentPlan() {
    const permissions = getContext().workspace.permissions;
    return Boolean(permissions.is_admin || permissions.is_lead || permissions.staff_role === 'lead');
  }

  function handleKeydown(event) {
    if (event.key === 'Escape' && state.history) {
      state.history = null;
      render();
    }
  }

  function exportAccountingWorkbook() {
    if (!window.XLSX || !state.consoleData) return showToast('أداة Excel غير متاحة حالياً.', 'error');
    const students = (state.consoleData.students || []).filter(student => accountingStudentMatches(student));
    const rows = students.map(student => {
      const assignments = student.assignments || [];
      const byType = Object.fromEntries(assignments.map(item => [item.task_type, item]));
      return {
        'اسم الطالب': student.full_name,
        'اسم المستخدم': student.username,
        'الحالة اليومية': dailyStateMeta(student.daily_state || inferDailyState(student)).label,
        'الحفظ': exportAssignmentStatus(byType.hifz),
        'التثبيت': exportAssignmentStatus(byType.tathbit),
        'المراجعة': exportAssignmentStatus(byType.murajaa),
        'المهام الفائتة': Number(student.overdue_count || 0),
        'الموعد القادم': student.next_due_at ? formatDateTime(student.next_due_at) : '',
        'يوجد تمديد': student.has_extension ? 'نعم' : 'لا',
      };
    });
    const sheet = window.XLSX.utils.json_to_sheet(rows);
    sheet['!cols'] = [{ wch: 28 }, { wch: 20 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 22 }, { wch: 12 }];
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, sheet, 'محاسبة الطلاب');
    window.XLSX.writeFile(workbook, `محاسبة-طلاب-${state.reportDate}.xlsx`);
    showToast(`تم تجهيز ملف محاسبة ${rows.length} طالباً.`, 'success');
  }

  async function loadReportManagementDetails(reportId) {
    if (!canManageStudentPlan() || state.busy) return;
    state.busy = true;
    try {
      state.reportDetails = isLocalPreviewMode()
        ? previewReportDetails(reportId, state.reviewPlan)
        : await rpc('get_quran_report_management_details', { p_report_id: reportId });
      state.reportManagementPreview = null;
      state.reportManagementPreviewKey = null;
      render();
      const dialog = container.querySelector('#quran-report-management-dialog');
      dialog?.showModal();
      refreshIcons();
    } catch (error) {
      showToast(friendlyManagerError(error, 'تعذر تحميل تفاصيل التقرير المعتمد.'), 'error');
    } finally {
      state.busy = false;
    }
  }

  function clearReportManagementPreview(form) {
    state.reportManagementPreview = null;
    state.reportManagementPreviewKey = null;
    const preview = form.querySelector('[data-report-management-preview]');
    if (preview) {
      preview.hidden = true;
      preview.innerHTML = '';
    }
    form.querySelectorAll('[data-report-submit^="apply-"]').forEach(button => {
      button.hidden = true;
      button.disabled = true;
    });
    form.querySelectorAll('[data-report-submit^="preview-"]').forEach(button => { button.hidden = false; });
  }

  async function manageApprovedReport(form, intent) {
    if (state.busy || !state.reportDetails?.report) return;
    const action = intent.endsWith('cancel') ? 'cancel' : 'edit';
    const apply = intent.startsWith('apply');
    const formData = new FormData(form);
    const reason = String(formData.get('approved-report-reason') || '').trim();
    const content = String(formData.get('approved-report-content') || '').trim();
    const date = String(formData.get('approved-report-date') || '');
    const repetitionsValue = String(formData.get('approved-report-repetitions') || '').trim();
    const notes = String(formData.get('approved-report-notes') || '').trim();
    if (reason.length < 3) return showToast('اكتب سبب الإجراء بوضوح قبل المعاينة.', 'error');
    if (action === 'edit' && (!date || !content)) return showToast('تاريخ التقرير ومحتواه مطلوبان.', 'error');
    const repetitions = repetitionsValue ? Number(repetitionsValue) : null;
    if (action === 'edit' && repetitions !== null && (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100)) {
      return showToast('عدد التكرارات يجب أن يكون بين 1 و100.', 'error');
    }
    const parameters = {
      p_report_id: state.reportDetails.report.id,
      p_action: action,
      p_report_date: action === 'edit' ? date : state.reportDetails.report.report_date,
      p_content: action === 'edit' ? content : state.reportDetails.report.content,
      p_repetitions: action === 'edit' ? repetitions : state.reportDetails.report.repetitions,
      p_notes: action === 'edit' ? (notes || null) : state.reportDetails.report.notes,
      p_reason: reason,
      p_dry_run: !apply,
    };
    const previewKey = reportManagementKey(parameters);
    if (apply && previewKey !== state.reportManagementPreviewKey) {
      return showToast('تغيّرت البيانات بعد المعاينة. عاين الأثر مرة أخرى قبل الاعتماد.', 'error');
    }
    if (apply && !state.reportManagementPreview?.can_apply) {
      return showToast('لا يمكن اعتماد العملية قبل معالجة التنبيهات الظاهرة.', 'error');
    }

    state.busy = true;
    setReportManagementBusy(form, true);
    try {
      const result = isLocalPreviewMode()
        ? previewManageApprovedReport(parameters, state.reportDetails, state.reviewPlan, apply)
        : await rpc('manage_quran_approved_report', parameters);
      if (!apply) {
        state.reportManagementPreview = result;
        state.reportManagementPreviewKey = previewKey;
        const preview = form.querySelector('[data-report-management-preview]');
        preview.hidden = false;
        preview.innerHTML = reportManagementPreviewMarkup(result);
        form.querySelectorAll('[data-report-submit^="preview-"]').forEach(button => { button.hidden = true; });
        const applyButton = form.querySelector(`[data-report-submit="apply-${action}"]`);
        if (applyButton) {
          applyButton.hidden = false;
          applyButton.disabled = !result.can_apply;
        }
        refreshIcons();
        return;
      }

      container.querySelector('#quran-report-management-dialog')?.close();
      state.reportDetails = null;
      state.reportManagementPreview = null;
      state.reportManagementPreviewKey = null;
      if (!isLocalPreviewMode()) await loadReviewPlan();
      else render();
      showToast(action === 'edit' ? 'تم تحديث التقرير وإشعار الطلاب المتأثرين.' : 'تم إلغاء التقرير المعلق مع حفظ السجل السابق.', 'success');
    } catch (error) {
      showToast(friendlyManagerError(error, action === 'edit' ? 'تعذر تعديل التقرير المعتمد.' : 'تعذر إلغاء التقرير المعتمد.'), 'error');
    } finally {
      state.busy = false;
      if (form.isConnected) setReportManagementBusy(form, false);
    }
  }

  function openPlanDialog() {
    const dialog = container.querySelector('#quran-plan-dialog');
    const form = dialog?.querySelector('[data-plan-adjustment-form]');
    if (!dialog || !form || !state.history) return;
    form.reset();
    const firstPending = [...(state.history.assignments || [])]
      .filter(item => item.status === 'pending')
      .sort((a, b) => a.report_date.localeCompare(b.report_date))[0];
    form.querySelector('[name="plan-from-date"]').value = firstPending?.report_date || state.reportDate;
    form.querySelector('[name="plan-target-date"]').value = state.reportDate;
    form.querySelector('[data-shift-days-field]').hidden = false;
    form.querySelector('[data-target-date-field]').hidden = true;
    form.querySelector('[name="plan-target-date"]').required = false;
    form.querySelector('[data-plan-from-label]').textContent = 'زحزحة التقارير ابتداءً من';
    clearPlanPreview(form);
    dialog.showModal();
    refreshIcons();
  }

  function clearPlanPreview(form) {
    state.planPreview = null;
    state.planPreviewKey = null;
    const preview = form.querySelector('[data-plan-preview]');
    preview.hidden = true;
    preview.innerHTML = '';
    form.querySelector('[data-plan-submit="apply"]').disabled = true;
  }

  async function adjustStudentPlan(form, intent) {
    if (state.busy || !state.selectedStudentId) return;
    const formData = new FormData(form);
    const action = String(formData.get('plan-action') || 'shift');
    const fromDate = String(formData.get('plan-from-date') || '');
    const targetDate = action === 'advance' ? String(formData.get('plan-target-date') || '') : null;
    const days = action === 'shift' ? Number(formData.get('plan-days')) : null;
    const reason = String(formData.get('plan-reason') || '').trim();
    if (!fromDate) return showToast('حدد تاريخ بداية التعديل.', 'error');
    if (action === 'shift' && (!Number.isInteger(days) || days < 1 || days > 365)) return showToast('حدد عدداً صحيحاً من 1 إلى 365 يوماً.', 'error');
    if (action === 'advance' && !targetDate) return showToast('حدد تاريخ بدء المرحلة الجديدة.', 'error');
    if (reason.length < 3) return showToast('اكتب سبب التعديل بوضوح.', 'error');

    const parameters = {
      p_circle_id: getContext().circle.id,
      p_student_id: state.selectedStudentId,
      p_action: action,
      p_from_date: fromDate,
      p_target_date: targetDate,
      p_days: days,
      p_reason: reason,
      p_dry_run: intent !== 'apply',
    };
    const previewKey = JSON.stringify({ action, fromDate, targetDate, days, reason });
    if (intent === 'apply' && state.planPreviewKey !== previewKey) {
      clearPlanPreview(form);
      return showToast('تغيّرت البيانات؛ عاين الأثر مرة أخرى قبل الاعتماد.', 'error');
    }

    state.busy = true;
    setPlanFormBusy(form, true);
    try {
      const result = isLocalPreviewMode()
        ? previewPlanAdjustment(parameters, intent === 'apply')
        : await rpc('adjust_quran_student_plan', parameters);
      if (intent !== 'apply') {
        state.planPreview = result;
        state.planPreviewKey = previewKey;
        const preview = form.querySelector('[data-plan-preview]');
        preview.innerHTML = planPreviewMarkup(result);
        preview.hidden = false;
        form.querySelector('[data-plan-submit="apply"]').disabled = !result.can_apply;
        refreshIcons();
        return;
      }

      form.closest('dialog')?.close();
      state.planPreview = null;
      state.planPreviewKey = null;
      if (!isLocalPreviewMode()) {
        await loadHistory(state.selectedStudentId);
        await loadAccounting();
      } else {
        render();
      }
      showToast(action === 'shift' ? 'تمت زحزحة التقارير وإعادة ضبط تواريخها.' : 'تم اعتماد نقطة البداية الجديدة لخطة الطالب.', 'success');
    } catch (error) {
      showToast(friendlyManagerError(error, 'تعذر تعديل خطة الطالب.'), 'error');
    } finally {
      state.busy = false;
      setPlanFormBusy(form, false);
    }
  }

  function previewPlanAdjustment(parameters, apply) {
    const assignments = state.history?.assignments || [];
    const moving = assignments.filter(item => item.status === 'pending' && item.report_date >= parameters.p_from_date);
    const skipped = parameters.p_action === 'advance'
      ? assignments.filter(item => item.status === 'pending' && item.report_date < parameters.p_from_date)
      : [];
    const delta = parameters.p_action === 'shift'
      ? parameters.p_days
      : dateDifference(parameters.p_from_date, parameters.p_target_date);
    if (!moving.length) throw new Error('No pending Quran reports were found from the selected date');
    const dates = moving.map(item => item.report_date).sort();
    const result = {
      action: parameters.p_action,
      moved_count: moving.length,
      skipped_count: skipped.length,
      current_start: dates[0],
      current_end: dates.at(-1),
      new_start: addDateKey(dates[0], delta),
      new_end: addDateKey(dates.at(-1), delta),
      shift_days: delta,
      conflict_count: 0,
      pending_extension_count: 0,
      can_apply: true,
      dry_run: !apply,
    };
    if (apply) {
      skipped.forEach(item => { item.status = 'replaced'; item.plan_event = 'skipped'; });
      moving.forEach(item => {
        item.report_date = addDateKey(item.report_date, delta);
        item.starts_at = shiftIsoDays(item.starts_at, delta);
        item.original_due_at = shiftIsoDays(item.original_due_at, delta);
        item.effective_due_at = shiftIsoDays(item.effective_due_at, delta);
        item.plan_event = 'rescheduled';
      });
      assignments.sort((a, b) => b.report_date.localeCompare(a.report_date));
    }
    return result;
  }

  async function loadActiveView() {
    if (state.activeView === 'review') await loadReviewPlan();
    if (state.activeView === 'accounting') await loadAccounting();
    if (state.activeView === 'extensions') await loadExtensions();
    if (state.activeView === 'shifts') await loadShiftRequests();
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
      state.history = isLocalPreviewMode() ? previewHistory(studentId) : await rpc('get_quran_student_history', { p_circle_id: getContext().circle.id, p_student_id: studentId, p_limit: 200, p_offset: 0 });
      render();
      container.querySelector('.quran-history-actions .close-command')?.focus();
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

  async function loadShiftRequests() {
    state.shiftQueue = null;
    render();
    try {
      state.shiftQueue = isLocalPreviewMode() ? previewShiftRequests() : await rpc('get_quran_plan_shift_queue', { p_circle_id: getContext().circle.id, p_status: 'all' });
      render();
    } catch (error) {
      showToast(friendlyManagerError(error, 'تعذر تحميل طلبات ترحيل التقارير.'), 'error');
    }
  }

  async function decideShiftRequest(form, decision) {
    if (state.busy) return;
    const request = state.shiftQueue?.find(item => item.id === form.dataset.shiftDecisionForm);
    if (!request || request.status !== 'pending') return;
    const formData = new FormData(form);
    const targetDate = String(formData.get('shift-target-date') || '');
    const note = String(formData.get('shift-decision-note') || '').trim();
    if (decision === 'approve' && (!targetDate || targetDate <= request.requested_from_date)) {
      return showToast('حدد تاريخ بداية جديداً بعد تاريخ التقرير المتأخر.', 'error');
    }
    state.busy = true;
    form.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      if (isLocalPreviewMode()) {
        request.status = decision === 'approve' ? 'approved' : 'rejected';
        request.decision_target_date = decision === 'approve' ? targetDate : null;
        request.shift_days = decision === 'approve' ? dateDifference(request.requested_from_date, targetDate) : null;
        request.decision_note = note || null;
        request.decided_at = new Date().toISOString();
      } else {
        await rpc('decide_quran_plan_shift_request', {
          p_request_id: request.id,
          p_decision: decision,
          p_target_date: decision === 'approve' ? targetDate : null,
          p_note: note || null,
        });
        await loadShiftRequests();
      }
      showToast(decision === 'approve' ? 'تم ترحيل خطة الطالب وإعادة ضبط التواريخ.' : 'تم رفض طلب الترحيل وإشعار الطالب.', 'success');
      render();
    } catch (error) {
      showToast(friendlyManagerError(error, 'تعذر اعتماد قرار طلب الترحيل.'), 'error');
    } finally {
      state.busy = false;
      if (form.isConnected) form.querySelectorAll('button').forEach(button => { button.disabled = false; });
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

function planPreviewMarkup(result) {
  const blocked = Number(result.conflict_count || 0) > 0 || Number(result.pending_extension_count || 0) > 0;
  const actionLabel = result.action === 'shift' ? 'زحزحة التقارير' : 'البدء من مرحلة متقدمة';
  return `<div class="quran-plan-preview-head"><i data-lucide="${blocked ? 'triangle-alert' : 'shield-check'}"></i><div><small>نتيجة المعاينة</small><strong>${actionLabel}</strong></div><span class="${blocked ? 'is-blocked' : 'is-ready'}">${blocked ? 'يتطلب معالجة' : 'جاهز للاعتماد'}</span></div>
    <div class="quran-plan-preview-metrics"><span><b>${Number(result.moved_count || 0)}</b> تقرير سيعاد تحديده</span><span><b>${Number(result.skipped_count || 0)}</b> تقرير سيُتخطى</span><span><b>${Math.abs(Number(result.shift_days || 0))}</b> يوم فرق</span></div>
    <div class="quran-plan-date-change"><span><small>النطاق الحالي</small><b>${formatDate(result.current_start)} - ${formatDate(result.current_end)}</b></span><i data-lucide="arrow-left"></i><span><small>النطاق الجديد</small><b>${formatDate(result.new_start)} - ${formatDate(result.new_end)}</b></span></div>
    ${Number(result.conflict_count || 0) ? `<p class="is-warning"><i data-lucide="calendar-x-2"></i>يوجد ${Number(result.conflict_count)} تعارض مع تقارير ثابتة للطالب. عالجها قبل الاعتماد.</p>` : ''}
    ${Number(result.pending_extension_count || 0) ? `<p class="is-warning"><i data-lucide="timer-off"></i>يوجد ${Number(result.pending_extension_count)} طلب تمديد معلق ضمن التقارير المتأثرة.</p>` : ''}
    ${!blocked ? '<p><i data-lucide="info"></i>لن تتغير التقارير المنجزة أو المعفاة، وسيصل إشعار للطالب بعد الاعتماد.</p>' : ''}`;
}

function managementMetric(icon, label, value, tone = '') {
  return `<article class="${tone ? `is-${tone}` : ''}"><i data-lucide="${icon}"></i><span>${label}</span><b>${Number(value || 0)}</b></article>`;
}

function reportAssignmentStatus(status) {
  if (status === 'completed') return 'منجز';
  if (status === 'exempted') return 'معفى';
  if (status === 'cancelled') return 'ملغى';
  if (status === 'replaced') return 'متخطى';
  return 'معلق';
}

function reportVersionLabel(changeType) {
  if (changeType === 'created') return 'إنشاء التقرير';
  if (changeType === 'edited') return 'تعديل التقرير';
  if (changeType === 'cancelled') return 'إلغاء التقرير';
  return 'تحديث التقرير';
}

function formatDateTime(value) {
  if (!value) return 'وقت غير متاح';
  return new Intl.DateTimeFormat('ar-OM', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Muscat',
  }).format(new Date(value));
}

function reportManagementKey(parameters) {
  const { p_dry_run, ...stable } = parameters;
  return JSON.stringify(stable);
}

function reportManagementPreviewMarkup(result) {
  const blocked = !result.can_apply;
  const editing = result.action === 'edit';
  return `<div class="quran-report-preview-head"><i data-lucide="${blocked ? 'triangle-alert' : editing ? 'file-check-2' : 'shield-alert'}"></i><div><small>نتيجة المعاينة</small><strong>${editing ? 'تعديل التقرير المعتمد' : 'إلغاء التقرير المعتمد'}</strong></div><span class="${blocked ? 'is-blocked' : 'is-ready'}">${blocked ? 'يتطلب معالجة' : 'جاهز للاعتماد'}</span></div>
    <div class="quran-report-preview-metrics"><span><b>${Number(result.pending_count || 0)}</b> طالب سيتأثر</span><span><b>${Number(result.completed_count || 0)}</b> إنجاز محفوظ</span><span><b>${Number(result.exempted_count || 0)}</b> إعفاء محفوظ</span></div>
    ${editing && result.current_date !== result.new_date ? `<p><i data-lucide="calendar-arrow-down"></i>سينتقل التقرير من ${formatDate(result.current_date)} إلى ${formatDate(result.new_date)}.</p>` : ''}
    ${result.split_required ? '<p><i data-lucide="git-branch"></i>لوجود إنجازات سابقة، سيُنشأ إصدار جديد للطلاب المعلقين وتبقى النسخة السابقة في السجل.</p>' : ''}
    ${!result.has_changes && editing ? '<p class="is-warning"><i data-lucide="equal"></i>لم تُجرَ أي تغييرات على التقرير.</p>' : ''}
    ${Number(result.conflict_count || 0) ? `<p class="is-warning"><i data-lucide="calendar-x-2"></i>يوجد تعارض في خطط ${Number(result.conflict_count)} من الطلاب.</p>` : ''}
    ${Number(result.pending_extension_count || 0) ? `<p class="is-warning"><i data-lucide="timer-off"></i>يوجد ${Number(result.pending_extension_count)} طلب تمديد معلق مرتبط بهذا التقرير.</p>` : ''}
    ${!blocked ? `<p><i data-lucide="shield-check"></i>${editing ? 'لن تتغير التقارير المنجزة أو المعفاة، وسيُشعر الطلاب المتأثرون.' : 'ستُلغى التعيينات المعلقة فقط، وتبقى الإنجازات والإعفاءات محفوظة.'}</p>` : ''}`;
}

function setReportManagementBusy(form, busy) {
  form.classList.toggle('is-busy', busy);
  form.querySelectorAll('button, input, textarea').forEach(control => {
    if (busy) control.disabled = true;
    else if (!control.matches('[data-report-submit^="apply-"]')) control.disabled = false;
  });
  if (!busy) {
    const action = form.querySelector('[data-report-submit^="apply-"]:not([hidden])');
    if (action) action.disabled = !form.querySelector('[data-report-management-preview] .is-ready');
  }
}

function setPlanFormBusy(form, busy) {
  form.classList.toggle('is-busy', busy);
  form.querySelectorAll('button, input, textarea').forEach(control => {
    if (control.matches('[data-plan-submit="apply"]')) {
      control.disabled = busy || !stateSafePlanPreview(form);
    } else {
      control.disabled = busy;
    }
  });
}

function stateSafePlanPreview(form) {
  const preview = form.querySelector('[data-plan-preview]');
  return preview && !preview.hidden && !preview.querySelector('.is-blocked');
}

function dateDifference(fromDate, toDate) {
  return Math.round((parseDateKey(toDate).getTime() - parseDateKey(fromDate).getTime()) / 86400000);
}

function shiftIsoDays(value, days) {
  if (!value) return value;
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
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
  students.forEach(student => {
    student.daily_state = inferDailyState(student);
    student.overall_completion_band = worstCompletionBand(student.assignments);
    student.report_count = student.assignments.length;
    student.completed_count = student.assignments.filter(item => item.status === 'completed').length;
    student.pending_count = student.assignments.filter(item => item.status === 'pending').length;
    student.exempted_count = student.assignments.filter(item => item.status === 'exempted').length;
    student.overdue_today_count = student.assignments.filter(item => item.is_overdue).length;
    student.next_due_at = student.assignments.filter(item => item.status === 'pending').map(item => item.effective_due_at).sort()[0] || null;
    student.has_extension = student.assignments.some(item => item.deadline_extended);
  });
  return { report_date: date, server_now: new Date().toISOString(), students, summary: previewAccountingSummary(students) };
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
      cancelled_count: 0,
      status: 'published',
      current_version: 1,
      root_report_id: `review-${day}-${type}`,
      supersedes_report_id: null,
    }));
  }
  return { date_from: reports[0].report_date, date_to: reports.at(-1).report_date, reports };
}

function previewReportDetails(reportId, reviewPlan) {
  const report = reviewPlan?.reports?.find(item => item.id === reportId);
  if (!report) throw new Error('Quran report not found');
  const assignments = [];
  const statuses = [
    ...Array(Number(report.completed_count || 0)).fill('completed'),
    ...Array(Number(report.pending_count || 0)).fill('pending'),
    ...Array(Number(report.exempted_count || 0)).fill('exempted'),
    ...Array(Number(report.cancelled_count || 0)).fill('cancelled'),
  ];
  const names = ['محمد بن أحمد الحارثي', 'وارث بن علي الخياري', 'يحيى بن عبدالله العدوي', 'عبدالله بن سالم الراشدي'];
  statuses.forEach((status, index) => assignments.push({
    id: `${report.id}-assignment-${index}`,
    student_id: `student-${index}`,
    full_name: names[index % names.length],
    username: `student${String(index + 1).padStart(2, '0')}`,
    status,
    report_date: report.report_date,
    starts_at: muscatIso(report.report_date, '00:00'),
    effective_due_at: muscatIso(report.report_date, '23:00'),
    completed_at: status === 'completed' ? muscatIso(report.report_date, '14:00') : null,
    awarded_points: status === 'completed' ? Number(report.max_points) * 0.55 : null,
  }));
  return {
    report: { ...report },
    assignments,
    versions: [{
      id: `${report.id}-version-1`, report_id: report.id, version_number: Number(report.current_version || 1),
      change_type: Number(report.current_version || 1) > 1 ? 'edited' : 'created',
      change_reason: Number(report.current_version || 1) > 1 ? 'تحديث سابق لخطة الحلقة' : 'اعتماد ملف الإكسل',
      changed_at: new Date().toISOString(), changed_by_name: 'المعلم المسؤول', snapshot: { ...report },
    }],
  };
}

function previewManageApprovedReport(parameters, details, reviewPlan, apply) {
  const report = details.report;
  const assignments = details.assignments || [];
  const pending = assignments.filter(item => item.status === 'pending');
  const completed = assignments.filter(item => item.status === 'completed');
  const exempted = assignments.filter(item => item.status === 'exempted');
  const editing = parameters.p_action === 'edit';
  const hasChanges = !editing || parameters.p_report_date !== report.report_date
    || parameters.p_content !== report.content
    || parameters.p_repetitions !== (report.repetitions ?? null)
    || parameters.p_notes !== (report.notes ?? null);
  const conflicts = editing && parameters.p_report_date !== report.report_date
    ? (reviewPlan?.reports || []).filter(item => item.id !== report.id && item.status === 'published'
      && item.report_date === parameters.p_report_date && item.task_type === report.task_type).length * pending.length
    : 0;
  const result = {
    report_id: report.id,
    action: parameters.p_action,
    task_type: report.task_type,
    current_date: report.report_date,
    new_date: editing ? parameters.p_report_date : report.report_date,
    pending_count: pending.length,
    completed_count: completed.length,
    exempted_count: exempted.length,
    historical_count: assignments.length - pending.length,
    conflict_count: conflicts,
    pending_extension_count: 0,
    split_required: editing && assignments.length > pending.length,
    has_changes: hasChanges,
    can_apply: pending.length > 0 && conflicts === 0 && hasChanges,
    dry_run: !apply,
  };
  if (!apply || !result.can_apply) return result;

  const list = reviewPlan?.reports || [];
  const source = list.find(item => item.id === report.id);
  if (parameters.p_action === 'cancel') {
    pending.forEach(item => { item.status = 'cancelled'; });
    if (source) {
      source.status = 'cancelled';
      source.pending_count = 0;
      source.assigned_count = Number(source.completed_count || 0) + Number(source.exempted_count || 0);
      source.cancelled_count = Number(source.cancelled_count || 0) + pending.length;
      source.current_version = Number(source.current_version || 1) + 1;
    }
    return { ...result, dry_run: false, target_report_id: report.id };
  }

  if (result.split_required && source) {
    source.status = 'cancelled';
    source.pending_count = 0;
    source.assigned_count = Number(source.completed_count || 0) + Number(source.exempted_count || 0);
    const successor = {
      ...source,
      id: `${source.id}-v${Number(source.current_version || 1) + 1}`,
      root_report_id: source.root_report_id || source.id,
      supersedes_report_id: source.id,
      status: 'published',
      report_date: parameters.p_report_date,
      content: parameters.p_content,
      repetitions: parameters.p_repetitions,
      notes: parameters.p_notes,
      assigned_count: pending.length,
      pending_count: pending.length,
      completed_count: 0,
      exempted_count: 0,
      cancelled_count: 0,
      current_version: 1,
    };
    list.push(successor);
    return { ...result, dry_run: false, target_report_id: successor.id, successor_report_id: successor.id };
  }

  if (source) {
    source.report_date = parameters.p_report_date;
    source.content = parameters.p_content;
    source.repetitions = parameters.p_repetitions;
    source.notes = parameters.p_notes;
    source.current_version = Number(source.current_version || 1) + 1;
  }
  return { ...result, dry_run: false, target_report_id: report.id };
}

function previewStudent(id, fullName, username, date, assignments, overdueCount = 0) {
  return { student_id: id, membership_id: `membership-${id}`, joined_at: muscatIso(addDateKey(date, -180), '08:00'), full_name: fullName, username, report_date: date, assignments, overdue_count: overdueCount };
}

function previewTeacherAssignment(id, date, taskType, status, band = null) {
  const startsAt = muscatIso(date, '00:00');
  const originalDueAt = muscatIso(date, '23:00');
  const extended = id === 'b2';
  const effectiveDueAt = extended ? new Date(new Date(originalDueAt).getTime() + 60 * 60000).toISOString() : originalDueAt;
  return { id, report_date: date, task_type: taskType, content: `نموذج ${TYPE_META[taskType].label} ليوم ${date}`, repetitions: 3, status, starts_at: startsAt, original_due_at: originalDueAt, effective_due_at: effectiveDueAt, deadline_extended: extended, extension_minutes: extended ? 60 : 0, completed_at: status === 'completed' ? muscatIso(date, band === 'early' ? '05:00' : band === 'middle' ? '13:00' : band === 'late' ? '23:30' : '21:00') : null, awarded_points: status === 'completed' ? (taskType === 'hifz' ? 3.1 : 1.7) : null, max_points: taskType === 'hifz' ? 4 : 3, available_points: status === 'pending' ? 1.8 : 0, completion_band: band, is_overdue: status === 'pending' && date < muscatDateKey() };
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
  for (let day = 1; day <= 14; day += 1) {
    const date = addDateKey(muscatDateKey(), day);
    ['hifz', 'tathbit', 'murajaa'].forEach(type => {
      assignments.push(previewTeacherAssignment(`future-${day}-${type}`, date, type, 'pending'));
    });
  }
  assignments.sort((a, b) => b.report_date.localeCompare(a.report_date));
  const completed = assignments.filter(item => item.status === 'completed');
  const latestProgress = {};
  ['hifz', 'tathbit', 'murajaa'].forEach(type => {
    const item = completed.find(assignment => assignment.task_type === type);
    if (item) latestProgress[type] = { report_date: item.report_date, content: item.content, repetitions: item.repetitions, completed_at: item.completed_at, awarded_points: item.awarded_points, max_points: item.max_points };
  });
  const periods = {};
  [7, 30, 90].forEach(days => {
    const from = addDateKey(muscatDateKey(), -(days - 1));
    const items = assignments.filter(item => item.report_date >= from && item.report_date <= muscatDateKey());
    const done = items.filter(item => item.status === 'completed');
    const onTime = done.filter(item => item.completion_band !== 'late');
    periods[String(days)] = {
      report_count: items.length,
      completed_count: done.length,
      on_time_count: onTime.length,
      late_count: done.length - onTime.length,
      overdue_count: items.filter(item => item.is_overdue).length,
      exempted_count: items.filter(item => item.status === 'exempted').length,
      earned_points: done.reduce((sum, item) => sum + Number(item.awarded_points || 0), 0),
      completion_rate: items.length ? done.length / items.filter(item => ['completed', 'pending'].includes(item.status)).length * 100 : 0,
      on_time_rate: done.length ? onTime.length / done.length * 100 : 0,
    };
  });
  const recentEvents = completed.slice(0, 8).map((item, index) => ({ id: index + 1, assignment_id: item.id, event_type: 'completed', created_at: item.completed_at, actor_name: student.full_name, report_date: item.report_date, task_type: item.task_type, content: item.content, metadata: {} }));
  return { student: { ...student, circle_name: 'حلقة الإتقان', joined_at: muscatIso(addDateKey(muscatDateKey(), -180), '08:00') }, total: assignments.length, overdue_count: assignments.filter(item => item.is_overdue).length, analytics: { periods, latest_progress: latestProgress }, assignments, recent_events: recentEvents };
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

function previewShiftRequests() {
  const fromDate = addDateKey(muscatDateKey(), -2);
  return [{
    id: 'shift-request-1', student_id: 'student-2', full_name: 'وارث بن علي الخياري', username: 'warith.student',
    requested_from_date: fromDate, reason: 'تعذر عليّ إتمام تقارير اليومين السابقين بسبب ظرف عائلي.', status: 'pending',
    requested_at: new Date(Date.now() - 22 * 60000).toISOString(), pending_report_count: 18, overdue_report_count: 6,
    current_start: fromDate, current_end: addDateKey(fromDate, 12), pending_extension_count: 0,
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

function dailyStateMeta(value) {
  const states = {
    completed: { label: 'مكتمل في الوقت', tone: 'complete' },
    completed_late: { label: 'مكتمل بعد الموعد', tone: 'late' },
    overdue: { label: 'لديه تقرير متأخر', tone: 'late' },
    partial: { label: 'أنجز جزءاً', tone: 'partial' },
    pending: { label: 'قيد الإنجاز', tone: 'pending' },
    exempted: { label: 'معفى', tone: 'exempted' },
    no_reports: { label: 'بلا تقارير', tone: 'empty' },
  };
  return states[value] || states.pending;
}

function inferDailyState(student) {
  const assignments = student.assignments || [];
  if (!assignments.length) return 'no_reports';
  if (assignments.some(item => item.status === 'pending' && item.is_overdue)) return 'overdue';
  const completed = assignments.filter(item => item.status === 'completed');
  const pending = assignments.filter(item => item.status === 'pending');
  const exempted = assignments.filter(item => item.status === 'exempted');
  if (pending.length && completed.length) return 'partial';
  if (pending.length) return 'pending';
  if (!completed.length && exempted.length) return 'exempted';
  if (completed.some(item => item.completion_band === 'late')) return 'completed_late';
  return 'completed';
}

function worstCompletionBand(assignments = []) {
  const rank = { early: 1, middle: 2, late_on_time: 3, late: 4 };
  return assignments.reduce((worst, item) => {
    const band = item.completion_band;
    return (rank[band] || 0) > (rank[worst] || 0) ? band : worst;
  }, null);
}

function previewAccountingSummary(students = []) {
  const states = students.map(student => student.daily_state || inferDailyState(student));
  return {
    student_count: students.length,
    completed_students: states.filter(value => ['completed', 'completed_late'].includes(value)).length,
    completed_on_time_students: states.filter(value => value === 'completed').length,
    completed_late_students: states.filter(value => value === 'completed_late').length,
    attention_students: states.filter(value => ['overdue', 'partial', 'pending'].includes(value)).length,
    overdue_students: states.filter(value => value === 'overdue').length,
    pending_students: states.filter(value => ['partial', 'pending'].includes(value)).length,
    exempted_students: states.filter(value => value === 'exempted').length,
    no_report_students: states.filter(value => value === 'no_reports').length,
  };
}

function latestProgressCard(type, item) {
  const meta = TYPE_META[type];
  if (!item) return `<article class="is-empty"><i data-lucide="${meta.icon}"></i><span>${meta.label}</span><strong>لا يوجد إنجاز مسجل</strong></article>`;
  return `<article><i data-lucide="${meta.icon}"></i><span>آخر ${meta.label}</span><strong>${escapeHtml(item.content || '')}</strong><small>${formatDate(item.report_date)}${item.repetitions ? ` · ${Number(item.repetitions)} تكرارات` : ''}</small></article>`;
}

function historyMetric(icon, label, value, tone = '') {
  return `<article class="${tone ? `is-${tone}` : ''}"><i data-lucide="${icon}"></i><span>${label}</span><strong>${value}</strong></article>`;
}

function historyEventRow(event) {
  const meta = TYPE_META[event.task_type] || { label: event.task_type || 'تقرير', icon: 'file-clock' };
  return `<article><i data-lucide="${historyEventIcon(event.event_type)}"></i><div><b>${historyEventLabel(event.event_type)} · ${meta.label}</b><span>${escapeHtml(event.content || '')}</span><small>${formatDateTime(event.created_at)}${event.actor_name ? ` · بواسطة ${escapeHtml(event.actor_name)}` : ''}</small></div></article>`;
}

function historyEventLabel(type) {
  return ({
    completed: 'تسليم التقرير',
    exempted: 'إعفاء من التقرير',
    extension_requested: 'طلب تمديد',
    extension_approved: 'اعتماد التمديد',
    extension_rejected: 'رفض التمديد',
    rescheduled: 'زحزحة الخطة',
    skipped: 'تخطي المرحلة',
    report_updated: 'تعديل التقرير',
    report_cancelled: 'إلغاء التقرير',
  })[type] || 'تحديث التقرير';
}

function historyEventIcon(type) {
  if (type === 'completed') return 'circle-check-big';
  if (type === 'exempted') return 'shield-minus';
  if (type.includes('extension')) return 'timer-reset';
  if (type === 'rescheduled') return 'calendar-arrow-down';
  if (type === 'skipped') return 'skip-forward';
  if (type === 'report_cancelled') return 'file-x-2';
  return 'file-pen-line';
}

function exportAssignmentStatus(item) {
  if (!item) return 'لا يوجد';
  const value = historyStatus(item);
  return item.deadline_extended ? `${value} - ممدد ${formatDuration(item.extension_minutes)}` : value;
}

function formatRemainingUntil(value, serverNow = null) {
  if (!value) return '';
  const difference = new Date(value).getTime() - new Date(serverNow || Date.now()).getTime();
  const minutes = Math.max(0, Math.ceil(Math.abs(difference) / 60000));
  const duration = formatDuration(minutes);
  return difference < 0 ? `منتهٍ منذ ${duration}` : `متبقي ${duration}`;
}

function historyTone(item) {
  if (item.status === 'exempted') return 'exempted';
  if (item.is_overdue || item.completion_band === 'late') return 'late';
  return item.completion_band || item.status;
}

function historyStatus(item) {
  if (item.status === 'replaced') return 'تم تخطيه';
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

function shiftRequestStatus(status) {
  if (status === 'approved') return 'تم الترحيل';
  if (status === 'rejected') return 'مرفوض';
  return 'بانتظار القرار';
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
  if (/No pending Quran reports/i.test(message)) return 'لا توجد تقارير معلقة ابتداءً من التاريخ المحدد.';
  if (/conflicts with existing/i.test(message)) return 'تتعارض التواريخ الجديدة مع تقارير ثابتة للطالب.';
  if (/pending extension requests/i.test(message)) return 'توجد طلبات تمديد معلقة؛ يجب البت فيها قبل تعديل الخطة.';
  if (/already been decided/i.test(message)) return 'تم اتخاذ قرار على هذا الطلب مسبقاً؛ حدّث القائمة.';
  if (/new Quran plan date/i.test(message)) return 'يجب أن يكون تاريخ البداية الجديد بعد أول يوم متأخر.';
  if (/without pending students|has no pending students/i.test(message)) return 'لا يوجد طلاب معلقون يمكن تطبيق هذا الإجراء عليهم.';
  if (/No approved Quran report changes/i.test(message)) return 'لم تُجرَ أي تغييرات على التقرير.';
  if (/edit conflicts with student plans/i.test(message)) return 'يتعارض التاريخ الجديد مع تقارير ثابتة في خطط بعض الطلاب.';
  if (/Only published Quran reports/i.test(message)) return 'هذه نسخة تاريخية محفوظة ولا يمكن تعديلها.';
  if (/lead teacher or administrator/i.test(message)) return 'تعديل خطة الطالب متاح للمدير والمعلم المسؤول فقط.';
  if (/within 72 hours/i.test(message)) return 'وقت التمديد يجب أن يكون خلال 72 ساعة.';
  if (/Every requested report/i.test(message)) return 'يجب اتخاذ قرار لكل تقرير في الطلب.';
  if (/Only pending/i.test(message)) return 'تغيّرت حالة التقرير؛ حدّث البيانات وحاول مجدداً.';
  if (/not allowed|permission|42501/i.test(message)) return 'لا تملك صلاحية مراجعة تقارير هذه الحلقة.';
  return fallback;
}
