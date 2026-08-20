import { supabase } from '../lib/supabase-client.js';
import { isLocalPreviewMode, logoutUser, requireAuth } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast } from '../lib/utils.js';
import { mountTeacherShell } from '../lib/teacher-shell.js?v=2';

const ROLE_LABELS = {
  admin: 'إدارة جميع المساحات التعليمية',
  teacher: 'الحلقات التي تعمل ضمن فريقها',
  student: 'الحلقات المسجل فيها حسابك',
};

const PARTICIPANT_LABELS = {
  admin: 'مدير المنصة',
  lead: 'المعلم المسؤول',
  assistant: 'معلم مساعد',
  student: 'طالب',
};

const state = {
  profile: null,
  circles: [],
  filter: 'all',
  query: '',
};

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
  await initI18n();
  const previewRole = getPreviewRole();
  const allowedRoles = previewRole
    ? [previewRole, ...['admin', 'teacher', 'student'].filter(role => role !== previewRole)]
    : ['admin', 'teacher', 'student'];
  const authData = await requireAuth(allowedRoles);
  if (!authData) return;

  state.profile = authData.profile;
  if (state.profile.role === 'teacher') mountTeacherShell('circles');
  setupHeader();
  setupFilters();
  await loadCircles();
  render();
}

function getPreviewRole() {
  if (!isLocalPreviewMode()) return null;
  const role = new URLSearchParams(window.location.search).get('role');
  return ['admin', 'teacher', 'student'].includes(role) ? role : 'teacher';
}

function setupHeader() {
  document.getElementById('profile-name').textContent = state.profile.full_name || state.profile.username || 'مستخدم المنصة';
  document.getElementById('role-context').textContent = ROLE_LABELS[state.profile.role] || 'مساحتك التعليمية';
  document.getElementById('circle-command-copy').textContent = state.profile.role === 'student'
    ? 'تظهر هنا الحلقات القرآنية والتعليمية النشطة المرتبطة بحسابك.'
    : 'ادخل إلى الساحة والأشخاص والملفات والإعدادات من مساحة موحدة.';

  const homeLink = document.getElementById('role-home-link');
  homeLink.href = roleHomePath(state.profile.role);
  document.getElementById('logout-btn').addEventListener('click', logoutUser);
}

function roleHomePath(role) {
  if (role === 'admin') return './admin/dashboard.html#overview';
  if (role === 'student') return './student/dashboard.html';
  return './circles.html';
}

function setupFilters() {
  const requestedType = new URLSearchParams(window.location.search).get('type');
  if (['all', 'quran', 'educational'].includes(requestedType)) state.filter = requestedType;

  document.getElementById('circle-search').addEventListener('input', event => {
    state.query = event.target.value.trim().toLowerCase();
    renderGrid();
  });
  document.querySelectorAll('[data-circle-filter]').forEach(button => {
    const active = button.dataset.circleFilter === state.filter;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => {
      state.filter = button.dataset.circleFilter;
      document.querySelectorAll('[data-circle-filter]').forEach(item => {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      renderGrid();
    });
  });
}

async function loadCircles() {
  if (isLocalPreviewMode()) {
    state.circles = previewCircles(state.profile.role);
    return;
  }

  const { data, error } = await supabase.rpc('list_my_learning_circles');
  if (error) {
    console.error('Unable to load learning circles:', error);
    showToast('تعذر تحميل الحلقات المرتبطة بحسابك.', 'error');
    state.circles = [];
    return;
  }
  state.circles = Array.isArray(data) ? data : [];
}

function render() {
  const quranCount = state.circles.filter(circle => circle.circle_type === 'quran').length;
  const educationalCount = state.circles.filter(circle => circle.circle_type === 'educational').length;
  document.getElementById('all-circles-count').textContent = state.circles.length;
  document.getElementById('quran-circles-count').textContent = quranCount;
  document.getElementById('educational-circles-count').textContent = educationalCount;
  renderGrid();
}

function filteredCircles() {
  return state.circles.filter(circle => {
    if (state.filter !== 'all' && circle.circle_type !== state.filter) return false;
    if (!state.query) return true;
    const haystack = [
      circle.name,
      circle.description,
      circle.lead_teacher?.full_name,
      ...(circle.subjects || []).map(subject => subject.name),
    ].join(' ').toLowerCase();
    return haystack.includes(state.query);
  });
}

function renderGrid() {
  const circles = filteredCircles();
  const grid = document.getElementById('circles-grid');
  document.getElementById('visible-circles-count').textContent = `${circles.length} حلقة`;

  if (!circles.length) {
    grid.innerHTML = `
      <div class="circle-empty">
        <i data-lucide="search-x"></i>
        <p>${state.circles.length ? 'لا توجد حلقات مطابقة للبحث.' : 'لا توجد حلقات نشطة مرتبطة بهذا الحساب.'}</p>
      </div>`;
    refreshIcons();
    return;
  }

  grid.innerHTML = circles.map(circle => {
    const quran = circle.circle_type === 'quran';
    const subjects = Array.isArray(circle.subjects) ? circle.subjects : [];
    const postsCount = Number(circle.posts_count || 0);
    const studentsCount = Number(circle.students_count || 0);
    return `
      <article class="circle-card ${quran ? 'is-quran' : 'is-educational'}">
        <div class="circle-card-accent" aria-hidden="true"></div>
        <div class="circle-card-body">
          <div class="circle-card-header">
            <span class="circle-card-type"><i data-lucide="${quran ? 'book-open-check' : 'graduation-cap'}"></i>${quran ? 'حلقة قرآنية' : 'حلقة تعليمية'}</span>
            <span class="circle-card-role">${escapeHtml(PARTICIPANT_LABELS[circle.participant_role] || 'عضو')}</span>
          </div>
          <h3>${escapeHtml(circle.name || 'حلقة تعليمية')}</h3>
          <p>${escapeHtml(circle.description || (quran ? 'حلقة للمتابعة القرآنية اليومية.' : 'مساحة للدروس والمهام التعليمية.'))}</p>
          ${subjects.length ? `<div class="circle-card-subjects">${subjects.map(subject => `<span>${escapeHtml(subject.name)}</span>`).join('')}</div>` : ''}
          <div class="circle-card-facts">
            <div><strong>${studentsCount}</strong><span>طالب</span></div>
            <div><strong>${postsCount}</strong><span>منشور</span></div>
            <div><strong>${circle.meet_link ? 'متاح' : 'غير مضاف'}</strong><span>اللقاء</span></div>
          </div>
        </div>
        <div class="circle-card-footer">
          <div class="circle-card-lead"><span>المعلم المسؤول</span><strong>${escapeHtml(circle.lead_teacher?.full_name || 'غير محدد')}</strong></div>
          <a class="circle-open-command" href="${escapeHtml(workspaceUrl(circle.id))}"><span>فتح الحلقة</span><i data-lucide="arrow-left"></i></a>
        </div>
      </article>`;
  }).join('');
  refreshIcons();
}

function workspaceUrl(circleId) {
  const params = new URLSearchParams({ id: circleId });
  if (isLocalPreviewMode()) {
    params.set('preview', '1');
    params.set('role', state.profile.role);
  }
  return `./circle.html?${params.toString()}`;
}

function previewCircles(role) {
  const participantRole = role === 'admin' ? 'admin' : role === 'teacher' ? 'lead' : 'student';
  return [
    {
      id: '91000000-0000-4000-8000-000000000001',
      name: 'حلقة الإتقان',
      description: 'متابعة الحفظ والمراجعة والتثبيت ضمن برنامج يومي منظم.',
      circle_type: 'quran',
      status: 'active',
      meet_link: 'https://meet.google.com/abc-defg-hij',
      subjects: [],
      lead_teacher: { full_name: 'المعلم حمزة' },
      participant_role: participantRole,
      students_count: 18,
      posts_count: 6,
    },
    {
      id: '91000000-0000-4000-8000-000000000002',
      name: 'فقه العبادات',
      description: 'دروس تطبيقية في أحكام الطهارة والصلاة والصيام.',
      circle_type: 'educational',
      status: 'active',
      meet_link: 'https://meet.google.com/xyz-abcd-efg',
      subjects: [{ name: 'فقه' }, { name: 'عقيدة' }],
      lead_teacher: { full_name: 'المعلم سالم' },
      participant_role: participantRole,
      students_count: 24,
      posts_count: 9,
    },
    {
      id: '91000000-0000-4000-8000-000000000003',
      name: 'مدخل إلى النحو',
      description: 'حلقة تعليمية لمبادئ النحو والتطبيق على النصوص.',
      circle_type: 'educational',
      status: 'active',
      meet_link: null,
      subjects: [{ name: 'نحو' }],
      lead_teacher: { full_name: 'المعلم حمزة' },
      participant_role: role === 'teacher' ? 'assistant' : participantRole,
      students_count: 15,
      posts_count: 4,
    },
  ];
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}
