import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const publicRoot = path.join(root, 'public');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

test('all local JavaScript files pass syntax checking', () => {
  const failures = [];
  const scripts = walk(path.join(publicRoot, 'js')).filter(file => file.endsWith('.js'));
  for (const script of scripts) {
    const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(`${path.relative(root, script)}: ${result.stderr.trim()}`);
  }
  assert.deepEqual(failures, []);
});

test('HTML documents do not contain duplicate ids', () => {
  const failures = [];
  const pages = walk(publicRoot).filter(file => file.endsWith('.html'));
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (duplicates.length) failures.push(`${path.relative(root, page)}: ${duplicates.join(', ')}`);
  }
  assert.deepEqual(failures, []);
});

test('HTML pattern attributes compile with the browser Unicode Sets flag', () => {
  const failures = [];
  const pages = walk(publicRoot).filter(file => file.endsWith('.html'));
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    for (const match of html.matchAll(/\spattern="([^"]+)"/g)) {
      try {
        new RegExp(match[1], 'v');
      } catch (error) {
        failures.push(`${path.relative(root, page)}: ${error.message}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('admin dashboard JavaScript references existing elements', () => {
  const html = fs.readFileSync(path.join(publicRoot, 'admin/dashboard.html'), 'utf8');
  const script = [
    'js/pages/admin-dashboard.js',
    'js/pages/admin-circles.js',
  ].map(file => fs.readFileSync(path.join(publicRoot, file), 'utf8')).join('\n');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
  const references = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]);
  const missing = [...new Set(references.filter(id => !ids.has(id)))];
  assert.deepEqual(missing, []);
});

test('admin learning-circle interface calls deployed server contracts', () => {
  const script = fs.readFileSync(path.join(publicRoot, 'js/pages/admin-circles.js'), 'utf8');
  const migrations = [
    '0012_learning_circles_security.sql',
    '0013_learning_circle_admin_operations.sql',
  ].map(file => fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8')).join('\n');
  const rpcNames = [...script.matchAll(/supabase\.rpc\('([^']+)'/g)].map(match => match[1]);
  const missing = [...new Set(rpcNames.filter(name => !migrations.includes(`function public.${name}`)))];
  assert.ok(rpcNames.length >= 8, 'circle administration should use the protected RPC surface');
  assert.deepEqual(missing, []);
});

test('circle workspace pages reference existing elements and protected RPCs', () => {
  const pairs = [
    ['circles.html', 'js/pages/circles.js'],
    ['circle.html', 'js/pages/circle-workspace.js'],
  ];
  const scripts = [];
  const failures = [];

  for (const [htmlPath, scriptPath] of pairs) {
    const html = fs.readFileSync(path.join(publicRoot, htmlPath), 'utf8');
    const script = fs.readFileSync(path.join(publicRoot, scriptPath), 'utf8');
    scripts.push(script);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
    const references = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]);
    const missing = [...new Set(references.filter(id => !ids.has(id)))];
    if (missing.length) failures.push(`${scriptPath}: ${missing.join(', ')}`);
  }

  assert.deepEqual(failures, []);
  const migrations = [
    '0012_learning_circles_security.sql',
    '0014_learning_circle_workspace.sql',
    '0029_quran_circle_performance.sql',
  ].map(file => fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8')).join('\n');
  const rpcNames = [...scripts.join('\n').matchAll(/supabase\.rpc\('([^']+)'/g)].map(match => match[1]);
  const missingRpcs = [...new Set(rpcNames.filter(name => !migrations.includes(`function public.${name}`)))];
  assert.ok(rpcNames.length >= 9, 'workspace pages should use the protected RPC surface');
  assert.deepEqual(missingRpcs, []);
});

test('Quran Excel importer uses the protected import contract and private bucket', () => {
  const script = fs.readFileSync(path.join(publicRoot, 'js/pages/quran-report-importer.js'), 'utf8');
  const migrations = [
    '0015_quran_reports_core.sql',
    '0016_quran_reports_security.sql',
    '0020_resilient_quran_report_import_archive.sql',
  ].map(file => fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8')).join('\n');
  const requiredRpcs = [
    'stage_quran_report_import',
    'get_quran_report_import_preview',
    'approve_quran_report_import',
    'cancel_quran_report_import',
    'attach_quran_report_import_file',
  ];

  for (const rpc of requiredRpcs) {
    assert.match(script, new RegExp(`supabase\\.rpc\\('${rpc}'`));
    assert.ok(migrations.includes(`function public.${rpc}`), `${rpc} must be deployed by a migration`);
  }
  assert.match(script, /storage\.from\('quran-report-imports'\)/);
  assert.match(migrations, /quran-report-imports/);
});

test('Quran student reports and teacher console use protected report operations', () => {
  const scripts = [
    'js/pages/student-reports.js',
    'js/pages/quran-report-manager.js',
  ].map(file => fs.readFileSync(path.join(publicRoot, file), 'utf8')).join('\n');
  const migration = [
    '0017_quran_report_operations.sql',
    '0021_quran_report_visibility_and_review.sql',
    '0022_quran_student_plan_adjustments.sql',
    '0023_quran_approved_report_management.sql',
    '0024_quran_student_accounting_analytics.sql',
    '0030_quran_plan_shift_requests.sql',
  ].map(file => fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8')).join('\n');
  const requiredRpcs = [
    'get_my_quran_reports',
    'complete_quran_report_assignment',
    'request_quran_report_extension',
    'get_quran_teacher_console',
    'get_quran_student_history',
    'get_quran_extension_queue',
    'decide_quran_report_extension',
    'exempt_quran_report_assignment',
    'get_my_quran_report_overview',
    'get_quran_approved_report_plan',
    'adjust_quran_student_plan',
    'get_quran_report_management_details',
    'manage_quran_approved_report',
    'request_quran_plan_shift',
    'get_my_quran_plan_shift_requests',
    'get_quran_plan_shift_queue',
    'decide_quran_plan_shift_request',
  ];

  for (const rpc of requiredRpcs) {
    assert.match(scripts, new RegExp(`rpc\\('${rpc}'`));
    assert.ok(migration.includes(`function public.${rpc}`), `${rpc} must be deployed by the Quran operations migrations`);
  }
});

test('student Quran reports expose an explicit confirmed submission flow and daily completion state', () => {
  const html = fs.readFileSync(path.join(publicRoot, 'student/reports.html'), 'utf8');
  const script = fs.readFileSync(path.join(publicRoot, 'js/pages/student-reports.js'), 'utf8');
  assert.match(html, /id="quran-complete-dialog"/);
  assert.match(html, /id="quran-complete-form"/);
  assert.match(script, /data-open-complete/);
  assert.match(script, /تسليم التقرير/);
  assert.match(script, /لقد قمت بإنجاز جميع تقارير اليوم/);
  assert.match(script, /اللهم اجعله حافظاً متقناً لكتابك/);
});

test('classroom workflow JavaScript references existing elements', () => {
  const pairs = [
    ['teacher/classroom-detail.html', 'js/pages/teacher-classroom-detail.js'],
    ['student/classroom.html', 'js/pages/student-classroom.js'],
    ['teacher/grading.html', 'js/pages/teacher-grading.js'],
    ['teacher/tasks.html', 'js/pages/teacher-tasks.js'],
    ['teacher/ai-assistant.html', 'js/pages/teacher-ai-assistant.js'],
    ['teacher/halaqa-detail.html', 'js/pages/teacher-halaqa-detail.js'],
    ['student/dashboard.html', 'js/pages/student-dashboard.js'],
  ];
  const failures = [];

  for (const [htmlPath, scriptPath] of pairs) {
    const html = fs.readFileSync(path.join(publicRoot, htmlPath), 'utf8');
    const script = fs.readFileSync(path.join(publicRoot, scriptPath), 'utf8');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
    const references = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]);
    const missing = [...new Set(references.filter(id => !ids.has(id)))];
    if (missing.length) failures.push(`${scriptPath}: ${missing.join(', ')}`);
  }

  assert.deepEqual(failures, []);
});

test('service worker cache entries point to real public files', () => {
  const worker = fs.readFileSync(path.join(publicRoot, 'service-worker.js'), 'utf8');
  const assetBlock = worker.match(/const ASSETS = \[([\s\S]*?)\];/)?.[1] || '';
  const assets = [...assetBlock.matchAll(/'([^']+)'/g)].map(match => match[1]);
  const missing = assets
    .filter(asset => asset !== '/')
    .filter(asset => !fs.existsSync(path.join(publicRoot, asset.replace(/^\//, ''))));
  assert.deepEqual(missing, []);
});

test('manifest and push notification icons point to real files', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicRoot, 'manifest.json'), 'utf8'));
  const worker = fs.readFileSync(path.join(publicRoot, 'service-worker.js'), 'utf8');
  const manifestIcons = manifest.icons.map(icon => icon.src);
  const notificationIcons = [...worker.matchAll(/(?:icon|badge):\s*'([^']+)'/g)].map(match => match[1]);
  const missing = [...manifestIcons, ...notificationIcons]
    .filter(asset => !fs.existsSync(path.join(publicRoot, asset.replace(/^\//, ''))));
  assert.deepEqual(missing, []);
});

test('required role entry pages exist', () => {
  const required = [
    'circles.html',
    'circle.html',
    'admin/dashboard.html',
    'teacher/halaqat.html',
    'teacher/tasks.html',
    'teacher/ai-assistant.html',
    'student/dashboard.html',
    'student/reports.html',
    'parent/dashboard.html',
  ];
  const missing = required.filter(file => !fs.existsSync(path.join(publicRoot, file)));
  assert.deepEqual(missing, []);
});

test('HTML local script, stylesheet, manifest, and module links resolve', () => {
  const failures = [];
  const pages = walk(publicRoot).filter(file => file.endsWith('.html'));
  const assetPattern = /(?:src|href)="([^"]+)"/g;

  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    for (const match of html.matchAll(assetPattern)) {
      const asset = match[1].split('#')[0].split('?')[0];
      if (!asset || asset === '#' || asset.startsWith('javascript:') || asset.startsWith('http://') || asset.startsWith('https://')) continue;
      const resolved = asset.startsWith('/')
        ? path.join(publicRoot, asset.slice(1))
        : path.resolve(path.dirname(page), asset);
      if (!fs.existsSync(resolved)) failures.push(`${path.relative(root, page)} -> ${asset}`);
    }
  }

  assert.deepEqual(failures, []);
});
