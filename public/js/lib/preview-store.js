const STORAGE_PREFIX = 'zat_khail_preview_';
const MAX_PREVIEW_ROWS = 100;

function storageKey(collection) {
  return `${STORAGE_PREFIX}${collection}`;
}

export function loadPreviewCollection(collection, fallback = []) {
  try {
    const stored = sessionStorage.getItem(storageKey(collection));
    if (!stored) return [...fallback];

    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_PREVIEW_ROWS) : [...fallback];
  } catch (error) {
    console.warn(`تعذر قراءة بيانات المعاينة: ${collection}`, error);
    return [...fallback];
  }
}

export function addPreviewRecord(collection, record, fallback = []) {
  const rows = loadPreviewCollection(collection, fallback);
  const updatedRows = [record, ...rows].slice(0, MAX_PREVIEW_ROWS);
  sessionStorage.setItem(storageKey(collection), JSON.stringify(updatedRows));
  return updatedRows;
}

export function createPreviewId(prefix) {
  const randomPart = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomPart}`;
}
