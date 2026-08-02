import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const scannedRoots = ['public', 'supabase'];
const textExtensions = new Set(['.html', '.js', '.json', '.sql', '.ts', '.md', '.example']);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function sourceFiles() {
  return scannedRoots
    .flatMap(relative => walk(path.join(root, relative)))
    .filter(file => textExtensions.has(path.extname(file)) || path.basename(file).startsWith('.env'));
}

test('source control contains no obvious private credentials', () => {
  const findings = [];
  const forbiddenPatterns = [
    { label: 'hard-coded SQL password hash input', pattern: /crypt\s*\(\s*['"][^'"]+['"]/i },
    { label: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{20,}/ },
    { label: 'shared Gemini-style key', pattern: /AQ\.[0-9A-Za-z_-]{20,}/ },
    { label: 'quoted service secret', pattern: /(?:SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|GEMINI_API_KEY)\s*=\s*['"](?!your_)[^'"]{16,}['"]/ },
    { label: 'environment-file service secret', pattern: /^(?:SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|GEMINI_API_KEY)=(?!your_|$)[^\s]{16,}$/m },
  ];

  for (const file of sourceFiles()) {
    const content = fs.readFileSync(file, 'utf8');
    for (const { label, pattern } of forbiddenPatterns) {
      if (pattern.test(content)) findings.push(`${path.relative(root, file)}: ${label}`);
    }

    for (const match of content.matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
      try {
        const payload = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString('utf8'));
        if (payload.role === 'service_role') findings.push(`${path.relative(root, file)}: service-role JWT`);
      } catch {
        // Ignore strings that only resemble JWTs.
      }
    }
  }

  assert.deepEqual(findings, []);
});

test('administrator seed never creates an Auth user or password', () => {
  const seed = fs.readFileSync(path.join(root, 'supabase/migrations/0002_seed_admin.sql'), 'utf8');
  assert.doesNotMatch(seed, /insert\s+into\s+auth\.users/i);
  assert.doesNotMatch(seed, /encrypted_password/i);
  assert.doesNotMatch(seed, /crypt\s*\(/i);
});

test('local preview bypass is restricted to loopback hostnames', () => {
  const auth = fs.readFileSync(path.join(root, 'public/js/lib/auth.js'), 'utf8');
  const login = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(auth, /localhost/);
  assert.match(auth, /127\.0\.0\.1/);
  assert.match(auth, /get\('preview'\) === '1'/);
  assert.match(login, /get\('preview'\) === '1'/);
  assert.match(login, /admin\/dashboard\.html\?preview=1/);
  assert.doesNotMatch(auth, /isLocalPreviewMode\(\)\s*{\s*return\s+true/);
});

test('password recovery is server-side and rate-limited', () => {
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/0006_password_recovery_codes.sql'), 'utf8');
  const functionSource = fs.readFileSync(path.join(root, 'supabase/functions/account-recovery/index.ts'), 'utf8');
  const pageSource = fs.readFileSync(path.join(root, 'public/js/pages/reset-password.js'), 'utf8');

  assert.match(migration, /password_recovery_codes/);
  assert.match(migration, /revoke all on public\.password_recovery_codes/);
  assert.match(functionSource, /SHA-256/);
  assert.match(functionSource, /attempts.*5/);
  assert.match(functionSource, /RESEND_API_KEY/);
  assert.match(pageSource, /account-recovery/);
});

test('schedule analysis requires an authenticated owner of the halaqa', () => {
  const functionSource = fs.readFileSync(path.join(root, 'supabase/functions/analyze-schedule/index.ts'), 'utf8');
  const teacherPage = fs.readFileSync(path.join(root, 'public/js/pages/teacher-ai-assistant.js'), 'utf8');

  assert.match(functionSource, /Authorization/);
  assert.match(functionSource, /auth\.getUser/);
  assert.match(functionSource, /halaqa\.teacher_id !== auth\.profile\.id/);
  assert.match(functionSource, /halaqa_students/);
  assert.match(teacherPage, /session\.access_token/);
  assert.doesNotMatch(functionSource, /fallback|طالب عام/i);
});

test('administrator actions have an immutable server audit contract', () => {
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/0007_admin_audit_logs.sql'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'public/js/pages/admin-dashboard.js'), 'utf8');

  assert.match(migration, /admin_audit_logs/);
  assert.match(migration, /actor_id uuid not null default auth\.uid\(\)/);
  assert.match(migration, /Admins read audit logs/);
  assert.match(migration, /Admins create own audit logs/);
  assert.match(dashboard, /admin_audit_logs/);
  assert.match(dashboard, /source: 'admin-dashboard'/);
});

test('edge function secret examples use placeholders', () => {
  const example = fs.readFileSync(path.join(root, 'supabase/functions/.env.example'), 'utf8');
  assert.match(example, /GEMINI_API_KEY=your_/);
  assert.match(example, /APP_ORIGIN=https:\/\/your-domain\.example/);
});

test('role dashboards escape user-controlled display values', () => {
  const pages = [
    'public/js/pages/chat.js',
    'public/js/pages/teacher-grading.js',
    'public/js/pages/teacher-halaqa-detail.js',
    'public/js/pages/teacher-classroom-detail.js',
    'public/js/pages/student-classroom.js',
  ];

  for (const relative of pages) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /escapeHtml/);
  }
});

test('classroom assignments enforce enrolled submissions and private files', () => {
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/0008_extra_assignments_workflow.sql'), 'utf8');
  const teacherPage = fs.readFileSync(path.join(root, 'public/js/pages/teacher-classroom-detail.js'), 'utf8');
  const studentPage = fs.readFileSync(path.join(root, 'public/js/pages/student-classroom.js'), 'utf8');
  const gradingPage = fs.readFileSync(path.join(root, 'public/js/pages/teacher-grading.js'), 'utf8');

  assert.match(migration, /Students create enrolled extra submissions/);
  assert.match(migration, /A graded submission cannot be changed/);
  assert.match(migration, /assignment-submissions/);
  assert.match(migration, /file_size_limit/);
  assert.match(migration, /notify_new_extra_assignment/);
  assert.match(migration, /notify_graded_extra_assignment/);
  assert.match(teacherPage, /assignments_extra/);
  assert.match(studentPage, /assignment_extra_submissions/);
  assert.match(studentPage, /createSignedUrl/);
  assert.match(gradingPage, /createSignedUrl/);
});

test('task publishing is atomic and student feeds stay scoped to the caller', () => {
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/0010_unified_student_tasks.sql'), 'utf8');
  const teacherTasks = fs.readFileSync(path.join(root, 'public/js/pages/teacher-tasks.js'), 'utf8');
  const excelImport = fs.readFileSync(path.join(root, 'public/js/pages/teacher-ai-assistant.js'), 'utf8');
  const studentDashboard = fs.readFileSync(path.join(root, 'public/js/pages/student-dashboard.js'), 'utf8');

  assert.match(migration, /create or replace function public\.publish_task_batch/);
  assert.match(migration, /security definer/);
  assert.match(migration, /caller_role not in \('teacher', 'admin'\)/);
  assert.match(migration, /target_student_id.*halaqa_students/is);
  assert.match(migration, /insert into public\.assignment_submissions/);
  assert.match(migration, /s\.student_id = auth\.uid\(\)/);
  assert.match(migration, /join public\.classroom_students.*auth\.uid\(\)/is);
  assert.match(teacherTasks, /rpc\('publish_task_batch'/);
  assert.match(excelImport, /rpc\('publish_task_batch'/);
  assert.doesNotMatch(excelImport, /from\('daily_assignments'\)\.insert/);
  assert.match(studentDashboard, /rpc\('get_student_task_feed'/);
});
