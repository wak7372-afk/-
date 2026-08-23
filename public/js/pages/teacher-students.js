import { supabase } from '../lib/supabase-client.js';
import { isLocalPreviewMode, logoutUser, requireAuth } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast } from '../lib/utils.js';
import {
  TASK_META,
  buildInterventions,
  buildPeriodCards,
  buildTaskMetrics,
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
}

function applyRequestedState() {
  const params = new URLSearchParams(window.location.search);
  const requestedDate = params.get('date');
  if (/^\d{4}-\d{2}-\d{2}$/.test(requestedDate || '') && requestedDate <= muscatDateKey()) state.date = requestedDate;
  document.getElementById('students-date').value = state.date;
  document.getElementById('students-date').max = muscatDateKey();
  renderDate();
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
    } else {
      const [consoleResponse, performanceResponse] = await Promise.all([
        supabase.rpc('get_quran_teacher_console', { p_circle_id: state.circleId, p_report_date: state.date }),
        supabase.rpc('get_quran_circle_performance', { p_circle_id: state.circleId, p_as_of: state.date }),
      ]);
      if (consoleResponse.error) throw consoleResponse.error;
      state.consoleData = consoleResponse.data;
      state.performance = performanceResponse.error ? null : performanceResponse.data;
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
  renderMetrics();
  renderDonut();
  renderTrend();
  renderComparisons();
  renderTaskDistribution();
  renderStudents();
  refreshIcons();
}

function renderPriorityCenter() {
  const container = document.getElementById('students-priority-list');
  const interventions = buildInterventions(state.consoleData?.students || [], state.performance?.students || []);
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
  const workspace = workspaceUrl(state.circleId, 'work');
  return `<article class="students-priority-card ${primaryReason.tone}">
    <div class="students-priority-rank" aria-label="الأولوية ${index + 1}">${index + 1}</div>
    <div class="students-priority-person"><span class="students-avatar">${escapeHtml(initials(student.full_name))}</span><div><strong>${escapeHtml(student.full_name || 'طالب')}</strong><small>@${escapeHtml(student.username || '')}</small></div></div>
    <div class="students-priority-reasons">${student.reasons.map(reason => `<span class="${reason.tone}">${escapeHtml(reason.label)}</span>`).join('')}</div>
    <div class="students-priority-rate"><span>التزام 7 أيام</span><strong>${formatPercent(student.completionRate)}%</strong><i><b style="width:${clamp(student.completionRate, 0, 100)}%"></b></i></div>
    <a href="${escapeHtml(workspace)}"><span>فتح التقارير</span><i data-lucide="arrow-left"></i></a>
  </article>`;
}

function renderComparisons() {
  const container = document.getElementById('students-comparison-cards');
  const cards = buildPeriodCards(state.performance?.comparisons || {});
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

function renderMetrics() {
  const summary = state.consoleData?.summary || {};
  const performanceStudents = state.performance?.students || [];
  const overdueStudents = performanceStudents.length
    ? performanceStudents.filter(student => Number(student.overdue_count || 0) > 0).length
    : Number(summary.overdue_students || 0);
  const week = state.performance?.comparisons?.week || {};
  const weeklyRate = Number(week.current?.completion_rate || average(performanceStudents.map(student => student.completion_rate_7)) || 0);
  const weeklyDelta = Number(week.completion_rate_delta || 0);

  setText('metric-students', summary.student_count || 0);
  setText('metric-completed', summary.completed_students || 0);
  setText('metric-pending', summary.pending_students || 0);
  setText('metric-overdue', overdueStudents);
  setText('metric-weekly', `${formatPercent(weeklyRate)}%`);
  setText('metric-completed-note', `${Number(summary.completed_on_time_students || 0)} في الوقت · ${Number(summary.completed_late_students || 0)} متأخر`);
  setText('metric-weekly-note', weeklyDelta === 0 ? 'مستقر مقارنة بالأسبوع السابق' : `${weeklyDelta > 0 ? '+' : ''}${formatPercent(weeklyDelta)} نقطة عن الأسبوع السابق`);
}

function renderDonut() {
  const summary = state.consoleData?.summary || {};
  const total = Number(summary.student_count || 0);
  const segments = [
    { label: 'منجز في الوقت', value: Number(summary.completed_on_time_students || 0), color: '#0b7654' },
    { label: 'منجز بعد الموعد', value: Number(summary.completed_late_students || 0), color: '#d4ad43' },
    { label: 'يحتاج متابعة', value: Number(summary.attention_students || 0), color: '#b53d45' },
    { label: 'بلا تقرير أو معفى', value: Number(summary.no_report_students || 0) + Number(summary.exempted_students || 0), color: '#b8c5cb' },
  ];
  const donut = document.getElementById('students-status-donut');
  donut.style.background = total ? conicGradient(segments, total) : '#e7ecee';
  donut.setAttribute('aria-label', segments.map(item => `${item.label}: ${item.value}`).join('، '));
  setText('students-status-total', total);
  document.getElementById('students-status-legend').innerHTML = segments.map(item => `
    <article style="--legend-color:${item.color}"><i aria-hidden="true"></i><span>${escapeHtml(item.label)}</span><strong>${item.value}</strong></article>`).join('');
}

function conicGradient(segments, total) {
  let cursor = 0;
  const stops = segments.map(segment => {
    const start = cursor;
    cursor += (segment.value / total) * 100;
    return `${segment.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
  });
  return `conic-gradient(${stops.join(',')})`;
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
  const workspace = workspaceUrl(state.circleId, 'work');
  const chat = `/teacher/chat.html?contact=${encodeURIComponent(student.student_id)}`;
  const nextDue = student.next_due_at ? formatTime(student.next_due_at) : 'لا يوجد';
  const tasks = Object.entries(TASK_META).map(([taskType, taskMeta]) => {
    const task = taskState(student.assignments || [], taskType);
    return `<span class="students-task-pill is-${task.key}" title="${escapeHtml(`${taskMeta.label}: ${task.label}`)}"><b>${escapeHtml(taskMeta.shortLabel)}</b><i></i></span>`;
  }).join('');
  return `<article class="students-table-row ${needsAttention ? 'needs-attention' : ''}">
    <div class="students-person"><span class="students-avatar">${escapeHtml(initials(student.full_name))}</span><div><strong>${escapeHtml(student.full_name || 'طالب')}</strong><small>@${escapeHtml(student.username || '')}</small></div></div>
    <span class="students-state ${meta.tone}" data-label="حالة اليوم">${escapeHtml(meta.label)}</span>
    <span class="students-task-pills" data-label="مهام اليوم">${tasks}</span>
    <strong class="students-overdue ${overdue ? 'has-overdue' : ''}" data-label="المهام المتأخرة">${overdue || '0'}</strong>
    <span class="students-count-cell" data-label="الموعد القادم">${escapeHtml(nextDue)}<small>${student.has_extension ? 'موعد ممدد' : 'الموعد الفعلي'}</small></span>
    <span class="students-week-rate" data-label="الأداء الأسبوعي"><span class="students-week-value"><strong>${formatPercent(rate)}%</strong><em class="${trend.tone}">${escapeHtml(trend.label)}</em></span><span><i style="width:${rate}%"></i></span></span>
    <span class="students-progress" data-label="آخر تقدم"><strong>${escapeHtml(latest.content)}</strong><small>${escapeHtml(latest.detail)}</small></span>
    <span class="students-row-actions"><a href="${escapeHtml(workspace)}" title="فتح مركز تقارير الحلقة"><i data-lucide="panel-left-open"></i><span>السجل</span></a><a href="${escapeHtml(chat)}" title="مراسلة الطالب"><i data-lucide="message-square"></i><span class="sr-only">مراسلة الطالب</span></a></span>
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
  renderPriorityCenter();
  renderMetrics();
  renderDonut();
  renderTrend();
  renderComparisons();
  renderTaskDistribution();
  document.getElementById('students-table-wrap').hidden = true;
  setFeedback(error ? 'error' : 'empty', message);
}

function renderDate() {
  setText('selected-date-label', formatDate(state.date));
}

function updateWorkspaceLinks() {
  document.getElementById('students-circle-workspace').href = state.circleId ? workspaceUrl(state.circleId, 'performance') : '/circles.html?type=quran';
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
