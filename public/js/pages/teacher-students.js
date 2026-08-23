import { supabase } from '../lib/supabase-client.js';
import { isLocalPreviewMode, logoutUser, requireAuth } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast } from '../lib/utils.js';
import {
  TASK_META,
  buildInterventions,
  buildPeriodCards,
  buildTaskMetrics,
  buildTodaySummary,
  performanceByStudent,
  studentTrend,
  taskState,
} from '../lib/teacher-student-analytics.js';
import '../lib/teacher-shell.js?v=3';

const STATUS_META = {
  completed: { label: 'منجز في الوقت', tone: 'is-completed' },
  completed_late: { label: 'منجز بعد الموعد', tone: 'is-late' },
  partial: { label: 'منجز جزئياً', tone: 'is-attention' },
  pending: { label: 'قيد الإنجاز', tone: 'is-attention' },
  overdue: { label: 'متأخر', tone: 'is-attention' },
  exempted: { label: 'معفى', tone: 'is-muted' },
  no_reports: { label: 'لا يوجد تقرير', tone: 'is-muted' },
};

const TASK_LABELS = { hifz: 'الحفظ', tathbit: 'التثبيت', murajaa: 'المراجعة' };

const state = {
  profile: null,
  circles: [],
  circleId: '',
  date: muscatDateKey(),
  consoleData: null,
  performance: null,
  extensionQueue: [],
  shiftQueue: [],
  requestAccess: { extension: true, shift: true },
  activeView: 'today',
  selectedStudentId: null,
  studentHistory: null,
  query: '',
  status: 'all',
  sort: 'priority',
  loading: false,
};

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
  await initI18n();
  const authData = await requireAuth(['teacher', 'admin']);
  if (!authData) return;

  state.profile = authData.profile;
  document.getElementById('teacher-name').textContent = displayName(state.profile);
  document.getElementById('students-greeting-name').textContent = firstName(displayName(state.profile));
  document.getElementById('logout-btn').addEventListener('click', logoutUser);
  bindControls();
  applyRequestedState();
  await loadCircles();
}

function bindControls() {
  document.querySelectorAll('[data-students-tab]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.studentsTab)));
  document.getElementById('students-circle-select').addEventListener('change', async event => {
    state.circleId = event.target.value;
    syncUrl();
    updateWorkspaceLinks();
    await loadDashboard();
  });
  document.getElementById('students-date').addEventListener('change', async event => {
    state.date = event.target.value || muscatDateKey();
    syncUrl();
    renderDate();
    await loadDashboard();
  });
  document.getElementById('students-refresh').addEventListener('click', loadDashboard);
  document.getElementById('students-search').addEventListener('input', event => {
    state.query = event.target.value.trim().toLocaleLowerCase('ar');
    renderStudents();
  });
  document.getElementById('students-status-filter').addEventListener('change', event => {
    state.status = event.target.value;
    renderStudents();
  });
  document.getElementById('students-sort').addEventListener('change', event => {
    state.sort = event.target.value;
    renderStudents();
  });
  document.getElementById('students-show-attention').addEventListener('click', () => {
    state.status = 'attention';
    document.getElementById('students-status-filter').value = 'attention';
    renderStudents();
    document.getElementById('students-list-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.addEventListener('click', event => {
    const details = event.target.closest('[data-student-details]');
    if (details) openStudentDrawer(details.dataset.studentDetails);
  });
  document.getElementById('student-drawer-close').addEventListener('click', closeStudentDrawer);
  document.getElementById('student-drawer-backdrop').addEventListener('click', closeStudentDrawer);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.selectedStudentId) closeStudentDrawer();
  });
}

function switchView(view) {
  state.activeView = ['today', 'trends', 'requests'].includes(view) ? view : 'today';
  document.querySelectorAll('[data-students-tab]').forEach(button => {
    const active = button.dataset.studentsTab === state.activeView;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-students-view]').forEach(panel => {
    panel.hidden = panel.dataset.studentsView !== state.activeView;
  });
  syncUrl();
  refreshIcons();
}

function applyRequestedState() {
  const params = new URLSearchParams(window.location.search);
  const requestedDate = params.get('date');
  state.activeView = ['today', 'trends', 'requests'].includes(params.get('view')) ? params.get('view') : 'today';
  if (/^\d{4}-\d{2}-\d{2}$/.test(requestedDate || '') && requestedDate <= muscatDateKey()) state.date = requestedDate;
  document.getElementById('students-date').value = state.date;
  document.getElementById('students-date').max = muscatDateKey();
  renderDate();
  switchView(state.activeView);
}

async function loadCircles() {
  setFeedback('loading', 'جاري تحميل الحلقات المرتبطة بك...');
  try {
    const circles = isLocalPreviewMode()
      ? previewCircles()
      : await loadCloudCircles();
    state.circles = circles.filter(circle => circle.circle_type === 'quran');
    renderCircleOptions();
    if (!state.circles.length) {
      renderEmptyPage('لا توجد حلقة قرآنية مرتبطة بحسابك حالياً.');
      return;
    }
    await loadDashboard();
  } catch (error) {
    console.error('Unable to load teacher circles:', error);
    renderEmptyPage('تعذر تحميل حلقاتك. تحقق من الاتصال ثم أعد المحاولة.', true);
  }
}

async function loadCloudCircles() {
  const { data, error } = await supabase.rpc('list_my_learning_circles');
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function renderCircleOptions() {
  const select = document.getElementById('students-circle-select');
  const requested = new URLSearchParams(window.location.search).get('circle');
  state.circleId = state.circles.some(circle => circle.id === requested) ? requested : state.circles[0]?.id || '';
  select.innerHTML = state.circles.map(circle => `<option value="${escapeHtml(circle.id)}">${escapeHtml(circle.name || 'حلقة قرآنية')}</option>`).join('');
  select.value = state.circleId;
  syncUrl();
  updateWorkspaceLinks();
}

async function loadDashboard() {
  if (!state.circleId || state.loading) return;
  state.loading = true;
  setRefreshBusy(true);
  setFeedback('loading', 'جاري جمع بيانات الطلاب وتحليل الأداء...');
  document.getElementById('students-table-wrap').hidden = true;

  try {
    if (isLocalPreviewMode()) {
      const preview = buildPreviewDashboard(state.date);
      state.consoleData = preview.consoleData;
      state.performance = preview.performance;
      state.extensionQueue = preview.extensionQueue;
      state.shiftQueue = preview.shiftQueue;
      state.requestAccess = { extension: true, shift: true };
    } else {
      const [consoleResponse, performanceResponse, extensionResponse, shiftResponse] = await Promise.all([
        supabase.rpc('get_quran_teacher_console', { p_circle_id: state.circleId, p_report_date: state.date }),
        supabase.rpc('get_quran_circle_performance', { p_circle_id: state.circleId, p_as_of: state.date }),
        supabase.rpc('get_quran_extension_queue', { p_circle_id: state.circleId, p_status: 'pending' }),
        supabase.rpc('get_quran_plan_shift_queue', { p_circle_id: state.circleId, p_status: 'pending' }),
      ]);
      if (consoleResponse.error) throw consoleResponse.error;
      state.consoleData = consoleResponse.data;
      state.performance = performanceResponse.error ? null : performanceResponse.data;
      state.extensionQueue = extensionResponse.error ? [] : extensionResponse.data || [];
      state.shiftQueue = shiftResponse.error ? [] : shiftResponse.data || [];
      state.requestAccess = { extension: !extensionResponse.error, shift: !shiftResponse.error };
      if (performanceResponse.error) {
        console.warn('Unable to load extended performance:', performanceResponse.error);
        showToast('تم تحميل متابعة اليوم، لكن تعذر تحميل اتجاه الأداء.', 'info');
      }
    }
    renderDashboard();
  } catch (error) {
    console.error('Unable to load teacher student dashboard:', error);
    state.consoleData = null;
    state.performance = null;
    setFeedback('error', friendlyError(error));
  } finally {
    state.loading = false;
    setRefreshBusy(false);
  }
}

function renderDashboard() {
  renderPriorityCenter();
  renderTodaySummary();
  renderTrend();
  renderComparisons();
  renderTaskDistribution();
  renderMomentum();
  renderRequests();
  renderStudents();
  refreshIcons();
}

function renderPriorityCenter() {
  const container = document.getElementById('students-priority-list');
  const interventions = buildInterventions(state.consoleData?.students || [], state.performance?.students || [], {
    now: state.consoleData?.server_now || Date.now(),
  });
  const urgentCount = interventions.filter(item => item.overdue > 0 || item.daily_state === 'overdue').length;
  document.getElementById('students-action-title').textContent = interventions.length
    ? `${interventions.length} ${interventions.length === 1 ? 'حالة تحتاج' : 'حالات تحتاج'} تدخلك`
    : 'لا توجد حالات عاجلة';

  if (!interventions.length) {
    container.innerHTML = `<div class="students-priority-empty"><i data-lucide="badge-check"></i><div><strong>المتابعة مستقرة اليوم</strong><p>لا توجد تقارير متأخرة أو مؤشرات تراجع تستلزم تدخلاً الآن.</p></div></div>`;
    return;
  }

  container.innerHTML = interventions.slice(0, 4).map((student, index) => priorityCard(student, index)).join('')
    + (interventions.length > 4 ? `<button class="students-priority-more" type="button" data-show-all-attention><strong>+${interventions.length - 4}</strong><span>حالات أخرى</span></button>` : '');
  container.querySelector('[data-show-all-attention]')?.addEventListener('click', () => document.getElementById('students-show-attention').click());
  document.querySelector('.students-action-center')?.classList.toggle('has-urgent', urgentCount > 0);
}

function priorityCard(student, index) {
  const primaryReason = student.reasons[0] || { label: 'يحتاج مراجعة', tone: 'is-neutral' };
  return `<article class="students-priority-card ${primaryReason.tone}">
    <div class="students-priority-rank" aria-label="الأولوية ${index + 1}">${index + 1}</div>
    <div class="students-priority-person"><span class="students-avatar">${escapeHtml(initials(student.full_name))}</span><div><strong>${escapeHtml(student.full_name || 'طالب')}</strong><small>@${escapeHtml(student.username || '')}</small></div></div>
    <div class="students-priority-reasons">${student.reasons.map(reason => `<span class="${reason.tone}">${escapeHtml(reason.label)}</span>`).join('')}</div>
    <div class="students-priority-rate"><span>التزام 7 أيام</span><strong>${formatPercent(student.completionRate)}%</strong><i><b style="width:${clamp(student.completionRate, 0, 100)}%"></b></i></div>
    <button type="button" data-student-details="${escapeHtml(student.student_id)}"><span>عرض التفاصيل</span><i data-lucide="arrow-left"></i></button>
  </article>`;
}

function renderComparisons() {
  const container = document.getElementById('students-comparison-cards');
  const cards = buildPeriodCards(state.performance?.comparisons || {}).filter(card => card.key !== 'today');
  container.innerHTML = cards.map(card => {
    const deltaTone = card.completionDelta > 0 ? 'is-up' : card.completionDelta < 0 ? 'is-down' : 'is-steady';
    const deltaLabel = card.completionDelta === 0 ? 'مستقر' : `${card.completionDelta > 0 ? '+' : ''}${formatPercent(card.completionDelta)} نقطة`;
    return `<article class="students-comparison-card">
      <div class="students-rate-ring" style="--rate:${card.completionRate}" role="img" aria-label="نسبة إكمال ${escapeHtml(card.label)} ${formatPercent(card.completionRate)} بالمئة"><span><strong>${formatPercent(card.completionRate)}%</strong><small>إكمال</small></span></div>
      <div><strong>${escapeHtml(card.label)}</strong><span>${card.completedCount} من ${card.expectedCount} يوماً طلابياً</span><em class="${deltaTone}"><i data-lucide="${card.completionDelta > 0 ? 'trending-up' : card.completionDelta < 0 ? 'trending-down' : 'minus'}"></i>${escapeHtml(deltaLabel)}</em><small>${escapeHtml(card.description)}</small></div>
    </article>`;
  }).join('');
}

function renderTaskDistribution() {
  const container = document.getElementById('students-task-chart');
  const tasks = buildTaskMetrics(state.performance?.task_distribution || {});
  if (!tasks.some(task => task.assigned > 0)) {
    container.innerHTML = '<div class="students-chart-empty"><i data-lucide="chart-bar-decreasing"></i><p>لا توجد تقارير كافية لتحليل توازن الخطة.</p></div>';
    return;
  }
  container.innerHTML = tasks.map(task => `<article class="students-task-row" style="--task-color:${task.color}">
    <div><span>${escapeHtml(task.label)}</span><strong>${formatPercent(task.completionRate)}%</strong></div>
    <span class="students-task-track"><i style="width:${task.completionRate}%"></i></span>
    <small><b>${task.completed}</b> من ${task.assigned} تقريراً منجزاً</small>
  </article>`).join('');
}

function renderMomentum() {
  const container = document.getElementById('students-momentum-list');
  if (!container) return;
  const students = (state.performance?.students || []).map(student => ({ ...student, trend: studentTrend(student) }));
  const changed = students.filter(student => Math.abs(student.trend.delta) >= 8)
    .sort((a, b) => Math.abs(b.trend.delta) - Math.abs(a.trend.delta))
    .slice(0, 6);
  if (!changed.length) {
    container.innerHTML = '<div class="students-chart-empty"><i data-lucide="minus"></i><p>لا توجد تغيرات واضحة في مستوى الطلاب خلال هذه الفترة.</p></div>';
    return;
  }
  container.innerHTML = changed.map(student => `<button type="button" data-student-details="${escapeHtml(student.student_id)}" class="${student.trend.tone}">
    <span class="students-avatar">${escapeHtml(initials(student.full_name))}</span>
    <span><strong>${escapeHtml(student.full_name || 'طالب')}</strong><small>${student.trend.label} مقارنة بالأسبوع السابق</small></span>
    <b>${student.trend.delta > 0 ? '+' : ''}${formatPercent(student.trend.delta)}</b>
  </button>`).join('');
}

function renderRequests() {
  const extensions = state.extensionQueue || [];
  const shifts = state.shiftQueue || [];
  const pendingCount = extensions.length + shifts.length;
  const completedReports = (state.consoleData?.students || []).reduce((sum, student) => sum + Number(student.completed_count || 0), 0);
  setText('requests-extension-count', extensions.length);
  setText('requests-shift-count', shifts.length);
  setText('requests-completed-count', completedReports);
  const badge = document.getElementById('students-requests-badge');
  badge.hidden = pendingCount === 0;
  badge.textContent = String(pendingCount);
  const container = document.getElementById('students-requests-list');
  if (!container) return;

  const items = [
    ...extensions.map(request => ({
      kind: 'extension', icon: 'timer-reset', label: 'طلب تمديد', studentId: request.student_id,
      fullName: request.full_name, username: request.username,
      reason: request.reason, detail: `${request.requested_minutes || 0} دقيقة · ${(request.items || []).length} تقرير`,
      requestedAt: request.requested_at,
    })),
    ...shifts.map(request => ({
      kind: 'shift', icon: 'calendar-arrow-down', label: 'طلب ترحيل', studentId: request.student_id,
      fullName: request.full_name, username: request.username,
      reason: request.reason, detail: `من ${formatDate(request.requested_from_date)} · ${request.pending_report_count || 0} تقرير`,
      requestedAt: request.requested_at,
    })),
  ].sort((a, b) => String(a.requestedAt || '').localeCompare(String(b.requestedAt || '')));

  if (!items.length) {
    const restricted = !state.requestAccess.extension || !state.requestAccess.shift;
    container.innerHTML = `<div class="students-requests-empty"><i data-lucide="${restricted ? 'shield-check' : 'inbox'}"></i><strong>${restricted ? 'لا توجد طلبات ضمن صلاحياتك' : 'لا توجد طلبات معلقة'}</strong><p>${restricted ? 'طلبات ترحيل الخطة تظهر للمعلم المسؤول والمدير فقط.' : 'ستظهر هنا طلبات التمديد والترحيل عند وصولها.'}</p></div>`;
    return;
  }
  container.innerHTML = items.map(item => `<article class="students-request-item is-${item.kind}">
    <span><i data-lucide="${item.icon}"></i></span>
    <div><small>${item.label}</small><strong>${escapeHtml(item.fullName || 'طالب')}</strong><p>${escapeHtml(item.reason || 'لم يكتب سبباً')}</p><em>${escapeHtml(item.detail)}</em></div>
    <button type="button" data-student-details="${escapeHtml(item.studentId)}"><span>مراجعة الطالب</span><i data-lucide="arrow-left"></i></button>
  </article>`).join('');
}

function renderTodaySummary() {
  const summary = buildTodaySummary(state.consoleData?.summary || {}, state.consoleData?.students || []);
  setText('metric-completion-rate', `${formatPercent(summary.completionRate)}%`);
  setText('metric-completion-detail', `${summary.completedReports} من ${summary.assignedReports} تقرير`);
  setText('metric-on-time', summary.completedOnTime);
  setText('metric-late', summary.completedLate);
  setText('metric-pending', summary.pendingStudents);
  setText('metric-overdue-reports', summary.overdueReports);
  setText('metric-overdue-students', `لدى ${summary.overdueStudents} طالب`);
  const bar = document.getElementById('metric-completion-bar');
  if (bar) bar.style.width = `${summary.completionRate}%`;
  const nextDueDates = (state.consoleData?.students || []).map(student => student.next_due_at).filter(Boolean).sort();
  setText('metric-deadline-note', nextDueDates.length ? `أقرب موعد اليوم ${formatTime(nextDueDates[0])}` : 'لا توجد مواعيد معلقة لهذا اليوم');
}

function renderTrend() {
  const chart = document.getElementById('students-trend-chart');
  const days = state.performance?.daily_chart || [];
  if (!days.length) {
    chart.innerHTML = '<div class="students-chart-empty"><i data-lucide="chart-no-axes-column-decreasing"></i><p>لا تتوفر بيانات كافية لرسم اتجاه الإنجاز.</p></div>';
    return;
  }
  const width = 760;
  const height = 220;
  const plot = { top: 16, right: 18, bottom: 40, left: 28 };
  const usableWidth = width - plot.left - plot.right;
  const usableHeight = height - plot.top - plot.bottom;
  const points = days.map((day, index) => {
    const rate = clamp(Number(day.completion_rate || 0), 0, 100);
    return {
      ...day,
      rate,
      x: plot.left + (days.length === 1 ? usableWidth / 2 : (index / (days.length - 1)) * usableWidth),
      y: plot.top + ((100 - rate) / 100) * usableHeight,
    };
  });
  const linePath = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${points.at(-1).x.toFixed(1)} ${(plot.top + usableHeight).toFixed(1)} L ${points[0].x.toFixed(1)} ${(plot.top + usableHeight).toFixed(1)} Z`;
  const averageRate = average(points.map(point => point.rate));
  const currentRate = points.at(-1).rate;
  const change = currentRate - points[0].rate;
  const changeTone = change > 0 ? 'is-up' : change < 0 ? 'is-down' : 'is-steady';
  const grid = [0, 25, 50, 75, 100].map(value => {
    const y = plot.top + ((100 - value) / 100) * usableHeight;
    return `<g><line x1="${plot.left}" y1="${y}" x2="${width - plot.right}" y2="${y}"/><text x="${plot.left - 6}" y="${y + 3}">${value}</text></g>`;
  }).join('');
  const labels = points.map((point, index) => index % 2 === 0 || index === points.length - 1
    ? `<text x="${point.x}" y="${height - 12}">${escapeHtml(shortDate(point.report_date))}</text>` : '').join('');
  const dots = points.map(point => `<circle cx="${point.x}" cy="${point.y}" r="4"><title>${escapeHtml(`${formatDate(point.report_date)}: ${formatPercent(point.rate)}%`)}</title></circle>`).join('');

  chart.innerHTML = `<div class="students-trend-summary">
      <span><small>اليوم</small><strong>${formatPercent(currentRate)}%</strong></span>
      <span><small>متوسط الفترة</small><strong>${formatPercent(averageRate)}%</strong></span>
      <span class="${changeTone}"><small>منذ بداية الرسم</small><strong>${change > 0 ? '+' : ''}${formatPercent(change)} نقطة</strong></span>
    </div>
    <svg class="students-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="خط زمني لنسبة إكمال تقارير الحلقة خلال آخر أربعة عشر يوماً">
      <defs><linearGradient id="students-trend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b7654" stop-opacity=".24"/><stop offset="1" stop-color="#0b7654" stop-opacity=".02"/></linearGradient></defs>
      <g class="students-chart-grid">${grid}</g>
      <path class="students-chart-area" d="${areaPath}"/>
      <path class="students-chart-line" d="${linePath}"/>
      <g class="students-chart-dots">${dots}</g>
      <g class="students-chart-labels">${labels}</g>
    </svg>`;
}

function renderStudents() {
  if (!state.consoleData) return;
  const rows = filteredStudents();
  const total = state.consoleData.students?.length || 0;
  setText('students-results-label', `${rows.length} من ${total} طالباً`);
  const table = document.getElementById('students-table-wrap');
  const body = document.getElementById('students-table-body');

  if (!rows.length) {
    table.hidden = true;
    setFeedback('empty', total ? 'لا يوجد طلاب مطابقون للبحث أو التصفية.' : 'لا يوجد طلاب نشطون في هذه الحلقة.');
    return;
  }

  document.getElementById('students-feedback').hidden = true;
  table.hidden = false;
  body.innerHTML = rows.map(studentRow).join('');
  refreshIcons();
}

function filteredStudents() {
  const performanceIndex = performanceByStudent(state.performance);
  const rows = (state.consoleData?.students || []).map(student => ({
    ...student,
    performance: performanceIndex.get(student.student_id) || null,
  })).filter(student => {
    const matchesQuery = !state.query || `${student.full_name || ''} ${student.username || ''}`.toLocaleLowerCase('ar').includes(state.query);
    const status = student.daily_state || 'no_reports';
    const matchesStatus = state.status === 'all'
      || state.status === status
      || (state.status === 'completed' && ['completed', 'completed_late'].includes(status))
      || (state.status === 'attention' && ['overdue', 'partial', 'pending'].includes(status))
      || (state.status === 'overdue' && Number(student.overdue_count || 0) > 0);
    return matchesQuery && matchesStatus;
  });

  return rows.sort((a, b) => {
    if (state.sort === 'name') return String(a.full_name || '').localeCompare(String(b.full_name || ''), 'ar');
    if (state.sort === 'overdue') return Number(b.overdue_count || 0) - Number(a.overdue_count || 0) || comparePriority(a, b);
    if (state.sort === 'completion') return Number(b.performance?.completion_rate_7 || 0) - Number(a.performance?.completion_rate_7 || 0) || comparePriority(a, b);
    return comparePriority(a, b);
  });
}

function comparePriority(a, b) {
  const rank = { overdue: 0, partial: 1, pending: 2, completed_late: 3, completed: 4, exempted: 5, no_reports: 6 };
  return (rank[a.daily_state] ?? 7) - (rank[b.daily_state] ?? 7)
    || Number(b.overdue_count || 0) - Number(a.overdue_count || 0)
    || String(a.full_name || '').localeCompare(String(b.full_name || ''), 'ar');
}

function studentRow(student) {
  const meta = STATUS_META[student.daily_state] || STATUS_META.no_reports;
  const overdue = Number(student.overdue_count || 0);
  const rate = clamp(Number(student.performance?.completion_rate_7 || 0), 0, 100);
  const trend = studentTrend(student.performance || {});
  const latest = latestProgress(student.performance?.latest_progress);
  const needsAttention = overdue > 0 || ['overdue', 'partial', 'pending'].includes(student.daily_state);
  const chat = `/teacher/chat.html?contact=${encodeURIComponent(student.student_id)}`;
  const nextDue = student.next_due_at ? formatTime(student.next_due_at) : 'لا يوجد';
  const completed = Number(student.completed_count || 0);
  const reportCount = Number(student.report_count || 0);
  const tasks = Object.entries(TASK_META).map(([taskType, taskMeta]) => {
    const task = taskState(student.assignments || [], taskType);
    return `<span class="students-task-pill is-${task.key}" title="${escapeHtml(`${taskMeta.label}: ${task.label}`)}"><b>${escapeHtml(taskMeta.shortLabel)}</b><i></i></span>`;
  }).join('');
  return `<article class="students-table-row ${needsAttention ? 'needs-attention' : ''}">
    <div class="students-person"><span class="students-avatar">${escapeHtml(initials(student.full_name))}</span><div><strong>${escapeHtml(student.full_name || 'طالب')}</strong><small>@${escapeHtml(student.username || '')}</small></div></div>
    <span class="students-daily-progress" data-label="تقرير اليوم"><strong>${completed}/${reportCount}</strong><span class="students-task-pills">${tasks}</span></span>
    <span class="students-state-cell" data-label="الحالة والموعد"><b class="students-state ${meta.tone}">${escapeHtml(meta.label)}</b><small>${escapeHtml(nextDue)}${student.has_extension ? ' · ممدد' : ''}</small></span>
    <span class="students-overdue-cell ${overdue ? 'has-overdue' : ''}" data-label="المتأخرات"><strong>${overdue || '0'}</strong><small>${overdue ? 'تقرير يحتاج معالجة' : 'لا يوجد تأخير'}</small></span>
    <span class="students-week-rate" data-label="الأداء الأسبوعي"><span class="students-week-value"><strong>${formatPercent(rate)}%</strong><em class="${trend.tone}">${escapeHtml(trend.label)}</em></span><span><i style="width:${rate}%"></i></span></span>
    <span class="students-progress" data-label="آخر تقدم"><strong>${escapeHtml(latest.content)}</strong><small>${escapeHtml(latest.detail)}</small></span>
    <span class="students-row-actions"><button type="button" data-student-details="${escapeHtml(student.student_id)}" title="فتح ملف الطالب"><i data-lucide="panel-left-open"></i><span>التفاصيل</span></button><a href="${escapeHtml(chat)}" title="مراسلة الطالب"><i data-lucide="message-square"></i><span class="sr-only">مراسلة الطالب</span></a></span>
  </article>`;
}

function latestProgress(progress = {}) {
  const items = Object.entries(progress || {}).map(([type, item]) => ({ type, ...item })).filter(item => item.report_date);
  items.sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
  const latest = items[0];
  return latest
    ? { content: latest.content || TASK_LABELS[latest.type] || 'تقرير منجز', detail: `${TASK_LABELS[latest.type] || latest.type} · ${formatDate(latest.report_date)}` }
    : { content: 'لا يوجد إنجاز مسجل', detail: 'سيظهر آخر تقدم هنا' };
}

async function openStudentDrawer(studentId) {
  const student = (state.consoleData?.students || []).find(item => item.student_id === studentId);
  if (!student) return;
  state.selectedStudentId = studentId;
  state.studentHistory = null;
  const drawer = document.getElementById('student-drawer');
  const backdrop = document.getElementById('student-drawer-backdrop');
  drawer.hidden = false;
  backdrop.hidden = false;
  drawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('has-student-drawer');
  renderStudentDrawer(student, null, true);
  refreshIcons();
  document.getElementById('student-drawer-close').focus();

  try {
    if (isLocalPreviewMode()) {
      state.studentHistory = buildPreviewHistory(student);
    } else {
      const { data, error } = await supabase.rpc('get_quran_student_history', {
        p_circle_id: state.circleId,
        p_student_id: studentId,
        p_limit: 60,
        p_offset: 0,
      });
      if (error) throw error;
      state.studentHistory = data;
    }
    if (state.selectedStudentId === studentId) renderStudentDrawer(student, state.studentHistory, false);
  } catch (error) {
    console.error('Unable to load student history:', error);
    if (state.selectedStudentId === studentId) renderStudentDrawer(student, null, false, friendlyError(error));
  }
}

function closeStudentDrawer() {
  state.selectedStudentId = null;
  state.studentHistory = null;
  const drawer = document.getElementById('student-drawer');
  drawer.setAttribute('aria-hidden', 'true');
  drawer.hidden = true;
  document.getElementById('student-drawer-backdrop').hidden = true;
  document.body.classList.remove('has-student-drawer');
}

function renderStudentDrawer(student, history, loading = false, errorMessage = '') {
  const performance = performanceByStudent(state.performance).get(student.student_id) || {};
  const period7 = history?.analytics?.periods?.['7'] || {};
  const period30 = history?.analytics?.periods?.['30'] || {};
  const assignments = history?.assignments || [];
  const overdueAssignments = assignments.filter(item => item.is_overdue);
  const oldestOverdue = overdueAssignments.slice().sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)))[0];
  const latest = latestProgress(history?.analytics?.latest_progress || performance.latest_progress);
  const chat = `/teacher/chat.html?contact=${encodeURIComponent(student.student_id)}`;
  const workspace = workspaceUrl(state.circleId, 'work');
  setText('student-drawer-title', student.full_name || 'سجل الطالب');
  const container = document.getElementById('student-drawer-content');
  if (loading) {
    container.innerHTML = '<div class="student-drawer-loading"><i data-lucide="loader-circle"></i><p>جاري تحميل سجل الطالب...</p></div>';
    return;
  }
  if (errorMessage) {
    container.innerHTML = `<div class="student-drawer-error"><i data-lucide="circle-alert"></i><p>${escapeHtml(errorMessage)}</p></div>`;
    return;
  }
  container.innerHTML = `
    <section class="student-drawer-identity"><span class="students-avatar">${escapeHtml(initials(student.full_name))}</span><div><strong>${escapeHtml(student.full_name || 'طالب')}</strong><small>@${escapeHtml(student.username || '')}</small></div></section>
    <section class="student-drawer-metrics">
      <article><small>إنجاز 7 أيام</small><strong>${formatPercent(period7.completion_rate ?? performance.completion_rate_7)}%</strong><span>${Number(period7.completed_count || 0)} تقريراً</span></article>
      <article><small>في الوقت</small><strong>${formatPercent(period7.on_time_rate ?? performance.on_time_rate_7)}%</strong><span>آخر 7 أيام</span></article>
      <article><small>إنجاز 30 يوماً</small><strong>${formatPercent(period30.completion_rate ?? performance.completion_rate_30)}%</strong><span>${Number(period30.completed_count || 0)} تقريراً</span></article>
      <article class="${overdueAssignments.length ? 'is-alert' : ''}"><small>التقارير المتأخرة</small><strong>${overdueAssignments.length}</strong><span>${oldestOverdue ? `منذ ${formatDate(oldestOverdue.report_date)}` : 'لا يوجد تأخير'}</span></article>
    </section>
    <section class="student-drawer-section"><header><div><span>اليوم</span><h3>التقارير المطلوبة</h3></div></header><div class="student-drawer-tasks">${drawerTodayTasks(student.assignments || [])}</div></section>
    <section class="student-drawer-section"><header><div><span>التقدم</span><h3>آخر موضع مسجل</h3></div></header><div class="student-drawer-latest"><i data-lucide="bookmark-check"></i><div><strong>${escapeHtml(latest.content)}</strong><small>${escapeHtml(latest.detail)}</small></div></div></section>
    <section class="student-drawer-section"><header><div><span>السجل القريب</span><h3>آخر التقارير</h3></div></header><div class="student-drawer-history">${drawerHistory(assignments.slice(0, 8))}</div></section>
    <footer class="student-drawer-actions"><a href="${escapeHtml(workspace)}"><i data-lucide="files"></i><span>إدارة التقارير</span></a><a href="${escapeHtml(chat)}"><i data-lucide="message-square"></i><span>مراسلة الطالب</span></a></footer>`;
  refreshIcons();
}

function drawerTodayTasks(assignments) {
  if (!assignments.length) return '<p class="student-drawer-empty">لا توجد تقارير مقررة لهذا اليوم.</p>';
  return assignments.map(item => {
    const task = taskState([item], item.task_type);
    return `<article class="is-${task.key}"><span><i data-lucide="${task.key === 'completed' ? 'check' : task.key === 'overdue' ? 'triangle-alert' : 'clock-3'}"></i></span><div><strong>${escapeHtml(TASK_LABELS[item.task_type] || item.task_type)}</strong><small>${escapeHtml(item.content || task.label)}</small></div><b>${escapeHtml(task.label)}</b></article>`;
  }).join('');
}

function drawerHistory(assignments) {
  if (!assignments.length) return '<p class="student-drawer-empty">لا يوجد سجل تقارير بعد.</p>';
  return assignments.map(item => {
    const status = item.status === 'completed' ? (item.completion_band === 'late' ? 'منجز متأخراً' : 'منجز') : item.status === 'exempted' ? 'معفى' : item.is_overdue ? 'متأخر' : 'منتظر';
    return `<article class="${item.is_overdue ? 'is-overdue' : ''}"><time>${escapeHtml(shortDate(item.report_date))}</time><div><strong>${escapeHtml(TASK_LABELS[item.task_type] || item.task_type)}</strong><small>${escapeHtml(item.content || '')}</small></div><span>${escapeHtml(status)}</span></article>`;
  }).join('');
}

function buildPreviewHistory(student) {
  const performance = performanceByStudent(state.performance).get(student.student_id) || {};
  const assignments = Array.from({ length: 9 }, (_, index) => ({
    id: `history-${student.student_id}-${index}`,
    report_date: addDays(state.date, -index),
    task_type: ['hifz', 'tathbit', 'murajaa'][index % 3],
    content: index % 3 === 0 ? `سورة البقرة، الآيات ${index + 1}-${index + 5}` : index % 3 === 1 ? 'تثبيت محفوظ الأسبوع' : 'مراجعة الورد السابق',
    status: index < Number(student.overdue_count || 0) ? 'pending' : 'completed',
    is_overdue: index < Number(student.overdue_count || 0),
    completion_band: index % 4 === 0 ? 'late' : 'early',
  }));
  return {
    analytics: {
      periods: {
        '7': { completion_rate: performance.completion_rate_7, on_time_rate: performance.on_time_rate_7, completed_count: 6 },
        '30': { completion_rate: performance.completion_rate_30, completed_count: 23 },
      },
      latest_progress: performance.latest_progress,
    },
    assignments,
  };
}

function setFeedback(type, message) {
  const feedback = document.getElementById('students-feedback');
  const icon = type === 'loading' ? 'loader-circle' : type === 'error' ? 'circle-alert' : 'user-round-search';
  feedback.hidden = false;
  feedback.className = `students-feedback is-${type}`;
  feedback.innerHTML = `<i data-lucide="${icon}"></i><p>${escapeHtml(message)}</p>`;
  refreshIcons();
}

function renderEmptyPage(message, error = false) {
  state.consoleData = null;
  state.performance = null;
  state.extensionQueue = [];
  state.shiftQueue = [];
  renderPriorityCenter();
  renderTodaySummary();
  renderTrend();
  renderComparisons();
  renderTaskDistribution();
  renderMomentum();
  renderRequests();
  document.getElementById('students-table-wrap').hidden = true;
  setFeedback(error ? 'error' : 'empty', message);
}

function renderDate() {
  setText('selected-date-label', formatDate(state.date));
}

function updateWorkspaceLinks() {
  document.getElementById('students-circle-workspace').href = state.circleId ? workspaceUrl(state.circleId, 'performance') : '/circles.html?type=quran';
  document.getElementById('students-review-workspace').href = state.circleId ? workspaceUrl(state.circleId, 'work') : '/circles.html?type=quran';
}

function workspaceUrl(circleId, section) {
  const params = new URLSearchParams({ id: circleId });
  if (isLocalPreviewMode()) {
    params.set('preview', '1');
    params.set('role', state.profile?.role || 'teacher');
  }
  return `/circle.html?${params.toString()}#${section}`;
}

function syncUrl() {
  const params = new URLSearchParams(window.location.search);
  if (state.circleId) params.set('circle', state.circleId);
  params.set('date', state.date);
  params.set('view', state.activeView);
  history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
}

function setRefreshBusy(busy) {
  const button = document.getElementById('students-refresh');
  button.disabled = busy;
  button.classList.toggle('is-loading', busy);
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = String(value);
}

function refreshIcons() {
  if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function displayName(profile) {
  return profile?.full_name || profile?.username || 'معلم المركز';
}

function firstName(name) {
  return String(name || 'معلمنا').trim().split(/\s+/)[0];
}

function initials(name) {
  return String(name || 'ط').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('');
}

function formatDate(value) {
  if (!value) return 'غير محدد';
  return new Intl.DateTimeFormat('ar-OM', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Muscat' })
    .format(new Date(`${value}T12:00:00+04:00`));
}

function shortDate(value) {
  return new Intl.DateTimeFormat('ar-OM', { day: 'numeric', month: 'short', timeZone: 'Asia/Muscat' })
    .format(new Date(`${value}T12:00:00+04:00`));
}

function formatTime(value) {
  return new Intl.DateTimeFormat('ar-OM', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Muscat' }).format(new Date(value));
}

function muscatDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Muscat' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatPercent(value) {
  return Number(value || 0).toFixed(Number(value || 0) % 1 ? 1 : 0);
}

function average(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function friendlyError(error) {
  const message = String(error?.message || error || '');
  if (/not allowed|42501|permission|policy/i.test(message)) return 'لا تملك صلاحية عرض بيانات هذه الحلقة.';
  if (/failed to fetch|network|load failed/i.test(message)) return 'تعذر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.';
  return 'تعذر تحميل متابعة الطلاب الآن. أعد المحاولة بعد قليل.';
}

function previewCircles() {
  return [{
    id: '91000000-0000-4000-8000-000000000001',
    name: 'حلقة الإتقان',
    circle_type: 'quran',
    participant_role: 'lead',
    students_count: 12,
  }];
}

function buildPreviewDashboard(date) {
  const names = [
    ['أحمد بن سعيد المعمري', 'ahmed.01', 'completed'],
    ['سالم بن راشد الهنائي', 'salem.02', 'pending'],
    ['حمزة بن علي الخياري', 'hamza.03', 'completed'],
    ['عبدالله بن عامر القضابي', 'abdullah.04', 'overdue'],
    ['يوسف بن أحمد الخليلي', 'yousef.05', 'completed_late'],
    ['محمد بن حمد الرئامي', 'mohammed.06', 'partial'],
    ['إسحاق بن سالم الظاهري', 'ishaq.07', 'no_reports'],
    ['خالد بن سيف الحاتمي', 'khalid.08', 'completed'],
  ];
  const students = names.map(([fullName, username, dailyState], index) => previewStudent(fullName, username, dailyState, index, date));
  const summary = {
    student_count: students.length,
    completed_students: students.filter(item => ['completed', 'completed_late'].includes(item.daily_state)).length,
    completed_on_time_students: students.filter(item => item.daily_state === 'completed').length,
    completed_late_students: students.filter(item => item.daily_state === 'completed_late').length,
    attention_students: students.filter(item => ['overdue', 'partial', 'pending'].includes(item.daily_state)).length,
    overdue_students: students.filter(item => item.daily_state === 'overdue').length,
    pending_students: students.filter(item => ['partial', 'pending'].includes(item.daily_state)).length,
    exempted_students: 0,
    no_report_students: students.filter(item => item.daily_state === 'no_reports').length,
  };
  const performanceStudents = students.map((student, index) => ({
    student_id: student.student_id,
    completion_rate_7: [100, 57, 86, 28, 72, 45, 0, 93][index],
    previous_completion_rate_7: [86, 64, 72, 42, 65, 52, 0, 88][index],
    on_time_rate_7: [94, 42, 88, 25, 55, 48, 0, 91][index],
    completion_rate_30: [96, 68, 84, 46, 75, 61, 12, 89][index],
    overdue_count: student.overdue_count,
    latest_progress: index === 6 ? {} : {
      hifz: { report_date: date, content: `سورة البقرة، الآيات ${index * 5 + 1}-${index * 5 + 5}` },
      murajaa: { report_date: addDays(date, -1), content: `مراجعة الجزء ${Math.max(1, index)}` },
    },
  }));
  const dailyChart = Array.from({ length: 14 }, (_, index) => ({
    report_date: addDays(date, index - 13),
    completion_rate: [62, 75, 68, 82, 71, 88, 79, 91, 84, 76, 93, 87, 72, 50][index],
  }));
  return {
    consoleData: { circle_id: state.circleId, report_date: date, summary, students },
    performance: {
      students: performanceStudents,
      daily_chart: dailyChart,
      comparisons: {
        today: { current: { completion_rate: 50, on_time_rate: 75, completed_student_days: 4, expected_student_days: 8 }, completion_rate_delta: -12.5 },
        week: { current: { completion_rate: 74.5, on_time_rate: 81, completed_student_days: 38, expected_student_days: 51 }, completion_rate_delta: 6.5 },
        month: { current: { completion_rate: 78, on_time_rate: 76, completed_student_days: 159, expected_student_days: 204 }, completion_rate_delta: 4 },
      },
      task_distribution: {
        hifz: { assigned_count: 162, completed_count: 132, earned_points: 408 },
        tathbit: { assigned_count: 151, completed_count: 108, earned_points: 270 },
        murajaa: { assigned_count: 158, completed_count: 121, earned_points: 303 },
      },
    },
    extensionQueue: [{
      id: 'preview-extension', student_id: students[5].student_id, full_name: students[5].full_name,
      username: students[5].username, requested_minutes: 90, reason: 'ارتباط عائلي طارئ وأحتاج وقتاً إضافياً.',
      requested_at: `${date}T09:10:00+04:00`, items: students[5].assignments.slice(0, 2).map(item => ({ assignment_id: item.id })),
    }],
    shiftQueue: [{
      id: 'preview-shift', student_id: students[3].student_id, full_name: students[3].full_name,
      username: students[3].username, requested_from_date: addDays(date, -2), reason: 'تعذر علي إنجاز تقارير يومين بسبب المرض.',
      requested_at: `${date}T08:20:00+04:00`, pending_report_count: 9, overdue_report_count: 3,
    }],
  };
}

function previewStudent(fullName, username, dailyState, index, date) {
  const completed = dailyState === 'completed' || dailyState === 'completed_late' ? 3 : dailyState === 'partial' ? 1 : 0;
  const reportCount = dailyState === 'no_reports' ? 0 : 3;
  const overdueCount = dailyState === 'overdue' ? 3 : dailyState === 'partial' ? 1 : index === 1 ? 1 : 0;
  return {
    student_id: `preview-student-${index + 1}`,
    full_name: fullName,
    username,
    daily_state: dailyState,
    report_count: reportCount,
    completed_count: completed,
    pending_count: Math.max(0, reportCount - completed),
    exempted_count: 0,
    overdue_count: overdueCount,
    next_due_at: ['pending', 'partial'].includes(dailyState) ? `${date}T23:00:00+04:00` : null,
    has_extension: index === 1,
    assignments: previewAssignments(dailyState, date),
  };
}

function previewAssignments(dailyState, date) {
  if (dailyState === 'no_reports') return [];
  const completedTypes = dailyState === 'completed' || dailyState === 'completed_late'
    ? ['hifz', 'tathbit', 'murajaa']
    : dailyState === 'partial' ? ['hifz'] : [];
  return Object.keys(TASK_META).map(taskType => ({
    id: `preview-${taskType}`,
    task_type: taskType,
    report_date: date,
    status: completedTypes.includes(taskType) ? 'completed' : dailyState === 'exempted' ? 'exempted' : 'pending',
    is_overdue: dailyState === 'overdue',
  }));
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00+04:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
