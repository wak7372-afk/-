const HEADER_ALIASES = {
  date: ['التاريخ', 'تاريخ', 'date'],
  notes: ['ملاحظات', 'الملاحظات', 'notes', 'note'],
  hifz: ['الحفظ', 'حفظ', 'hifz'],
  hifzRepetitions: ['تكرارات الحفظ', 'تكرار الحفظ', 'عدد تكرارات الحفظ', 'hifz repetitions'],
  tathbit: ['التثبيت', 'تثبيت', 'tathbit'],
  tathbitRepetitions: ['تكرارات التثبيت', 'تكرار التثبيت', 'عدد تكرارات التثبيت', 'tathbit repetitions'],
  murajaa: ['المراجعة', 'مراجعة', 'murajaa', 'review'],
  murajaaRepetitions: ['تكرارات المراجعة', 'تكرار المراجعة', 'عدد تكرارات المراجعة', 'murajaa repetitions'],
};

const TASK_DEFINITIONS = [
  { type: 'hifz', column: 'hifz', repetitionsColumn: 'hifzRepetitions', label: 'الحفظ', maxPoints: 4 },
  { type: 'tathbit', column: 'tathbit', repetitionsColumn: 'tathbitRepetitions', label: 'التثبيت', maxPoints: 3 },
  { type: 'murajaa', column: 'murajaa', repetitionsColumn: 'murajaaRepetitions', label: 'المراجعة', maxPoints: 3 },
];

const EMPTY_TASK_VALUES = new Set(['', 'لايوجد', 'لايوجد.', 'none', 'n/a', '-', '—']);

export function parseQuranWorkbook(XLSX, arrayBuffer) {
  if (!XLSX?.read || !XLSX?.utils?.sheet_to_json) {
    throw new Error('تعذر تحميل قارئ Excel. حدّث الصفحة وحاول مجدداً.');
  }

  const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true, dense: false });
  const rows = [];
  const issues = [];
  const sheetSummaries = [];

  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    const header = findHeader(matrix);
    if (!header) {
      issues.push({ level: 'error', sheet: sheetName, row: null, message: 'لم يتم العثور على أعمدة التاريخ والحفظ أو التثبيت أو المراجعة.' });
      return;
    }

    let tasksInSheet = 0;
    for (let index = header.rowIndex + 1; index < matrix.length; index += 1) {
      const cells = matrix[index] || [];
      if (cells.every(isBlankCell)) continue;

      const rawDate = cells[header.columns.date];
      const parsedDate = parseSpreadsheetDate(XLSX, rawDate);
      const notes = cleanOptionalText(cells[header.columns.notes]);
      const sourceRow = index + 1;
      let foundTask = false;

      TASK_DEFINITIONS.forEach(definition => {
        const content = cleanTaskContent(cells[header.columns[definition.column]]);
        if (!content) return;
        foundTask = true;

        const repetitionResult = parseRepetitions(cells[header.columns[definition.repetitionsColumn]]);
        const rowIssues = [];
        if (!parsedDate.value) rowIssues.push(parsedDate.error || 'تاريخ غير صالح');
        if (repetitionResult.error) rowIssues.push(repetitionResult.error);

        rows.push({
          source_sheet: sheetName,
          source_row: sourceRow,
          date: parsedDate.value || String(rawDate ?? ''),
          type: definition.type,
          typeLabel: definition.label,
          content,
          repetitions: repetitionResult.value,
          notes,
          maxPoints: definition.maxPoints,
          issues: rowIssues,
        });
        tasksInSheet += 1;

        rowIssues.forEach(message => {
          issues.push({ level: 'error', sheet: sheetName, row: sourceRow, type: definition.type, message });
        });
      });

      if (!foundTask && !isBlankCell(rawDate)) {
        issues.push({ level: 'warning', sheet: sheetName, row: sourceRow, message: 'لا توجد مهمة حفظ أو تثبيت أو مراجعة في هذا الصف.' });
      }
    }

    sheetSummaries.push({ name: sheetName, headerRow: header.rowIndex + 1, tasksCount: tasksInSheet });
  });

  const duplicateKeys = new Map();
  rows.forEach(row => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return;
    const key = `${row.date}|${row.type}`;
    const existing = duplicateKeys.get(key);
    if (existing) {
      const message = `مهمة ${row.typeLabel} مكررة في التاريخ نفسه.`;
      row.issues.push(message);
      existing.issues.push(message);
      issues.push({ level: 'error', sheet: row.source_sheet, row: row.source_row, type: row.type, message });
    } else {
      duplicateKeys.set(key, row);
    }
  });

  return {
    rows,
    issues,
    sheets: sheetSummaries,
    sourceSheetCount: workbook.SheetNames.length,
  };
}

export function buildQuranReportTemplate(XLSX) {
  const workbook = XLSX.utils.book_new();
  const matrix = [
    ['التقرير اليومي', null, null, null, null, null, null, null],
    ['التاريخ', 'الحفظ', 'تكرارات الحفظ', 'التثبيت', 'تكرارات التثبيت', 'المراجعة', 'تكرارات المراجعة', 'ملاحظات'],
    [new Date(), 'سورة النبأ الآيات (1-4)', 3, 'لا يوجد', null, 'الصفحات (596-604)', 3, 'ملاحظة اختيارية'],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(matrix);
  sheet['!cols'] = [
    { wch: 14 }, { wch: 32 }, { wch: 18 }, { wch: 32 },
    { wch: 18 }, { wch: 32 }, { wch: 18 }, { wch: 38 },
  ];
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }];
  if (sheet.A3) sheet.A3.z = 'yyyy-mm-dd';
  XLSX.utils.book_append_sheet(workbook, sheet, 'الخطة اليومية');
  return workbook;
}

export function toServerRows(rows) {
  return rows.map(row => ({
    source_sheet: row.source_sheet,
    source_row: row.source_row,
    date: row.date,
    type: row.type,
    content: row.content,
    repetitions: row.repetitions,
    notes: row.notes,
  }));
}

function findHeader(matrix) {
  const searchLimit = Math.min(matrix.length, 20);
  for (let rowIndex = 0; rowIndex < searchLimit; rowIndex += 1) {
    const cells = matrix[rowIndex] || [];
    const columns = {};
    cells.forEach((value, columnIndex) => {
      const key = matchHeader(value);
      if (key && columns[key] === undefined) columns[key] = columnIndex;
    });
    const hasTaskColumn = TASK_DEFINITIONS.some(definition => columns[definition.column] !== undefined);
    if (columns.date !== undefined && hasTaskColumn) return { rowIndex, columns };
  }
  return null;
}

function matchHeader(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return Object.entries(HEADER_ALIASES).find(([, aliases]) => aliases.some(alias => normalizeText(alias) === normalized))?.[0] || null;
}

function cleanTaskContent(value) {
  const text = cleanOptionalText(value);
  if (!text) return null;
  return EMPTY_TASK_VALUES.has(normalizeText(text)) ? null : text;
}

function cleanOptionalText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function parseRepetitions(value) {
  if (isBlankCell(value)) return { value: null, error: null };
  const normalized = toLatinDigits(String(value)).trim();
  const number = Number(normalized);
  if (!Number.isInteger(number) || number < 1 || number > 100) {
    return { value: normalized, error: 'عدد التكرارات يجب أن يكون رقماً صحيحاً من 1 إلى 100.' };
  }
  return { value: number, error: null };
}

function parseSpreadsheetDate(XLSX, value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return validateDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parts = XLSX.SSF?.parse_date_code?.(value);
    if (parts) return validateDateParts(parts.y, parts.m, parts.d);
  }

  const text = toLatinDigits(String(value ?? '')).trim();
  if (!text) return { value: null, error: 'التاريخ مطلوب.' };
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) return validateDateParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const short = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (!short) return { value: null, error: 'صيغة التاريخ غير مفهومة؛ استخدم YYYY-MM-DD.' };
  const first = Number(short[1]);
  const second = Number(short[2]);
  const year = normalizeYear(Number(short[3]));
  if (first <= 12 && second <= 12) {
    return { value: null, error: 'التاريخ النصي ملتبس بين اليوم والشهر؛ استخدم YYYY-MM-DD.' };
  }
  return first > 12
    ? validateDateParts(year, second, first)
    : validateDateParts(year, first, second);
}

function validateDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return { value: null, error: 'التاريخ غير صالح.' };
  }
  return { value: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, error: null };
}

function normalizeYear(year) {
  return year < 100 ? 2000 + year : year;
}

function normalizeText(value) {
  return toLatinDigits(String(value ?? ''))
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\s_\-–—:،,.()]/g, '')
    .toLowerCase();
}

function toLatinDigits(value) {
  return value.replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

function isBlankCell(value) {
  return value === null || value === undefined || String(value).trim() === '';
}
