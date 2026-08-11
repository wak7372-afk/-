# Phase 6 Quran Reports - Database Gate

Date: 2026-08-11

## Approved product rules

- Quran reports use one daily window in `Asia/Muscat`: `00:00` to `23:00`.
- The automatic circle summary is scheduled for `23:05`.
- A source row may create independent hifz, tathbit, and murajaa tasks.
- Maximum points are fixed per task: hifz `4.00`, tathbit `3.00`, murajaa `3.00`.
- Missing task types do not redistribute points.
- Points decrease linearly and are stored with two decimal places on completion.
- An approved extension recalculates the decline over the extended window.
- One Excel plan targets either all active circle students or a selected snapshot.
- Students joining after approval do not receive historical assignments automatically.
- Existing assignments are reported as conflicts before approval.
- Completed and exempted assignments cannot be replaced.

## Implemented migrations

- `0015_quran_reports_core.sql`
  - Adds daily Quran timing settings without removing legacy morning/evening settings.
  - Adds import batches, normalized rows, recipient snapshots, shared reports, student assignments, immutable versions, assignment events, extension requests/items, and daily summaries.
  - Enforces one active assignment per student, date, and task type.
  - Enforces report, membership, student, timing, and point consistency in PostgreSQL.
  - Keeps legacy `daily_assignments` and `assignment_submissions` untouched.
- `0016_quran_reports_security.sql`
  - Restricts direct writes and grants authenticated users scoped read access only.
  - Allows administrators, lead teachers, and delegated assistants with `create_tasks` to stage imports.
  - Snapshots all or selected active Quran-circle memberships.
  - Validates up to 5,000 normalized report items and 250,000 resulting assignments.
  - Returns row, recipient, and conflict previews before publication.
  - Approves imports atomically with reject, replace, or skip conflict strategies.
  - Records platform audit events and sends one publication notification per recipient.

## Verification completed

- Full local Supabase reset applied migrations `0001` through `0016` successfully.
- SQL integration flow passed for:
  - all-student recipient snapshots;
  - selected-student imports;
  - `4/3/3` scoring at start, midpoint, and deadline;
  - conflict detection and explicit replacement;
  - immutable replacement history;
  - denied assistant access before delegation;
  - allowed assistant access after `create_tasks` delegation;
  - denied direct student writes;
  - required audit events.
- `supabase db lint --local --level warning`: no schema errors.
- Node test suite: 40 tests passed.
- `git diff --check`: clean except existing Windows line-ending warnings.

## Deployment state

The migrations have not been applied to the production Supabase project. Production deployment requires a separate owner approval after the Excel importer and UI have passed their gates.

## Gate status

This database gate was approved and the Excel importer gate was completed afterward. See `PHASE_6_QURAN_REPORTS_IMPORTER_REPORT.md` for its implementation and verification record.
