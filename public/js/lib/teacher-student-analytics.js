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

export function buildInterventions(consoleStudents = [], performanceStudents = [], options = {}) {
  const now = new Date(options.now || Date.now());
  const dueSoonMinutes = Number(options.dueSoonMinutes || 120);
  const performanceIndex = new Map(performanceStudents.map(student => [student.student_id, student]));
  return consoleStudents.map(student => {
    const performance = performanceIndex.get(student.student_id) || {};
    const overdue = Math.max(Number(student.overdue_count || 0), Number(performance.overdue_count || 0));
    const trend = studentTrend(performance);
    const completionRate = Number(performance.completion_rate_7 || 0);
    const onTimeRate = Number(performance.on_time_rate_7 || 0);
    const remainingMinutes = minutesUntil(student.next_due_at, now);
    const dueSoon = ['pending', 'partial'].includes(student.daily_state)
      && remainingMinutes !== null
      && remainingMinutes >= 0
      && remainingMinutes <= dueSoonMinutes;
    const reasons = [];
    let score = 0;
    let priority = 'watch';

    if (overdue > 0) {
      score += 90 + Math.min(overdue, 9) * 4;
      reasons.push({ label: `${overdue} تقرير متأخر`, tone: 'is-critical' });
      priority = 'critical';
    }
    if (student.daily_state === 'overdue') {
      score += 70;
      reasons.push({ label: 'تجاوز موعد اليوم', tone: 'is-critical' });
      priority = 'critical';
    } else if (dueSoon) {
      score += student.daily_state === 'partial' ? 58 : 48;
      reasons.push({ label: `بقي ${formatDuration(remainingMinutes)}`, tone: 'is-warning' });
      if (priority !== 'critical') priority = 'urgent';
    }
    if (trend.key === 'declining' && Math.abs(trend.delta) >= 15) {
      score += 45 + Math.min(Math.abs(trend.delta), 30);
      reasons.push({ label: `تراجع ${formatNumber(Math.abs(trend.delta))} نقطة`, tone: 'is-warning' });
    }
    if ((completionRate > 0 || Number(performance.previous_completion_rate_7 || 0) > 0) && completionRate < 60) {
      score += 28;
      reasons.push({ label: `التزام أسبوعي ${formatNumber(completionRate)}%`, tone: 'is-warning' });
    }
    if (onTimeRate > 0 && onTimeRate < 50 && completionRate >= 60 && score > 0) {
      score += 18;
      reasons.push({ label: `الإنجاز في الوقت ${formatNumber(onTimeRate)}%`, tone: 'is-neutral' });
    }

    return {
      ...student,
      performance,
      trend,
      overdue,
      completionRate,
      onTimeRate,
      remainingMinutes,
      dueSoon,
      priority,
      score,
      reasons: uniqueReasons(reasons),
    };
  }).filter(student => student.score > 0)
    .sort((a, b) => b.score - a.score || String(a.full_name || '').localeCompare(String(b.full_name || ''), 'ar'));
}

export function buildTodaySummary(summary = {}, students = []) {
  const totalStudents = Number(summary.student_count || students.length || 0);
  const completedOnTime = Number(summary.completed_on_time_students || 0);
  const completedLate = Number(summary.completed_late_students || 0);
  const pendingStudents = Number(summary.pending_students || 0);
  const overdueStudents = Number(summary.overdue_students || 0);
  const overdueReports = students.reduce((sum, student) => sum + Number(student.overdue_count || 0), 0);
  const assignedReports = students.reduce((sum, student) => sum + Number(student.report_count || 0), 0);
  const completedReports = students.reduce((sum, student) => sum + Number(student.completed_count || 0), 0);
  return {
    totalStudents,
    completedOnTime,
    completedLate,
    pendingStudents,
    overdueStudents,
    overdueReports,
    assignedReports,
    completedReports,
    completionRate: assignedReports ? clamp((completedReports / assignedReports) * 100, 0, 100) : 0,
  };
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

function minutesUntil(value, now) {
  if (!value) return null;
  const dueAt = new Date(value);
  if (Number.isNaN(dueAt.getTime()) || Number.isNaN(now.getTime())) return null;
  return Math.ceil((dueAt.getTime() - now.getTime()) / 60000);
}

function formatDuration(minutes) {
  if (minutes < 60) return `${Math.max(0, minutes)} دقيقة`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} س ${rest} د` : `${hours} ساعة`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
