import { supabase } from '../lib/supabase-client.js';
import { requireAuth } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast } from '../lib/utils.js';

let currentUser = null;
let activeRecipientId = null;
let activeChannel = null;

document.addEventListener('DOMContentLoaded', async () => {
  const authData = await requireAuth(['teacher', 'student']);
  if (!authData) return;

  currentUser = authData.profile;
  await initI18n();

  document.getElementById('user-name').textContent = currentUser.full_name;

  await loadContacts();

  document.getElementById('send-msg-form').addEventListener('submit', handleSendMessage);
});

async function loadContacts() {
  const container = document.getElementById('contacts-list');

  let contacts = [];
  if (currentUser.role === 'teacher') {
    // Load all students in teacher's halaqat
    const { data: halaqat } = await supabase.from('halaqat').select('id').eq('teacher_id', currentUser.id);
    const halaqatIds = halaqat ? halaqat.map(h => h.id) : [];

    if (halaqatIds.length > 0) {
      const { data: rels } = await supabase.from('halaqa_students').select('student:student_id(id, full_name, username)').in('halaqa_id', halaqatIds);
      contacts = rels ? rels.map(r => r.student) : [];
    }
  } else {
    // Load student's teacher
    const { data: rels } = await supabase.from('halaqa_students').select('halaqa:halaqa_id(teacher:teacher_id(id, full_name, username))').eq('student_id', currentUser.id);
    if (rels) {
      contacts = rels.map(r => r.halaqa?.teacher).filter(Boolean);
    }
  }

  // Remove duplicates
  const uniqueContacts = Array.from(new Set(contacts.map(c => c.id))).map(id => contacts.find(c => c.id === id));

  if (!uniqueContacts || uniqueContacts.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-xs p-4 text-center">لا يوجد جهات اتصال متاحة للدردشة.</p>';
    return;
  }

  container.innerHTML = uniqueContacts.map(c => `
    <button type="button" data-contact-id="${escapeHtml(c.id)}" class="w-full text-right p-3 rounded-xl hover:bg-slate-100 transition border border-gray-100 flex items-center space-x-3 space-x-reverse mb-2">
      <div class="w-9 h-9 rounded-full bg-emerald-700 text-amber-300 flex items-center justify-center font-bold text-sm">
        ${escapeHtml((c.full_name || '?').charAt(0))}
      </div>
      <div>
        <p class="font-bold text-sm text-gray-800">${escapeHtml(c.full_name || 'بدون اسم')}</p>
        <p class="text-[11px] text-gray-500" dir="ltr">@${escapeHtml(c.username || '')}</p>
      </div>
    </button>
  `).join('');

  container.querySelectorAll('[data-contact-id]').forEach(button => {
    button.addEventListener('click', () => {
      const contact = uniqueContacts.find(item => item.id === button.dataset.contactId);
      if (contact) selectContact(contact.id, contact.full_name || 'جهة اتصال');
    });
  });

  // Auto select first contact
  if (uniqueContacts.length > 0) {
    selectContact(uniqueContacts[0].id, uniqueContacts[0].full_name || 'جهة اتصال');
  }
}

window.selectContact = async function(contactId, contactName) {
  activeRecipientId = contactId;
  document.getElementById('active-recipient-name').textContent = String(contactName || 'جهة اتصال');
  document.getElementById('chat-window').classList.remove('hidden');

  if (activeChannel) {
    await supabase.removeChannel(activeChannel);
    activeChannel = null;
  }
  await loadMessages();
  subscribeToRealtimeMessages();
};

async function loadMessages() {
  const container = document.getElementById('messages-box');
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${activeRecipientId}),and(sender_id.eq.${activeRecipientId},receiver_id.eq.${currentUser.id})`)
    .order('created_at', { ascending: true });

  if (!messages || messages.length === 0) {
    container.innerHTML = '<p class="text-gray-400 text-xs text-center py-6">ابدأ المحادثة الآن...</p>';
    return;
  }

  container.innerHTML = messages.map(m => {
    const isMine = m.sender_id === currentUser.id;
    return `
      <div class="flex ${isMine ? 'justify-start' : 'justify-end'} mb-3">
        <div class="max-w-xs md:max-w-md p-3.5 rounded-2xl text-sm ${isMine ? 'bg-emerald-800 text-white rounded-br-none' : 'bg-amber-100 text-emerald-950 border border-amber-300 rounded-bl-none'} shadow">
          <p class="leading-relaxed">${escapeHtml(m.content)}</p>
          <span class="text-[10px] ${isMine ? 'text-emerald-200' : 'text-gray-500'} block text-left mt-1">${new Date(m.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
    `;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

async function handleSendMessage(e) {
  e.preventDefault();
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content || !activeRecipientId) return;

  try {
    const { error } = await supabase.from('messages').insert({
      sender_id: currentUser.id,
      receiver_id: activeRecipientId,
      content
    });

    if (error) throw error;
    input.value = '';
    await loadMessages();
  } catch (err) {
    showToast('فشل إرسال الرسالة', 'error');
  }
}

function subscribeToRealtimeMessages() {
  activeChannel = supabase
    .channel(`chat_${currentUser.id}_${activeRecipientId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const msg = payload.new;
      if ((msg.sender_id === activeRecipientId && msg.receiver_id === currentUser.id) ||
          (msg.sender_id === currentUser.id && msg.receiver_id === activeRecipientId)) {
        loadMessages();
      }
    })
    .subscribe();
}
