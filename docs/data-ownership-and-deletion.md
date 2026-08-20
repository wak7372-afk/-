# Data Ownership, Transfer, and Deletion Rules

This document is the implementation contract for student records, circle transfers,
and permanent deletion. Database functions and user interfaces must enforce the same
rules.

## Student record ownership

- A student's educational history belongs to the student, not to a former circle.
- Approving a Quran-circle transfer must move the student's active Quran plan and
  student-specific records to the destination circle in the same database transaction
  that creates the new membership.
- The move includes pending and completed Quran assignments, extension requests,
  plan-adjustment events, and student-specific import recipients that are still needed
  to explain the student's plan.
- Shared source material and summaries remain with their original circle. When a
  student-specific record depends on shared source material, the transfer operation
  must copy or re-home the minimum required source record before moving the student's
  record.
- A transfer is complete only after the destination membership and all moved records
  pass integrity checks. A partial transfer must roll back entirely.

## Circle deletion

- Archiving is the default reversible operation.
- Permanent deletion is restricted to active administrators and requires an impact
  preview plus typed confirmation.
- Deleting an old circle must never delete the history of a student whose transfer to
  another circle completed successfully.
- Circle-owned data for students who were not transferred is deleted with the circle.
- Pending transfers involving the deleted circle must be resolved or cancelled before
  permanent deletion.
- The platform keeps a minimal non-personal audit event for the destructive action.

## Account deletion

- Permanent account deletion removes the authentication identity, profile, active
  memberships, student-specific educational history, messages, requests,
  notifications, and owned files.
- The primary administrator account cannot delete itself.
- Account deletion must run server-side in a transaction where possible, followed by
  authentication and storage cleanup. Any failure must be reported as partial and
  retried safely; it must not be reported as complete.

## Backup baseline

Before the first migration implementing these rules, a schema dump and data dump were
created under the ignored `scratch/` directory. They contain production data and must
never be committed.
