# Phase 6 Quran Reports - Excel Importer Gate

Date: 2026-08-11

## Scope completed

- Adds an Excel importer to the reports tab of Quran circles for administrators, lead teachers, and delegated assistant teachers.
- Downloads an Arabic workbook template for date, hifz, tathbit, murajaa, repetitions, and notes.
- Accepts `XLSX`, `XLS`, and `CSV` files up to 10 MB.
- Locates the header row within the first 20 rows and supports Arabic and English aliases.
- Converts every source row into independent hifz, tathbit, and murajaa report items.
- Applies the approved fixed maximums: hifz `4`, tathbit `3`, and murajaa `3`.
- Skips blank cells and the value `لا يوجد` without redistributing points.
- Blocks invalid dates, repetitions outside `1-100`, and duplicate date/task combinations.
- Shows the date range, task count, total possible points, errors, recipients, source sheet, and source row before any server write.
- Filters the preview by hifz, tathbit, and murajaa and paginates long plans.
- Assigns the complete uploaded plan to all active students or an explicit selected snapshot.
- Uploads the original workbook to the private `quran-report-imports` bucket.
- Stages the normalized rows through the protected RPC, displays conflicts, and requires an explicit replace or skip decision.
- Prevents replacement when an existing assignment is completed or exempted.
- Approves publication atomically and shows report, assignment, replacement, and skip counts.
- Cancels the staged batch and removes the uploaded file when the teacher returns to edit.
- Rolls back a staged batch if the server preview fails after upload.

## Real workbook verification

The owner workbook `موقع مركز ذات خيل.xlsx` was parsed successfully:

- Sheet: `ورقة1`
- Header row: `2`
- Plan dates: `2026-12-08` through `2026-12-21`
- Hifz reports: `14`
- Tathbit reports: `13`
- Murajaa reports: `10`
- Total reports: `37`
- Total maximum points across the plan: `125.00`
- Parser errors: `0`
- Parser warnings: `0`

## Verification completed

- Full Node suite: `48/48` tests passed.
- Excel parser unit tests cover the Arabic schema, `4/3/3` points, missing task types, invalid repetitions, ambiguous dates, duplicate reports, server payload normalization, and template round-trip parsing.
- Static integrity confirms all importer RPCs exist in migrations and the private storage bucket contract is present.
- Desktop browser flow passed with the real workbook:
  - 37 parsed reports;
  - all/selected audience switching;
  - 10 murajaa reports after filtering;
  - one selected student producing 37 expected assignments;
  - staging, server-preview simulation, approval, and success summary.
- Mobile verification at `390x844` passed:
  - no horizontal overflow;
  - one-column report cards;
  - readable four-step workflow;
  - fixed navigation does not resize the content.
- Browser console warnings and errors: none.
- Downloaded template content is verified by a write/read round-trip test. The in-app browser test backend did not expose a Blob download event, so the generated file download itself remains a short manual click check.
- `git diff --check`: no whitespace errors; only existing Windows line-ending notices.

## Deployment state

- The interface is available in local preview mode at the Quran circle reports tab.
- Production Supabase migrations `0015` and `0016` are still not applied.
- The current work is not deployed to Vercel yet.
- Cloud publication must not be tested until the owner separately approves the production database migration and deployment.

## Gate decision

The Excel import, analysis, recipient selection, conflict review, and atomic approval gate is implementation-complete and locally verified. The next product gate must wait for owner review and approval.
