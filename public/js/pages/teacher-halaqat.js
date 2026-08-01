import { supabase } from '../lib/supabase-client.js';
import { requireAuth, logoutUser } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast, formatDate } from '../lib/utils.js';

let currentUser = null;

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['teacher', 'admin']);
  if (!authData) return;

  currentUser = authData.profile;
  await initI18n();

  document.getElementById('teacher-name').textContent = currentUser.full_name + (currentUser.role === 'admin' ? ' (مدير)' : '');
  document.getElementById('logout-btn').addEventListener('click', logoutUser);

  await loadHalaqat();

  document.getElementById('create-halaqa-form').addEventListener('submit', handleCreateHalaqa);
});

async function loadHalaqat() {
  const container = document.getElementById('halaqat-grid');
  container.innerHTML = '<p class="text-gray-500 text-center col-span-3 py-8">جاري تحميل الحلقات...</p>';

  let query = supabase.from('halaqat').select('*, teacher:teacher_id(full_name), halaqa_students(count)');
  if (currentUser.role !== 'admin') {
    query = query.eq('teacher_id', currentUser.id);
  }

  const { data: halaqat, error } = await query.order('created_at', { ascending: false });

  if (error) {
    showToast('حدث خطأ أثناء جلب الحلقات', 'error');
    return;
  }

  if (!halaqat || halaqat.length === 0) {
    container.innerHTML = `
      <div class="col-span-full glass-card text-center py-12 rounded-2xl border border-dashed border-emerald-300">
        <h4 class="text-xl font-bold text-emerald-950 mb-2">لا توجد حلقات قرآنية مضافة بعد</h4>
        <p class="text-gray-500 text-sm mb-4">أنشئ الحلقة الأولى لتستطيع إضافة الطلاب وتعيين المقررات اليومية.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = halaqat.map(h => {
    const studentCount = h.halaqa_students ? h.halaqa_students[0]?.count || 0 : 0;
    return `
      <div class="glass-card rounded-2xl p-6 border border-amber-400/30 shadow-md hover:shadow-xl transition flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-amiri text-2xl font-bold text-emerald-950">${escapeHtml(h.name || 'حلقة قرآنية')}</h3>
            <span class="bg-emerald-100 text-emerald-900 text-xs font-extrabold px-3 py-1 rounded-full">${escapeHtml(studentCount)} طالب</span>
          </div>
          <p class="text-xs font-bold text-amber-800 mb-1">المعلم: ${escapeHtml(h.teacher?.full_name || 'غير محدد')}</p>
          <p class="text-[11px] text-gray-500 mb-6">تاريخ الإنشاء: ${escapeHtml(formatDate(h.created_at))}</p>
        </div>
        <div class="flex space-x-2 space-x-reverse pt-4 border-t border-gray-100">
          <a href="/teacher/halaqa-detail.html?id=${encodeURIComponent(h.id)}" class="w-full btn-emerald text-center py-2.5 rounded-xl font-bold text-sm">
            إدارة الحلقة والمقررات
          </a>
        </div>
      </div>
    `;
  }).join('');
}

async function handleCreateHalaqa(e) {
  e.preventDefault();
  const name = document.getElementById('halaqa-name').value.trim();

  try {
    const { error } = await supabase.from('halaqat').insert({
      name,
      teacher_id: currentUser.id
    });

    if (error) throw error;

    showToast('تم إنشاء الحلقة بنجاح', 'success');
    document.getElementById('halaqa-name').value = '';
    await loadHalaqat();
  } catch (err) {
    showToast(err.message || 'فشل إنشاء الحلقة', 'error');
  }
}
