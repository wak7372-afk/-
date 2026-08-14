import { supabase } from '../lib/supabase-client.js';
import { isLocalPreviewMode, logoutUser, requireAuth } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, getSafeExternalUrl, showToast } from '../lib/utils.js';
import { createQuranReportManager } from './quran-report-manager.js?v=5';
import { mountTeacherShell } from '../lib/teacher-shell.js';

const POST_TYPES = {
  announcement: { label: 'إعلان', icon: 'megaphone' },
  meeting: { label: 'لقاء مباشر', icon: 'video' },
  resource: { label: 'مورد', icon: 'folder-up' },
  discussion: { label: 'موضوع نقاش', icon: 'messages-square' },
  system: { label: 'رسالة النظام', icon: 'shield-check' },
};

const PARTICIPANT_LABELS = {
  admin: 'مدير المنصة',
  lead: 'المعلم المسؤول',
  assistant: 'معلم مساعد',
  student: 'طالب',
};

const state = {
  profile: null,
  circleId: null,
  workspace: null,
  selectedPostType: null,
  activeTab: 'stream',
};

let quranReportManager = null;

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
  await initI18n();
  state.circleId = new URLSearchParams(window.location.search).get('id');
  if (!state.circleId) {
    window.location.replace('./circles.html');
    return;
  }

  const previewRole = getPreviewRole();
  const allowedRoles = previewRole
    ? [previewRole, ...['admin', 'teacher', 'student'].filter(role => role !== previewRole)]
    : ['admin', 'teacher', 'student'];
  const authData = await requireAuth(allowedRoles);
  if (!authData) return;

  state.profile = authData.profile;
  if (state.profile.role === 'teacher') mountTeacherShell('circles');
  setupStaticControls();
  await loadWorkspace();
  renderWorkspace();
  const requestedTab = window.location.hash.replace('#', '');
  if (['stream', 'work', 'people', 'files', 'performance', 'settings'].includes(requestedTab)) {
    switchTab(requestedTab);
  }
}

function getPreviewRole() {
  if (!isLocalPreviewMode()) return null;
  const role = new URLSearchParams(window.location.search).get('role');
  return ['admin', 'teacher', 'student'].includes(role) ? role : 'teacher';
}

function setupStaticControls() {
  const backLink = document.getElementById('back-to-circles');
  const params = new URLSearchParams();
  if (isLocalPreviewMode()) {
    params.set('preview', '1');
    params.set('role', state.profile.role);
  }
  backLink.href = `./circles.html${params.size ? `?${params.toString()}` : ''}`;

  document.getElementById('logout-btn').addEventListener('click', logoutUser);
  document.querySelectorAll('[data-workspace-tab]').forEach(button => {
    button.addEventListener('click', () => switchTab(button.dataset.workspaceTab));
  });
  document.getElementById('post-composer').addEventListener('submit', handleCreatePost);
  document.getElementById('workspace-feed').addEventListener('click', handleFeedAction);
  document.getElementById('workspace-feed').addEventListener('submit', handleReplySubmit);
  document.getElementById('file-upload-form').addEventListener('submit', handleFileUpload);
  document.getElementById('circle-file').addEventListener('change', updateFilePickerLabel);
  document.getElementById('workspace-files-list').addEventListener('click', handleFileAction);
  document.getElementById('meet-settings-form').addEventListener('submit', handleMeetSettings);
  document.getElementById('discussion-settings-form').addEventListener('submit', handleDiscussionSettings);
}

async function loadWorkspace() {
  if (isLocalPreviewMode()) {
    state.workspace = previewWorkspace(state.profile.role, state.circleId);
    return;
  }

  const { data, error } = await supabase.rpc('get_learning_circle_workspace', {
    p_circle_id: state.circleId,
  });
  if (error || !data?.circle) {
    console.error('Unable to load circle workspace:', error);
    showToast('تعذر فتح الحلقة أو لا تملك صلاحية الوصول إليها.', 'error');
    window.setTimeout(() => window.location.replace('./circles.html'), 1000);
    return;
  }
  state.workspace = data;
}

function renderWorkspace() {
  if (!state.workspace?.circle) return;
  renderHeader();
  renderComposer();
  renderFeed();
  renderWorkPanel();
  renderPeople();
  renderFiles();
  renderPerformance();
  renderSettings();
  refreshIcons();
}

function renderHeader() {
  const { circle, permissions, people } = state.workspace;
  const quran = circle.circle_type === 'quran';
  const participantRole = PARTICIPANT_LABELS[permissions.staff_role || (permissions.is_admin ? 'admin' : 'student')] || 'عضو';
  document.title = `مركز ذات خيل لتعليم القرآن الكريم وعلومه | ${circle.name}`;
  document.getElementById('workspace-title').textContent = circle.name;
  document.getElementById('workspace-role-label').textContent = participantRole;
  document.getElementById('workspace-type').textContent = quran ? 'حلقة قرآنية' : 'حلقة تعليمية';
  document.getElementById('workspace-participant-role').textContent = participantRole;
  document.getElementById('workspace-hero-title').textContent = circle.name;
  document.getElementById('workspace-description').textContent = circle.description || (quran ? 'متابعة قرآنية منظمة للحفظ والمراجعة والتثبيت.' : 'دروس ومهام وموارد تعليمية مرتبطة بمواد الحلقة.');
  document.getElementById('workspace-students-count').textContent = Number(people.students_count || 0);
  document.getElementById('workspace-user-name').textContent = state.profile.full_name || state.profile.username || 'حسابي';
  document.getElementById('workspace-user-role').textContent = participantRole;
  document.getElementById('workspace-user-avatar').textContent = firstCharacter(state.profile.full_name || state.profile.username || 'م');
  document.getElementById('work-tab-label').textContent = quran ? 'التقارير' : 'المهام';
  document.getElementById('work-heading').textContent = quran ? 'تقارير الحلقة' : 'مهام الحلقة';
  document.getElementById('workspace-subjects').innerHTML = (circle.subjects || []).map(subject => `<span>${escapeHtml(subject.name)}</span>`).join('');

  const meetLink = document.getElementById('top-meet-link');
  const safeMeetLink = getSafeExternalUrl(circle.meet_link);
  meetLink.hidden = !safeMeetLink;
  if (safeMeetLink) meetLink.href = safeMeetLink;
  renderCircleSidebarContext(circle, participantRole, quran);
}

function renderCircleSidebarContext(circle, participantRole, quran) {
  const note = document.querySelector('.teacher-sidebar-note');
  if (!note) return;
  note.classList.add('is-circle-context');
  note.innerHTML = `<i data-lucide="${quran ? 'book-open-check' : 'graduation-cap'}"></i><span><small>أنت داخل</small><strong>${escapeHtml(circle.name)}</strong><small>${escapeHtml(participantRole)}</small></span>`;
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('[data-workspace-tab]').forEach(button => {
    const active = button.dataset.workspaceTab === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-workspace-panel]').forEach(panel => {
    const active = panel.dataset.workspacePanel === tab;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  });
  window.location.hash = tab;
}

function allowedPostTypes() {
  const permissions = state.workspace.permissions;
  const types = [];
  if (permissions.can_post_announcements) types.push('announcement', 'meeting', 'resource');
  if (permissions.can_create_topics) types.push('discussion');
  return types;
}

function renderComposer() {
  const form = document.getElementById('post-composer');
  const types = allowedPostTypes();
  form.hidden = !types.length;
  if (!types.length) return;

  if (!types.includes(state.selectedPostType)) state.selectedPostType = types[0];
  document.getElementById('post-type-control').innerHTML = types.map(type => `
    <button type="button" class="${type === state.selectedPostType ? 'is-active' : ''}" data-post-type="${type}">
      <i data-lucide="${POST_TYPES[type].icon}"></i><span>${POST_TYPES[type].label}</span>
    </button>`).join('');
  document.querySelectorAll('[data-post-type]').forEach(button => {
    button.addEventListener('click', () => {
      state.selectedPostType = button.dataset.postType;
      renderComposer();
      refreshIcons();
    });
  });
  document.getElementById('post-url-field').hidden = !['meeting', 'resource'].includes(state.selectedPostType);
  document.getElementById('post-replies-field').hidden = state.selectedPostType !== 'discussion';
  document.getElementById('post-external-url').placeholder = state.selectedPostType === 'meeting'
    ? 'https://meet.google.com/...'
    : 'https://...';
  document.getElementById('composer-permission-label').textContent = state.workspace.permissions.is_student
    ? 'موضوع تعليمي جديد'
    : 'نشر باسم فريق الحلقة';
}

async function handleCreatePost(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.getElementById('publish-post');
  const payload = {
    postType: state.selectedPostType,
    title: document.getElementById('post-title').value.trim(),
    body: document.getElementById('post-body').value.trim(),
    externalUrl: document.getElementById('post-external-url').value.trim(),
    repliesEnabled: document.getElementById('post-replies-enabled').checked,
  };
  if (!payload.title) return;

  setButtonBusy(button, true, 'جاري النشر...');
  try {
    if (isLocalPreviewMode()) {
      state.workspace.posts.unshift(createPreviewPost(payload));
    } else {
      const { error } = await supabase.rpc('create_learning_circle_post', {
        p_circle_id: state.circleId,
        p_post_type: payload.postType,
        p_title: payload.title,
        p_body: payload.body || null,
        p_external_url: payload.externalUrl || null,
        p_replies_enabled: payload.repliesEnabled,
        p_is_pinned: false,
      });
      if (error) throw error;
      await reloadWorkspace();
    }
    form.reset();
    showToast('تم نشر المحتوى في ساحة الحلقة.', 'success');
    renderWorkspace();
  } catch (error) {
    console.error('Post creation failed:', error);
    showToast(friendlyWorkspaceError(error, 'تعذر نشر المحتوى.'), 'error');
  } finally {
    setButtonBusy(button, false, 'نشر');
  }
}

function renderFeed() {
  const posts = (state.workspace.posts || []).filter(post => post.status !== 'archived' || canModeratePost(post));
  const container = document.getElementById('workspace-feed');
  document.getElementById('posts-count').textContent = `${posts.filter(post => post.status === 'published').length} منشور`;
  if (!posts.length) {
    container.innerHTML = '<div class="workspace-empty-state"><i data-lucide="panel-top-inactive"></i><p>لا توجد منشورات في ساحة الحلقة بعد.</p></div>';
    refreshIcons();
    return;
  }

  container.innerHTML = posts.map(renderPost).join('');
  refreshIcons();
}

function renderPost(post) {
  const type = POST_TYPES[post.post_type] || POST_TYPES.system;
  const authorName = post.author?.full_name || 'نظام مركز ذات خيل';
  const externalUrl = getSafeExternalUrl(post.external_url);
  const canModerate = canModeratePost(post);
  const replies = Array.isArray(post.replies) ? post.replies : [];
  const canReply = state.workspace.permissions.can_reply && post.replies_enabled && post.status === 'published';
  return `
    <article class="workspace-post ${post.is_pinned ? 'is-pinned' : ''} ${post.post_type === 'system' ? 'is-system' : ''}" data-post-id="${escapeHtml(post.id)}">
      <div class="post-main">
        <header class="post-header">
          <div class="post-author">
            <span class="post-avatar">${escapeHtml(firstCharacter(authorName))}</span>
            <div class="post-author-copy"><strong>${escapeHtml(authorName)}</strong><span>${escapeHtml(roleLabel(post.author?.role))} · ${escapeHtml(formatDateTime(post.published_at))}</span></div>
          </div>
          <span class="post-type-label"><i data-lucide="${type.icon}"></i>${escapeHtml(type.label)}${post.is_pinned ? ' · مثبت' : ''}${post.status === 'archived' ? ' · مؤرشف' : ''}</span>
        </header>
        <h3>${escapeHtml(post.title)}</h3>
        ${post.body ? `<p class="post-body">${escapeHtml(post.body)}</p>` : ''}
        ${externalUrl ? `<a class="post-external-link" href="${escapeHtml(externalUrl)}" target="_blank" rel="noopener noreferrer"><i data-lucide="external-link"></i><span>${post.post_type === 'meeting' ? 'دخول اللقاء' : 'فتح الرابط'}</span></a>` : ''}
        ${canModerate && post.status === 'published' ? `
          <div class="post-actions">
            ${post.post_type === 'discussion' ? `<button type="button" data-post-action="${post.replies_enabled ? 'close' : 'reopen'}" data-post-id="${escapeHtml(post.id)}"><i data-lucide="${post.replies_enabled ? 'message-square-off' : 'message-square-more'}"></i>${post.replies_enabled ? 'إغلاق الردود' : 'فتح الردود'}</button>` : ''}
            <button type="button" data-post-action="${post.is_pinned ? 'unpin' : 'pin'}" data-post-id="${escapeHtml(post.id)}"><i data-lucide="pin"></i>${post.is_pinned ? 'إلغاء التثبيت' : 'تثبيت'}</button>
            <button type="button" class="is-danger" data-post-action="archive" data-post-id="${escapeHtml(post.id)}"><i data-lucide="archive"></i>أرشفة</button>
          </div>` : ''}
      </div>
      ${replies.length || canReply ? `
        <div class="post-replies">
          ${replies.map(reply => renderReply(reply, canModerate)).join('')}
          ${canReply ? `<form class="post-reply-form" data-reply-form="${escapeHtml(post.id)}"><input type="text" name="reply" maxlength="5000" required placeholder="اكتب رداً..."><button type="submit" title="إرسال الرد" aria-label="إرسال الرد"><i data-lucide="send"></i></button></form>` : ''}
        </div>` : ''}
    </article>`;
}

function renderReply(reply, canModerate) {
  const removed = reply.status === 'removed';
  return `
    <div class="post-reply">
      <span class="person-avatar">${escapeHtml(firstCharacter(reply.author?.full_name || 'م'))}</span>
      <div class="post-reply-copy">
        <strong>${escapeHtml(reply.author?.full_name || 'عضو')}</strong><time>${escapeHtml(formatDateTime(reply.created_at))}</time>
        <p>${removed ? 'تمت إزالة هذا الرد بواسطة الإشراف.' : escapeHtml(reply.body)}</p>
      </div>
      ${canModerate && !removed ? `<button type="button" class="circle-icon-command is-danger" data-remove-reply="${escapeHtml(reply.id)}" title="إزالة الرد" aria-label="إزالة الرد"><i data-lucide="trash-2"></i></button>` : ''}
    </div>`;
}

function canModeratePost(post) {
  return post.post_type === 'discussion'
    ? Boolean(state.workspace.permissions.can_manage_discussions)
    : Boolean(state.workspace.permissions.can_post_announcements);
}

async function handleFeedAction(event) {
  const replyButton = event.target.closest('[data-remove-reply]');
  if (replyButton) {
    await removeReply(replyButton.dataset.removeReply);
    return;
  }
  const button = event.target.closest('[data-post-action]');
  if (!button) return;
  const action = button.dataset.postAction;
  if (action === 'archive' && !window.confirm('هل تريد أرشفة هذا المنشور؟')) return;
  setButtonBusy(button, true, '...');
  try {
    if (isLocalPreviewMode()) {
      const post = state.workspace.posts.find(item => item.id === button.dataset.postId);
      applyPreviewModeration(post, action);
    } else {
      const { error } = await supabase.rpc('moderate_learning_circle_post', {
        p_post_id: button.dataset.postId,
        p_action: action,
      });
      if (error) throw error;
      await reloadWorkspace();
    }
    renderWorkspace();
  } catch (error) {
    showToast(friendlyWorkspaceError(error, 'تعذر تنفيذ الإجراء.'), 'error');
  } finally {
    setButtonBusy(button, false, '');
  }
}

async function handleReplySubmit(event) {
  const form = event.target.closest('[data-reply-form]');
  if (!form) return;
  event.preventDefault();
  const input = form.elements.reply;
  const body = input.value.trim();
  if (!body) return;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    if (isLocalPreviewMode()) {
      const post = state.workspace.posts.find(item => item.id === form.dataset.replyForm);
      post.replies.push({ id: crypto.randomUUID(), body, status: 'published', created_at: new Date().toISOString(), author: { full_name: state.profile.full_name, role: state.profile.role } });
    } else {
      const { error } = await supabase.rpc('reply_to_learning_circle_post', {
        p_post_id: form.dataset.replyForm,
        p_body: body,
      });
      if (error) throw error;
      await reloadWorkspace();
    }
    input.value = '';
    renderFeed();
  } catch (error) {
    showToast(friendlyWorkspaceError(error, 'تعذر إرسال الرد.'), 'error');
  } finally {
    button.disabled = false;
  }
}

async function removeReply(replyId) {
  if (!window.confirm('هل تريد إزالة هذا الرد من الساحة؟')) return;
  try {
    if (isLocalPreviewMode()) {
      state.workspace.posts.forEach(post => {
        const reply = post.replies.find(item => item.id === replyId);
        if (reply) reply.status = 'removed';
      });
    } else {
      const { error } = await supabase.rpc('remove_learning_circle_reply', { p_reply_id: replyId });
      if (error) throw error;
      await reloadWorkspace();
    }
    renderFeed();
  } catch (error) {
    showToast(friendlyWorkspaceError(error, 'تعذر إزالة الرد.'), 'error');
  }
}

function renderWorkPanel() {
  const quran = state.workspace.circle.circle_type === 'quran';
  const staff = state.workspace.permissions.is_staff || state.workspace.permissions.is_admin;
  const container = document.getElementById('workspace-work-content');
  if (quran && staff && (state.workspace.permissions.can_create_tasks || state.workspace.permissions.can_review_submissions)) {
    if (!quranReportManager) {
      quranReportManager = createQuranReportManager({
        container,
        supabase,
        getContext: () => ({
          circle: state.workspace.circle,
          workspace: state.workspace,
          profile: state.profile,
        }),
        refreshIcons,
      });
    }
    quranReportManager.render();
    return;
  }
  const href = quran
    ? (staff ? './teacher/tasks.html' : './student/dashboard.html')
    : (staff ? './teacher/classrooms.html' : './student/dashboard.html');
  container.className = 'workspace-empty-state';
  container.innerHTML = `
    <i data-lucide="${quran ? 'book-heart' : 'clipboard-list'}"></i>
    <strong>${quran ? 'لا توجد تقارير منشورة لهذه الحلقة اليوم.' : 'لا توجد مهام منشورة لهذه الحلقة حالياً.'}</strong>
    <a class="circle-open-command" href="${href}">${staff ? (quran ? 'إدارة التقارير' : 'إدارة المهام') : 'العودة إلى يومي'}<i data-lucide="arrow-left"></i></a>`;
}

function renderPeople() {
  const people = state.workspace.people;
  const staff = Array.isArray(people.staff) ? people.staff : [];
  const students = Array.isArray(people.students) ? people.students : [];
  document.getElementById('staff-count').textContent = staff.length;
  document.getElementById('people-students-count').textContent = Number(people.students_count || 0);
  document.getElementById('staff-list').innerHTML = staff.length ? staff.map(person => `
    <div class="person-row">
      <span class="person-avatar">${escapeHtml(firstCharacter(person.full_name))}</span>
      <div class="person-copy"><strong>${escapeHtml(person.full_name)}</strong><span>${person.staff_role === 'lead' ? 'المعلم المسؤول' : 'معلم مساعد'} · @${escapeHtml(person.username || '')}</span></div>
      ${person.staff_role === 'assistant' ? `<div class="person-permissions">${assistantPermissionLabels(person.permissions).map(label => `<span>${escapeHtml(label)}</span>`).join('')}</div>` : ''}
    </div>`).join('') : '<div class="workspace-empty-state"><p>لا يوجد فريق نشط.</p></div>';

  if (students.length) {
    document.getElementById('students-list').innerHTML = students.map(person => `
      <div class="person-row">
        <span class="person-avatar">${escapeHtml(firstCharacter(person.full_name))}</span>
        <div class="person-copy"><strong>${escapeHtml(person.full_name)}</strong><span>@${escapeHtml(person.username || '')} · ${escapeHtml(membershipLabel(person.status))}</span></div>
      </div>`).join('');
  } else {
    document.getElementById('students-list').innerHTML = '<div class="workspace-empty-state"><i data-lucide="shield-check"></i><p>تظهر قائمة الطلاب لفريق الحلقة والإدارة.</p></div>';
  }
}

function renderFiles() {
  const files = (state.workspace.files || []).filter(file => file.status === 'active');
  document.getElementById('files-count').textContent = `${files.length} ملف`;
  document.getElementById('file-upload-form').hidden = !state.workspace.permissions.can_upload_files;
  const container = document.getElementById('workspace-files-list');
  if (!files.length) {
    container.innerHTML = '<div class="workspace-empty-state"><i data-lucide="folder-open"></i><p>لا توجد ملفات منشورة في الحلقة.</p></div>';
    return;
  }
  container.innerHTML = files.map(file => {
    const canRemove = state.workspace.permissions.can_manage_people || file.uploader?.id === state.profile.id;
    return `
      <article class="workspace-file-row">
        <span class="file-type-icon"><i data-lucide="${fileIcon(file.mime_type)}"></i></span>
        <div class="file-row-copy"><strong>${escapeHtml(file.title)}</strong><span>${escapeHtml(file.original_name)} · ${escapeHtml(formatFileSize(file.size_bytes))} · ${escapeHtml(file.uploader?.full_name || '')}</span></div>
        <div class="file-row-actions">
          <button type="button" data-download-file="${escapeHtml(file.id)}" title="تنزيل الملف" aria-label="تنزيل الملف"><i data-lucide="download"></i></button>
          ${canRemove ? `<button type="button" class="is-danger" data-remove-file="${escapeHtml(file.id)}" title="حذف الملف" aria-label="حذف الملف"><i data-lucide="trash-2"></i></button>` : ''}
        </div>
      </article>`;
  }).join('');
}

function updateFilePickerLabel(event) {
  const file = event.target.files?.[0];
  document.getElementById('file-picker-title').textContent = file ? file.name : 'اختيار ملف';
  if (file && !document.getElementById('file-title').value.trim()) {
    document.getElementById('file-title').value = file.name.replace(/\.[^.]+$/, '');
  }
}

async function handleFileUpload(event) {
  event.preventDefault();
  const file = document.getElementById('circle-file').files?.[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    showToast('حجم الملف يتجاوز 20 MB.', 'error');
    return;
  }
  const button = document.getElementById('upload-file');
  const title = document.getElementById('file-title').value.trim();
  const description = document.getElementById('file-description').value.trim();
  setButtonBusy(button, true, 'جاري الرفع...');

  try {
    if (isLocalPreviewMode()) {
      state.workspace.files.unshift({
        id: crypto.randomUUID(), title, description, storage_path: '', original_name: file.name,
        mime_type: file.type || 'application/octet-stream', size_bytes: file.size, status: 'active',
        created_at: new Date().toISOString(), uploader: { id: state.profile.id, full_name: state.profile.full_name },
      });
    } else {
      await uploadRealCircleFile(file, title, description);
      await reloadWorkspace();
    }
    event.currentTarget.reset();
    document.getElementById('file-picker-title').textContent = 'اختيار ملف';
    showToast('تم رفع الملف ونشره لأعضاء الحلقة.', 'success');
    renderWorkspace();
  } catch (error) {
    console.error('Circle file upload failed:', error);
    showToast(friendlyWorkspaceError(error, 'تعذر رفع الملف.'), 'error');
  } finally {
    setButtonBusy(button, false, 'رفع ونشر');
  }
}

async function uploadRealCircleFile(file, title, description) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-180) || 'file';
  const storagePath = `${state.circleId}/${state.profile.id}/${crypto.randomUUID()}-${safeName}`;
  const { error: uploadError } = await supabase.storage.from('circle-files').upload(storagePath, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || undefined,
  });
  if (uploadError) throw uploadError;

  let postId = null;
  try {
    const { data, error: postError } = await supabase.rpc('create_learning_circle_post', {
      p_circle_id: state.circleId,
      p_post_type: 'resource',
      p_title: title,
      p_body: description || null,
      p_external_url: null,
      p_replies_enabled: false,
      p_is_pinned: false,
    });
    if (postError) throw postError;
    postId = data;

    const { error: registerError } = await supabase.rpc('register_learning_circle_file', {
      p_circle_id: state.circleId,
      p_storage_path: storagePath,
      p_original_name: file.name,
      p_title: title,
      p_description: description || null,
      p_mime_type: file.type || 'application/octet-stream',
      p_size_bytes: file.size,
      p_post_id: postId,
    });
    if (registerError) throw registerError;
  } catch (error) {
    await supabase.storage.from('circle-files').remove([storagePath]);
    if (postId) await supabase.rpc('moderate_learning_circle_post', { p_post_id: postId, p_action: 'archive' });
    throw error;
  }
}

async function handleFileAction(event) {
  const downloadButton = event.target.closest('[data-download-file]');
  if (downloadButton) {
    const file = state.workspace.files.find(item => item.id === downloadButton.dataset.downloadFile);
    if (!file) return;
    if (isLocalPreviewMode()) {
      showToast('التنزيل متاح للحسابات الفعلية بعد رفع الملف إلى التخزين الخاص.', 'info');
      return;
    }
    const { data, error } = await supabase.storage.from('circle-files').createSignedUrl(file.storage_path, 120);
    if (error || !data?.signedUrl) {
      showToast('تعذر إنشاء رابط تنزيل آمن.', 'error');
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    return;
  }

  const removeButton = event.target.closest('[data-remove-file]');
  if (!removeButton || !window.confirm('هل تريد حذف هذا الملف من الحلقة؟')) return;
  const file = state.workspace.files.find(item => item.id === removeButton.dataset.removeFile);
  if (!file) return;
  try {
    if (isLocalPreviewMode()) {
      file.status = 'removed';
    } else {
      const { data: storagePath, error } = await supabase.rpc('remove_learning_circle_file', { p_file_id: file.id });
      if (error) throw error;
      const { error: storageError } = await supabase.storage.from('circle-files').remove([storagePath]);
      if (storageError) console.error('Private object cleanup failed:', storageError);
      await reloadWorkspace();
    }
    renderFiles();
    refreshIcons();
    showToast('تم حذف الملف من الحلقة.', 'success');
  } catch (error) {
    showToast(friendlyWorkspaceError(error, 'تعذر حذف الملف.'), 'error');
  }
}

function renderPerformance() {
  const activePosts = (state.workspace.posts || []).filter(post => post.status === 'published').length;
  const activeFiles = (state.workspace.files || []).filter(file => file.status === 'active').length;
  const replies = (state.workspace.posts || []).reduce((total, post) => total + (post.replies || []).filter(reply => reply.status === 'published').length, 0);
  document.getElementById('workspace-performance').innerHTML = `
    <article class="performance-metric"><span>الطلاب النشطون</span><strong>${Number(state.workspace.people.students_count || 0)}</strong></article>
    <article class="performance-metric is-gold"><span>منشورات الساحة</span><strong>${activePosts}</strong></article>
    <article class="performance-metric is-blue"><span>ملفات الحلقة</span><strong>${activeFiles}</strong></article>
    <article class="performance-metric is-red"><span>الردود المنشورة</span><strong>${replies}</strong></article>`;
}

function renderSettings() {
  const { circle, permissions, settings } = state.workspace;
  const meetForm = document.getElementById('meet-settings-form');
  const meetInput = document.getElementById('settings-meet-link');
  const meetButton = document.getElementById('save-meet-settings');
  meetInput.value = circle.meet_link || '';
  meetInput.disabled = !permissions.can_manage_meet_link;
  meetButton.disabled = !permissions.can_manage_meet_link;
  meetForm.setAttribute('aria-disabled', String(!permissions.can_manage_meet_link));
  document.getElementById('meet-settings-status').textContent = circle.meet_link ? 'رابط اللقاء متاح لأعضاء الحلقة' : 'لا يوجد رابط محفوظ';

  const discussionForm = document.getElementById('discussion-settings-form');
  const topicsInput = document.getElementById('students-create-topics');
  const repliesInput = document.getElementById('students-reply');
  const settingsButton = document.getElementById('save-discussion-settings');
  const quran = circle.circle_type === 'quran';
  topicsInput.checked = Boolean(settings.students_can_create_topics);
  repliesInput.checked = Boolean(settings.students_can_reply);
  topicsInput.disabled = quran || !permissions.can_manage_settings;
  repliesInput.disabled = quran || !permissions.can_manage_settings;
  settingsButton.disabled = quran || !permissions.can_manage_settings;
  discussionForm.setAttribute('aria-disabled', String(quran || !permissions.can_manage_settings));
}

async function handleMeetSettings(event) {
  event.preventDefault();
  const button = document.getElementById('save-meet-settings');
  if (button.disabled) return;
  const link = document.getElementById('settings-meet-link').value.trim();
  if (link && !/^https:\/\/meet\.google\.com\/[a-z0-9_-]+(?:[/?#].*)?$/i.test(link)) {
    showToast('أدخل رابط Google Meet صحيحاً.', 'error');
    return;
  }
  setButtonBusy(button, true, 'جاري الحفظ...');
  try {
    if (isLocalPreviewMode()) state.workspace.circle.meet_link = link || null;
    else {
      const { error } = await supabase.rpc('update_learning_circle_meet_link', { p_circle_id: state.circleId, p_meet_link: link || null });
      if (error) throw error;
      await reloadWorkspace();
    }
    renderHeader();
    renderSettings();
    showToast('تم حفظ رابط اللقاء.', 'success');
  } catch (error) {
    showToast(friendlyWorkspaceError(error, 'تعذر حفظ رابط اللقاء.'), 'error');
  } finally {
    setButtonBusy(button, false, 'حفظ الرابط');
  }
}

async function handleDiscussionSettings(event) {
  event.preventDefault();
  const button = document.getElementById('save-discussion-settings');
  if (button.disabled) return;
  const topics = document.getElementById('students-create-topics').checked;
  const replies = document.getElementById('students-reply').checked;
  setButtonBusy(button, true, 'جاري الحفظ...');
  try {
    if (isLocalPreviewMode()) {
      state.workspace.settings.students_can_create_topics = topics;
      state.workspace.settings.students_can_reply = replies;
    } else {
      const { error } = await supabase.rpc('update_learning_circle_workspace_settings', {
        p_circle_id: state.circleId,
        p_students_can_create_topics: topics,
        p_students_can_reply: replies,
      });
      if (error) throw error;
      await reloadWorkspace();
    }
    renderComposer();
    renderSettings();
    showToast('تم حفظ إعدادات النقاش.', 'success');
  } catch (error) {
    showToast(friendlyWorkspaceError(error, 'تعذر حفظ إعدادات النقاش.'), 'error');
  } finally {
    setButtonBusy(button, false, 'حفظ الإعدادات');
  }
}

async function reloadWorkspace() {
  const { data, error } = await supabase.rpc('get_learning_circle_workspace', { p_circle_id: state.circleId });
  if (error) throw error;
  state.workspace = data;
}

function createPreviewPost(payload) {
  return {
    id: crypto.randomUUID(),
    post_type: payload.postType,
    title: payload.title,
    body: payload.body || null,
    external_url: payload.externalUrl || null,
    status: 'published',
    replies_enabled: payload.postType === 'discussion' && payload.repliesEnabled && state.workspace.circle.circle_type === 'educational',
    is_pinned: false,
    published_at: new Date().toISOString(),
    author: { id: state.profile.id, full_name: state.profile.full_name, role: state.profile.role },
    replies: [],
  };
}

function applyPreviewModeration(post, action) {
  if (!post) return;
  if (action === 'close') post.replies_enabled = false;
  if (action === 'reopen') post.replies_enabled = true;
  if (action === 'pin') post.is_pinned = true;
  if (action === 'unpin') post.is_pinned = false;
  if (action === 'archive') post.status = 'archived';
}

function previewWorkspace(role, circleId) {
  const educational = circleId.endsWith('2') || circleId.endsWith('3');
  const staffRole = role === 'teacher' ? (circleId.endsWith('3') ? 'assistant' : 'lead') : null;
  const admin = role === 'admin';
  const student = role === 'student';
  const assistant = staffRole === 'assistant';
  const fullPermissions = admin || staffRole === 'lead';
  const permissions = {
    role,
    is_admin: admin,
    is_staff: role === 'teacher',
    is_lead: staffRole === 'lead',
    is_student: student,
    staff_role: staffRole,
    can_post_announcements: fullPermissions || assistant,
    can_manage_meet_link: fullPermissions,
    can_create_tasks: fullPermissions || assistant,
    can_review_submissions: fullPermissions,
    can_manage_discussions: fullPermissions || assistant,
    can_track_students: fullPermissions || assistant,
    can_manage_people: fullPermissions,
    can_manage_settings: fullPermissions || assistant,
    can_upload_files: fullPermissions || assistant,
    can_create_topics: fullPermissions || assistant || (student && educational),
    can_reply: admin || role === 'teacher' || (student && educational),
  };

  const circle = {
    id: circleId,
    name: educational ? (circleId.endsWith('3') ? 'مدخل إلى النحو' : 'فقه العبادات') : 'حلقة الإتقان',
    description: educational ? 'دروس وموارد تعليمية مع نقاشات منظمة ومهام مرتبطة بالحصة.' : 'متابعة الحفظ والمراجعة والتثبيت ضمن برنامج يومي منظم.',
    circle_type: educational ? 'educational' : 'quran',
    status: 'active',
    meet_link: 'https://meet.google.com/abc-defg-hij',
    subjects: educational ? [{ id: 'subject-1', name: circleId.endsWith('3') ? 'نحو' : 'فقه' }] : [],
  };
  const staff = [
    { id: 'staff-1', teacher_id: 'teacher-1', staff_role: 'lead', full_name: 'المعلم حمزة', username: 'hamza', permissions: {} },
    { id: 'staff-2', teacher_id: 'teacher-2', staff_role: 'assistant', full_name: 'المعلم سالم', username: 'salem', permissions: { post_announcements: true, manage_discussions: true } },
  ];
  const students = student ? [
    { membership_id: 'member-self', student_id: state.profile?.id, full_name: state.profile?.full_name || 'الطالب أحمد', username: state.profile?.username || 'student', status: 'active' },
  ] : [
    { membership_id: 'member-1', student_id: 'student-1', full_name: 'أحمد بن خالد', username: 'ahmad.k', status: 'active' },
    { membership_id: 'member-2', student_id: 'student-2', full_name: 'محمد بن علي', username: 'mohammed.a', status: 'active' },
    { membership_id: 'member-3', student_id: 'student-3', full_name: 'يحيى بن عبدالله', username: 'yahya.a', status: 'active' },
  ];
  const now = new Date();
  const earlier = new Date(now.getTime() - 1000 * 60 * 90);
  const muscatDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Muscat', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const posts = [
    {
      id: 'post-welcome', post_type: 'announcement', title: educational ? 'موعد اللقاء القادم' : 'تنبيه برنامج هذا الأسبوع',
      body: educational ? 'سيكون اللقاء القادم مساء الثلاثاء، وقد أضيف ملف التحضير في قسم الملفات.' : 'يرجى مراجعة التقارير اليومية والتأكد من إتمام المتأخر قبل بدء تقرير اليوم.',
      external_url: null, status: 'published', replies_enabled: false, is_pinned: true, published_at: earlier.toISOString(),
      author: { id: 'teacher-1', full_name: 'المعلم حمزة', role: 'teacher' }, replies: [],
    },
    {
      id: 'post-meeting', post_type: 'meeting', title: 'اللقاء المباشر', body: 'الرابط متاح لأعضاء الحلقة في الموعد المحدد.',
      external_url: circle.meet_link, status: 'published', replies_enabled: false, is_pinned: false, published_at: now.toISOString(),
      author: { id: 'teacher-1', full_name: 'المعلم حمزة', role: 'teacher' }, replies: [],
    },
  ];
  if (educational) posts.push({
    id: 'post-discussion', post_type: 'discussion', title: 'سؤال الدرس: أثر النية في العبادة', body: 'اكتب خلاصة قصيرة، ثم راجع ردود المعلم.',
    external_url: null, status: 'published', replies_enabled: true, is_pinned: false, published_at: now.toISOString(),
    author: { id: 'teacher-2', full_name: 'المعلم سالم', role: 'teacher' },
    replies: [{ id: 'reply-1', body: 'النية تميز العبادة عن العادة.', status: 'published', created_at: now.toISOString(), author: { full_name: 'أحمد بن خالد', role: 'student' } }],
  });
  if (!educational) posts.unshift({
    id: 'post-daily-quran-summary',
    post_type: 'system',
    title: `تقرير إنجاز يوم ${muscatDate}`,
    body: `ملخص تقارير القرآن اليومية للحلقة: ${circle.name}\nالتاريخ: ${muscatDate}\n\n✓ المنجزون في الوقت (2):\n1. أحمد بن خالد\n2. محمد بن علي\n\n⏱ المنجزون بعد المهلة (1):\n1. وارث بن علي\n\n⌛ ضمن مهلة معتمدة (1):\n1. يحيى بن عبدالله\n\n✕ غير المنجزين (1):\n1. عبدالله بن سالم\n\n◇ المعفون من تقارير اليوم (0):\nلا يوجد`,
    external_url: null,
    status: 'published',
    replies_enabled: false,
    is_pinned: false,
    published_at: now.toISOString(),
    author: null,
    replies: [],
  });

  return {
    circle,
    settings: { students_can_create_topics: educational, students_can_reply: educational, timezone: 'Asia/Muscat' },
    permissions,
    people: { staff, students, students_count: educational ? 24 : 18 },
    posts,
    files: [{
      id: 'file-1', title: educational ? 'ملخص الدرس الأول' : 'خطة المتابعة الأسبوعية', description: null,
      storage_path: '', original_name: educational ? 'lesson-01.pdf' : 'weekly-plan.pdf', mime_type: 'application/pdf', size_bytes: 842000,
      status: 'active', created_at: now.toISOString(), uploader: { id: 'teacher-1', full_name: 'المعلم حمزة' },
    }],
  };
}

function assistantPermissionLabels(permissions = {}) {
  const labels = [];
  if (permissions.post_announcements) labels.push('إعلانات');
  if (permissions.manage_meet_link) labels.push('Meet');
  if (permissions.create_tasks) labels.push('مهام');
  if (permissions.review_submissions) labels.push('مراجعة');
  if (permissions.manage_discussions) labels.push('نقاش');
  if (permissions.track_students) labels.push('متابعة');
  return labels;
}

function membershipLabel(status) {
  return status === 'transfer_pending' ? 'نقل معلق' : 'عضو نشط';
}

function roleLabel(role) {
  if (role === 'admin') return 'الإدارة';
  if (role === 'teacher') return 'فريق الحلقة';
  if (role === 'student') return 'طالب';
  return 'النظام';
}

function firstCharacter(value) {
  return String(value || 'ذ').trim().charAt(0) || 'ذ';
}

function formatDateTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ar-OM', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatFileSize(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(mimeType = '') {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio-lines';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'file-spreadsheet';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'presentation';
  if (mimeType.includes('word')) return 'file-text';
  if (mimeType.includes('pdf')) return 'file-type-2';
  return 'file';
}

function setButtonBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) {
    button.dataset.idleHtml = button.innerHTML;
    if (label) button.textContent = label;
    return;
  }
  if (button.dataset.idleHtml) {
    button.innerHTML = button.dataset.idleHtml;
    delete button.dataset.idleHtml;
  }
}

function friendlyWorkspaceError(error, fallback) {
  const message = String(error?.message || '');
  if (/access denied|not allowed|permission|42501/i.test(message)) return 'لا تملك الصلاحية اللازمة لهذا الإجراء.';
  if (/replies are closed/i.test(message)) return 'الردود مغلقة في هذا الموضوع.';
  if (/meet/i.test(message)) return 'رابط Google Meet غير صحيح.';
  if (/file type/i.test(message)) return 'نوع الملف غير مدعوم.';
  if (/file size/i.test(message)) return 'حجم الملف غير مسموح.';
  return fallback;
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}
