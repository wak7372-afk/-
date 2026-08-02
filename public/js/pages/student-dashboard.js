import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { showToast, escapeHtml } from '../lib/utils.js';

const arabicDays = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const state = {
  profile: null,
  preview: false,
  weekStart: startOfWeek(new Date()),
  selectedDate: toDateKey(new Date()),
  period: 'all',
  tasks: [],
  notifications: [],
  notificationChannel: null,
};

document.addEventListener('DOMContentLoaded', initializeStudentDashboard);

async function initializeStudentDashboard() {
  const authData = await requireAuth(['student']);
  if (!authData) return;
  state.profile = authData.profile;
  state.preview = Boolean(authData.preview);

  document.getElementById('student-name').textContent = state.profile.username || state.profile.full_name || 'طالبنا';
  document.getElementById('logout-btn').addEventListener('click', logoutUser);
  document.getElementById('previous-week').addEventListener('click', () => moveWeek(-7));
  document.getElementById('next-week').addEventListener('click', () => moveWeek(7));
  document.getElementById('week-days').addEventListener('click', selectDay);
  document.querySelector('.period-tabs').addEventListener('click', selectPeriod);
  document.getElementById('student-task-list').addEventListener('click', handleTaskAction);
  document.getElementById('mobile-week').addEventListener('click', () => document.querySelector('.week-panel').scrollIntoView({ behavior: 'smooth' }));
  document.getElementById('notifications-toggle').addEventListener('click', toggleNotifications);
  document.getElementById('read-all-notifications').addEventListener('click', markAllNotificationsRead);
  document.getElementById('notification-list').addEventListener('click', markNotificationRead);
  document.addEventListener('click', closeNotificationsOnOutsideClick);
  setupFamilyLink();

  renderWeek();
  await Promise.all([loadTaskFeed(), loadJoinedClassrooms(), loadNotifications()]);
  subscribeToNotifications();
  refreshIcons();
}

async function loadNotifications() {
  if (state.preview) {
    state.notifications = [
      { id: 'preview-n1', title: 'مهمة جديدة', body: 'أضيفت مهمة الحفظ الجديد إلى جدولك.', type: 'quran_task_created', is_read: false, created_at: new Date().toISOString() },
      { id: 'preview-n2', title: 'تم تقييم الواجب', body: 'تم تحديث نتيجة واجب التجويد التطبيقي.', type: 'assignment_graded', is_read: true, created_at: addDays(new Date(), -1).toISOString() },
    ];
    renderNotifications();
    return;
  }
  const { data, error } = await supabase
    .from('notifications')
    .select('id, title, body, type, is_read, created_at')
    .eq('user_id', state.profile.id)
    .order('created_at', { ascending: false })
    .limit(12);
  if (error) {
    console.error(error);
    return;
  }
  state.notifications = data || [];
  renderNotifications();
}

function subscribeToNotifications() {
  if (state.preview) return;
  state.notificationChannel = supabase
    .channel(`student-notifications-${state.profile.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${state.profile.id}` }, payload => {
      state.notifications.unshift(payload.new);
      state.notifications = state.notifications.slice(0, 12);
      renderNotifications();
      showToast(payload.new.title || 'لديك إشعار جديد.', 'info');
    })
    .subscribe();
  window.addEventListener('beforeunload', () => {
    if (state.notificationChannel) supabase.removeChannel(state.notificationChannel);
  }, { once: true });
}

function toggleNotifications(event) {
  event.stopPropagation();
  const popover = document.getElementById('notification-popover');
  popover.hidden = !popover.hidden;
  document.getElementById('notifications-toggle').setAttribute('aria-expanded', String(!popover.hidden));
}

function closeNotificationsOnOutsideClick(event) {
  const popover = document.getElementById('notification-popover');
  if (popover.hidden || popover.contains(event.target)) return;
  popover.hidden = true;
  document.getElementById('notifications-toggle').setAttribute('aria-expanded', 'false');
}

async function markAllNotificationsRead(event) {
  event.stopPropagation();
  const unreadIds = state.notifications.filter(item => !item.is_read).map(item => item.id);
  if (!unreadIds.length) return;
  if (!state.preview) {
    const { error } = await supabase.from('notifications').update({ is_read: true }).in('id', unreadIds);
    if (error) {
      showToast('تعذر تحديث الإشعارات.', 'error');
      return;
    }
  }
  state.notifications.forEach(item => { item.is_read = true; });
  renderNotifications();
}

async function markNotificationRead(event) {
  const button = event.target.closest('[data-notification-id]');
  if (!button) return;
  const notification = state.notifications.find(item => item.id === button.dataset.notificationId);
  if (!notification || notification.is_read) return;
  if (!state.preview) {
    const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', notification.id);
    if (error) return;
  }
  notification.is_read = true;
  renderNotifications();
}

function renderNotifications() {
  const unread = state.notifications.filter(item => !item.is_read).length;
  const badge = document.getElementById('notification-count');
  badge.textContent = unread > 9 ? '9+' : String(unread);
  badge.hidden = unread === 0;
  const list = document.getElementById('notification-list');
  list.innerHTML = state.notifications.length ? state.notifications.map(item => `
    <button type="button" data-notification-id="${escapeHtml(item.id)}" class="notification-item ${item.is_read ? '' : 'unread'}">
      <span class="notification-icon"><i data-lucide="${notificationIcon(item.type)}"></i></span>
      <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.body || '')}</small><time>${escapeHtml(relativeTime(item.created_at))}</time></span>
    </button>`).join('') : '<p class="notification-empty">لا توجد إشعارات جديدة.</p>';
  refreshIcons();
}

function notificationIcon(type) {
  if (type === 'assignment_graded') return 'badge-check';
  if (type === 'assignment_created') return 'notebook-tabs';
  return 'calendar-plus-2';
}

function relativeTime(value) {
  const date = new Date(value);
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'الآن';
  if (minutes < 60) return `منذ ${minutes} د`;
  if (minutes < 1440) return `منذ ${Math.floor(minutes / 60)} س`;
  return new Intl.DateTimeFormat('ar-OM', { day: 'numeric', month: 'short' }).format(date);
}

function setupFamilyLink() {
  const familyCode = state.profile.family_link_code || '';
  document.getElementById('family-link-code').textContent = familyCode || 'غير متاح';
  document.getElementById('copy-family-code').addEventListener('click', async () => {
    if (!familyCode) {
      showToast('رمز الربط غير متاح. تواصل مع إدارة المركز.', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(familyCode);
      showToast('تم نسخ رمز الربط.', 'success');
    } catch (_) {
      showToast(`رمز الربط: ${familyCode}`, 'info');
    }
  });
}

async function moveWeek(days) {
  state.weekStart = addDays(state.weekStart, days);
  state.selectedDate = toDateKey(state.weekStart);
  renderWeek();
  await loadTaskFeed();
}

function selectDay(event) {
  const button = event.target.closest('[data-date]');
  if (!button) return;
  state.selectedDate = button.dataset.date;
  renderWeek();
  renderDashboard();
}

function selectPeriod(event) {
  const button = event.target.closest('[data-period]');
  if (!button) return;
  state.period = button.dataset.period;
  document.querySelectorAll('.period-tabs button').forEach(tab => {
    const active = tab === button;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  renderTasks();
}

async function loadTaskFeed() {
  const list = document.getElementById('student-task-list');
  list.innerHTML = '<div class="student-loading"><span></span><p>جاري ترتيب مهامك...</p></div>';
  const weekEnd = addDays(state.weekStart, 6);
  if (state.preview) {
    state.tasks = buildPreviewTasks();
    renderDashboard();
    return;
  }

  const { data, error } = await supabase.rpc('get_student_task_feed', {
    p_start_date: toDateKey(state.weekStart),
    p_end_date: toDateKey(weekEnd),
  });
  if (error) {
    console.error(error);
    state.tasks = [];
    list.innerHTML = '<div class="task-empty is-error"><i data-lucide="cloud-off"></i><h3>تعذر تحميل المهام</h3><p>حدّث الصفحة أو تواصل مع إدارة المركز.</p></div>';
    refreshIcons();
    return;
  }
  state.tasks = Array.isArray(data) ? data : [];
  renderDashboard();
}

function renderDashboard() {
  renderWeek();
  renderMetrics();
  renderTasks();
}

function renderWeek() {
  const todayKey = toDateKey(new Date());
  const weekEnd = addDays(state.weekStart, 6);
  document.getElementById('week-title').textContent = isDateInRange(new Date(), state.weekStart, weekEnd) ? 'هذا الأسبوع' : 'أسبوع المهام';
  document.getElementById('week-range').textContent = `${formatShortDate(state.weekStart)} - ${formatShortDate(weekEnd)}`;
  document.getElementById('week-days').innerHTML = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(state.weekStart, index);
    const key = toDateKey(date);
    const taskCount = state.tasks.filter(task => task.task_date === key).length;
    return `
      <button type="button" data-date="${key}" class="week-day ${key === state.selectedDate ? 'active' : ''} ${key === todayKey ? 'today' : ''}" aria-pressed="${key === state.selectedDate}">
        <span>${escapeHtml(arabicDays[date.getDay()])}</span>
        <strong>${date.getDate()}</strong>
        <small>${taskCount ? `${taskCount} مهام` : 'متاح'}</small>
      </button>
    `;
  }).join('');
  const selected = parseDateKey(state.selectedDate);
  document.getElementById('selected-day-label').textContent = state.selectedDate === todayKey
    ? 'مهام اليوم'
    : `${arabicDays[selected.getDay()]}، ${formatShortDate(selected)}`;
  refreshIcons();
}

function renderMetrics() {
  const selectedTasks = tasksForSelectedDay();
  const completed = selectedTasks.filter(task => task.status === 'done').length;
  const overdue = selectedTasks.filter(task => task.status === 'overdue').length;
  const progress = selectedTasks.length ? Math.round((completed / selectedTasks.length) * 100) : 0;
  const minutes = selectedTasks.filter(task => task.status !== 'done').reduce((sum, task) => sum + Number(task.estimated_minutes || 0), 0);
  const points = state.tasks.reduce((sum, task) => sum + Number(task.points || 0), 0);

  document.getElementById('metric-progress').textContent = `${progress}%`;
  document.getElementById('metric-points').textContent = String(points);
  document.getElementById('metric-minutes').textContent = `${minutes} د`;
  document.getElementById('metric-overdue').textContent = String(overdue);
  document.getElementById('hero-progress').textContent = `${progress}%`;
  document.getElementById('hero-done-count').textContent = `${completed} من ${selectedTasks.length}`;
  document.getElementById('progress-ring').style.setProperty('--progress', progress);
  document.getElementById('daily-message').textContent = dailyMessage(selectedTasks.length, completed, overdue);

  const morning = selectedTasks.filter(task => task.period === 'morning').length;
  const evening = selectedTasks.filter(task => task.period === 'evening').length;
  document.getElementById('all-count').textContent = String(selectedTasks.length);
  document.getElementById('morning-count').textContent = String(morning);
  document.getElementById('evening-count').textContent = String(evening);
}

function renderTasks() {
  const container = document.getElementById('student-task-list');
  const tasks = tasksForSelectedDay().filter(task => state.period === 'all' || task.period === state.period || task.period === 'flexible');
  if (!tasks.length) {
    container.innerHTML = `
      <div class="task-empty">
        <i data-lucide="calendar-check-2"></i>
        <h3>لا توجد مهام في هذه الفترة</h3>
        <p>يمكنك مراجعة ما سبق أو الاستعداد للمهمة التالية.</p>
      </div>`;
    refreshIcons();
    return;
  }

  container.innerHTML = tasks.map(task => {
    const done = task.status === 'done';
    const overdue = task.status === 'overdue';
    const classroom = task.source === 'classroom';
    const statusLabel = done ? 'مكتملة' : overdue ? 'متأخرة' : 'قيد الإنجاز';
    return `
      <article class="student-task ${done ? 'is-done' : ''} ${overdue ? 'is-overdue' : ''}">
        <div class="task-state-icon"><i data-lucide="${done ? 'circle-check-big' : classroom ? 'book-open-check' : task.category === 'murajaa' ? 'refresh-cw' : 'book-heart'}"></i></div>
        <div class="task-body">
          <div class="task-meta-row">
            <span class="task-category ${classroom ? 'classroom' : task.category}">${escapeHtml(taskCategory(task))}</span>
            <span class="task-status">${escapeHtml(statusLabel)}</span>
          </div>
          <h3>${escapeHtml(task.title || task.content)}</h3>
          <p class="task-content">${escapeHtml(task.content || '')}</p>
          <div class="task-context"><i data-lucide="${classroom ? 'school' : 'users-round'}"></i><span>${escapeHtml(task.context_name || (classroom ? 'الفصل الافتراضي' : 'الحلقة'))}</span></div>
          ${task.teacher_notes ? `<div class="teacher-note"><i data-lucide="message-circle-more"></i><span>${escapeHtml(task.teacher_notes)}</span></div>` : ''}
          <div class="task-facts">
            <span><i data-lucide="clock-3"></i>${escapeHtml(dueLabel(task))}</span>
            <span><i data-lucide="timer"></i>${Number(task.estimated_minutes || 0)} دقيقة</span>
            ${task.priority === 3 ? '<span class="important"><i data-lucide="flag"></i>أولوية عالية</span>' : ''}
          </div>
        </div>
        <div class="task-command">
          ${done
            ? '<span class="done-mark"><i data-lucide="check"></i> تم الإنجاز</span>'
            : classroom
              ? `<a href="./classroom.html?id=${encodeURIComponent(task.classroom_id || '')}">فتح المهمة <i data-lucide="arrow-left"></i></a>`
              : `<button type="button" data-complete="${escapeHtml(task.submission_id)}">تسجيل الإتمام <i data-lucide="check"></i></button>`}
        </div>
      </article>`;
  }).join('');
  refreshIcons();
}

async function handleTaskAction(event) {
  const button = event.target.closest('[data-complete]');
  if (!button) return;
  const submissionId = button.dataset.complete;
  if (!submissionId) return;
  button.disabled = true;
  try {
    if (!state.preview) {
      const { error } = await supabase
        .from('assignment_submissions')
        .update({ status: 'done', submitted_at: new Date().toISOString() })
        .eq('id', submissionId);
      if (error) throw error;
    }
    const task = state.tasks.find(item => item.submission_id === submissionId);
    if (task) {
      task.status = 'done';
      task.points = 10;
    }
    showToast('أحسنت، تم تسجيل إنجاز المهمة.', 'success');
    renderDashboard();
  } catch (error) {
    console.error(error);
    button.disabled = false;
    showToast('تعذر تسجيل الإتمام. حاول مرة أخرى.', 'error');
  }
}

async function loadJoinedClassrooms() {
  const container = document.getElementById('joined-classrooms-list');
  if (state.preview) {
    container.innerHTML = classroomCard({ id: 'preview', name: 'التجويد التطبيقي', subject: { name: 'التجويد' }, teacher: { full_name: 'المعلم حمزة' } });
    refreshIcons();
    return;
  }
  const { data: rels, error } = await supabase
    .from('classroom_students')
    .select('classroom:classroom_id(*, subject:subject_id(name), teacher:teacher_id(full_name))')
    .eq('student_id', state.profile.id);
  if (error || !rels?.length) {
    container.innerHTML = '<p class="side-empty">لا توجد فصول مرتبطة حالياً.</p>';
    return;
  }
  container.innerHTML = rels.map(item => item.classroom ? classroomCard(item.classroom) : '').join('');
  refreshIcons();
}

function classroomCard(classroom) {
  return `
    <a class="classroom-row" href="./classroom.html?id=${encodeURIComponent(classroom.id)}">
      <span class="classroom-icon"><i data-lucide="book-open-text"></i></span>
      <span><strong>${escapeHtml(classroom.name)}</strong><small>${escapeHtml(classroom.subject?.name || 'مادة تعليمية')} · ${escapeHtml(classroom.teacher?.full_name || '')}</small></span>
      <i data-lucide="chevron-left"></i>
    </a>`;
}

function tasksForSelectedDay() {
  return state.tasks.filter(task => task.task_date === state.selectedDate);
}

function taskCategory(task) {
  if (task.source === 'classroom') return 'واجب فصل';
  return task.category === 'murajaa' ? 'مراجعة' : 'حفظ';
}

function dueLabel(task) {
  if (task.status === 'done') return 'أُنجزت المهمة';
  if (!task.due_at) return task.period === 'morning' ? 'الفترة الصباحية' : task.period === 'evening' ? 'الفترة المسائية' : 'خلال اليوم';
  const due = new Date(task.due_at);
  if (Number.isNaN(due.getTime())) return 'خلال اليوم';
  if (task.status === 'overdue') return `تجاوز الموعد ${formatTime(due)}`;
  const minutes = Math.round((due.getTime() - Date.now()) / 60000);
  if (task.task_date === toDateKey(new Date()) && minutes > 0) {
    if (minutes < 60) return `متبقي ${minutes} دقيقة`;
    return `متبقي ${Math.floor(minutes / 60)} س ${minutes % 60} د`;
  }
  return `التسليم ${formatTime(due)}`;
}

function dailyMessage(total, completed, overdue) {
  if (!total) return 'يوم هادئ للمراجعة والتثبيت.';
  if (completed === total) return 'أتممت مهام هذا اليوم، بارك الله في جهدك.';
  if (overdue) return 'ابدأ بالمهمة المتأخرة ثم واصل بقية جدولك.';
  if (completed) return 'بداية طيبة، واصل حتى تكتمل مهام اليوم.';
  return 'ابدأ بالمهمة الأولى، فالاستمرار يصنع التقدم.';
}

function buildPreviewTasks() {
  const today = toDateKey(new Date());
  const tomorrow = toDateKey(addDays(new Date(), 1));
  return [
    { source: 'quran', task_id: 'q1', submission_id: 'preview-q1', title: 'الحفظ الجديد', content: 'سورة الملك من الآية 1 إلى الآية 8', category: 'hifz', task_date: today, period: 'morning', due_at: localIso(today, '11:30'), estimated_minutes: 35, priority: 3, status: 'pending', points: 0, context_name: 'حلقة الإتقان' },
    { source: 'quran', task_id: 'q2', submission_id: 'preview-q2', title: 'مراجعة المحفوظ', content: 'سورة القلم كاملة مع ضبط مواضع التشابه', category: 'murajaa', task_date: today, period: 'evening', due_at: localIso(today, '19:00'), estimated_minutes: 25, priority: 2, status: 'pending', points: 0, context_name: 'حلقة الإتقان', teacher_notes: 'ركّز على الآيات من 17 إلى 24.' },
    { source: 'classroom', task_id: 'c1', submission_id: 'preview-c1', title: 'تطبيق أحكام النون الساكنة', content: 'استخرج خمسة أمثلة من سورة الملك وحدد الحكم.', category: 'classroom', task_date: today, period: 'flexible', due_at: localIso(today, '20:00'), estimated_minutes: 20, priority: 2, status: 'done', points: 15, classroom_id: 'preview', context_name: 'التجويد التطبيقي' },
    { source: 'quran', task_id: 'q3', submission_id: 'preview-q3', title: 'تثبيت الحفظ', content: 'تسميع سورة الملك من الآية 1 إلى الآية 15', category: 'hifz', task_date: tomorrow, period: 'morning', due_at: localIso(tomorrow, '11:30'), estimated_minutes: 40, priority: 2, status: 'pending', points: 0, context_name: 'حلقة الإتقان' },
  ];
}

function startOfWeek(date) {
  const value = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const distanceFromSaturday = (value.getDay() + 1) % 7;
  value.setDate(value.getDate() - distanceFromSaturday);
  return value;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateKey(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function localIso(date, time) {
  return new Date(`${date}T${time}:00`).toISOString();
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat('ar-OM', { day: 'numeric', month: 'short' }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat('ar-OM', { hour: 'numeric', minute: '2-digit' }).format(date);
}

function isDateInRange(date, start, end) {
  const key = toDateKey(date);
  return key >= toDateKey(start) && key <= toDateKey(end);
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}
