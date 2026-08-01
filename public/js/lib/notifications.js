import { supabase } from './supabase-client.js';

export async function initNotifications(userId) {
  if (!userId) return;

  loadUserNotifications(userId);
  subscribeToNotifications(userId);
}

async function loadUserNotifications(userId) {
  const { data: notifications } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  updateNotificationBadge(notifications || []);
}

function updateNotificationBadge(notifications) {
  const unreadCount = notifications.filter(n => !n.is_read).length;
  const badge = document.getElementById('notif-badge');
  if (badge) {
    if (unreadCount > 0) {
      badge.textContent = unreadCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

function subscribeToNotifications(userId) {
  supabase
    .channel('user_notifications')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` }, (payload) => {
      const notif = payload.new;
      if (Notification.permission === 'granted') {
        new Notification(notif.title, { body: notif.body });
      }
      loadUserNotifications(userId);
    })
    .subscribe();
}
