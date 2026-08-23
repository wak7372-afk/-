export const TASK_META = {
  hifz: { label: 'الحفظ', shortLabel: 'حفظ', color: '#0b7654' },
  tathbit: { label: 'التثبيت', shortLabel: 'تثبيت', color: '#24739a' },
  murajaa: { label: 'المراجعة', shortLabel: 'مراجعة', color: '#b38720' },
};

const PERIOD_META = {
  today: { label: 'اليوم', description: 'مقارنة بالأمس' },
  week: { label: 'آخر 7 أيام', description: 'مقارنة بالأسبوع السابق' },
  month: { label: 'آخر 30 يوماً', description: 'مقارنة بالشهر السابق' },
};

export function performanceByStudent(performance) {
  return new Map((performance?.students || []).map(student => [student.student_id, student]));
}

export function buildPeriodCards(comparisons = {}) {
  return Object.entries(PERIOD_META).map(([key, meta]) => {
    const comparison = comparisons?.[key] || {};
    const current = comparison.current || {};
    return {
      key,
      ...meta,
      completionRate: clamp(Number(current.completion_rate || 0), 0, 100),
      onTimeRate: clamp(Number(current.on_time_rate || 0), 0, 100),
      completionDelta: Number(comparison.completion_rate_delta || 0),
      completedCount: Number(current.completed_student_days || 0),
      expectedCount: Number(current.expected_student_days || 0),
    };
  });
}

export function buildTaskMetrics(taskDistribution = {}) {
  return Object.entries(TASK_META).map(([key, meta]) => {
    const task = taskDistribution?.[key] || {};
    const assigned = Number(task.assigned_count || 0);
    const completed = Number(task.completed_count || 0);
    return {
      key,
      ...meta,
      assigned,
      completed,
      earnedPoints: Number(task.earned_points || 0),
      completionRate: assigned ? clamp((completed / assigned) * 100, 0, 100) : 0,
    };
  });
}

export function studentTrend(student = {}) {
  const current = Number(student.completion_rate_7 || 0);
  const previous = Number(student.previous_completion_rate_7 || 0);
  const delta = current - previous;
  if (delta >= 8) return { key: 'improving', label: 'يتحسن', delta, tone: 'is-up' };
  if (delta <= -8) return { key: 'declining', label: 'يتراجع', delta, tone: 'is-down' };
  return { key: 'stable', label: 'مستقر', delta, tone: 'is-steady' };
}

export function buildInterventions(consoleStudents = [], performanceStudents = []) {
  const performanceIndex = new Map(performanceStudents.map(student => [student.student_id, student]));
  return consoleStudents.map(student => {
    const performance = performanceIndex.get(student.student_id) || {};
    const overdue = Math.max(Number(student.overdue_count || 0), Number(performance.overdue_count || 0));
    const trend = studentTrend(performance);
    const completionRate = Number(performance.completion_rate_7 || 0);
    const onTimeRate = Number(performance.on_time_rate_7 || 0);
    const reasons = [];
    let score = 0;

    if (overdue > 0) {
      score += 90 + Math.min(overdue, 9) * 4;
      reasons.push({ label: `${overdue} تقرير متأخر`, tone: 'is-critical' });
    }
    if (student.daily_state === 'overdue') {
      score += 70;
      reasons.push({ label: 'تجاوز موعد اليوم', tone: 'is-critical' });
    } else if (student.daily_state === 'partial') {
      score += 42;
      reasons.push({ label: 'أنجز جزءاً من تقرير اليوم', tone: 'is-warning' });
    } else if (student.daily_state === 'pending') {
      score += 28;
      reasons.push({ label: 'لم يكمل تقرير اليوم', tone: 'is-warning' });
    }
    if (trend.key === 'declining') {
      score += 45 + Math.min(Math.abs(trend.delta), 30);
      reasons.push({ label: `تراجع ${formatNumber(Math.abs(trend.delta))} نقطة`, tone: 'is-warning' });
    }
    if (completionRate > 0 && completionRate < 60) {
      score += 28;
      reasons.push({ label: `التزام أسبوعي ${formatNumber(completionRate)}%`, tone: 'is-warning' });
    }
    if (onTimeRate > 0 && onTimeRate < 50 && completionRate >= 60) {
      score += 18;
      reasons.push({ label: 'يتكرر الإنجاز قرب الموعد', tone: 'is-neutral' });
    }
    if (student.daily_state === 'no_reports') {
      score += 14;
      reasons.push({ label: 'لا توجد له خطة اليوم', tone: 'is-neutral' });
    }

    return {
      ...student,
      performance,
      trend,
      overdue,
      completionRate,
      onTimeRate,
      score,
      reasons: uniqueReasons(reasons),
    };
  }).filter(student => student.score > 0)
    .sort((a, b) => b.score - a.score || String(a.full_name || '').localeCompare(String(b.full_name || ''), 'ar'));
}

export function taskState(assignments = [], taskType) {
  const assignment = assignments.find(item => item.task_type === taskType);
  if (!assignment) return { key: 'none', label: 'غير مقرر' };
  if (assignment.status === 'completed') return { key: 'completed', label: 'منجز' };
  if (assignment.status === 'exempted') return { key: 'exempted', label: 'معفى' };
  if (assignment.is_overdue) return { key: 'overdue', label: 'متأخر' };
  return { key: 'pending', label: 'منتظر' };
}

function uniqueReasons(reasons) {
  const seen = new Set();
  return reasons.filter(reason => {
    if (seen.has(reason.label)) return false;
    seen.add(reason.label);
    return true;
  }).slice(0, 3);
}

function formatNumber(value) {
  const number = Number(value || 0);
  return number.toFixed(number % 1 ? 1 : 0);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
