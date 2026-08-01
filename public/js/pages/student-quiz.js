import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast } from '../lib/utils.js';

let currentStudent = null;
let quizId = null;
let questions = [];

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['student']);
  if (!authData) return;

  currentStudent = authData.profile;
  await initI18n();

  const urlParams = new URLSearchParams(window.location.search);
  quizId = urlParams.get('id');

  if (!quizId) {
    window.location.href = '/student/dashboard.html';
    return;
  }

  document.getElementById('logout-btn').addEventListener('click', logoutUser);

  await loadQuiz();

  document.getElementById('quiz-form').addEventListener('submit', handleSubmitQuiz);
});

async function loadQuiz() {
  // Check if already submitted
  const { data: existing } = await supabase
    .from('quiz_submissions')
    .select('*')
    .eq('quiz_id', quizId)
    .eq('student_id', currentStudent.id)
    .maybeSingle();

  if (existing) {
    document.getElementById('quiz-form-container').classList.add('hidden');
    const resultDiv = document.getElementById('quiz-result-container');
    resultDiv.classList.remove('hidden');
    document.getElementById('result-score').textContent = `${existing.score}%`;
    return;
  }

  // The RPC intentionally omits answer keys. Scoring happens atomically in PostgreSQL.
  const { data: quiz, error } = await supabase.rpc('get_student_quiz', {
    p_quiz_id: quizId,
  });
  const qData = quiz?.questions || [];

  if (error || !qData || qData.length === 0) {
    document.getElementById('questions-container').innerHTML = '<p class="text-gray-500 text-sm py-4">لا توجد أسئلة مضافة لهذا الاختبار بعد.</p>';
    return;
  }

  document.getElementById('quiz-title').textContent = quiz.title;
  questions = qData;

  document.getElementById('questions-container').innerHTML = qData.map((q, idx) => `
    <div class="p-5 bg-white rounded-xl border border-gray-200 shadow-sm space-y-3">
      <p class="font-bold text-gray-900 text-base">سـ${idx + 1}: ${escapeHtml(q.question_text)}</p>
      <div class="space-y-2 pr-2">
        ${q.quiz_options.map(opt => `
          <label class="flex items-center space-x-3 space-x-reverse p-3 rounded-lg border border-gray-100 hover:bg-slate-50 cursor-pointer">
            <input type="radio" name="question_${escapeHtml(q.id)}" value="${escapeHtml(opt.id)}" required class="w-4 h-4 text-emerald-600 focus:ring-emerald-500">
            <span class="text-sm font-semibold text-gray-700">${escapeHtml(opt.option_text)}</span>
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');
}

async function handleSubmitQuiz(e) {
  e.preventDefault();
  const submitBtn = document.getElementById('submit-quiz-btn');
  submitBtn.disabled = true;

  const userAnswers = [];

  questions.forEach(q => {
    const selectedRadio = document.querySelector(`input[name="question_${q.id}"]:checked`);
    const selectedOptId = selectedRadio ? selectedRadio.value : null;

    userAnswers.push({
      question_id: q.id,
      selected_option_id: selectedOptId
    });
  });

  try {
    const { data, error } = await supabase.rpc('submit_quiz', {
      p_quiz_id: quizId,
      p_answers: userAnswers,
    });
    if (error) throw error;
    const finalScore = Number(data?.[0]?.score ?? 0);

    document.getElementById('quiz-form-container').classList.add('hidden');
    const resultDiv = document.getElementById('quiz-result-container');
    resultDiv.classList.remove('hidden');
    document.getElementById('result-score').textContent = `${finalScore}%`;

    showToast('تم إرسال إجاباتك وحساب النتيجة تلقائياً', 'success');
  } catch (err) {
    showToast(err.message || 'حدث خطأ أثناء تقديم الاختبار', 'error');
    submitBtn.disabled = false;
  }
}
