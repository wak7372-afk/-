import { supabase } from '../lib/supabase-client.js';
import { isLocalPreviewMode, requireAuth } from '../lib/auth.js';
import { initI18n } from '../lib/i18n.js';
import { escapeHtml, showToast } from '../lib/utils.js';

let currentUser = null;
let activeRecipientId = null;
let activeChannel = null;

document.addEventListener('DOMContentLoaded', async () => {
  const isStudentChat = window.location.pathname.includes('/student/');
  const authData = await requireAuth(isStudentChat ? ['student', 'teacher'] : ['teacher', 'student']);
  if (!authData) return;

  currentUser = authData.profile;
  await initI18n();

  document.getElementById('user-name').textContent = currentUser.full_name;

  await loadContacts();

  document.getElementById('send-msg-form').addEventListener('submit', handleSendMessage);
});

async function loadContacts() {
  const container = document.getElementById('contacts-list');
  let uniqueContacts = [];
  if (isLocalPreviewMode()) {
    uniqueContacts = previewContacts(currentUser.role);
  } else {
    const { data, error } = await supabase.rpc('list_my_direct_message_contacts');
    if (error) {
      console.error('Unable to load direct-message contacts:', error);
      showToast('تعذر تحميل جهات الاتصال.', 'error');
    } else {
      uniqueContacts = Array.isArray(data) ? data : [];
    }
  }

  if (!uniqueContacts || uniqueContacts.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-xs p-4 text-center">لا يوجد جهات اتصال متاحة للدردشة.</p>';
    return;
  }

  container.innerHTML = uniqueContacts.map(c => `
    <button type="button" data-contact-id="${escapeHtml(c.id)}" class="chat-contact-button w-full text-right p-3 rounded-xl hover:bg-slate-100 transition border border-gray-100 flex items-center space-x-3 space-x-reverse mb-2">
      <div class="w-9 h-9 rounded-full bg-emerald-700 text-amber-300 flex items-center justify-center font-bold text-sm">
        ${escapeHtml((c.full_name || '?').charAt(0))}
      </div>
      <div>
        <p class="chat-contact-name">${escapeHtml(c.full_name || 'بدون اسم')}</p>
        <p class="chat-contact-username" dir="ltr">@${escapeHtml(c.username || '')}</p>
        <p class="chat-contact-circle">${escapeHtml(contactCircleLabel(c.circles))}</p>
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

function contactCircleLabel(circles) {
  const names = (Array.isArray(circles) ? circles : []).map(circle => circle.name).filter(Boolean);
  if (!names.length) return 'حلقة مرتبطة';
  if (names.length === 1) return names[0];
  return `${names[0]} و${names.length - 1} أخرى`;
}

function previewContacts(role) {
  if (role === 'student') {
    return [
      { id: 'preview-teacher-1', full_name: 'المعلم حمزة', username: 'hamza', circles: [{ name: 'حلقة الإتقان', circle_type: 'quran' }] },
      { id: 'preview-teacher-2', full_name: 'المعلم سالم', username: 'salem', circles: [{ name: 'فقه العبادات', circle_type: 'educational' }] },
    ];
  }
  return [
    { id: 'preview-student-1', full_name: 'محمد سعيد', username: 'mohammed.01', circles: [{ name: 'حلقة الإتقان', circle_type: 'quran' }] },
    { id: 'preview-student-2', full_name: 'أحمد علي', username: 'ahmed.02', circles: [{ name: 'حلقة الإتقان', circle_type: 'quran' }] },
  ];
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
        <div class="chat-message-bubble ${isMine ? 'is-mine' : 'is-other'}">
          <p class="chat-message-text">${escapeHtml(m.content)}</p>
          <time class="chat-message-time" datetime="${escapeHtml(m.created_at)}">${new Date(m.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</time>
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
