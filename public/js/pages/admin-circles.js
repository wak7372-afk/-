const PREVIEW_STORAGE_KEY = 'zat_khail_preview_learning_circles_v1';

const CIRCLE_TYPE_LABELS = {
  quran: 'حلقة قرآنية',
  educational: 'حلقة تعليمية',
};

const PERMISSIONS = [
  ['post_announcements', 'can_post_announcements', 'نشر الإعلانات'],
  ['manage_meet_link', 'can_manage_meet_link', 'إدارة رابط اللقاء'],
  ['create_tasks', 'can_create_tasks', 'إنشاء المهام'],
  ['review_submissions', 'can_review_submissions', 'مراجعة التسليمات'],
  ['manage_discussions', 'can_manage_discussions', 'إدارة النقاشات'],
  ['track_students', 'can_track_students', 'متابعة الطلاب'],
];

const AUDIT_LABELS = {
  'circle.created': 'إنشاء الحلقة',
  'circle.details_updated': 'تحديث بيانات الحلقة',
  'circle.staff_assigned': 'تعيين معلم في الحلقة',
  'circle.staff_ended': 'إنهاء تكليف معلم مساعد',
  'circle.assistant_permissions_updated': 'تحديث صلاحيات معلم مساعد',
  'circle.student_added': 'إضافة طالب إلى الحلقة',
  'circle.student_removed': 'إنهاء عضوية طالب',
  'circle.transfer_requested': 'إنشاء طلب نقل قرآني',
  'circle.transfer_approved': 'اعتماد نقل طالب',
  'circle.transfer_rejected': 'رفض نقل طالب',
  'circle.meet_link_updated': 'تحديث رابط اللقاء',
  'circle.archived': 'أرشفة الحلقة',
};

const PREVIEW_SUBJECTS = [
  { id: 'preview-subject-fiqh', name: 'فقه' },
  { id: 'preview-subject-aqeedah', name: 'عقيدة' },
  { id: 'preview-subject-seerah', name: 'سيرة' },
];

export function createAdminCirclesController({
  supabase,
  isLocalPreviewMode,
  escapeHtml,
  showToast,
  getAccounts,
  onMetricsChange,
}) {
  const state = {
    circles: [],
    subjects: [],
    circleSubjects: [],
    staff: [],
    memberships: [],
    transfers: [],
    activities: [],
    selectedCircleId: null,
    loading: false,
  };

  function setup() {
    document.getElementById('open-create-circle').addEventListener('click', openCreateCircleDialog);
    document.getElementById('create-circle-form').addEventListener('submit', handleCreateCircle);
    document.querySelectorAll('input[name="circleType"]').forEach(input => {
      input.addEventListener('change', syncCreateCircleType);
    });

    ['circle-search', 'circle-type-filter', 'circle-status-filter'].forEach(id => {
      document.getElementById(id).addEventListener('input', renderCircleList);
      document.getElementById(id).addEventListener('change', renderCircleList);
    });
    document.getElementById('clear-circle-filters').addEventListener('click', clearFilters);
    document.querySelectorAll('[data-circle-filter-target]').forEach(button => {
      button.addEventListener('click', () => {
        document.getElementById('circle-type-filter').value = button.dataset.circleFilterTarget;
        document.getElementById('circle-status-filter').value = 'active';
        renderCircleList();
      });
    });

    document.getElementById('circles-list').addEventListener('click', handleCircleListClick);
    document.getElementById('transfer-requests-list').addEventListener('click', handleTransferListClick);
    document.querySelectorAll('[data-circle-tab]').forEach(button => {
      button.addEventListener('click', () => switchCircleTab(button.dataset.circleTab));
    });

    document.getElementById('edit-circle-form').addEventListener('submit', handleUpdateCircleDetails);
    document.getElementById('circle-meet-form').addEventListener('submit', handleUpdateMeetLink);
    document.getElementById('save-circle-lead').addEventListener('click', handleAssignLead);
    document.getElementById('add-circle-assistant-button').addEventListener('click', handleAddAssistant);
    document.getElementById('circle-assistants-list').addEventListener('click', handleAssistantAction);
    document.getElementById('add-circle-student-button').addEventListener('click', handleAddStudent);
    document.getElementById('circle-students-list').addEventListener('click', handleStudentAction);
    document.getElementById('archive-circle').addEventListener('click', handleArchiveCircle);
    document.getElementById('open-delete-circle').addEventListener('click', openDeleteCircleDialog);
    document.getElementById('delete-circle-form').addEventListener('submit', handleDeleteCircle);
    document.getElementById('transfer-decision-form').addEventListener('submit', handleTransferDecision);
  }

  async function refresh() {
    state.loading = true;
    renderLoadingState();
    try {
      if (isLocalPreviewMode()) loadPreviewState();
      else await loadRemoteState();
      render();
    } catch (error) {
      console.error('Unable to load learning circles:', error);
      showToast('تعذر تحميل نظام الحلقات. أعد المحاولة بعد قليل.', 'error');
      renderLoadError();
    } finally {
      state.loading = false;
    }
  }

  async function loadRemoteState() {
    const results = await Promise.all([
      supabase.from('learning_circles').select('*').order('created_at', { ascending: false }),
      supabase.from('subjects').select('id, name').order('name'),
      supabase.from('learning_circle_subjects').select('circle_id, subject_id'),
      supabase.from('learning_circle_staff').select('*').order('started_at'),
      supabase.from('learning_circle_memberships').select('*').order('joined_at'),
      supabase.from('learning_circle_transfer_requests').select('*').order('requested_at', { ascending: false }),
      supabase.from('platform_audit_events').select('id, actor_id, circle_id, action, entity_type, entity_id, metadata, created_at').order('created_at', { ascending: false }).limit(250),
    ]);

    const failed = results.find(result => result.error);
    if (failed) throw failed.error;
    [
      state.circles,
      state.subjects,
      state.circleSubjects,
      state.staff,
      state.memberships,
      state.transfers,
      state.activities,
    ] = results.map(result => result.data || []);
  }

  function loadPreviewState() {
    const stored = readPreviewState();
    state.circles = stored.circles;
    state.subjects = PREVIEW_SUBJECTS;
    state.circleSubjects = stored.circleSubjects;
    state.staff = stored.staff;
    state.memberships = stored.memberships;
    state.transfers = stored.transfers;
    state.activities = stored.activities;
  }

  function readPreviewState() {
    const fallback = {
      circles: [],
      circleSubjects: [],
      staff: [],
      memberships: [],
      transfers: [],
      activities: [],
    };
    try {
      const parsed = JSON.parse(localStorage.getItem(PREVIEW_STORAGE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return fallback;
      return Object.fromEntries(Object.entries(fallback).map(([key, value]) => [
        key,
        Array.isArray(parsed[key]) ? parsed[key] : value,
      ]));
    } catch {
      return fallback;
    }
  }

  function savePreviewState() {
    localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify({
      circles: state.circles,
      circleSubjects: state.circleSubjects,
      staff: state.staff,
      memberships: state.memberships,
      transfers: state.transfers,
      activities: state.activities.slice(0, 250),
    }));
  }

  function render() {
    renderMetrics();
    renderCircleList();
    renderTransferRequests();
    if (state.selectedCircleId && document.getElementById('manage-circle-dialog').open) {
      renderCircleDialog();
    }
  }

  function renderMetrics() {
    const active = state.circles.filter(circle => circle.status === 'active');
    const pendingTransfers = state.transfers.filter(request => request.status === 'pending').length;
    const metrics = {
      active: active.length,
      quran: active.filter(circle => circle.circle_type === 'quran').length,
      educational: active.filter(circle => circle.circle_type === 'educational').length,
      pendingTransfers,
    };
    setText('circle-stat-active', metrics.active);
    setText('circle-stat-quran', metrics.quran);
    setText('circle-stat-educational', metrics.educational);
    setText('circle-stat-transfers', metrics.pendingTransfers);
    setText('nav-circles-count', metrics.active);
    setText('pending-transfer-count', metrics.pendingTransfers);
    onMetricsChange(metrics);
  }

  function getFilteredCircles() {
    const search = document.getElementById('circle-search').value.trim().toLowerCase();
    const type = document.getElementById('circle-type-filter').value;
    const status = document.getElementById('circle-status-filter').value;
    return state.circles.filter(circle => {
      const lead = getCircleLead(circle.id);
      const subjectNames = getCircleSubjects(circle.id).map(subject => subject.name).join(' ');
      const haystack = `${circle.name} ${circle.description || ''} ${getAccount(lead?.teacher_id).full_name} ${subjectNames}`.toLowerCase();
      return (!search || haystack.includes(search))
        && (type === 'all' || circle.circle_type === type)
        && (status === 'all' || circle.status === status);
    });
  }

  function renderCircleList() {
    const circles = getFilteredCircles();
    const container = document.getElementById('circles-list');
    const empty = document.getElementById('circles-empty-state');
    setText('filtered-circles-count', circles.length);
    empty.hidden = circles.length > 0;
    container.hidden = circles.length === 0;

    container.innerHTML = circles.map(circle => {
      const lead = getCircleLead(circle.id);
      const leadAccount = getAccount(lead?.teacher_id);
      const subjects = getCircleSubjects(circle.id);
      const memberCount = getCircleMemberships(circle.id).length;
      const assistantCount = getCircleStaff(circle.id).filter(row => row.staff_role === 'assistant').length;
      const archived = circle.status === 'archived';
      return `
        <article class="admin-circle-card ${archived ? 'is-archived' : ''}" data-circle-id="${escapeHtml(circle.id)}">
          <div class="admin-circle-card-accent admin-circle-card-accent-${escapeHtml(circle.circle_type)}" aria-hidden="true"></div>
          <div class="admin-circle-card-head">
            <div>
              <span class="admin-circle-type admin-circle-type-${escapeHtml(circle.circle_type)}">${escapeHtml(CIRCLE_TYPE_LABELS[circle.circle_type])}</span>
              <h3 class="font-amiri">${escapeHtml(circle.name)}</h3>
            </div>
            <span class="admin-account-status ${archived ? 'is-inactive' : 'is-active'}">${archived ? 'مؤرشفة' : 'نشطة'}</span>
          </div>
          <p class="admin-circle-description">${escapeHtml(circle.description || 'لا يوجد وصف مضاف لهذه الحلقة.')}</p>
          ${subjects.length ? `<div class="admin-circle-subjects">${subjects.map(subject => `<span>${escapeHtml(subject.name)}</span>`).join('')}</div>` : ''}
          <dl class="admin-circle-facts">
            <div><dt>المسؤول</dt><dd>${escapeHtml(leadAccount.full_name)}</dd></div>
            <div><dt>الطلاب</dt><dd>${memberCount}</dd></div>
            <div><dt>المساعدون</dt><dd>${assistantCount}</dd></div>
            <div><dt>اللقاء</dt><dd>${circle.meet_link ? 'مربوط' : 'غير مضاف'}</dd></div>
          </dl>
          <div class="admin-circle-card-footer">
            <span>أنشئت ${escapeHtml(formatShortDate(circle.created_at))}</span>
            <div class="admin-circle-card-actions">
              ${archived ? '' : `<a href="${escapeHtml(workspaceHref(circle.id))}">فتح المساحة</a>`}
              <button type="button" data-circle-action="manage" data-circle-id="${escapeHtml(circle.id)}">${archived ? 'عرض السجل' : 'إدارة الحلقة'}</button>
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  function workspaceHref(circleId) {
    const params = new URLSearchParams({ id: circleId });
    if (isLocalPreviewMode()) {
      params.set('preview', '1');
      params.set('role', 'admin');
    }
    return `/circle.html?${params.toString()}`;
  }

  function renderTransferRequests() {
    const requests = state.transfers.filter(request => request.status === 'pending');
    const container = document.getElementById('transfer-requests-list');
    if (!requests.length) {
      container.innerHTML = '<div class="admin-list-empty">لا توجد طلبات نقل معلقة.</div>';
      return;
    }
    container.innerHTML = requests.map(request => {
      const student = getAccount(request.student_id);
      const fromCircle = getCircle(request.from_circle_id);
      const toCircle = getCircle(request.to_circle_id);
      return `
        <article class="admin-transfer-item">
          <div class="admin-transfer-person">
            <span class="admin-account-initial" aria-hidden="true">${escapeHtml(getInitial(student.full_name))}</span>
            <div><strong>${escapeHtml(student.full_name)}</strong><small>@${escapeHtml(student.username || 'student')}</small></div>
          </div>
          <p><span>${escapeHtml(fromCircle?.name || 'حلقة سابقة')}</span><b aria-hidden="true">←</b><span>${escapeHtml(toCircle?.name || 'حلقة جديدة')}</span></p>
          <time datetime="${escapeHtml(request.requested_at)}">${escapeHtml(formatRelativeTime(request.requested_at))}</time>
          <div class="admin-row-actions">
            <button type="button" class="is-success" data-transfer-action="approve" data-transfer-id="${escapeHtml(request.id)}">اعتماد</button>
            <button type="button" class="is-danger" data-transfer-action="reject" data-transfer-id="${escapeHtml(request.id)}">رفض</button>
          </div>
        </article>
      `;
    }).join('');
  }

  function renderLoadingState() {
    document.getElementById('circles-list').innerHTML = `
      <div class="admin-panel admin-circle-loading" role="status">جاري تحميل الحلقات...</div>
    `;
    document.getElementById('transfer-requests-list').innerHTML = '<div class="admin-list-empty">جاري تحميل الطلبات...</div>';
  }

  function renderLoadError() {
    document.getElementById('circles-list').innerHTML = `
      <div class="admin-panel admin-circle-loading is-error">تعذر تحميل الحلقات. تحقق من الاتصال ثم حدّث الصفحة.</div>
    `;
  }

  function clearFilters() {
    document.getElementById('circle-search').value = '';
    document.getElementById('circle-type-filter').value = 'all';
    document.getElementById('circle-status-filter').value = 'active';
    renderCircleList();
  }

  function openCreateCircleDialog() {
    const form = document.getElementById('create-circle-form');
    form.reset();
    const teachers = getActiveAccounts('teacher');
    document.getElementById('circle-lead-teacher').innerHTML = buildAccountOptions(teachers, 'اختر المعلم المسؤول');
    renderSubjectChoices('create-circle-subjects', []);
    syncCreateCircleType();
    const submit = document.getElementById('create-circle-submit');
    submit.disabled = teachers.length === 0;
    submit.title = teachers.length ? '' : 'أنشئ حساب معلم نشط أولاً';
    document.getElementById('create-circle-dialog').showModal();
    requestAnimationFrame(() => document.getElementById('circle-name').focus());
  }

  function syncCreateCircleType() {
    const type = document.querySelector('input[name="circleType"]:checked')?.value || 'quran';
    const educational = type === 'educational';
    document.getElementById('create-circle-title').textContent = educational ? 'إنشاء حلقة تعليمية' : 'إنشاء حلقة قرآنية';
    document.getElementById('create-circle-subjects-field').hidden = !educational;
  }

  async function handleCreateCircle(event) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const type = document.querySelector('input[name="circleType"]:checked')?.value || 'quran';
    const subjectIds = type === 'educational' ? getCheckedValues('create-circle-subjects') : [];
    if (type === 'educational' && !subjectIds.length) {
      showToast('اختر مادة واحدة على الأقل للحلقة التعليمية.', 'error');
      return;
    }
    const payload = {
      name: document.getElementById('circle-name').value.trim(),
      type,
      leadTeacherId: document.getElementById('circle-lead-teacher').value,
      description: document.getElementById('circle-description').value.trim(),
      subjectIds,
    };
    if (!payload.leadTeacherId) {
      showToast('اختر المعلم المسؤول عن الحلقة.', 'error');
      return;
    }

    const button = document.getElementById('create-circle-submit');
    setButtonLoading(button, true, 'جاري الإنشاء...');
    try {
      if (isLocalPreviewMode()) createPreviewCircle(payload);
      else {
        const { error } = await supabase.rpc('create_learning_circle', {
          p_name: payload.name,
          p_circle_type: payload.type,
          p_lead_teacher_id: payload.leadTeacherId,
          p_description: payload.description || null,
          p_subject_ids: payload.subjectIds,
        });
        if (error) throw error;
      }
      document.getElementById('create-circle-dialog').close();
      await refresh();
      showToast('تم إنشاء الحلقة وربط المعلم المسؤول بنجاح.', 'success');
    } catch (error) {
      console.error('Circle creation failed:', error);
      showToast(friendlyError(error, 'تعذر إنشاء الحلقة.'), 'error');
    } finally {
      setButtonLoading(button, false, 'إنشاء الحلقة');
    }
  }

  function createPreviewCircle(payload) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    state.circles.unshift({
      id,
      circle_type: payload.type,
      name: payload.name,
      description: payload.description || null,
      status: 'active',
      meet_link: null,
      created_at: now,
      updated_at: now,
    });
    state.staff.push({
      id: crypto.randomUUID(),
      circle_id: id,
      teacher_id: payload.leadTeacherId,
      staff_role: 'lead',
      status: 'active',
      ...allPermissions(true),
      started_at: now,
    });
    payload.subjectIds.forEach(subjectId => state.circleSubjects.push({ circle_id: id, subject_id: subjectId }));
    addPreviewAudit(id, 'circle.created');
    savePreviewState();
  }

  function handleCircleListClick(event) {
    const button = event.target.closest('[data-circle-action="manage"]');
    if (!button) return;
    state.selectedCircleId = button.dataset.circleId;
    switchCircleTab('details');
    renderCircleDialog();
    document.getElementById('manage-circle-dialog').showModal();
  }

  function renderCircleDialog() {
    const circle = getSelectedCircle();
    if (!circle) {
      document.getElementById('manage-circle-dialog').close();
      return;
    }
    const archived = circle.status === 'archived';
    document.getElementById('manage-circle-type').textContent = CIRCLE_TYPE_LABELS[circle.circle_type];
    document.getElementById('manage-circle-title').textContent = circle.name;
    const status = document.getElementById('manage-circle-status');
    status.textContent = archived ? 'مؤرشفة' : 'نشطة';
    status.className = `admin-account-status ${archived ? 'is-inactive' : 'is-active'}`;

    document.getElementById('edit-circle-name').value = circle.name;
    document.getElementById('edit-circle-description').value = circle.description || '';
    document.getElementById('circle-meet-link').value = circle.meet_link || '';
    const subjectField = document.getElementById('edit-circle-subjects-field');
    subjectField.hidden = circle.circle_type !== 'educational';
    renderSubjectChoices('edit-circle-subjects', getCircleSubjects(circle.id).map(subject => subject.id));
    renderTeamPanel(circle);
    renderStudentsPanel(circle);
    renderCircleActivity(circle);
    syncCircleWriteState(archived);
  }

  function renderTeamPanel(circle) {
    const activeTeachers = getActiveAccounts('teacher');
    const lead = getCircleLead(circle.id);
    const leadSelect = document.getElementById('manage-circle-lead');
    leadSelect.innerHTML = buildAccountOptions(activeTeachers, 'اختر المسؤول', lead?.teacher_id);

    const activeStaffIds = new Set(getCircleStaff(circle.id).map(row => row.teacher_id));
    const availableAssistants = activeTeachers.filter(account => !activeStaffIds.has(account.id));
    document.getElementById('add-circle-assistant').innerHTML = buildAccountOptions(availableAssistants, 'اختر معلماً مساعداً');

    const assistants = getCircleStaff(circle.id).filter(row => row.staff_role === 'assistant');
    const container = document.getElementById('circle-assistants-list');
    if (!assistants.length) {
      container.innerHTML = '<div class="admin-list-empty">لم يُضف معلمون مساعدون بعد.</div>';
      return;
    }
    container.innerHTML = assistants.map(assistant => {
      const account = getAccount(assistant.teacher_id);
      return `
        <article class="admin-assistant-item" data-assistant-id="${escapeHtml(assistant.teacher_id)}">
          <div class="admin-assistant-head">
            <div class="admin-transfer-person">
              <span class="admin-account-initial" aria-hidden="true">${escapeHtml(getInitial(account.full_name))}</span>
              <div><strong>${escapeHtml(account.full_name)}</strong><small>@${escapeHtml(account.username || 'teacher')}</small></div>
            </div>
            <button type="button" class="admin-link-danger" data-assistant-action="remove" data-teacher-id="${escapeHtml(assistant.teacher_id)}">إنهاء التكليف</button>
          </div>
          <div class="admin-permissions-grid">
            ${PERMISSIONS.map(([key, column, label]) => `
              <label><input type="checkbox" data-permission="${escapeHtml(key)}" ${assistant[column] ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>
            `).join('')}
          </div>
          <div class="admin-assistant-footer">
            <span>الصلاحيات مستقلة ويمكن تعديلها في أي وقت.</span>
            <button type="button" class="admin-secondary-button" data-assistant-action="save" data-teacher-id="${escapeHtml(assistant.teacher_id)}">حفظ الصلاحيات</button>
          </div>
        </article>
      `;
    }).join('');
  }

  function renderStudentsPanel(circle) {
    const memberships = getCircleMemberships(circle.id);
    setText('circle-members-count', memberships.length);
    document.getElementById('circle-student-rule').textContent = circle.circle_type === 'quran'
      ? 'للطالب حلقة قرآن نشطة واحدة. إضافته من حلقة أخرى تنشئ طلب نقل للمدير.'
      : 'يمكن للطالب الانضمام إلى أكثر من حلقة تعليمية.';

    const memberIds = new Set(memberships.map(row => row.student_id));
    const availableStudents = getActiveAccounts('student').filter(account => !memberIds.has(account.id));
    document.getElementById('add-circle-student').innerHTML = buildAccountOptions(availableStudents, 'اختر طالباً');

    const container = document.getElementById('circle-students-list');
    if (!memberships.length) {
      container.innerHTML = '<div class="admin-list-empty">لا يوجد طلاب نشطون في هذه الحلقة.</div>';
      return;
    }
    container.innerHTML = memberships.map(membership => {
      const student = getAccount(membership.student_id);
      return `
        <article class="admin-member-row">
          <div class="admin-transfer-person">
            <span class="admin-account-initial" aria-hidden="true">${escapeHtml(getInitial(student.full_name))}</span>
            <div><strong>${escapeHtml(student.full_name)}</strong><small>@${escapeHtml(student.username || 'student')}</small></div>
          </div>
          <span>منذ ${escapeHtml(formatShortDate(membership.joined_at))}</span>
          <button type="button" class="admin-link-danger" data-student-action="remove" data-membership-id="${escapeHtml(membership.id)}">إخراج من الحلقة</button>
        </article>
      `;
    }).join('');
  }

  function renderCircleActivity(circle) {
    const activities = state.activities.filter(activity => activity.circle_id === circle.id).slice(0, 60);
    const container = document.getElementById('circle-activity-list');
    if (!activities.length) {
      container.innerHTML = '<div class="admin-list-empty">لا توجد عمليات مسجلة لهذه الحلقة بعد.</div>';
      return;
    }
    container.innerHTML = activities.map(activity => {
      const actor = getAccount(activity.actor_id);
      return `
        <div class="admin-circle-activity-row">
          <span class="admin-activity-index" aria-hidden="true">${escapeHtml(String(activity.id || '').slice(-2) || '•')}</span>
          <div><strong>${escapeHtml(AUDIT_LABELS[activity.action] || activity.action)}</strong><small>بواسطة ${escapeHtml(actor.full_name)}</small></div>
          <time datetime="${escapeHtml(activity.created_at)}">${escapeHtml(formatRelativeTime(activity.created_at))}</time>
        </div>
      `;
    }).join('');
  }

  function syncCircleWriteState(archived) {
    const controls = [
      '#edit-circle-form input', '#edit-circle-form textarea', '#edit-circle-form button',
      '#circle-meet-form input', '#circle-meet-form button',
      '#manage-circle-lead', '#save-circle-lead', '#add-circle-assistant',
      '#add-circle-assistant-button', '#circle-assistants-list input',
      '#circle-assistants-list button', '#add-circle-student',
      '#add-circle-student-button', '#circle-students-list button', '#archive-circle',
    ];
    document.querySelectorAll(controls.join(',')).forEach(control => { control.disabled = archived; });
    document.getElementById('archive-circle').hidden = archived;
  }

  function switchCircleTab(tabName) {
    const safeTab = ['details', 'team', 'students', 'activity'].includes(tabName) ? tabName : 'details';
    document.querySelectorAll('[data-circle-tab]').forEach(button => {
      const active = button.dataset.circleTab === safeTab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-circle-tab-panel]').forEach(panel => {
      panel.hidden = panel.dataset.circleTabPanel !== safeTab;
    });
  }

  async function handleUpdateCircleDetails(event) {
    event.preventDefault();
    const circle = getSelectedCircle();
    if (!circle || circle.status === 'archived' || !event.currentTarget.reportValidity()) return;
    const subjectIds = circle.circle_type === 'educational' ? getCheckedValues('edit-circle-subjects') : [];
    if (circle.circle_type === 'educational' && !subjectIds.length) {
      showToast('يجب أن تبقى للحلقة التعليمية مادة واحدة على الأقل.', 'error');
      return;
    }
    const button = document.getElementById('save-circle-details');
    setButtonLoading(button, true, 'جاري الحفظ...');
    try {
      const name = document.getElementById('edit-circle-name').value.trim();
      const description = document.getElementById('edit-circle-description').value.trim();
      if (isLocalPreviewMode()) {
        Object.assign(circle, { name, description: description || null, updated_at: new Date().toISOString() });
        state.circleSubjects = state.circleSubjects.filter(link => link.circle_id !== circle.id);
        subjectIds.forEach(subjectId => state.circleSubjects.push({ circle_id: circle.id, subject_id: subjectId }));
        addPreviewAudit(circle.id, 'circle.details_updated');
        savePreviewState();
      } else {
        const { error } = await supabase.rpc('update_learning_circle_details', {
          p_circle_id: circle.id,
          p_name: name,
          p_description: description || null,
          p_subject_ids: subjectIds,
        });
        if (error) throw error;
      }
      await refresh();
      showToast('تم حفظ بيانات الحلقة.', 'success');
    } catch (error) {
      console.error('Circle details update failed:', error);
      showToast(friendlyError(error, 'تعذر حفظ بيانات الحلقة.'), 'error');
    } finally {
      setButtonLoading(button, false, 'حفظ البيانات');
    }
  }

  async function handleUpdateMeetLink(event) {
    event.preventDefault();
    const circle = getSelectedCircle();
    if (!circle || circle.status === 'archived') return;
    const link = document.getElementById('circle-meet-link').value.trim();
    if (link && !/^https:\/\/meet\.google\.com\/[a-z0-9_-]+(?:[/?#].*)?$/i.test(link)) {
      showToast('أدخل رابط Google Meet صحيحاً.', 'error');
      return;
    }
    const button = document.getElementById('save-circle-meet');
    setButtonLoading(button, true, 'جاري الحفظ...');
    try {
      if (isLocalPreviewMode()) {
        circle.meet_link = link || null;
        addPreviewAudit(circle.id, 'circle.meet_link_updated');
        savePreviewState();
      } else {
        const { error } = await supabase.rpc('update_learning_circle_meet_link', {
          p_circle_id: circle.id,
          p_meet_link: link || null,
        });
        if (error) throw error;
      }
      await refresh();
      showToast(link ? 'تم حفظ رابط اللقاء.' : 'تم حذف رابط اللقاء.', 'success');
    } catch (error) {
      console.error('Meet link update failed:', error);
      showToast(friendlyError(error, 'تعذر حفظ رابط اللقاء.'), 'error');
    } finally {
      setButtonLoading(button, false, 'حفظ الرابط');
    }
  }

  async function handleAssignLead() {
    const circle = getSelectedCircle();
    const teacherId = document.getElementById('manage-circle-lead').value;
    if (!circle || !teacherId || circle.status === 'archived') return;
    const currentLead = getCircleLead(circle.id);
    if (currentLead?.teacher_id === teacherId) {
      showToast('هذا المعلم هو المسؤول الحالي بالفعل.', 'info');
      return;
    }
    const button = document.getElementById('save-circle-lead');
    setButtonLoading(button, true, 'جاري التعيين...');
    try {
      if (isLocalPreviewMode()) {
        state.staff.forEach(row => {
          if (row.circle_id === circle.id && row.staff_role === 'lead' && row.status === 'active') {
            row.status = 'ended';
            row.ended_at = new Date().toISOString();
          }
        });
        const existing = state.staff.find(row => row.circle_id === circle.id && row.teacher_id === teacherId && row.status === 'active');
        if (existing) Object.assign(existing, { staff_role: 'lead', ...allPermissions(true) });
        else state.staff.push(createPreviewStaff(circle.id, teacherId, 'lead'));
        addPreviewAudit(circle.id, 'circle.staff_assigned');
        savePreviewState();
      } else {
        const { error } = await supabase.rpc('admin_set_learning_circle_staff', {
          p_circle_id: circle.id,
          p_teacher_id: teacherId,
          p_staff_role: 'lead',
          p_active: true,
        });
        if (error) throw error;
      }
      await refresh();
      showToast('تم تعيين المعلم المسؤول.', 'success');
    } catch (error) {
      console.error('Lead assignment failed:', error);
      showToast(friendlyError(error, 'تعذر تعيين المعلم المسؤول.'), 'error');
    } finally {
      setButtonLoading(button, false, 'تعيين المسؤول');
    }
  }

  async function handleAddAssistant() {
    const circle = getSelectedCircle();
    const teacherId = document.getElementById('add-circle-assistant').value;
    if (!circle || !teacherId || circle.status === 'archived') {
      if (!teacherId) showToast('اختر معلماً لإضافته.', 'error');
      return;
    }
    const button = document.getElementById('add-circle-assistant-button');
    setButtonLoading(button, true, 'جاري الإضافة...');
    try {
      if (isLocalPreviewMode()) {
        state.staff.push(createPreviewStaff(circle.id, teacherId, 'assistant'));
        addPreviewAudit(circle.id, 'circle.staff_assigned');
        savePreviewState();
      } else {
        const { error } = await supabase.rpc('admin_set_learning_circle_staff', {
          p_circle_id: circle.id,
          p_teacher_id: teacherId,
          p_staff_role: 'assistant',
          p_active: true,
        });
        if (error) throw error;
      }
      await refresh();
      showToast('تمت إضافة المعلم المساعد. حدّد صلاحياته الآن.', 'success');
    } catch (error) {
      console.error('Assistant assignment failed:', error);
      showToast(friendlyError(error, 'تعذر إضافة المعلم المساعد.'), 'error');
    } finally {
      setButtonLoading(button, false, 'إضافة مساعد');
    }
  }

  async function handleAssistantAction(event) {
    const button = event.target.closest('[data-assistant-action]');
    const circle = getSelectedCircle();
    if (!button || !circle || circle.status === 'archived') return;
    const teacherId = button.dataset.teacherId;
    if (button.dataset.assistantAction === 'remove') {
      const teacher = getAccount(teacherId);
      if (!window.confirm(`هل تريد إنهاء تكليف ${teacher.full_name} كمعلّم مساعد؟`)) return;
      await removeAssistant(circle, teacherId, button);
      return;
    }
    const item = button.closest('[data-assistant-id]');
    const permissions = {};
    item.querySelectorAll('[data-permission]').forEach(input => {
      permissions[input.dataset.permission] = input.checked;
    });
    await saveAssistantPermissions(circle, teacherId, permissions, button);
  }

  async function removeAssistant(circle, teacherId, button) {
    setButtonLoading(button, true, 'جاري الإنهاء...');
    try {
      if (isLocalPreviewMode()) {
        const row = state.staff.find(item => item.circle_id === circle.id && item.teacher_id === teacherId && item.status === 'active');
        if (row) Object.assign(row, { status: 'ended', ended_at: new Date().toISOString() });
        addPreviewAudit(circle.id, 'circle.staff_ended');
        savePreviewState();
      } else {
        const { error } = await supabase.rpc('admin_set_learning_circle_staff', {
          p_circle_id: circle.id,
          p_teacher_id: teacherId,
          p_staff_role: 'assistant',
          p_active: false,
        });
        if (error) throw error;
      }
      await refresh();
      showToast('تم إنهاء تكليف المعلم المساعد.', 'success');
    } catch (error) {
      console.error('Assistant removal failed:', error);
      showToast(friendlyError(error, 'تعذر إنهاء تكليف المعلم.'), 'error');
    } finally {
      setButtonLoading(button, false, 'إنهاء التكليف');
    }
  }

  async function saveAssistantPermissions(circle, teacherId, permissions, button) {
    setButtonLoading(button, true, 'جاري الحفظ...');
    try {
      if (isLocalPreviewMode()) {
        const row = state.staff.find(item => item.circle_id === circle.id && item.teacher_id === teacherId && item.status === 'active');
        if (row) PERMISSIONS.forEach(([key, column]) => { row[column] = permissions[key]; });
        addPreviewAudit(circle.id, 'circle.assistant_permissions_updated');
        savePreviewState();
      } else {
        const { error } = await supabase.rpc('set_learning_circle_assistant_permissions', {
          p_circle_id: circle.id,
          p_teacher_id: teacherId,
          p_permissions: permissions,
        });
        if (error) throw error;
      }
      await refresh();
      showToast('تم حفظ صلاحيات المعلم المساعد.', 'success');
    } catch (error) {
      console.error('Assistant permissions update failed:', error);
      showToast(friendlyError(error, 'تعذر حفظ الصلاحيات.'), 'error');
    } finally {
      setButtonLoading(button, false, 'حفظ الصلاحيات');
    }
  }

  async function handleAddStudent() {
    const circle = getSelectedCircle();
    const studentId = document.getElementById('add-circle-student').value;
    if (!circle || !studentId || circle.status === 'archived') {
      if (!studentId) showToast('اختر طالباً لإضافته.', 'error');
      return;
    }
    const button = document.getElementById('add-circle-student-button');
    setButtonLoading(button, true, 'جاري الإضافة...');
    try {
      let result;
      if (isLocalPreviewMode()) result = addPreviewStudent(circle, studentId);
      else {
        const response = await supabase.rpc('add_student_to_learning_circle', {
          p_circle_id: circle.id,
          p_student_id: studentId,
        });
        if (response.error) throw response.error;
        result = response.data;
      }
      await refresh();
      if (result?.status === 'transfer_required') {
        showToast('الطالب مرتبط بحلقة قرآن أخرى؛ أُنشئ طلب نقل بانتظار قرارك.', 'info');
      } else if (result?.status === 'already_member') {
        showToast('الطالب عضو في الحلقة بالفعل.', 'info');
      } else {
        showToast('تمت إضافة الطالب إلى الحلقة.', 'success');
      }
    } catch (error) {
      console.error('Student enrollment failed:', error);
      showToast(friendlyError(error, 'تعذر إضافة الطالب.'), 'error');
    } finally {
      setButtonLoading(button, false, 'إضافة الطالب');
    }
  }

  function addPreviewStudent(circle, studentId) {
    const existing = state.memberships.find(row => row.circle_id === circle.id && row.student_id === studentId && row.status === 'active');
    if (existing) return { status: 'already_member', membership_id: existing.id };
    if (circle.circle_type === 'quran') {
      const other = state.memberships.find(row => row.student_id === studentId && row.circle_type === 'quran' && row.status === 'active');
      if (other) {
        let request = state.transfers.find(row => row.student_id === studentId && row.status === 'pending');
        if (!request) {
          request = {
            id: crypto.randomUUID(), student_id: studentId, from_circle_id: other.circle_id,
            to_circle_id: circle.id, status: 'pending', requested_at: new Date().toISOString(),
          };
          state.transfers.unshift(request);
          addPreviewAudit(circle.id, 'circle.transfer_requested');
          savePreviewState();
        }
        return { status: 'transfer_required', transfer_request_id: request.id };
      }
    }
    const membership = {
      id: crypto.randomUUID(), circle_id: circle.id, student_id: studentId,
      circle_type: circle.circle_type, status: 'active', source: 'manual', joined_at: new Date().toISOString(),
    };
    state.memberships.push(membership);
    addPreviewAudit(circle.id, 'circle.student_added');
    savePreviewState();
    return { status: 'added', membership_id: membership.id };
  }

  async function handleStudentAction(event) {
    const button = event.target.closest('[data-student-action="remove"]');
    const circle = getSelectedCircle();
    if (!button || !circle || circle.status === 'archived') return;
    const membership = state.memberships.find(row => row.id === button.dataset.membershipId);
    if (!membership) return;
    const student = getAccount(membership.student_id);
    if (!window.confirm(`هل تريد إخراج ${student.full_name} من الحلقة؟ سيبقى سجل العضوية محفوظاً.`)) return;
    setButtonLoading(button, true, 'جاري الإخراج...');
    try {
      if (isLocalPreviewMode()) {
        Object.assign(membership, { status: 'ended', ended_at: new Date().toISOString(), ended_reason: 'removed_by_manager' });
        state.transfers.forEach(request => {
          if (request.student_id === membership.student_id && request.status === 'pending'
            && [request.from_circle_id, request.to_circle_id].includes(circle.id)) {
            request.status = 'cancelled';
          }
        });
        addPreviewAudit(circle.id, 'circle.student_removed');
        savePreviewState();
      } else {
        const { error } = await supabase.rpc('end_learning_circle_membership', {
          p_membership_id: membership.id,
          p_reason: 'removed_by_admin',
        });
        if (error) throw error;
      }
      await refresh();
      showToast('تم إخراج الطالب مع حفظ سجل عضويته.', 'success');
    } catch (error) {
      console.error('Membership end failed:', error);
      showToast(friendlyError(error, 'تعذر إخراج الطالب.'), 'error');
    } finally {
      setButtonLoading(button, false, 'إخراج من الحلقة');
    }
  }

  function handleTransferListClick(event) {
    const button = event.target.closest('[data-transfer-action]');
    if (!button) return;
    const request = state.transfers.find(row => row.id === button.dataset.transferId && row.status === 'pending');
    if (!request) return;
    const approve = button.dataset.transferAction === 'approve';
    document.getElementById('transfer-request-id').value = request.id;
    document.getElementById('transfer-decision-value').value = String(approve);
    document.getElementById('transfer-admin-notes').value = '';
    document.getElementById('transfer-decision-title').textContent = approve ? 'اعتماد نقل الطالب' : 'رفض طلب النقل';
    const student = getAccount(request.student_id);
    document.getElementById('transfer-decision-summary').textContent = `${student.full_name}: من ${getCircle(request.from_circle_id)?.name || 'الحلقة السابقة'} إلى ${getCircle(request.to_circle_id)?.name || 'الحلقة الجديدة'}.`;
    const submit = document.getElementById('transfer-decision-submit');
    submit.textContent = approve ? 'اعتماد النقل' : 'رفض الطلب';
    submit.className = approve ? 'admin-primary-button' : 'admin-danger-button';
    document.getElementById('transfer-decision-dialog').showModal();
  }

  async function handleTransferDecision(event) {
    event.preventDefault();
    const requestId = document.getElementById('transfer-request-id').value;
    const approve = document.getElementById('transfer-decision-value').value === 'true';
    const notes = document.getElementById('transfer-admin-notes').value.trim();
    const request = state.transfers.find(row => row.id === requestId && row.status === 'pending');
    if (!request) return;
    const button = document.getElementById('transfer-decision-submit');
    setButtonLoading(button, true, 'جاري تنفيذ القرار...');
    try {
      if (isLocalPreviewMode()) decidePreviewTransfer(request, approve, notes);
      else {
        const { error } = await supabase.rpc('decide_learning_circle_transfer', {
          p_request_id: request.id,
          p_approve: approve,
          p_admin_notes: notes || null,
        });
        if (error) throw error;
      }
      document.getElementById('transfer-decision-dialog').close();
      await refresh();
      showToast(approve ? 'تم نقل الطالب إلى الحلقة الجديدة.' : 'تم رفض طلب النقل.', 'success');
    } catch (error) {
      console.error('Transfer decision failed:', error);
      showToast(friendlyError(error, 'تعذر تنفيذ قرار النقل.'), 'error');
    } finally {
      setButtonLoading(button, false, approve ? 'اعتماد النقل' : 'رفض الطلب');
    }
  }

  function decidePreviewTransfer(request, approve, notes) {
    request.status = approve ? 'approved' : 'rejected';
    request.admin_notes = notes || null;
    request.decided_at = new Date().toISOString();
    if (approve) {
      state.memberships.forEach(row => {
        if (row.student_id === request.student_id && row.circle_type === 'quran' && row.status === 'active') {
          Object.assign(row, { status: 'ended', ended_at: new Date().toISOString(), ended_reason: 'transferred' });
        }
      });
      state.memberships.push({
        id: crypto.randomUUID(), circle_id: request.to_circle_id, student_id: request.student_id,
        circle_type: 'quran', status: 'active', source: 'transfer', joined_at: new Date().toISOString(),
      });
    }
    addPreviewAudit(request.to_circle_id, approve ? 'circle.transfer_approved' : 'circle.transfer_rejected');
    savePreviewState();
  }

  async function invokeCircleDeletionAction(body) {
    const { data, error } = await supabase.functions.invoke('admin-account-actions', { body });
    if (error) {
      let message = data?.error || error.message;
      try {
        const payload = await error.context?.json();
        if (payload?.error) message = payload.error;
      } catch {
        // Keep the SDK message when the response has no JSON body.
      }
      throw new Error(message || 'تعذر تنفيذ العملية.');
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  function renderCircleDeleteImpact(impact) {
    const fields = [
      ['active_students', 'طلاب نشطون'],
      ['staff', 'تكليفات المعلمين'],
      ['quran_assignments', 'تقارير القرآن'],
      ['completed_quran_assignments', 'تقارير منجزة'],
      ['posts', 'المنشورات'],
      ['files', 'الملفات'],
      ['pending_transfers', 'طلبات نقل معلقة'],
    ];
    document.getElementById('delete-circle-impact').innerHTML = fields.map(([key, label]) => `
      <span>${escapeHtml(label)} <b>${Number(impact?.[key] || 0).toLocaleString('ar')}</b></span>
    `).join('');
  }

  async function openDeleteCircleDialog() {
    const circle = getSelectedCircle();
    if (!circle) return;
    const form = document.getElementById('delete-circle-form');
    form.reset();
    document.getElementById('delete-circle-id').value = circle.id;
    document.getElementById('delete-circle-name').value = circle.name;
    document.getElementById('delete-circle-label').textContent = circle.name;
    document.getElementById('delete-circle-hint').textContent = `اكتب «${circle.name}» كما يظهر تماماً.`;
    const impactContainer = document.getElementById('delete-circle-impact');
    impactContainer.textContent = 'جاري حساب البيانات التي ستُحذف...';
    document.getElementById('delete-circle-dialog').showModal();
    requestAnimationFrame(() => document.getElementById('delete-circle-confirmation').focus());

    try {
      if (isLocalPreviewMode()) {
        renderCircleDeleteImpact({
          active_students: state.memberships.filter(row => row.circle_id === circle.id && row.status === 'active').length,
          staff: state.staff.filter(row => row.circle_id === circle.id).length,
          pending_transfers: state.transfers.filter(row => row.status === 'pending' && [row.from_circle_id, row.to_circle_id].includes(circle.id)).length,
        });
      } else {
        const result = await invokeCircleDeletionAction({ action: 'delete_circle_impact', circleId: circle.id });
        renderCircleDeleteImpact(result.impact);
      }
    } catch (error) {
      impactContainer.textContent = error.message || 'تعذر حساب أثر حذف الحلقة.';
    }
  }

  async function handleDeleteCircle(event) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const circleId = document.getElementById('delete-circle-id').value;
    const circle = state.circles.find(item => item.id === circleId);
    const confirmation = document.getElementById('delete-circle-confirmation').value.trim();
    if (!circle) return;
    if (confirmation !== circle.name.trim()) {
      showToast('اسم الحلقة المكتوب غير مطابق.', 'error');
      return;
    }

    const button = document.getElementById('delete-circle-submit');
    setButtonLoading(button, true, 'جاري الحذف النهائي...');
    try {
      let result = null;
      if (isLocalPreviewMode()) {
        state.circles = state.circles.filter(row => row.id !== circleId);
        state.circleSubjects = state.circleSubjects.filter(row => row.circle_id !== circleId);
        state.staff = state.staff.filter(row => row.circle_id !== circleId);
        state.memberships = state.memberships.filter(row => row.circle_id !== circleId);
        state.transfers = state.transfers.filter(row => row.from_circle_id !== circleId && row.to_circle_id !== circleId);
        state.activities = state.activities.filter(row => row.circle_id !== circleId);
        savePreviewState();
      } else {
        result = await invokeCircleDeletionAction({
          action: 'delete_circle', circleId, confirmation,
        });
      }
      document.getElementById('delete-circle-dialog').close();
      document.getElementById('manage-circle-dialog').close();
      state.selectedCircleId = null;
      await refresh();
      showToast('تم حذف الحلقة وبياناتها نهائياً.', 'success');
      if (result?.warning) showToast(result.warning, 'warning');
    } catch (error) {
      console.error('Circle hard deletion failed:', error);
      showToast(friendlyError(error, 'تعذر حذف الحلقة نهائياً.'), 'error');
    } finally {
      setButtonLoading(button, false, 'حذف الحلقة نهائياً');
    }
  }

  async function handleArchiveCircle() {
    const circle = getSelectedCircle();
    if (!circle || circle.status === 'archived') return;
    if (!window.confirm(`أرشفة ${circle.name} ستنهي عضويات الطلاب وتكليفات المعلمين. هل تريد المتابعة؟`)) return;
    const button = document.getElementById('archive-circle');
    setButtonLoading(button, true, 'جاري الأرشفة...');
    try {
      if (isLocalPreviewMode()) {
        Object.assign(circle, { status: 'archived', archived_at: new Date().toISOString() });
        state.staff.forEach(row => {
          if (row.circle_id === circle.id && row.status === 'active') Object.assign(row, { status: 'ended', ended_at: new Date().toISOString() });
        });
        state.memberships.forEach(row => {
          if (row.circle_id === circle.id && row.status === 'active') Object.assign(row, { status: 'ended', ended_at: new Date().toISOString(), ended_reason: 'circle_archived' });
        });
        state.transfers.forEach(request => {
          if (request.status === 'pending' && [request.from_circle_id, request.to_circle_id].includes(circle.id)) request.status = 'cancelled';
        });
        addPreviewAudit(circle.id, 'circle.archived');
        savePreviewState();
      } else {
        const { error } = await supabase.rpc('archive_learning_circle', { p_circle_id: circle.id });
        if (error) throw error;
      }
      document.getElementById('manage-circle-dialog').close();
      state.selectedCircleId = null;
      await refresh();
      showToast('تمت أرشفة الحلقة مع حفظ سجلها.', 'success');
    } catch (error) {
      console.error('Circle archive failed:', error);
      showToast(friendlyError(error, 'تعذر أرشفة الحلقة.'), 'error');
    } finally {
      setButtonLoading(button, false, 'أرشفة الحلقة');
    }
  }

  function renderSubjectChoices(containerId, selectedIds) {
    const selected = new Set(selectedIds);
    const container = document.getElementById(containerId);
    container.innerHTML = state.subjects.map(subject => `
      <label><input type="checkbox" value="${escapeHtml(subject.id)}" ${selected.has(subject.id) ? 'checked' : ''}><span>${escapeHtml(subject.name)}</span></label>
    `).join('') || '<span class="admin-panel-meta">لا توجد مواد مضافة في النظام.</span>';
  }

  function buildAccountOptions(accounts, placeholder, selectedId = '') {
    return `<option value="">${escapeHtml(placeholder)}</option>${accounts.map(account => `
      <option value="${escapeHtml(account.id)}" ${account.id === selectedId ? 'selected' : ''}>${escapeHtml(account.full_name)} (@${escapeHtml(account.username || '')})</option>
    `).join('')}`;
  }

  function getCheckedValues(containerId) {
    return [...document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)].map(input => input.value);
  }

  function getActiveAccounts(role) {
    return getAccounts().filter(account => account.role === role && account.is_active)
      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ar'));
  }

  function getAccount(id) {
    return getAccounts().find(account => account.id === id) || {
      id: id || '', full_name: id ? 'حساب غير متاح' : 'غير معيّن', username: '',
    };
  }

  function getCircle(id) {
    return state.circles.find(circle => circle.id === id);
  }

  function getSelectedCircle() {
    return getCircle(state.selectedCircleId);
  }

  function getCircleStaff(circleId) {
    return state.staff.filter(row => row.circle_id === circleId && row.status === 'active');
  }

  function getCircleLead(circleId) {
    return getCircleStaff(circleId).find(row => row.staff_role === 'lead');
  }

  function getCircleMemberships(circleId) {
    return state.memberships.filter(row => row.circle_id === circleId && row.status === 'active');
  }

  function getCircleSubjects(circleId) {
    const ids = new Set(state.circleSubjects.filter(link => link.circle_id === circleId).map(link => link.subject_id));
    return state.subjects.filter(subject => ids.has(subject.id));
  }

  function createPreviewStaff(circleId, teacherId, role) {
    const permissions = allPermissions(role === 'lead');
    if (role === 'assistant') permissions.can_track_students = true;
    return {
      id: crypto.randomUUID(), circle_id: circleId, teacher_id: teacherId,
      staff_role: role, status: 'active', started_at: new Date().toISOString(),
      ...permissions,
    };
  }

  function allPermissions(value) {
    return Object.fromEntries(PERMISSIONS.map(([, column]) => [column, value]));
  }

  function addPreviewAudit(circleId, action) {
    state.activities.unshift({
      id: `${Date.now()}`, actor_id: getAccounts().find(account => account.role === 'admin')?.id || null,
      circle_id: circleId, action, created_at: new Date().toISOString(),
    });
  }

  function friendlyError(error, fallback) {
    const message = String(error?.message || '');
    if (/active teacher/i.test(message)) return 'يجب اختيار حساب معلم نشط.';
    if (/at least one subject|require at least one subject/i.test(message)) return 'اختر مادة واحدة على الأقل.';
    if (/permission|administrator|42501/i.test(message)) return 'لا تملك صلاحية تنفيذ هذه العملية.';
    if (/already|duplicate|unique/i.test(message)) return 'هذا الربط موجود بالفعل.';
    if (/meet/i.test(message)) return 'رابط Google Meet غير صحيح.';
    return fallback;
  }

  function setButtonLoading(button, loading, label) {
    button.disabled = loading;
    button.textContent = label;
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
  }

  function getInitial(value) {
    return String(value || 'م').trim().charAt(0) || 'م';
  }

  function formatShortDate(value) {
    if (!value) return 'غير محدد';
    return new Intl.DateTimeFormat('ar-OM', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
  }

  function formatRelativeTime(value) {
    const date = new Date(value);
    const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
    if (minutes < 1) return 'الآن';
    if (minutes < 60) return `منذ ${minutes} د`;
    if (minutes < 1440) return `منذ ${Math.floor(minutes / 60)} س`;
    return formatShortDate(value);
  }

  return { setup, refresh, render };
}
