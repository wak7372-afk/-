import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInterventions,
  buildPeriodCards,
  buildTaskMetrics,
  buildTodaySummary,
  studentTrend,
  taskState,
} from '../public/js/lib/teacher-student-analytics.js';

test('teacher interventions prioritize overdue students over mild decline', () => {
  const consoleStudents = [
    { student_id: 'stable', full_name: 'طالب مستقر', daily_state: 'completed', overdue_count: 0 },
    { student_id: 'overdue', full_name: 'طالب متأخر', daily_state: 'overdue', overdue_count: 2 },
    { student_id: 'declining', full_name: 'طالب متراجع', daily_state: 'completed', overdue_count: 0 },
  ];
  const performanceStudents = [
    { student_id: 'stable', completion_rate_7: 90, previous_completion_rate_7: 88, on_time_rate_7: 90 },
    { student_id: 'overdue', completion_rate_7: 70, previous_completion_rate_7: 70, on_time_rate_7: 65 },
    { student_id: 'declining', completion_rate_7: 62, previous_completion_rate_7: 85, on_time_rate_7: 70 },
  ];

  const interventions = buildInterventions(consoleStudents, performanceStudents);
  assert.equal(interventions[0].student_id, 'overdue');
  assert.equal(interventions[0].reasons[0].tone, 'is-critical');
  assert.ok(interventions.some(item => item.student_id === 'declining'));
  assert.ok(!interventions.some(item => item.student_id === 'stable'));
});

test('teacher interventions do not flag an ordinary pending student far from the deadline', () => {
  const students = [
    { student_id: 'far', daily_state: 'pending', next_due_at: '2026-08-23T23:00:00+04:00' },
    { student_id: 'soon', daily_state: 'partial', next_due_at: '2026-08-23T11:30:00+04:00' },
  ];
  const interventions = buildInterventions(students, [], {
    now: '2026-08-23T10:00:00+04:00',
    dueSoonMinutes: 120,
  });
  assert.deepEqual(interventions.map(item => item.student_id), ['soon']);
  assert.equal(interventions[0].priority, 'urgent');
  assert.match(interventions[0].reasons[0].label, /بقي/);
});

test('today summary distinguishes students from reports', () => {
  const summary = buildTodaySummary({
    student_count: 2,
    completed_on_time_students: 1,
    completed_late_students: 0,
    pending_students: 1,
    overdue_students: 1,
  }, [
    { report_count: 3, completed_count: 3, overdue_count: 0 },
    { report_count: 3, completed_count: 1, overdue_count: 2 },
  ]);
  assert.equal(summary.overdueStudents, 1);
  assert.equal(summary.overdueReports, 2);
  assert.equal(summary.completionRate, 66.66666666666666);
});

test('period cards preserve equivalent-period comparisons', () => {
  const cards = buildPeriodCards({
    week: {
      current: { completion_rate: 78.5, on_time_rate: 82, completed_student_days: 44, expected_student_days: 56 },
      completion_rate_delta: 6.5,
    },
  });
  const week = cards.find(card => card.key === 'week');
  assert.equal(cards.length, 3);
  assert.equal(week.completionRate, 78.5);
  assert.equal(week.completionDelta, 6.5);
  assert.equal(week.completedCount, 44);
});

test('task metrics calculate a bounded completion rate for each Quran task type', () => {
  const tasks = buildTaskMetrics({
    hifz: { assigned_count: 10, completed_count: 8 },
    tathbit: { assigned_count: 5, completed_count: 7 },
  });
  assert.deepEqual(tasks.map(task => task.key), ['hifz', 'tathbit', 'murajaa']);
  assert.equal(tasks.find(task => task.key === 'hifz').completionRate, 80);
  assert.equal(tasks.find(task => task.key === 'tathbit').completionRate, 100);
  assert.equal(tasks.find(task => task.key === 'murajaa').completionRate, 0);
});

test('student trend and daily task state use clear operational thresholds', () => {
  assert.equal(studentTrend({ completion_rate_7: 80, previous_completion_rate_7: 68 }).key, 'improving');
  assert.equal(studentTrend({ completion_rate_7: 60, previous_completion_rate_7: 75 }).key, 'declining');
  assert.equal(studentTrend({ completion_rate_7: 73, previous_completion_rate_7: 70 }).key, 'stable');
  assert.deepEqual(taskState([{ task_type: 'hifz', status: 'pending', is_overdue: true }], 'hifz'), { key: 'overdue', label: 'متأخر' });
  assert.deepEqual(taskState([], 'murajaa'), { key: 'none', label: 'غير مقرر' });
});
