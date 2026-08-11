import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  buildQuranReportTemplate,
  parseQuranWorkbook,
  toServerRows,
} from '../public/js/lib/quran-report-excel.js';

const require = createRequire(import.meta.url);
const XLSX = require('../public/js/vendor/xlsx.full.min.js');

function workbookBuffer(matrix, sheetName = 'ورقة1') {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(matrix);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const headers = [
  'التاريخ',
  'الحفظ',
  'تكرارات الحفظ',
  'التثبيت',
  'تكرارات التثبيت',
  'المراجعة',
  'تكرارات المراجعة',
  'ملاحظات',
];

test('Arabic Quran plan rows become separate hifz, tathbit, and murajaa reports', () => {
  const parsed = parseQuranWorkbook(XLSX, workbookBuffer([
    ['خطة الحلقة اليومية'],
    headers,
    [new Date(2026, 11, 8), 'النبأ 1-5', 5, 'النبأ 6-10', 3, 'جزء عم', 2, 'يراعى التجويد'],
  ]));

  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows.map(row => row.type), ['hifz', 'tathbit', 'murajaa']);
  assert.deepEqual(parsed.rows.map(row => row.maxPoints), [4, 3, 3]);
  assert.ok(parsed.rows.every(row => row.date === '2026-12-08'));
  assert.ok(parsed.rows.every(row => row.notes === 'يراعى التجويد'));
  assert.equal(parsed.issues.length, 0);
});

test('missing task types lower the daily maximum without redistributing points', () => {
  const parsed = parseQuranWorkbook(XLSX, workbookBuffer([
    headers,
    [new Date(2026, 11, 9), 'النازعات 1-8', 4, 'لا يوجد', null, '', null, null],
  ]));

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].type, 'hifz');
  assert.equal(parsed.rows[0].maxPoints, 4);
  assert.equal(parsed.rows.reduce((sum, row) => sum + row.maxPoints, 0), 4);
});

test('invalid repetitions and ambiguous text dates are reported as blocking errors', () => {
  const parsed = parseQuranWorkbook(XLSX, workbookBuffer([
    headers,
    ['08/12/2026', 'النبأ 1-5', 101, null, null, null, null, null],
  ]));

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.issues.filter(issue => issue.level === 'error').length, 2);
  assert.match(parsed.rows[0].issues.join(' '), /ملتبس/);
  assert.match(parsed.rows[0].issues.join(' '), /1 إلى 100/);
});

test('duplicate date and task type are rejected before server staging', () => {
  const parsed = parseQuranWorkbook(XLSX, workbookBuffer([
    headers,
    [new Date(2026, 11, 10), 'المقطع الأول', 3, null, null, null, null, null],
    [new Date(2026, 11, 10), 'المقطع الثاني', 3, null, null, null, null, null],
  ]));

  assert.equal(parsed.rows.length, 2);
  assert.ok(parsed.rows.every(row => row.issues.some(issue => issue.includes('مكررة'))));
});

test('server payload contains only the normalized contract fields', () => {
  const parsed = parseQuranWorkbook(XLSX, workbookBuffer([
    headers,
    [new Date(2026, 11, 11), 'عبس 1-7', 3, null, null, null, null, 'ملاحظة'],
  ], 'الحلقة الأولى'));

  assert.deepEqual(toServerRows(parsed.rows), [{
    source_sheet: 'الحلقة الأولى',
    source_row: 2,
    date: '2026-12-11',
    type: 'hifz',
    content: 'عبس 1-7',
    repetitions: 3,
    notes: 'ملاحظة',
  }]);
});

test('downloaded template can be parsed back into the importer', () => {
  const workbook = buildQuranReportTemplate(XLSX);
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const parsed = parseQuranWorkbook(XLSX, buffer);

  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows.map(row => row.type), ['hifz', 'murajaa']);
  assert.equal(parsed.issues.length, 0);
});
