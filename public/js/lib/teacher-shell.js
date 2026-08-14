const TEACHER_NAV_ITEMS = [
  { key: 'tasks', href: '/teacher/tasks.html', icon: 'layout-dashboard', label: 'مركز المتابعة' },
  { key: 'circles', href: '/circles.html', icon: 'users-round', label: 'الحلقات' },
  { key: 'reports', href: '/teacher/ai-assistant.html', icon: 'file-spreadsheet', label: 'التقارير' },
  { key: 'messages', href: '/teacher/chat.html', icon: 'messages-square', label: 'الرسائل' },
  { key: 'account', href: '/account-settings.html', icon: 'circle-user-round', label: 'حسابي' },
];

export function mountTeacherShell(activeSection = 'tasks') {
  const body = document.body;
  body.classList.add('teacher-unified-shell');

  let sidebar = document.querySelector('.teacher-sidebar');
  if (!sidebar) {
    sidebar = document.createElement('aside');
    sidebar.className = 'teacher-sidebar';
    sidebar.setAttribute('aria-label', 'التنقل الرئيسي للمعلم');
    body.prepend(sidebar);
  }

  sidebar.innerHTML = `
    <a class="teacher-sidebar-brand" href="/teacher/tasks.html" aria-label="مركز ذات خيل">
      <span class="teacher-sidebar-mark">ذ</span>
      <span><strong class="font-amiri">مركز ذات خيل</strong><small>مساحة المعلم</small></span>
    </a>
    <nav class="teacher-sidebar-nav">
      ${TEACHER_NAV_ITEMS.map(item => `
        <a class="${item.key === activeSection ? 'is-active' : ''}" href="${item.href}"${item.key === activeSection ? ' aria-current="page"' : ''}>
          <i data-lucide="${item.icon}"></i><span>${item.label}</span>
        </a>`).join('')}
    </nav>
    <div class="teacher-sidebar-note">
      <i data-lucide="shield-check"></i>
      <span><strong>مساحة تعليم آمنة</strong><small>تظهر الأدوات بحسب صلاحيتك في الحلقة</small></span>
    </div>`;

  markLegacyHeaderActions(body);
  refreshTeacherShellIcons();
}

function markLegacyHeaderActions(body) {
  const header = [...body.children].find(element => element.tagName === 'HEADER');
  const inner = header?.firstElementChild;
  if (!inner || inner.children.length < 2) return;

  const actions = inner.lastElementChild;
  actions.classList.add('teacher-context-actions');
  const repeatedLinks = actions.querySelectorAll(':scope > a');
  if (repeatedLinks.length > 2) {
    repeatedLinks.forEach(link => { link.hidden = true; });
  }
}

function refreshTeacherShellIcons() {
  if (window.lucide?.createIcons) {
    window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  }
}

function autoMountTeacherShell() {
  const section = document.body.dataset.teacherSection;
  if (section) mountTeacherShell(section);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoMountTeacherShell, { once: true });
} else {
  autoMountTeacherShell();
}
