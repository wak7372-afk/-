import { isLocalPreviewMode } from '../lib/auth.js';
import { escapeHtml, showToast } from '../lib/utils.js?v=2';
import { buildQuranReportTemplate, parseQuranWorkbook, toServerRows } from '../lib/quran-report-excel.js';

const PAGE_SIZE = 18;
const TYPE_META = {
  hifz: { label: 'الحفظ', icon: 'book-open-check', points: 4 },
  tathbit: { label: 'التثبيت', icon: 'refresh-cw', points: 3 },
  murajaa: { label: 'المراجعة', icon: 'library-big', points: 3 },
};

export function createQuranReportImporter({ container, supabase, getContext, refreshIcons }) {
  const state = freshState();

  container.addEventListener('click', handleClick);
  container.addEventListener('change', handleChange);
  container.addEventListener('input', handleInput);

  return {
    render,
    reset: resetImporter,
  };

  function render() {
    const context = getContext();
    const activeStudents = getActiveStudents(context);
    container.className = 'quran-import-root';
    container.innerHTML = `
      <div class="quran-import-shell">
        ${renderStageHeader()}
        ${state.published ? renderPublishedState() : `
          ${renderUploadSection()}
          ${state.parsed ? renderParsedWorkspace(activeStudents) : ''}
        `}
      </div>`;
    refreshIcons();
  }

  function renderStageHeader() {
    const active = state.published ? 4 : state.serverPreview ? 3 : state.parsed ? 2 : 1;
    return `
      <div class="quran-import-steps" aria-label="مراحل إنشاء التقارير">
        ${['رفع الملف', 'المعاينة والطلاب', 'فحص التعارضات', 'الاعتماد'].map((label, index) => `
          <div class="quran-import-step ${active > index + 1 ? 'is-done' : ''} ${active === index + 1 ? 'is-active' : ''}">
            <span>${active > index + 1 ? '<i data-lucide="check"></i>' : index + 1}</span><b>${label}</b>
          </div>`).join('')}
      </div>`;
  }

  function renderUploadSection() {
    const locked = Boolean(state.serverPreview);
    return `
      <section class="quran-import-upload ${locked ? 'is-locked' : ''}" aria-labelledby="quran-import-upload-title">
        <div class="quran-import-section-heading">
          <div><span>ملف الخطة اليومية</span><h3 id="quran-import-upload-title">رفع Excel</h3></div>
          <button type="button" class="circle-secondary-command" data-import-action="download-template" ${locked ? 'disabled' : ''}>
            <i data-lucide="file-down"></i><span>تنزيل القالب</span>
          </button>
        </div>
        <label class="quran-import-dropzone ${state.busy ? 'is-busy' : ''}">
          <input id="quran-report-file" type="file" accept=".xlsx,.xls,.csv" ${locked || state.busy ? 'disabled' : ''}>
          <i data-lucide="file-spreadsheet"></i>
          <span><b>${escapeHtml(state.file?.name || 'اختيار ملف Excel')}</b><small>XLSX أو XLS أو CSV · حتى 10 MB</small></span>
          <span class="circle-primary-command">${state.file ? 'استبدال الملف' : 'اختيار ملف'}</span>
        </label>
        ${state.busy ? '<div class="quran-import-progress"><span></span><b>جاري تحليل الملف...</b></div>' : ''}
      </section>`;
  }

  function renderParsedWorkspace(activeStudents) {
    const rows = state.parsed.rows;
    const errorCount = state.parsed.issues.filter(issue => issue.level === 'error').length;
    const warningCount = state.parsed.issues.filter(issue => issue.level === 'warning').length;
    const dates = rows.map(row => row.date).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort();
    const totalPoints = rows.reduce((total, row) => total + Number(row.maxPoints || 0), 0);
    const recipientCount = state.audience === 'all' ? activeStudents.length : state.selectedStudents.size;
    const serverErrors = Number(state.serverPreview?.batch?.error_row_count || 0);
    const conflictCount = Number(state.serverPreview?.conflict_count || 0);

    return `
      <section class="quran-import-summary" aria-label="ملخص الملف">
        ${summaryMetric('calendar-days', 'الفترة', dates.length ? `${formatDate(dates[0])} - ${formatDate(dates.at(-1))}` : 'غير محددة')}
        ${summaryMetric('clipboard-list', 'المهام', rows.length)}
        ${summaryMetric('star', 'إجمالي النقاط', formatPoints(totalPoints))}
        ${summaryMetric(errorCount || serverErrors ? 'circle-alert' : 'shield-check', 'الأخطاء', Math.max(errorCount, serverErrors), errorCount || serverErrors ? 'danger' : 'success')}
        ${summaryMetric('users-round', 'المستفيدون', recipientCount)}
      </section>

      ${errorCount || warningCount ? renderIssues(errorCount, warningCount) : ''}
      ${renderReportPreview(rows)}
      ${renderAudienceSection(activeStudents, Boolean(state.serverPreview))}
      ${state.serverPreview ? renderServerReview(conflictCount) : renderStageAction(activeStudents)}
    `;
  }

  function renderIssues(errorCount, warningCount) {
    const visibleIssues = state.parsed.issues.slice(0, 12);
    return `
      <section class="quran-import-issues ${errorCount ? 'has-errors' : ''}">
        <div class="quran-import-section-heading"><div><span>نتيجة التحليل</span><h3>${errorCount} خطأ · ${warningCount} تنبيه</h3></div></div>
        <div class="quran-import-issue-list">
          ${visibleIssues.map(issue => `<div><i data-lucide="${issue.level === 'error' ? 'circle-alert' : 'triangle-alert'}"></i><span>${escapeHtml(issue.message)}${issue.row ? ` · ${escapeHtml(issue.sheet)}، الصف ${issue.row}` : ''}</span></div>`).join('')}
          ${state.parsed.issues.length > visibleIssues.length ? `<small>و${state.parsed.issues.length - visibleIssues.length} ملاحظة أخرى</small>` : ''}
        </div>
      </section>`;
  }

  function renderReportPreview(rows) {
    const filteredRows = rows.filter(row => state.typeFilter === 'all' || row.type === state.typeFilter);
    const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
    state.page = Math.min(state.page, totalPages);
    const pageRows = filteredRows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    return `
      <section class="quran-import-preview" aria-labelledby="quran-import-preview-title">
        <div class="quran-import-section-heading">
          <div><span>المعاينة</span><h3 id="quran-import-preview-title">التقارير المستخرجة</h3></div>
          <div class="quran-import-filters" role="group" aria-label="تصفية التقارير">
            ${['all', 'hifz', 'tathbit', 'murajaa'].map(type => `<button type="button" class="${state.typeFilter === type ? 'is-active' : ''}" data-import-filter="${type}">${type === 'all' ? 'الكل' : TYPE_META[type].label}</button>`).join('')}
          </div>
        </div>
        <div class="quran-report-preview-grid">
          ${pageRows.map(renderReportCard).join('') || '<div class="workspace-empty-state"><p>لا توجد تقارير ضمن هذا التصنيف.</p></div>'}
        </div>
        ${totalPages > 1 ? `<div class="quran-import-pagination">
          <button type="button" data-import-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
          <span>صفحة ${state.page} من ${totalPages}</span>
          <button type="button" data-import-page="${state.page + 1}" ${state.page === totalPages ? 'disabled' : ''}><i data-lucide="chevron-left"></i></button>
        </div>` : ''}
      </section>`;
  }

  function renderReportCard(row) {
    const meta = TYPE_META[row.type] || TYPE_META.hifz;
    const hasError = row.issues?.length;
    return `
      <article class="quran-report-preview-card type-${row.type} ${hasError ? 'has-error' : ''}">
        <div class="quran-report-card-head">
          <span class="quran-report-type"><i data-lucide="${meta.icon}"></i>${meta.label}</span>
          <time>${escapeHtml(formatDate(row.date))}</time>
        </div>
        <strong>${escapeHtml(row.content)}</strong>
        <div class="quran-report-card-meta">
          <span><i data-lucide="star"></i>${formatPoints(row.maxPoints)} نقطة</span>
          ${row.repetitions ? `<span><i data-lucide="repeat-2"></i>${escapeHtml(row.repetitions)} تكرارات</span>` : ''}
          <span><i data-lucide="sheet"></i>${escapeHtml(row.source_sheet)} · صف ${row.source_row}</span>
        </div>
        ${row.notes ? `<p>${escapeHtml(row.notes)}</p>` : ''}
        ${hasError ? `<small class="quran-report-card-error">${escapeHtml(row.issues.join(' · '))}</small>` : ''}
      </article>`;
  }

  function renderAudienceSection(activeStudents, locked) {
    const filteredStudents = activeStudents.filter(student => {
      const query = state.studentSearch.trim().toLowerCase();
      return !query || `${student.full_name} ${student.username}`.toLowerCase().includes(query);
    });
    return `
      <section class="quran-import-audience" aria-labelledby="quran-import-audience-title">
        <div class="quran-import-section-heading"><div><span>المستفيدون</span><h3 id="quran-import-audience-title">إسناد الخطة</h3></div><b>${state.audience === 'all' ? activeStudents.length : state.selectedStudents.size} طالب</b></div>
        <div class="quran-audience-segments" role="radiogroup" aria-label="نطاق التقارير">
          <label class="${state.audience === 'all' ? 'is-active' : ''}"><input type="radio" name="quran-audience" value="all" ${state.audience === 'all' ? 'checked' : ''} ${locked ? 'disabled' : ''}><i data-lucide="users-round"></i><span><b>جميع الطلاب</b><small>${activeStudents.length} طالباً نشطاً</small></span></label>
          <label class="${state.audience === 'selected' ? 'is-active' : ''}"><input type="radio" name="quran-audience" value="selected" ${state.audience === 'selected' ? 'checked' : ''} ${locked ? 'disabled' : ''}><i data-lucide="list-checks"></i><span><b>طلاب محددون</b><small>${state.selectedStudents.size} محدد</small></span></label>
        </div>
        ${state.audience === 'selected' ? `
          <div class="quran-student-picker">
            <div class="quran-student-picker-tools">
              <label><i data-lucide="search"></i><input id="quran-student-search" type="search" value="${escapeHtml(state.studentSearch)}" placeholder="بحث بالاسم أو اسم المستخدم" ${locked ? 'disabled' : ''}></label>
              <button type="button" data-import-action="select-visible" ${locked ? 'disabled' : ''}>تحديد الظاهر</button>
              <button type="button" data-import-action="clear-students" ${locked ? 'disabled' : ''}>إلغاء التحديد</button>
            </div>
            <div class="quran-student-list">
              ${filteredStudents.map(student => `<label class="${state.selectedStudents.has(student.student_id) ? 'is-selected' : ''}">
                <input type="checkbox" data-import-student="${escapeHtml(student.student_id)}" ${state.selectedStudents.has(student.student_id) ? 'checked' : ''} ${locked ? 'disabled' : ''}>
                <span class="person-avatar">${escapeHtml(firstCharacter(student.full_name))}</span>
                <span><b>${escapeHtml(student.full_name)}</b><small>@${escapeHtml(student.username || '')}</small></span>
                <i data-lucide="check"></i>
              </label>`).join('') || '<div class="workspace-empty-state"><p>لا توجد نتائج.</p></div>'}
            </div>
          </div>` : ''}
      </section>`;
  }

  function renderStageAction(activeStudents) {
    const recipientCount = state.audience === 'all' ? activeStudents.length : state.selectedStudents.size;
    const errorCount = state.parsed.issues.filter(issue => issue.level === 'error').length;
    const disabled = state.busy || !state.parsed.rows.length || !recipientCount || errorCount > 0;
    return `
      <div class="quran-import-final-action">
        <div><b>${state.parsed.rows.length * recipientCount} مهمة طالب متوقعة</b><span>${errorCount ? 'صحح أخطاء الملف قبل الفحص النهائي' : `${state.parsed.rows.length} تقرير × ${recipientCount} طالب`}</span></div>
        <button type="button" class="circle-primary-command" data-import-action="stage" ${disabled ? 'disabled' : ''}><i data-lucide="shield-check"></i><span>${state.busy ? 'جاري الفحص...' : errorCount ? 'الملف يحتاج تصحيحاً' : 'فحص التعارضات'}</span></button>
      </div>`;
  }

  function renderServerReview(conflictCount) {
    const errorCount = Number(state.serverPreview.batch?.error_row_count || 0);
    const conflicts = Array.isArray(state.serverPreview.conflicts) ? state.serverPreview.conflicts : [];
    const nonReplaceable = conflicts.some(conflict => ['completed', 'exempted'].includes(conflict.existing_status));
    const canApprove = !errorCount && (!conflictCount || state.conflictStrategy) && !(nonReplaceable && state.conflictStrategy === 'replace');
    return `
      <section class="quran-import-server-review ${errorCount || conflictCount ? 'needs-attention' : 'is-clear'}">
        <div class="quran-import-section-heading">
          <div><span>الفحص النهائي</span><h3>${errorCount ? 'يجب تصحيح الملف' : conflictCount ? `${conflictCount} تعارض مع خطط الطلاب` : 'الخطة جاهزة للاعتماد'}</h3></div>
          <span class="quran-review-status"><i data-lucide="${errorCount || conflictCount ? 'triangle-alert' : 'badge-check'}"></i>${errorCount || conflictCount ? 'تحتاج قراراً' : 'تم التحقق'}</span>
        </div>
        ${state.archiveWarning ? `<div class="quran-import-archive-warning" role="status"><i data-lucide="archive-x"></i><span><b>تعذر حفظ نسخة الملف الأصلية</b><small>${escapeHtml(state.archiveWarning)} يمكنك مراجعة التعارضات واعتماد التقارير بصورة طبيعية.</small></span></div>` : ''}
        ${conflictCount ? renderConflicts(conflicts, nonReplaceable) : ''}
        <div class="quran-import-final-action">
          <button type="button" class="circle-secondary-command" data-import-action="reset"><i data-lucide="arrow-right"></i><span>العودة والتعديل</span></button>
          <div><b>${Number(state.serverPreview.batch?.valid_row_count || 0)} تقرير صالح</b><span>${Number(state.serverPreview.batch?.recipient_count || 0)} طالباً في لقطة الاعتماد</span></div>
          <button type="button" class="circle-primary-command" data-import-action="approve" ${!canApprove || state.busy ? 'disabled' : ''}><i data-lucide="send"></i><span>${state.busy ? 'جاري الاعتماد...' : 'اعتماد ونشر التقارير'}</span></button>
        </div>
      </section>`;
  }

  function renderConflicts(conflicts, nonReplaceable) {
    return `
      <div class="quran-conflict-layout">
        <div class="quran-conflict-list">
          ${conflicts.slice(0, 12).map(conflict => `<article>
            <span class="person-avatar">${escapeHtml(firstCharacter(conflict.full_name))}</span>
            <div><b>${escapeHtml(conflict.full_name)}</b><small>${formatDate(conflict.report_date)} · ${TYPE_META[conflict.task_type]?.label || conflict.task_type}</small><p><del>${escapeHtml(conflict.existing_content)}</del><i data-lucide="arrow-left"></i><ins>${escapeHtml(conflict.incoming_content)}</ins></p></div>
            <em>${conflictStatusLabel(conflict.existing_status)}</em>
          </article>`).join('')}
          ${conflicts.length >= 500 ? '<small>تظهر أول 500 حالة؛ العدد الكامل محسوب في الملخص.</small>' : ''}
        </div>
        <div class="quran-conflict-strategies" role="radiogroup" aria-label="طريقة معالجة التعارض">
          <label class="${state.conflictStrategy === 'replace' ? 'is-active' : ''} ${nonReplaceable ? 'is-disabled' : ''}"><input type="radio" name="conflict-strategy" value="replace" ${state.conflictStrategy === 'replace' ? 'checked' : ''} ${nonReplaceable ? 'disabled' : ''}><i data-lucide="replace"></i><span><b>استبدال القديمة</b><small>يحفظ الإصدار السابق في السجل.</small></span></label>
          <label class="${state.conflictStrategy === 'skip' ? 'is-active' : ''}"><input type="radio" name="conflict-strategy" value="skip" ${state.conflictStrategy === 'skip' ? 'checked' : ''}><i data-lucide="list-minus"></i><span><b>تجاوز المتعارضة</b><small>ينشر بقية التقارير فقط.</small></span></label>
          ${state.conflictStrategy === 'replace' ? `<fieldset class="quran-replaced-history-options"><legend>سجل المهام القديمة</legend><label><input type="radio" name="replaced-history-action" value="keep" ${state.replacedHistoryAction === 'keep' ? 'checked' : ''}><span><b>الاحتفاظ بالسجل</b><small>تبقى المهام بحالة مستبدلة ولا تُحسب كتأخير.</small></span></label><label><input type="radio" name="replaced-history-action" value="delete" ${state.replacedHistoryAction === 'delete' ? 'checked' : ''}><span><b>حذف المهام القديمة</b><small>يحذف المهام المعلقة المستبدلة من سجل الطالب، مع إبقاء أثر إداري للعملية.</small></span></label></fieldset>` : ''}
        </div>
      </div>`;
  }

  function renderPublishedState() {
    const result = state.published;
    return `
      <section class="quran-import-success">
        <span><i data-lucide="badge-check"></i></span>
        <div><small>تم الاعتماد</small><h3>نُشرت خطة التقارير بنجاح</h3><p>${Number(result.reports_count || 0)} تقرير · ${Number(result.assignments_count || 0)} مهمة طالب</p></div>
        <div class="quran-import-success-metrics">
          <span><b>${Number(result.replaced_count || 0)}</b><small>مستبدلة</small></span>
          <span><b>${Number(result.skipped_count || 0)}</b><small>متجاوزة</small></span>
          ${Number(result.deleted_history_count || 0) ? `<span><b>${Number(result.deleted_history_count)}</b><small>سجل قديم محذوف</small></span>` : ''}
        </div>
        <button type="button" class="circle-primary-command" data-import-action="new"><i data-lucide="plus"></i><span>خطة جديدة</span></button>
      </section>`;
  }

  async function handleChange(event) {
    const fileInput = event.target.closest('#quran-report-file');
    if (fileInput) {
      await parseFile(fileInput.files?.[0]);
      return;
    }
    if (event.target.name === 'quran-audience') {
      state.audience = event.target.value;
      render();
      return;
    }
    const studentInput = event.target.closest('[data-import-student]');
    if (studentInput) {
      if (studentInput.checked) state.selectedStudents.add(studentInput.dataset.importStudent);
      else state.selectedStudents.delete(studentInput.dataset.importStudent);
      render();
      return;
    }
    if (event.target.name === 'conflict-strategy') {
      state.conflictStrategy = event.target.value;
      if (state.conflictStrategy !== 'replace') state.replacedHistoryAction = 'keep';
      render();
      return;
    }
    if (event.target.name === 'replaced-history-action') {
      state.replacedHistoryAction = event.target.value;
      render();
    }
  }

  function handleInput(event) {
    if (event.target.id !== 'quran-student-search') return;
    const position = event.target.selectionStart;
    state.studentSearch = event.target.value;
    render();
    const input = container.querySelector('#quran-student-search');
    input?.focus();
    input?.setSelectionRange(position, position);
  }

  async function handleClick(event) {
    const filter = event.target.closest('[data-import-filter]');
    if (filter) {
      state.typeFilter = filter.dataset.importFilter;
      state.page = 1;
      render();
      return;
    }
    const page = event.target.closest('[data-import-page]');
    if (page && !page.disabled) {
      state.page = Number(page.dataset.importPage);
      render();
      return;
    }
    const action = event.target.closest('[data-import-action]')?.dataset.importAction;
    if (!action) return;
    if (action === 'download-template') return downloadTemplate();
    if (action === 'select-visible') return selectVisibleStudents();
    if (action === 'clear-students') {
      state.selectedStudents.clear();
      return render();
    }
    if (action === 'stage') return stageImport();
    if (action === 'approve') return approveImport();
    if (action === 'reset') return resetImporter(true);
    if (action === 'new') return resetImporter(false);
  }

  async function parseFile(file) {
    if (!file) return;
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      showToast('نوع الملف غير مدعوم. استخدم XLSX أو XLS أو CSV.', 'error');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showToast('حجم ملف Excel يتجاوز 10 MB.', 'error');
      return;
    }

    state.busy = true;
    state.file = file;
    state.parsed = null;
    render();
    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseQuranWorkbook(window.XLSX, buffer);
      if (!parsed.rows.length) throw new Error('لم يعثر النظام على أي مهام قابلة للمعاينة في الملف.');
      state.fileBuffer = buffer;
      state.fileHash = await sha256Hex(buffer);
      state.parsed = parsed;
      state.page = 1;
      state.typeFilter = 'all';
      showToast(`تم تحليل ${parsed.rows.length} تقريراً.`, 'success');
    } catch (error) {
      console.error('Quran Excel parsing failed:', error);
      state.file = null;
      showToast(error.message || 'تعذر تحليل ملف Excel.', 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function stageImport() {
    const context = getContext();
    const activeStudents = getActiveStudents(context);
    const selectedIds = state.audience === 'selected' ? [...state.selectedStudents] : null;
    if (!state.parsed?.rows.length || !state.file) return;
    if (state.audience === 'selected' && !selectedIds.length) {
      showToast('حدد طالباً واحداً على الأقل.', 'error');
      return;
    }
    if (!activeStudents.length) {
      showToast('لا يوجد طلاب نشطون في الحلقة.', 'error');
      return;
    }

    state.busy = true;
    render();
    try {
      if (isLocalPreviewMode()) {
        state.batchId = 'preview-batch';
        state.serverPreview = previewServerResult(activeStudents, selectedIds);
      } else {
        const { data: staged, error: stageError } = await supabase.rpc('stage_quran_report_import', {
          p_circle_id: context.circle.id,
          p_file_name: state.file.name,
          p_file_size_bytes: state.file.size,
          p_file_sha256: state.fileHash,
          p_rows: toServerRows(state.parsed.rows),
          p_audience_mode: state.audience,
          p_student_ids: selectedIds,
          p_storage_path: null,
          p_metadata: { parser: 'quran-daily-v1', source_sheets: state.parsed.sheets },
        });
        if (stageError) throw stageError;
        state.batchId = staged.batch_id;
        const { data: preview, error: previewError } = await supabase.rpc('get_quran_report_import_preview', { p_batch_id: state.batchId });
        if (previewError) throw previewError;
        state.serverPreview = preview;
        await archiveOriginalFile(context);
      }
      state.conflictStrategy = Number(state.serverPreview.conflict_count || 0) ? '' : 'reject';
      showToast('اكتمل فحص التقارير والمستفيدين.', 'success');
    } catch (error) {
      console.error('Quran report staging failed:', error);
      await rollbackFailedStage();
      showToast(friendlyImportError(error, 'تعذر فحص التقارير.'), 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function approveImport() {
    if (!state.batchId || !state.serverPreview) return;
    state.busy = true;
    render();
    try {
      if (isLocalPreviewMode()) {
        const recipientCount = Number(state.serverPreview.batch.recipient_count || 0);
        state.published = {
          reports_count: Number(state.serverPreview.batch.valid_row_count || 0),
          assignments_count: Number(state.serverPreview.batch.valid_row_count || 0) * recipientCount,
          replaced_count: state.conflictStrategy === 'replace' ? Number(state.serverPreview.conflict_count || 0) : 0,
          skipped_count: state.conflictStrategy === 'skip' ? Number(state.serverPreview.conflict_count || 0) : 0,
          deleted_history_count: state.conflictStrategy === 'replace' && state.replacedHistoryAction === 'delete' ? Number(state.serverPreview.conflict_count || 0) : 0,
        };
      } else {
        const { data, error } = await supabase.rpc('approve_quran_report_import_with_history', {
          p_batch_id: state.batchId,
          p_conflict_strategy: state.conflictStrategy || 'reject',
          p_replaced_history_action: state.replacedHistoryAction,
        });
        if (error) throw error;
        state.published = data;
      }
      showToast('تم اعتماد ونشر تقارير القرآن.', 'success');
    } catch (error) {
      console.error('Quran report approval failed:', error);
      showToast(friendlyImportError(error, 'تعذر اعتماد التقارير.'), 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function resetImporter(cancelStaged) {
    if (cancelStaged && state.batchId && !state.published && !isLocalPreviewMode()) {
      state.busy = true;
      render();
      try {
        const { error } = await supabase.rpc('cancel_quran_report_import', { p_batch_id: state.batchId });
        if (error) throw error;
        await removeUploadedFile();
      } catch (error) {
        showToast(friendlyImportError(error, 'تعذر إلغاء دفعة المعاينة.'), 'error');
        state.busy = false;
        render();
        return;
      }
    }
    Object.assign(state, freshState());
    render();
  }

  function selectVisibleStudents() {
    const activeStudents = getActiveStudents(getContext());
    const query = state.studentSearch.trim().toLowerCase();
    activeStudents.filter(student => !query || `${student.full_name} ${student.username}`.toLowerCase().includes(query))
      .forEach(student => state.selectedStudents.add(student.student_id));
    render();
  }

  function downloadTemplate() {
    if (!window.XLSX) return showToast('قارئ Excel غير متاح.', 'error');
    const workbook = buildQuranReportTemplate(window.XLSX);
    const bytes = window.XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'قالب-تقارير-القرآن-ذات-خيل.xlsx';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function uploadOriginalFile(context) {
    const safeName = state.file.name.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(-140);
    const path = `${context.circle.id}/${context.profile.id}/${crypto.randomUUID()}-${safeName}`;
    const { error } = await supabase.storage.from('quran-report-imports').upload(path, state.file, {
      cacheControl: '3600',
      upsert: false,
      contentType: mimeFromName(state.file.name),
    });
    if (error) throw error;
    return path;
  }

  async function archiveOriginalFile(context) {
    state.archiveWarning = '';
    try {
      const storagePath = await uploadOriginalFile(context);
      state.storagePath = storagePath;
      const { error } = await supabase.rpc('attach_quran_report_import_file', {
        p_batch_id: state.batchId,
        p_storage_path: storagePath,
      });
      if (error) throw error;
    } catch (error) {
      console.error('Quran report source archive failed:', error);
      state.archiveWarning = friendlyImportError(error, 'لم تُحفظ نسخة الملف في الأرشيف السحابي.');
      try {
        await removeUploadedFile();
      } catch (cleanupError) {
        console.error('Quran report source archive cleanup failed:', cleanupError);
      }
    }
  }

  async function removeUploadedFile() {
    if (!state.storagePath || isLocalPreviewMode()) return;
    const { error } = await supabase.storage.from('quran-report-imports').remove([state.storagePath]);
    if (error) throw error;
    state.storagePath = null;
  }

  async function rollbackFailedStage() {
    try {
      if (state.batchId && !isLocalPreviewMode()) {
        const { error } = await supabase.rpc('cancel_quran_report_import', { p_batch_id: state.batchId });
        if (error) throw error;
        state.batchId = null;
      }
      await removeUploadedFile();
    } catch (cleanupError) {
      console.error('Quran report staging cleanup failed:', cleanupError);
    }
  }

  function previewServerResult(activeStudents, selectedIds) {
    const recipients = state.audience === 'all'
      ? activeStudents
      : activeStudents.filter(student => selectedIds.includes(student.student_id));
    const errorRows = state.parsed.rows.filter(row => row.issues?.length).length;
    return {
      batch: {
        valid_row_count: state.parsed.rows.length - errorRows,
        error_row_count: errorRows,
        recipient_count: recipients.length,
      },
      rows: state.parsed.rows,
      recipients,
      conflict_count: 0,
      conflicts: [],
    };
  }
}

function freshState() {
  return {
    file: null,
    fileBuffer: null,
    fileHash: null,
    parsed: null,
    audience: 'all',
    selectedStudents: new Set(),
    studentSearch: '',
    typeFilter: 'all',
    page: 1,
    batchId: null,
    storagePath: null,
    archiveWarning: '',
    serverPreview: null,
    conflictStrategy: '',
    replacedHistoryAction: 'keep',
    published: null,
    busy: false,
  };
}

function getActiveStudents(context) {
  return (context.workspace?.people?.students || []).filter(student => student.status === 'active');
}

function summaryMetric(icon, label, value, tone = '') {
  return `<div class="quran-summary-metric ${tone ? `is-${tone}` : ''}"><i data-lucide="${icon}"></i><span>${label}</span><b>${escapeHtml(String(value))}</b></div>`;
}

async function sha256Hex(buffer) {
  if (!crypto?.subtle) throw new Error('المتصفح لا يدعم بصمة الملفات الآمنة.');
  const digest = await crypto.subtle.digest('SHA-256', buffer.slice(0));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return String(value || 'تاريخ غير صالح');
  return new Intl.DateTimeFormat('ar-OM', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Muscat' })
    .format(new Date(`${value}T12:00:00+04:00`));
}

function formatPoints(value) {
  return Number(value || 0).toFixed(2);
}

function firstCharacter(value) {
  return String(value || 'ط').trim().charAt(0) || 'ط';
}

function conflictStatusLabel(status) {
  if (status === 'completed') return 'منجز';
  if (status === 'exempted') return 'معفى';
  return 'مخطط';
}

function mimeFromName(name) {
  if (/\.csv$/i.test(name)) return 'text/csv';
  if (/\.xls$/i.test(name)) return 'application/vnd.ms-excel';
  return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

function friendlyImportError(error, fallback) {
  const message = String(error?.message || '');
  if (/validation errors/i.test(message)) return 'يحتوي الملف على أخطاء؛ صححها ثم أعد رفعه.';
  if (/conflicts with existing/i.test(message)) return 'توجد تقارير متعارضة؛ اختر الاستبدال أو التجاوز.';
  if (/completed or exempted/i.test(message)) return 'لا يمكن استبدال تقرير منجز أو معفى؛ استخدم التجاوز.';
  if (/not active members|eligible selected/i.test(message)) return 'تغيرت عضوية أحد الطلاب؛ أعد اختيار المستفيدين.';
  if (/permission|not allowed|authorized|42501/i.test(message)) return 'لا تملك صلاحية إنشاء تقارير هذه الحلقة.';
  if (/file size/i.test(message)) return 'حجم الملف غير مسموح.';
  if (/mime|content.?type|invalid.*type/i.test(message)) return 'صيغة ملف Excel غير مقبولة في الأرشيف السحابي.';
  if (/bucket.*not found|quran-report-imports.*not found/i.test(message)) return 'مخزن ملفات التقارير غير متاح حالياً.';
  if (/row-level security|storage.*policy|stored Excel file/i.test(message)) return 'تعذر أرشفة الملف بسبب صلاحيات التخزين.';
  if (/failed to fetch|network|load failed/i.test(message)) return 'تعذر الاتصال بالخدمة السحابية. تحقق من الشبكة ثم حاول مجدداً.';
  return fallback;
}
