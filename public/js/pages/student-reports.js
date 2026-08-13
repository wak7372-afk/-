import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { escapeHtml, showToast } from '../lib/utils.js';

const TYPE_META = {
  hifz: { label: 'الحفظ', icon: 'book-open-check', tone: 'hifz' },
  tathbit: { label: 'التثبيت', icon: 'refresh-cw', tone: 'tathbit' },
  murajaa: { label: 'المراجعة', icon: 'library-big', tone: 'murajaa' },
};
const ARABIC_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const state = {
  profile: null,
  preview: false,
  selectedDate: muscatDateKey(),
  assignments: [],
  overview: null,
  overdueCount: 0,
  earnedPoints: 0,
  selectedForExtension: new Set(),
  confirmingReportId: null,
  busy: false,
};

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
  const authData = await requireAuth(['student']);
  if (!authData) return;
  state.profile = authData.profile;
  state.preview = Boolean(authData.preview);
  document.getElementById('student-name').textContent = state.profile.username || state.profile.full_name || 'طالبنا';
  document.getElementById('logout-btn').addEventListener('click', logoutUser);
  document.getElementById('previous-report-week').addEventListener('click', () => moveSelectedDate(-7));
  document.getElementById('next-report-week').addEventListener('click', () => moveSelectedDate(7));
  document.getElementById('quran-date-days').addEventListener('click', selectDate);
  document.getElementById('quran-plan-notice').addEventListener('click', selectDate);
  document.getElementById('quran-student-report-list').addEventListener('click', handleReportAction);
  document.getElementById('quran-extension-form').addEventListener('submit', submitExtensionRequest);
  document.getElementById('quran-complete-form').addEventListener('submit', submitConfirmedReport);
  document.getElementById('cancel-quran-complete').addEventListener('click', closeCompleteDialog);
  const requestedDate = new URL(window.location.href).searchParams.get('date');
  if (isDateKey(requestedDate)) state.selectedDate = requestedDate;
  await loadOverview();
  if (!isDateKey(requestedDate) && state.overview?.focus_date) state.selectedDate = state.overview.focus_date;
  await loadReports();
  setInterval(() => renderPage(), 60000);
  refreshIcons();
}

async function loadOverview() {
  if (state.preview) {
    state.overview = {
      total_count: 5,
      pending_count: 4,
      first_report_date: addDateKey(muscatDateKey(), -1),
      last_report_date: addDateKey(muscatDateKey(), 1),
      focus_date: muscatDateKey(),
    };
    return;
  }
  const { data, error } = await supabase.rpc('get_my_quran_report_overview');
  if (error) {
    console.error('Loading Quran report overview failed:', error);
    return;
  }
  state.overview = data || null;
}

async function loadReports() {
  const list = document.getElementById('quran-student-report-list');
  list.innerHTML = '<div class="student-loading"><span></span><p>جاري تحميل تقاريرك...</p></div>';
  try {
    if (state.preview) {
      if (!state.assignments.length) state.assignments = buildPreviewAssignments();
      updateDerivedState();
      renderPage();
      return;
    }
    const { data, error } = await supabase.rpc('get_my_quran_reports', {
      p_start_date: addDateKey(state.selectedDate, -21),
      p_end_date: addDateKey(state.selectedDate, 14),
    });
    if (error) throw error;
    state.assignments = Array.isArray(data?.assignments) ? data.assignments : [];
    state.overdueCount = Number(data?.overdue_count || 0);
    state.earnedPoints = Number(data?.earned_points || 0);
    state.selectedForExtension.clear();
    updateDerivedState();
    renderPage();
  } catch (error) {
    console.error('Loading Quran reports failed:', error);
    list.innerHTML = '<div class="quran-reports-empty is-error"><i data-lucide="cloud-off"></i><h3>تعذر تحميل التقارير</h3><p>حدّث الصفحة أو تواصل مع إدارة المركز.</p></div>';
    refreshIcons();
  }
}

function updateDerivedState() {
  state.assignments.forEach(assignment => {
    assignment.is_overdue = assignment.status === 'pending' && new Date(assignment.effective_due_at).getTime() < Date.now();
    assignment.blocked_by_overdue = assignment.status === 'pending' && state.assignments.some(blocker => (
      blocker.status === 'pending'
      && new Date(blocker.effective_due_at).getTime() < Date.now()
      && blocker.report_date < assignment.report_date
    ));
    if (assignment.status === 'pending') assignment.available_points = livePoints(assignment);
  });
  state.overdueCount = state.assignments.filter(item => item.is_overdue).length;
  state.earnedPoints = state.assignments.reduce((sum, item) => sum + Number(item.awarded_points || 0), 0);
}

function renderPage() {
  updateDerivedState();
  renderDateStrip();
  renderMetrics();
  renderPlanNotice();
  renderReports();
  renderExtensionStatus();
  refreshIcons();
}

function renderPlanNotice() {
  const notice = document.getElementById('quran-plan-notice');
  const overview = state.overview;
  if (!overview?.total_count) {
    notice.hidden = true;
    notice.innerHTML = '';
    return;
  }
  const today = muscatDateKey();
  const firstDate = overview.first_report_date;
  const lastDate = overview.last_report_date;
  const upcoming = firstDate && firstDate > today;
  notice.hidden = false;
  notice.classList.toggle('is-upcoming', upcoming);
  notice.innerHTML = `
    <span><i data-lucide="${upcoming ? 'calendar-clock' : 'route'}"></i></span>
    <div>
      <strong>${upcoming ? `خطتك القرآنية تبدأ في ${escapeHtml(formatDate(firstDate))}` : 'خطة التقارير القرآنية مرتبطة بحسابك'}</strong>
      <small>من ${escapeHtml(formatDate(firstDate))} إلى ${escapeHtml(formatDate(lastDate))} · ${Number(overview.pending_count || 0)} تقرير قيد الإنجاز</small>
    </div>
    ${overview.focus_date && overview.focus_date !== state.selectedDate ? `<button type="button" data-plan-focus="${escapeHtml(overview.focus_date)}">الانتقال لأقرب تقرير <i data-lucide="arrow-left"></i></button>` : ''}`;
}

function renderDateStrip() {
  const selected = parseDateKey(state.selectedDate);
  const start = addDays(selected, -3);
  document.getElementById('quran-date-days').innerHTML = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    const dateKey = toDateKey(date);
    const count = state.assignments.filter(item => item.report_date === dateKey).length;
    return `<button type="button" data-report-date="${dateKey}" class="${dateKey === state.selectedDate ? 'is-active' : ''} ${dateKey === muscatDateKey() ? 'is-today' : ''}" aria-pressed="${dateKey === state.selectedDate}">
      <span>${ARABIC_DAYS[date.getDay()]}</span><strong>${date.getDate()}</strong><small>${count || 'ـ'}</small>
    </button>`;
  }).join('');
  const selectedDate = parseDateKey(state.selectedDate);
  document.getElementById('quran-selected-date-label').textContent = state.selectedDate === muscatDateKey()
    ? 'تقارير اليوم'
    : `${ARABIC_DAYS[selectedDate.getDay()]}، ${formatDate(state.selectedDate)}`;
}

function renderMetrics() {
  const reports = reportsForSelectedDate();
  const completed = reports.filter(item => item.status === 'completed').length;
  const available = reports.reduce((sum, item) => sum + Number(item.status === 'completed' ? item.awarded_points : item.available_points || 0), 0);
  document.getElementById('quran-total-count').textContent = reports.length;
  document.getElementById('quran-completed-count').textContent = completed;
  document.getElementById('quran-available-points').textContent = available.toFixed(2);
  document.getElementById('quran-overdue-count').textContent = state.overdueCount;
  document.getElementById('quran-earned-points').textContent = state.earnedPoints.toFixed(2);
  document.getElementById('quran-day-message').textContent = dailyMessage(reports, completed);
}

function renderReports() {
  const container = document.getElementById('quran-student-report-list');
  const extensionSide = document.querySelector('.quran-extension-side');
  const layout = document.querySelector('.quran-reports-layout');
  const reports = reportsForSelectedDate();
  if (!reports.length) {
    extensionSide.hidden = false;
    layout.classList.remove('is-day-complete');
    container.innerHTML = '<div class="quran-reports-empty"><i data-lucide="calendar-check-2"></i><h3>لا توجد تقارير في هذا اليوم</h3><p>اختر يوماً آخر من الشريط العلوي.</p></div>';
    return;
  }
  const allCompleted = reports.every(report => report.status === 'completed');
  extensionSide.hidden = allCompleted;
  layout.classList.toggle('is-day-complete', allCompleted);
  if (allCompleted) {
    const points = reports.reduce((sum, report) => sum + Number(report.awarded_points || 0), 0);
    container.innerHTML = `<section class="quran-day-complete">
      <span><i data-lucide="badge-check"></i></span>
      <div><small>اكتمل ورد اليوم</small><h3>لقد قمت بإنجاز جميع تقارير اليوم</h3><p>اللهم اجعله حافظاً متقناً لكتابك</p></div>
      <strong><i data-lucide="star"></i>${points.toFixed(2)} نقطة</strong>
    </section>`;
    return;
  }
  container.innerHTML = reports.map(reportCard).join('');
}

function reportCard(report) {
  const meta = TYPE_META[report.task_type] || TYPE_META.hifz;
  const status = reportStatus(report);
  const availablePoints = Number(report.status === 'completed' ? report.awarded_points : report.available_points || 0);
  const percent = report.max_points ? Math.max(0, Math.min(100, (availablePoints / Number(report.max_points)) * 100)) : 0;
  const canComplete = report.status === 'pending' && Date.now() >= new Date(report.starts_at).getTime() && !report.blocked_by_overdue;
  const canRequest = report.status === 'pending' && report.extension_status !== 'pending';
  return `<article class="quran-student-report-card type-${meta.tone} status-${status.tone}">
    <div class="quran-report-state">
      <span class="quran-report-status-mark" aria-hidden="true">
        <i data-lucide="${report.status === 'completed' ? 'check' : report.status === 'exempted' ? 'minus' : 'circle'}"></i>
      </span>
      <span>${escapeHtml(status.label)}</span>
    </div>
    <div class="quran-report-copy">
      <div class="quran-report-card-title"><span><i data-lucide="${meta.icon}"></i>${meta.label}</span><time><i data-lucide="calendar-days"></i>${formatDate(report.report_date)}</time></div>
      <h3>${escapeHtml(report.content)}</h3>
      ${report.repetitions ? `<span class="quran-repetitions"><i data-lucide="repeat-2"></i>${Number(report.repetitions)} تكرارات</span>` : ''}
      ${report.notes ? `<p>${escapeHtml(report.notes)}</p>` : ''}
      <div class="quran-report-score-row">
        <span class="score-pill"><i data-lucide="star"></i><b>${availablePoints.toFixed(2)}</b> من ${Number(report.max_points).toFixed(2)} نقطة</span>
        <span class="score-percent"><i data-lucide="flame"></i>${Math.round(percent)}% متاحة</span>
        <span class="time-pill"><i data-lucide="clock-3"></i>${escapeHtml(reportTimeLabel(report))}</span>
      </div>
      <div class="quran-score-track" aria-label="${Math.round(percent)} بالمئة من النقاط متاحة"><span style="width:${percent}%"></span></div>
      ${report.blocked_by_overdue ? '<div class="quran-blocked-note"><i data-lucide="lock-keyhole"></i>أكمل التقرير المتأخر السابق أولاً.</div>' : ''}
      ${report.extension_status === 'pending' ? '<div class="quran-extension-note"><i data-lucide="hourglass"></i>طلب التمديد قيد المراجعة.</div>' : ''}
    </div>
    ${report.status === 'pending' ? `<div class="quran-report-actions">
      <button type="button" class="quran-complete-command" data-open-complete="${escapeHtml(report.id)}" ${canComplete ? '' : 'disabled'}><i data-lucide="${canComplete ? 'send' : 'lock-keyhole'}"></i><span>${escapeHtml(completionCommandLabel(report))}</span></button>
      ${canRequest ? `<label class="quran-select-extension ${state.selectedForExtension.has(report.id) ? 'is-selected' : ''}"><input type="checkbox" data-extension-report="${escapeHtml(report.id)}" ${state.selectedForExtension.has(report.id) ? 'checked' : ''}><i data-lucide="timer-reset"></i><span>طلب تمديد</span></label>` : ''}
    </div>` : ''}
  </article>`;
}

function completionCommandLabel(report) {
  if (report.blocked_by_overdue) return 'أكمل التقرير السابق أولاً';
  if (Date.now() < new Date(report.starts_at).getTime()) return 'لم يبدأ التقرير';
  return 'تسليم التقرير';
}

function renderExtensionStatus() {
  document.getElementById('extension-selected-count').textContent = state.selectedForExtension.size;
  const statuses = state.assignments.filter(item => item.extension_status);
  const container = document.getElementById('quran-extension-status-list');
  container.innerHTML = statuses.length ? statuses.slice(0, 8).map(item => `<article>
    <i data-lucide="${extensionIcon(item.extension_status)}"></i>
    <div><b>${TYPE_META[item.task_type]?.label || item.task_type} · ${formatDate(item.report_date)}</b><small>${extensionStatusLabel(item.extension_status)}${item.extension_requested_minutes ? ` · ${formatDuration(item.extension_requested_minutes)}` : ''}</small></div>
  </article>`).join('') : '<p>لا توجد طلبات تمديد بعد.</p>';
}

async function handleReportAction(event) {
  const extensionInput = event.target.closest('[data-extension-report]');
  if (extensionInput) {
    if (extensionInput.checked) state.selectedForExtension.add(extensionInput.dataset.extensionReport);
    else state.selectedForExtension.delete(extensionInput.dataset.extensionReport);
    renderPage();
    return;
  }
  const button = event.target.closest('[data-open-complete]');
  if (!button || button.disabled || state.busy) return;
  const report = state.assignments.find(item => item.id === button.dataset.openComplete);
  if (!report) return;
  state.confirmingReportId = report.id;
  document.getElementById('quran-complete-dialog').showModal();
}

function closeCompleteDialog() {
  if (state.busy) return;
  state.confirmingReportId = null;
  document.getElementById('quran-complete-dialog').close();
}

async function submitConfirmedReport(event) {
  event.preventDefault();
  if (state.busy || !state.confirmingReportId) return;
  const report = state.assignments.find(item => item.id === state.confirmingReportId);
  if (!report) return closeCompleteDialog();
  state.busy = true;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    let result;
    if (state.preview) {
      const completedAt = new Date();
      result = {
        status: 'completed',
        completed_at: completedAt.toISOString(),
        awarded_points: livePoints(report),
        completion_band: completionBand(report.starts_at, report.effective_due_at, completedAt),
      };
    } else {
      const { data, error } = await supabase.rpc('complete_quran_report_assignment', { p_assignment_id: report.id });
      if (error) throw error;
      result = data;
    }
    Object.assign(report, result);
    state.selectedForExtension.delete(report.id);
    showToast(`تم تسجيل الإنجاز وحصلت على ${Number(result.awarded_points || 0).toFixed(2)} نقطة.`, 'success');
    document.getElementById('quran-complete-dialog').close();
    state.confirmingReportId = null;
    renderPage();
  } catch (error) {
    console.error('Completing Quran report failed:', error);
    showToast(friendlyStudentError(error, 'تعذر تسجيل إنجاز التقرير.'), 'error');
  } finally {
    state.busy = false;
    button.disabled = false;
  }
}

async function submitExtensionRequest(event) {
  event.preventDefault();
  if (state.busy) return;
  const assignmentIds = [...state.selectedForExtension];
  const minutes = Number(new FormData(event.currentTarget).get('extension-duration'));
  const reason = document.getElementById('extension-reason').value.trim();
  if (!assignmentIds.length) return showToast('حدد تقريراً واحداً على الأقل.', 'error');
  if (reason.length < 3) return showToast('اكتب سبب طلب التمديد بوضوح.', 'error');
  state.busy = true;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    if (!state.preview) {
      const { error } = await supabase.rpc('request_quran_report_extension', {
        p_assignment_ids: assignmentIds,
        p_requested_minutes: minutes,
        p_reason: reason,
      });
      if (error) throw error;
    }
    state.assignments.filter(item => assignmentIds.includes(item.id)).forEach(item => {
      item.extension_status = 'pending';
      item.extension_requested_minutes = minutes;
      item.extension_requested_at = new Date().toISOString();
    });
    state.selectedForExtension.clear();
    document.getElementById('extension-reason').value = '';
    showToast('تم إرسال طلب التمديد إلى معلم الحلقة.', 'success');
    renderPage();
  } catch (error) {
    console.error('Requesting Quran extension failed:', error);
    showToast(friendlyStudentError(error, 'تعذر إرسال طلب التمديد.'), 'error');
  } finally {
    state.busy = false;
    button.disabled = false;
  }
}

function selectDate(event) {
  const focusButton = event.target.closest('[data-plan-focus]');
  if (focusButton) {
    state.selectedDate = focusButton.dataset.planFocus;
    state.selectedForExtension.clear();
    updateSelectedDateUrl();
    loadReports();
    return;
  }
  const button = event.target.closest('[data-report-date]');
  if (!button) return;
  state.selectedDate = button.dataset.reportDate;
  state.selectedForExtension.clear();
  updateSelectedDateUrl();
  renderPage();
}

async function moveSelectedDate(days) {
  state.selectedDate = addDateKey(state.selectedDate, days);
  state.selectedForExtension.clear();
  updateSelectedDateUrl();
  if (state.preview) renderPage();
  else await loadReports();
}

function updateSelectedDateUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('date', state.selectedDate);
  window.history.replaceState({}, '', url);
}

function reportsForSelectedDate() {
  return state.assignments
    .filter(item => item.report_date === state.selectedDate)
    .sort((a, b) => typeOrder(a.task_type) - typeOrder(b.task_type));
}

function reportStatus(report) {
  if (report.status === 'completed') return { label: completionBandLabel(report.completion_band), tone: report.completion_band || 'completed', commandHint: 'تم إنجاز التقرير' };
  if (report.status === 'exempted') return { label: 'معفى', tone: 'exempted', commandHint: 'أعفاك المعلم من التقرير' };
  if (report.is_overdue) return { label: 'متأخر', tone: 'late', commandHint: 'تسجيل التقرير المتأخر' };
  if (report.blocked_by_overdue) return { label: 'موقوف مؤقتاً', tone: 'blocked', commandHint: 'أكمل التقرير المتأخر أولاً' };
  if (Date.now() < new Date(report.starts_at).getTime()) return { label: 'لم يبدأ', tone: 'upcoming', commandHint: 'لا يمكن الإنجاز قبل بداية التقرير' };
  return { label: 'متاح', tone: 'active', commandHint: 'تسجيل إنجاز التقرير' };
}

function reportTimeLabel(report) {
  if (report.status === 'completed') return `${completionBandLabel(report.completion_band)} · ${formatTime(report.completed_at)}`;
  if (report.status === 'exempted') return 'أعفاك المعلم';
  const due = new Date(report.effective_due_at).getTime();
  const minutes = Math.round((due - Date.now()) / 60000);
  if (minutes <= 0) return `متأخر ${formatDuration(Math.abs(minutes))}`;
  return `متبقي ${formatDuration(minutes)}`;
}

function livePoints(report) {
  const start = new Date(report.starts_at).getTime();
  const due = new Date(report.effective_due_at).getTime();
  const now = Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(due) || due <= start) return 0;
  if (now <= start) return Number(report.max_points || 0);
  if (now >= due) return 0;
  return Math.round((Number(report.max_points || 0) * (due - now) / (due - start)) * 100) / 100;
}

function completionBand(startsAt, dueAt, completedAt) {
  const start = new Date(startsAt).getTime();
  const due = new Date(dueAt).getTime();
  const completed = new Date(completedAt).getTime();
  if (completed > due) return 'late';
  const progress = (completed - start) / (due - start);
  if (progress <= 1 / 3) return 'early';
  if (progress <= 2 / 3) return 'middle';
  return 'late_on_time';
}

function dailyMessage(reports, completed) {
  if (!reports.length) return 'لا توجد تقارير مطلوبة في هذا اليوم.';
  if (state.overdueCount) return 'ابدأ بالتقرير المتأخر؛ بعده تُفتح لك بقية التقارير.';
  if (completed === reports.length) return 'أتممت تقارير هذا اليوم، بارك الله في جهدك.';
  if (completed) return 'بداية طيبة، واصل حتى تكتمل تقارير اليوم.';
  return 'كلما بادرت بالإنجاز حافظت على نسبة أعلى من النقاط.';
}

function buildPreviewAssignments() {
  const today = muscatDateKey();
  const yesterday = addDateKey(today, -1);
  const tomorrow = addDateKey(today, 1);
  return [
    previewAssignment('preview-overdue', yesterday, 'hifz', 'سورة الملك من الآية 1 إلى الآية 8', 4, 3),
    previewAssignment('preview-hifz', today, 'hifz', 'سورة الملك من الآية 9 إلى الآية 15', 4, 3),
    { ...previewAssignment('preview-tathbit', today, 'tathbit', 'تثبيت سورة الملك من الآية 1 إلى الآية 8', 3, 2), status: 'completed', completed_at: muscatIso(today, '05:30'), awarded_points: 2.28, completion_band: 'early' },
    previewAssignment('preview-murajaa', today, 'murajaa', 'مراجعة الصفحات 562 إلى 570', 3, 3, 'انتبه إلى مواضع التشابه.'),
    previewAssignment('preview-tomorrow', tomorrow, 'hifz', 'سورة الملك من الآية 16 إلى الآية 22', 4, 3),
  ];
}

function previewAssignment(id, date, type, content, maxPoints, repetitions, notes = null) {
  return {
    id,
    report_id: `report-${id}`,
    circle_id: 'preview-circle',
    circle_name: 'حلقة الإتقان',
    report_date: date,
    task_type: type,
    content,
    repetitions,
    notes,
    starts_at: muscatIso(date, '00:00'),
    original_due_at: muscatIso(date, '23:00'),
    effective_due_at: muscatIso(date, '23:00'),
    max_points: maxPoints,
    status: 'pending',
    completed_at: null,
    awarded_points: null,
  };
}

function extensionIcon(status) {
  if (status === 'approved' || status === 'partially_approved') return 'badge-check';
  if (status === 'rejected') return 'circle-x';
  return 'hourglass';
}

function extensionStatusLabel(status) {
  if (status === 'approved') return 'مقبول';
  if (status === 'partially_approved') return 'مقبول جزئياً';
  if (status === 'rejected') return 'مرفوض';
  return 'قيد المراجعة';
}

function completionBandLabel(band) {
  if (band === 'early') return 'منجز مبكراً';
  if (band === 'middle') return 'منجز في الوقت';
  if (band === 'late_on_time') return 'منجز قرب النهاية';
  if (band === 'late') return 'منجز متأخراً';
  return 'مكتمل';
}

function friendlyStudentError(error, fallback) {
  const message = String(error?.message || '');
  if (/has not started/i.test(message)) return 'لا يمكن إنهاء التقرير قبل بداية وقته.';
  if (/overdue Quran reports/i.test(message)) return 'أكمل التقرير المتأخر السابق أولاً.';
  if (/pending extension request/i.test(message)) return 'يوجد طلب تمديد قيد المراجعة لهذا التقرير.';
  if (/not belong|Only active students|permission|42501/i.test(message)) return 'لا تملك صلاحية تنفيذ هذه العملية.';
  return fallback;
}

function typeOrder(type) {
  return type === 'hifz' ? 1 : type === 'tathbit' ? 2 : 3;
}

function formatDuration(minutes) {
  const value = Math.max(0, Math.round(Number(minutes || 0)));
  if (value < 60) return `${value} دقيقة`;
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  return remainder ? `${hours} س ${remainder} د` : `${hours} ساعة`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ar-OM', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Muscat' })
    .format(new Date(`${value}T12:00:00+04:00`));
}

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ar-OM', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Muscat' }).format(new Date(value));
}

function muscatDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Muscat' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function muscatIso(date, time) {
  return new Date(`${date}T${time}:00+04:00`).toISOString();
}

function parseDateKey(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

function toDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function addDateKey(value, days) {
  return toDateKey(addDays(parseDateKey(value), days));
}

function isDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseDateKey(value).getTime());
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}
