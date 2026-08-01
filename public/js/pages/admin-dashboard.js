import { supabase } from '../lib/supabase-client.js';
import { isLocalPreviewMode, requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast } from '../lib/utils.js';

const PREVIEW_ACCOUNTS_KEY = 'zat_khail_preview_accounts';
const ADMIN_ACTIVITY_KEY = 'zat_khail_admin_activity';
const PRIMARY_ADMIN_USERNAME = 'warith';
const ROLE_LABELS = {
  admin: 'مدير',
  teacher: 'معلم',
  student: 'طالب',
  parent: 'ولي أمر',
};

const state = {
  profile: null,
  accounts: [],
  selectedAccountIds: new Set(),
  academic: {
    halaqat: 0,
    classrooms: 0,
    pendingWork: 0,
    absentToday: 0,
  },
  auditActivities: [],
};

document.addEventListener('DOMContentLoaded', initializeAdminDashboard);

async function initializeAdminDashboard() {
  const authData = await requireAuth(['admin']);
  if (!authData) return;

  state.profile = authData.profile;
  await initI18n();
  setupProfile();
  setupDate();
  setupNavigation();
  setupDialogs();
  setupAccountControls();
  setupMobileSidebar();

  document.getElementById('logout-btn').addEventListener('click', logoutUser);
  document.getElementById('preview-notice').hidden = !isLocalPreviewMode();

  await refreshDashboardData();

  const requestedView = window.location.hash.replace('#', '');
  switchView(requestedView === 'accounts' ? 'accounts' : 'overview', false);
}

function setupProfile() {
  const fullName = state.profile.full_name || 'مدير النظام';
  const username = state.profile.username || PRIMARY_ADMIN_USERNAME;
  document.getElementById('admin-name').textContent = fullName;
  document.getElementById('sidebar-admin-name').textContent = fullName;
  document.getElementById('sidebar-admin-username').textContent = `@${username}`;
}

function setupDate() {
  const now = new Date();
  document.getElementById('current-day').textContent = new Intl.DateTimeFormat('ar-OM', {
    weekday: 'long',
  }).format(now);
  document.getElementById('current-date').textContent = new Intl.DateTimeFormat('ar-OM', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
}

function setupNavigation() {
  document.querySelectorAll('[data-admin-view], [data-go-view]').forEach(control => {
    control.addEventListener('click', () => {
      switchView(control.dataset.adminView || control.dataset.goView);
    });
  });

  document.getElementById('quick-create-account').addEventListener('click', openCreateAccountDialog);
  document.getElementById('open-create-account').addEventListener('click', openCreateAccountDialog);

  document.getElementById('global-search-form').addEventListener('submit', event => {
    event.preventDefault();
    const value = document.getElementById('global-search').value.trim();
    document.getElementById('account-search').value = value;
    switchView('accounts');
    renderAccountsTable();
  });

  document.getElementById('top-alerts-button').addEventListener('click', () => {
    switchView('overview');
    document.getElementById('attention-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function switchView(viewName, updateHash = true) {
  const safeView = viewName === 'accounts' ? 'accounts' : 'overview';
  document.querySelectorAll('[data-view-panel]').forEach(panel => {
    const active = panel.dataset.viewPanel === safeView;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  });

  document.querySelectorAll('[data-admin-view]').forEach(button => {
    const active = button.dataset.adminView === safeView;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });

  document.getElementById('view-title').textContent = safeView === 'accounts'
    ? 'الحسابات والصلاحيات'
    : 'الرئيسية';

  if (updateHash) history.replaceState(null, '', safeView === 'overview' ? '#overview' : '#accounts');
  closeMobileSidebar();
}

function setupDialogs() {
  document.querySelectorAll('[data-close-dialog]').forEach(button => {
    button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close());
  });

  document.querySelectorAll('.admin-dialog').forEach(dialog => {
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
  });

  document.getElementById('create-account-form').addEventListener('submit', handleCreateAccount);
  document.getElementById('edit-account-form').addEventListener('submit', handleEditAccount);
}

function setupAccountControls() {
  ['account-search', 'role-filter', 'status-filter'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderAccountsTable);
    document.getElementById(id).addEventListener('change', renderAccountsTable);
  });

  document.getElementById('clear-account-filters').addEventListener('click', () => {
    document.getElementById('account-search').value = '';
    document.getElementById('role-filter').value = 'all';
    document.getElementById('status-filter').value = 'all';
    renderAccountsTable();
  });

  document.getElementById('accounts-table-body').addEventListener('click', handleAccountTableClick);
  document.getElementById('accounts-table-body').addEventListener('change', handleAccountSelectionChange);

  document.getElementById('select-all-accounts').addEventListener('change', event => {
    const visibleAccounts = getFilteredAccounts().filter(account => !isProtectedAccount(account));
    visibleAccounts.forEach(account => {
      if (event.target.checked) state.selectedAccountIds.add(account.id);
      else state.selectedAccountIds.delete(account.id);
    });
    renderAccountsTable();
  });

  document.getElementById('clear-selection').addEventListener('click', clearAccountSelection);
  document.querySelectorAll('[data-bulk-status]').forEach(button => {
    button.addEventListener('click', () => updateSelectedAccountStatus(button.dataset.bulkStatus === 'true'));
  });
}

function setupMobileSidebar() {
  const sidebar = document.getElementById('admin-sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  document.getElementById('open-sidebar').addEventListener('click', () => {
    sidebar.classList.add('is-open');
    overlay.hidden = false;
  });
  document.getElementById('close-sidebar').addEventListener('click', closeMobileSidebar);
  overlay.addEventListener('click', closeMobileSidebar);
}

function closeMobileSidebar() {
  document.getElementById('admin-sidebar').classList.remove('is-open');
  document.getElementById('sidebar-overlay').hidden = true;
}

function openCreateAccountDialog() {
  const form = document.getElementById('create-account-form');
  form.reset();
  document.getElementById('account-active').checked = true;
  document.getElementById('create-account-dialog').showModal();
  requestAnimationFrame(() => document.getElementById('account-name').focus());
}

async function refreshDashboardData() {
  await Promise.all([loadAccounts(), loadAcademicMetrics(), loadAuditActivities()]);
  renderDashboard();
  renderAccountsTable();
}

async function loadAuditActivities() {
  if (isLocalPreviewMode()) {
    state.auditActivities = getAdminActivities();
    return;
  }

  const { data, error } = await supabase
    .from('admin_audit_logs')
    .select('id, action, metadata, created_at, actor_id')
    .order('created_at', { ascending: false })
    .limit(12);
  if (error) {
    console.error('Unable to load audit logs:', error);
    state.auditActivities = [];
    return;
  }
  state.auditActivities = data || [];
}

async function loadAccounts() {
  if (isLocalPreviewMode()) {
    const previewAccounts = getPreviewAccounts();
    state.accounts = [getPreviewAdminAccount(), ...previewAccounts];
    return;
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, username, phone, role, is_active, must_change_password, created_at, updated_at')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Unable to load accounts:', error);
    showToast('تعذر تحميل حسابات المركز.', 'error');
    state.accounts = [];
    return;
  }
  state.accounts = (data || []).map(normalizeAccount);
}

async function loadAcademicMetrics() {
  if (isLocalPreviewMode()) {
    state.academic = { halaqat: 0, classrooms: 0, pendingWork: 0, absentToday: 0 };
    return;
  }

  const today = getLocalDateValue(new Date());
  const results = await Promise.all([
    supabase.from('halaqat').select('*', { count: 'exact', head: true }),
    supabase.from('classrooms').select('*', { count: 'exact', head: true }),
    supabase.from('assignment_submissions').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('attendance').select('*', { count: 'exact', head: true }).eq('attendance_date', today).eq('status', 'absent'),
  ]);

  state.academic = {
    halaqat: results[0].count || 0,
    classrooms: results[1].count || 0,
    pendingWork: results[2].count || 0,
    absentToday: results[3].count || 0,
  };
}

function getPreviewAdminAccount() {
  return normalizeAccount({
    id: 'preview-primary-admin',
    full_name: state.profile.full_name || 'مدير النظام',
    username: state.profile.username || PRIMARY_ADMIN_USERNAME,
    phone: '',
    role: 'admin',
    is_active: true,
    must_change_password: false,
    created_at: new Date(2026, 0, 1).toISOString(),
    protected: true,
  });
}

function getPreviewAccounts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREVIEW_ACCOUNTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.map(normalizeAccount) : [];
  } catch {
    return [];
  }
}

function savePreviewAccounts() {
  const accounts = state.accounts.filter(account => !isProtectedAccount(account));
  localStorage.setItem(PREVIEW_ACCOUNTS_KEY, JSON.stringify(accounts));
}

function normalizeAccount(account) {
  return {
    id: String(account.id || crypto.randomUUID()),
    full_name: String(account.full_name || 'بدون اسم'),
    username: String(account.username || '').toLowerCase(),
    phone: String(account.phone || ''),
    role: ROLE_LABELS[account.role] ? account.role : 'student',
    is_active: account.is_active !== false,
    must_change_password: account.must_change_password === true,
    created_at: account.created_at || new Date().toISOString(),
    updated_at: account.updated_at || account.created_at || new Date().toISOString(),
    protected: account.protected === true,
  };
}

function isProtectedAccount(account) {
  return account.protected === true || (account.role === 'admin' && account.username === PRIMARY_ADMIN_USERNAME);
}

function renderDashboard() {
  const teachers = state.accounts.filter(account => account.role === 'teacher').length;
  const students = state.accounts.filter(account => account.role === 'student').length;
  const inactive = state.accounts.filter(account => !account.is_active).length;

  setText('stat-accounts', state.accounts.length);
  setText('stat-teachers', teachers);
  setText('stat-students', students);
  setText('stat-inactive', inactive);
  setText('stat-halaqat', state.academic.halaqat);
  setText('stat-classrooms', state.academic.classrooms);
  setText('stat-pending-work', state.academic.pendingWork);
  setText('stat-absent-today', state.academic.absentToday);
  setText('nav-accounts-count', state.accounts.length);
  setText('data-last-updated', `آخر تحديث ${formatTime(new Date())}`);

  const alerts = buildAdministrativeAlerts();
  setText('attention-count', alerts.length);
  setText('top-alerts-count', alerts.length);
  renderAttentionList(alerts);
  renderRecentAccounts();
  renderActivityList();
}

function buildAdministrativeAlerts() {
  const alerts = [];
  const inactiveAccounts = state.accounts.filter(account => !account.is_active).length;
  const passwordChanges = state.accounts.filter(account => account.must_change_password && account.is_active).length;
  const students = state.accounts.filter(account => account.role === 'student').length;
  const teachers = state.accounts.filter(account => account.role === 'teacher' && account.is_active).length;

  if (inactiveAccounts) alerts.push({
    title: `${inactiveAccounts} حساب غير نشط`,
    body: 'راجع الحسابات الموقوفة وفعّل من اكتملت بياناته.',
  });
  if (passwordChanges) alerts.push({
    title: `${passwordChanges} حساب يحتاج تغيير كلمة المرور`,
    body: 'هذه الحسابات ما زالت تستخدم كلمة المرور المؤقتة.',
  });
  if (students > 0 && teachers === 0) alerts.push({
    title: 'يوجد طلاب دون معلمين نشطين',
    body: 'أنشئ حساب معلم أو فعّل معلماً قبل توزيع الطلاب على الحلقات.',
  });
  if (state.academic.pendingWork) alerts.push({
    title: `${state.academic.pendingWork} مقرر بانتظار الإنجاز`,
    body: 'تابع المقررات المتأخرة مع المعلمين والطلاب.',
  });
  if (state.academic.absentToday) alerts.push({
    title: `${state.academic.absentToday} حالة غياب اليوم`,
    body: 'راجع سجل الحضور وحدد الحالات التي تحتاج متابعة.',
  });
  return alerts;
}

function renderAttentionList(alerts) {
  const container = document.getElementById('attention-list');
  if (!alerts.length) {
    container.innerHTML = '<div class="admin-attention-empty">لا توجد تنبيهات إدارية حالياً.</div>';
    return;
  }
  container.innerHTML = alerts.map(alert => `
    <div class="admin-attention-item">
      <span class="admin-attention-mark" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(alert.title)}</strong>
        <p>${escapeHtml(alert.body)}</p>
      </div>
    </div>
  `).join('');
}

function renderRecentAccounts() {
  const container = document.getElementById('recent-accounts-list');
  const recent = [...state.accounts]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5);
  if (!recent.length) {
    container.innerHTML = '<div class="admin-list-empty">لا توجد حسابات مضافة بعد.</div>';
    return;
  }
  container.innerHTML = recent.map(account => `
    <div class="admin-recent-account">
      <span class="admin-account-initial" aria-hidden="true">${escapeHtml(getInitial(account.full_name))}</span>
      <div>
        <strong>${escapeHtml(account.full_name)}</strong>
        <span>${escapeHtml(ROLE_LABELS[account.role])} · @${escapeHtml(account.username)}</span>
      </div>
      <time datetime="${escapeHtml(account.created_at)}">${escapeHtml(formatShortDate(account.created_at))}</time>
    </div>
  `).join('');
}

function renderActivityList() {
  const container = document.getElementById('activity-list');
  const activities = state.auditActivities.slice(0, 6);
  if (!activities.length) {
    container.innerHTML = '<div class="admin-list-empty">ستظهر هنا عمليات إنشاء الحسابات وتعديلها.</div>';
    return;
  }
  container.innerHTML = activities.map((activity, index) => `
    <div class="admin-activity-item">
      <span class="admin-activity-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
      <div>
        <strong>${escapeHtml(activity.message)}</strong>
        <span>بواسطة ${escapeHtml(state.profile.full_name || 'المدير')}</span>
      </div>
      <time datetime="${escapeHtml(activity.created_at)}">${escapeHtml(formatRelativeTime(activity.created_at))}</time>
    </div>
  `).join('');
}

function getFilteredAccounts() {
  const search = document.getElementById('account-search').value.trim().toLowerCase();
  const role = document.getElementById('role-filter').value;
  const status = document.getElementById('status-filter').value;

  return state.accounts.filter(account => {
    const matchesSearch = !search
      || account.full_name.toLowerCase().includes(search)
      || account.username.toLowerCase().includes(search)
      || account.phone.includes(search);
    const matchesRole = role === 'all' || account.role === role;
    const matchesStatus = status === 'all'
      || (status === 'active' ? account.is_active : !account.is_active);
    return matchesSearch && matchesRole && matchesStatus;
  });
}

function renderAccountsTable() {
  const accounts = getFilteredAccounts();
  const body = document.getElementById('accounts-table-body');
  const emptyState = document.getElementById('accounts-empty-state');
  const tableWrap = document.querySelector('.admin-table-wrap');

  setText('filtered-accounts-count', accounts.length);
  emptyState.hidden = accounts.length > 0;
  tableWrap.hidden = accounts.length === 0;

  body.innerHTML = accounts.map(account => {
    const protectedAccount = isProtectedAccount(account);
    const checked = state.selectedAccountIds.has(account.id);
    return `
      <tr data-account-row="${escapeHtml(account.id)}">
        <td class="admin-checkbox-cell">
          <input type="checkbox" data-select-account="${escapeHtml(account.id)}" aria-label="تحديد حساب ${escapeHtml(account.full_name)}" ${checked ? 'checked' : ''} ${protectedAccount ? 'disabled' : ''}>
        </td>
        <td>
          <div class="admin-user-cell">
            <span class="admin-account-initial" aria-hidden="true">${escapeHtml(getInitial(account.full_name))}</span>
            <div>
              <strong>${escapeHtml(account.full_name)}</strong>
              <small>${escapeHtml(account.phone || 'لا يوجد رقم هاتف')}</small>
            </div>
          </div>
        </td>
        <td dir="ltr">@${escapeHtml(account.username || '—')}</td>
        <td><span class="admin-role-badge admin-role-${escapeHtml(account.role)}">${escapeHtml(ROLE_LABELS[account.role])}</span></td>
        <td><span class="admin-account-status ${account.is_active ? 'is-active' : 'is-inactive'}">${account.is_active ? 'نشط' : 'موقوف'}</span></td>
        <td>${escapeHtml(formatShortDate(account.created_at))}</td>
        <td>
          ${protectedAccount
            ? '<span class="admin-panel-meta">الحساب الأساسي محمي</span>'
            : `<div class="admin-row-actions">
                <button type="button" data-account-action="edit" data-account-id="${escapeHtml(account.id)}">تعديل</button>
                <button type="button" class="${account.is_active ? 'is-danger' : 'is-success'}" data-account-action="toggle" data-account-id="${escapeHtml(account.id)}">${account.is_active ? 'إيقاف' : 'تفعيل'}</button>
              </div>`}
        </td>
      </tr>
    `;
  }).join('');

  syncBulkActions(accounts);
}

function handleAccountTableClick(event) {
  const button = event.target.closest('[data-account-action]');
  if (!button) return;
  const account = state.accounts.find(item => item.id === button.dataset.accountId);
  if (!account || isProtectedAccount(account)) return;

  if (button.dataset.accountAction === 'edit') openEditAccountDialog(account);
  if (button.dataset.accountAction === 'toggle') toggleAccountStatus(account);
}

function handleAccountSelectionChange(event) {
  const checkbox = event.target.closest('[data-select-account]');
  if (!checkbox) return;
  if (checkbox.checked) state.selectedAccountIds.add(checkbox.dataset.selectAccount);
  else state.selectedAccountIds.delete(checkbox.dataset.selectAccount);
  syncBulkActions(getFilteredAccounts());
}

function syncBulkActions(visibleAccounts) {
  const selectableIds = visibleAccounts.filter(account => !isProtectedAccount(account)).map(account => account.id);
  const selectedVisible = selectableIds.filter(id => state.selectedAccountIds.has(id));
  const selectAll = document.getElementById('select-all-accounts');
  selectAll.checked = selectableIds.length > 0 && selectedVisible.length === selectableIds.length;
  selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < selectableIds.length;

  document.getElementById('bulk-actions').hidden = state.selectedAccountIds.size === 0;
  setText('selected-accounts-count', state.selectedAccountIds.size);
}

function clearAccountSelection() {
  state.selectedAccountIds.clear();
  renderAccountsTable();
}

async function updateSelectedAccountStatus(isActive) {
  const ids = [...state.selectedAccountIds].filter(id => {
    const account = state.accounts.find(item => item.id === id);
    return account && !isProtectedAccount(account);
  });
  if (!ids.length) return;

  if (isLocalPreviewMode()) {
    state.accounts = state.accounts.map(account => ids.includes(account.id)
      ? { ...account, is_active: isActive, updated_at: new Date().toISOString() }
      : account);
    savePreviewAccounts();
  } else {
    const { error } = await supabase.from('users').update({ is_active: isActive }).in('id', ids);
    if (error) {
      showToast('تعذر تحديث الحسابات المحددة.', 'error');
      return;
    }
    await loadAccounts();
  }

  logAdminActivity(`${isActive ? 'تفعيل' : 'إيقاف'} ${ids.length} حساب`);
  clearAccountSelection();
  renderDashboard();
  showToast(`تم ${isActive ? 'تفعيل' : 'إيقاف'} الحسابات المحددة.`, 'success');
}

function openEditAccountDialog(account) {
  document.getElementById('edit-account-id').value = account.id;
  document.getElementById('edit-account-name').value = account.full_name;
  document.getElementById('edit-account-username').value = account.username;
  document.getElementById('edit-account-phone').value = account.phone;
  document.getElementById('edit-account-role').value = account.role;
  document.getElementById('edit-account-dialog').showModal();
}

async function handleCreateAccount(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;

  const submitButton = document.getElementById('create-account-submit');
  const fullName = document.getElementById('account-name').value.trim();
  const username = document.getElementById('account-username').value.trim().toLowerCase();
  const phone = document.getElementById('account-phone').value.trim();
  const role = document.getElementById('account-role').value;
  const password = document.getElementById('account-password').value;
  const isActive = document.getElementById('account-active').checked;

  if (state.accounts.some(account => account.username === username)) {
    showToast('اسم المستخدم مستخدم بالفعل.', 'error');
    return;
  }

  setButtonLoading(submitButton, true, 'جاري الإنشاء...');
  try {
    if (isLocalPreviewMode()) {
      state.accounts.unshift(normalizeAccount({
        id: crypto.randomUUID(),
        full_name: fullName,
        username,
        phone,
        role,
        is_active: isActive,
        must_change_password: true,
        created_at: new Date().toISOString(),
      }));
      savePreviewAccounts();
    } else {
      const { data, error } = await supabase.functions.invoke('admin-create-account', {
        body: { fullName, username, password, phone, role },
      });
      if (error || data?.error) throw new Error(data?.error || error.message);
      if (!isActive && data?.account?.id) {
        const { error: statusError } = await supabase.from('users').update({ is_active: false }).eq('id', data.account.id);
        if (statusError) throw statusError;
      }
      await loadAccounts();
    }

    logAdminActivity(`إنشاء حساب ${ROLE_LABELS[role]}: ${fullName}`);
    document.getElementById('create-account-dialog').close();
    renderDashboard();
    renderAccountsTable();
    showToast('تم إنشاء الحساب بنجاح.', 'success');
  } catch (error) {
    console.error('Account creation failed:', error);
    showToast(error.message || 'تعذر إنشاء الحساب.', 'error');
  } finally {
    setButtonLoading(submitButton, false, 'إنشاء الحساب');
  }
}

async function handleEditAccount(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;

  const id = document.getElementById('edit-account-id').value;
  const account = state.accounts.find(item => item.id === id);
  if (!account || isProtectedAccount(account)) return;

  const updates = {
    full_name: document.getElementById('edit-account-name').value.trim(),
    username: document.getElementById('edit-account-username').value.trim().toLowerCase(),
    phone: document.getElementById('edit-account-phone').value.trim(),
    role: document.getElementById('edit-account-role').value,
    updated_at: new Date().toISOString(),
  };

  if (state.accounts.some(item => item.id !== id && item.username === updates.username)) {
    showToast('اسم المستخدم مستخدم بالفعل.', 'error');
    return;
  }

  const submitButton = document.getElementById('edit-account-submit');
  setButtonLoading(submitButton, true, 'جاري الحفظ...');
  try {
    if (isLocalPreviewMode()) {
      state.accounts = state.accounts.map(item => item.id === id ? { ...item, ...updates } : item);
      savePreviewAccounts();
    } else {
      const { error } = await supabase
        .from('users')
        .update({
          full_name: updates.full_name,
          username: updates.username,
          phone: updates.phone || null,
          role: updates.role,
        })
        .eq('id', id);
      if (error) throw error;
      await loadAccounts();
    }

    logAdminActivity(`تعديل حساب: ${updates.full_name}`);
    document.getElementById('edit-account-dialog').close();
    renderDashboard();
    renderAccountsTable();
    showToast('تم حفظ تعديلات الحساب.', 'success');
  } catch (error) {
    console.error('Account update failed:', error);
    showToast(error.message || 'تعذر تعديل الحساب.', 'error');
  } finally {
    setButtonLoading(submitButton, false, 'حفظ التعديلات');
  }
}

async function toggleAccountStatus(account) {
  const nextStatus = !account.is_active;
  const actionLabel = nextStatus ? 'تفعيل' : 'إيقاف';
  if (!window.confirm(`هل تريد ${actionLabel} حساب ${account.full_name}؟`)) return;

  try {
    if (isLocalPreviewMode()) {
      state.accounts = state.accounts.map(item => item.id === account.id
        ? { ...item, is_active: nextStatus, updated_at: new Date().toISOString() }
        : item);
      savePreviewAccounts();
    } else {
      const { error } = await supabase.from('users').update({ is_active: nextStatus }).eq('id', account.id);
      if (error) throw error;
      await loadAccounts();
    }

    logAdminActivity(`${actionLabel} حساب: ${account.full_name}`);
    renderDashboard();
    renderAccountsTable();
    showToast(`تم ${actionLabel} الحساب.`, 'success');
  } catch (error) {
    console.error('Account status update failed:', error);
    showToast(`تعذر ${actionLabel} الحساب.`, 'error');
  }
}

function getAdminActivities() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ADMIN_ACTIVITY_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function logAdminActivity(message) {
  const activities = getAdminActivities();
  activities.unshift({
    id: crypto.randomUUID(),
    message,
    created_at: new Date().toISOString(),
  });
  localStorage.setItem(ADMIN_ACTIVITY_KEY, JSON.stringify(activities.slice(0, 50)));
  state.auditActivities = [{ message, created_at: new Date().toISOString() }, ...state.auditActivities].slice(0, 12);

  if (!isLocalPreviewMode() && state.profile?.id) {
    void supabase.from('admin_audit_logs').insert({
      actor_id: state.profile.id,
      action: message,
      metadata: { source: 'admin-dashboard' },
    }).then(({ error }) => {
      if (error) console.error('Audit log write failed:', error);
    });
  }
}

function setButtonLoading(button, loading, label) {
  button.disabled = loading;
  button.textContent = label;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = String(value);
}

function getInitial(name) {
  return String(name || 'م').trim().charAt(0) || 'م';
}

function getLocalDateValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatShortDate(value) {
  if (!value) return 'غير محدد';
  return new Intl.DateTimeFormat('ar-OM', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat('ar-OM', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(value);
}

function formatRelativeTime(value) {
  const date = new Date(value);
  const diffMinutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (diffMinutes < 1) return 'الآن';
  if (diffMinutes < 60) return `منذ ${diffMinutes} د`;
  const hours = Math.floor(diffMinutes / 60);
  if (hours < 24) return `منذ ${hours} س`;
  return formatShortDate(value);
}
