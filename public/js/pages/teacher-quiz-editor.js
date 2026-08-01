import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { showToast } from '../lib/utils.js';

let currentTeacher = null;
let classroomId = null;
let quizId = null;
let questionCount = 0;

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['teacher']);
  if (!authData) return;

  currentTeacher = authData.profile;
  await initI18n();

  const urlParams = new URLSearchParams(window.location.search);
  classroomId = urlParams.get('classroom_id');
  quizId = urlParams.get('quiz_id');

  document.getElementById('logout-btn').addEventListener('click', logoutUser);
  document.getElementById('add-question-btn').addEventListener('click', addQuestionBlock);
  document.getElementById('save-quiz-form').addEventListener('submit', handleSaveQuiz);

  // Add initial question block
  addQuestionBlock();
});

function addQuestionBlock() {
  questionCount++;
  const container = document.getElementById('questions-editor-container');
  
  const qDiv = document.createElement('div');
  qDiv.className = 'p-5 bg-white rounded-xl border border-gray-200 shadow-sm space-y-4 question-block relative';
  qDiv.dataset.index = questionCount;

  qDiv.innerHTML = `
    <div class="flex items-center justify-between">
      <h4 class="font-bold text-emerald-950">السؤال رقم ${questionCount}</h4>
      ${questionCount > 1 ? `<button type="button" onclick="this.closest('.question-block').remove()" class="text-xs text-red-600 hover:underline">حذف السؤال</button>` : ''}
    </div>

    <div>
      <label class="block text-xs font-bold text-gray-700 mb-1">نص السؤال</label>
      <input type="text" class="question-text w-full px-3.5 py-2 rounded-xl border border-gray-300 text-sm outline-none" required placeholder="ما هو الحكم الشرعي لـ...">
    </div>

    <div class="space-y-2">
      <label class="block text-xs font-bold text-gray-700">الخيارات المتاحة (اختر الخيار الصحيح بحدده بالدائرة):</label>
      
      <div class="flex items-center space-x-2 space-x-reverse">
        <input type="radio" name="correct_q_${questionCount}" value="0" required checked class="w-4 h-4 text-emerald-600">
        <input type="text" class="option-text w-full px-3 py-1.5 rounded-lg border text-xs outline-none" required placeholder="الخيار الأول">
      </div>

      <div class="flex items-center space-x-2 space-x-reverse">
        <input type="radio" name="correct_q_${questionCount}" value="1" required class="w-4 h-4 text-emerald-600">
        <input type="text" class="option-text w-full px-3 py-1.5 rounded-lg border text-xs outline-none" required placeholder="الخيار الثاني">
      </div>

      <div class="flex items-center space-x-2 space-x-reverse">
        <input type="radio" name="correct_q_${questionCount}" value="2" class="w-4 h-4 text-emerald-600">
        <input type="text" class="option-text w-full px-3 py-1.5 rounded-lg border text-xs outline-none" placeholder="الخيار الثالث (اختياري)">
      </div>

      <div class="flex items-center space-x-2 space-x-reverse">
        <input type="radio" name="correct_q_${questionCount}" value="3" class="w-4 h-4 text-emerald-600">
        <input type="text" class="option-text w-full px-3 py-1.5 rounded-lg border text-xs outline-none" placeholder="الخيار الرابع (اختياري)">
      </div>
    </div>
  `;

  container.appendChild(qDiv);
}

async function handleSaveQuiz(e) {
  e.preventDefault();
  const quizTitle = document.getElementById('quiz-title-input').value.trim();

  try {
    // 1. Create Quiz Record
    const { data: quiz, error: qErr } = await supabase
      .from('quizzes')
      .insert({
        classroom_id: classroomId,
        title: quizTitle
      })
      .select()
      .single();

    if (qErr) throw qErr;

    // 2. Iterate Question Blocks
    const blocks = document.querySelectorAll('.question-block');
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const qText = block.querySelector('.question-text').value.trim();
      const selectedRadio = block.querySelector(`input[type="radio"]:checked`).value;

      const { data: question, error: questionErr } = await supabase
        .from('quiz_questions')
        .insert({
          quiz_id: quiz.id,
          question_text: qText,
          order_index: i + 1
        })
        .select()
        .single();

      if (questionErr) throw questionErr;

      const optionInputs = block.querySelectorAll('.option-text');
      const optionsPayload = [];
      optionInputs.forEach((optInput, optIndex) => {
        const optText = optInput.value.trim();
        if (optText) {
          optionsPayload.push({
            question_id: question.id,
            option_text: optText,
            is_correct: parseInt(selectedRadio) === optIndex
          });
        }
      });

      if (optionsPayload.length > 0) {
        await supabase.from('quiz_options').insert(optionsPayload);
      }
    }

    showToast('تم حفظ الاختبار وتلقيم الأسئلة والخيارات بنجاح', 'success');
    setTimeout(() => {
      window.location.href = `/teacher/classroom-detail.html?id=${classroomId}`;
    }, 1500);
  } catch (err) {
    showToast(err.message || 'حدث خطأ أثناء حفظ الاختبار', 'error');
  }
}
