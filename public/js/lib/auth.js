import { supabase } from './supabase-client.js';

const ROLE_HOME = {
  admin: 'admin/dashboard.html',
  teacher: 'circles.html',
  student: 'student/dashboard.html',
  parent: 'parent/dashboard.html',
};

const PREVIEW_PROFILES = {
  admin: {
    id: '00000000-0000-4000-8000-000000000001',
    full_name: 'مدير النظام - معاينة',
    username: 'warith',
    role: 'admin',
    is_active: true,
    must_change_password: false,
  },
  teacher: {
    id: '00000000-0000-4000-8000-000000000002',
    full_name: 'المعلم حمزة',
    username: 'preview.teacher',
    role: 'teacher',
    is_active: true,
    must_change_password: false,
  },
  student: {
    id: '00000000-0000-4000-8000-000000000003',
    full_name: 'طالب تجريبي',
    username: 'preview.student',
    role: 'student',
    is_active: true,
    must_change_password: false,
    family_link_code: 'PREVIEW001',
  },
  parent: {
    id: '00000000-0000-4000-8000-000000000004',
    full_name: 'ولي أمر تجريبي',
    username: 'preview.parent',
    role: 'parent',
    is_active: true,
    must_change_password: false,
  },
};

const PREVIEW_SESSION_KEY = 'zat_khail_explicit_preview';

export function isLocalPreviewMode() {
  const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (!isLocalHost) return false;

  const previewParam = new URLSearchParams(window.location.search).get('preview');
  if (previewParam === '0') {
    sessionStorage.removeItem(PREVIEW_SESSION_KEY);
    return false;
  }

  const requested = previewParam === '1';
  if (requested) sessionStorage.setItem(PREVIEW_SESSION_KEY, '1');
  return requested || sessionStorage.getItem(PREVIEW_SESSION_KEY) === '1';
}

function getBasePath() {
  const path = window.location.pathname;
  const isRolePage = ['/admin/', '/teacher/', '/student/', '/parent/'].some(segment => path.includes(segment));
  return isRolePage ? '../' : './';
}

function redirectTo(targetPath) {
  const cleanTarget = targetPath.replace(/^\.\//, '').replace(/^\//, '');
  window.location.replace(getBasePath() + cleanTarget);
}

export function exitPreviewMode() {
  sessionStorage.removeItem(PREVIEW_SESSION_KEY);
  redirectTo('./index.html?preview=0');
}

function installPreviewBanner(role) {
  if (document.getElementById('preview-mode-banner')) return;

  const banner = document.createElement('aside');
  banner.id = 'preview-mode-banner';
  banner.className = 'preview-mode-banner';
  banner.setAttribute('role', 'status');

  const copy = document.createElement('div');
  copy.className = 'preview-mode-banner-copy';

  const title = document.createElement('strong');
  title.textContent = 'وضع المعاينة';

  const description = document.createElement('span');
  description.textContent = `أنت تشاهد لوحة ${role === 'admin' ? 'المدير' : role === 'teacher' ? 'المعلم' : role === 'student' ? 'الطالب' : 'ولي الأمر'} ببيانات تجريبية، ولن تُرسل التغييرات إلى قاعدة البيانات.`;

  const exitButton = document.createElement('button');
  exitButton.type = 'button';
  exitButton.className = 'preview-mode-exit';
  exitButton.textContent = 'الدخول للعمل الفعلي';
  exitButton.addEventListener('click', exitPreviewMode);

  copy.append(title, description);
  banner.append(copy, exitButton);
  document.body.prepend(banner);
  document.body.classList.add('preview-mode-active');
}

function getAuthErrorMessage(error, serverMessage = '') {
  const normalizedServerMessage = String(serverMessage || '').toLowerCase();
  if (normalizedServerMessage.includes('اسم المستخدم') || normalizedServerMessage.includes('بيانات الدخول')) {
    return 'اسم المستخدم أو كلمة المرور غير صحيحة.';
  }
  const status = error?.context?.status;
  if (status === 404) {
    return 'خدمة تسجيل الدخول المحلية غير منشورة في Supabase بعد. تواصل مع إدارة النظام لإكمال النشر.';
  }
  if (status === 401 || status === 403) {
    return 'اسم المستخدم أو كلمة المرور غير صحيحة.';
  }
  const message = (error?.message || '').toLowerCase();
  if (error?.name === 'FunctionsHttpError' || message.includes('non-2xx status code')) {
    return 'اسم المستخدم أو كلمة المرور غير صحيحة.';
  }
  if (message.includes('failed to send a request') || message.includes('failed to fetch') || message.includes('network')) {
    return 'تعذر الاتصال بخدمة تسجيل الدخول. تحقق من اتصالك ثم حاول مرة أخرى.';
  }
  if (message.includes('rate limit')) return 'تم تجاوز عدد المحاولات المسموح. حاول مرة أخرى بعد قليل.';
  if (message.includes('password')) return 'كلمة المرور غير صحيحة أو لا تحقق المتطلبات.';
  return error?.message || 'تعذر إتمام عملية المصادقة. حاول مرة أخرى.';
}

export async function getUserProfile(userId) {
  if (!userId) return null;
  const { data, error } = await supabase.from('users').select('*').eq('id', userId).maybeSingle();
  if (error) {
    console.error('Error fetching user profile:', error);
    throw new Error('تعذر تحميل ملف المستخدم من قاعدة البيانات.');
  }
  return data;
}

export async function loginUser(username, password) {
  const cleanUsername = String(username || '').trim().toLowerCase();
  if (!cleanUsername) throw new Error('يرجى إدخال اسم المستخدم.');
  if (!password) throw new Error('يرجى إدخال كلمة المرور.');

  sessionStorage.removeItem(PREVIEW_SESSION_KEY);

  const { data, error } = await supabase.functions.invoke('login-with-username', {
    body: { username: cleanUsername, password },
  });
  if (error || !data?.session) {
    let serverMessage = data?.error || '';
    if (!serverMessage && error?.context) {
      try {
        const payload = await error.context.json();
        serverMessage = payload?.error || '';
      } catch {
        // The status code still lets us show a precise authentication error.
      }
    }
    throw new Error(getAuthErrorMessage(error, serverMessage));
  }

  const { error: sessionError } = await supabase.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  if (sessionError) throw new Error(getAuthErrorMessage(sessionError));

  const profile = await getUserProfile(data.session.user.id);
  if (!profile) {
    await supabase.auth.signOut();
    throw new Error('ملف الحساب غير موجود. تواصل مع إدارة المركز.');
  }

  routeAuthenticatedProfile(profile);
  return { session: data.session, profile };
}

function routeAuthenticatedProfile(profile) {
  if (!profile.is_active) {
    redirectTo('./pending-approval.html');
    return;
  }
  if (profile.must_change_password) {
    redirectTo('./account-settings.html?force=password');
    return;
  }
  redirectUserByRole(profile.role);
}

export function redirectUserByRole(role) {
  const destination = ROLE_HOME[role];
  if (!destination) {
    redirectTo('./index.html?error=invalid-role');
    return;
  }
  redirectTo(destination);
}

export async function routeExistingSession() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (!error && session?.user) {
    const profile = await getUserProfile(session.user.id);
    if (!profile) return false;
    routeAuthenticatedProfile(profile);
    return true;
  }

  if (isLocalPreviewMode()) {
    redirectUserByRole('admin');
    return true;
  }
  return false;
}

export async function logoutUser() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    await supabase.auth.signOut();
  }
  sessionStorage.removeItem(PREVIEW_SESSION_KEY);
  redirectTo('./index.html?preview=0');
}

export async function requireAuth(allowedRoles = []) {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (!error && session?.user) {
    try {
      const profile = await getUserProfile(session.user.id);
      if (!profile) {
        await supabase.auth.signOut();
        redirectTo('./index.html?error=profile-missing');
        return null;
      }
      if (!profile.is_active) {
        redirectTo('./pending-approval.html');
        return null;
      }
      if (allowedRoles.length > 0 && !allowedRoles.includes(profile.role)) {
        redirectUserByRole(profile.role);
        return null;
      }
      return { session, profile, preview: false };
    } catch (profileError) {
      console.error(profileError);
      redirectTo('./index.html?error=profile-load');
      return null;
    }
  }

  if (isLocalPreviewMode()) {
    const previewRole = allowedRoles[0] || 'admin';
    const profile = PREVIEW_PROFILES[previewRole] || PREVIEW_PROFILES.admin;
    installPreviewBanner(profile.role);
    return { session: null, profile, preview: true };
  }

  redirectTo('./index.html?reason=login-required');
  return null;
}
