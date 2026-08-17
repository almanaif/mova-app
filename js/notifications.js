// ===== notifications.js — نظام إشعارات حقيقي مبني على Firestore (Read/Unread + لحظي عبر onSnapshot) =====
// نقطة الإنشاء الوحيدة لأي إشعار في التطبيق هي createNotification() تحت. orders.js بيستخدمها
// لكل أحداث الطلب التسعة (بدل التكرار في كل ملف). ملحوظة نطاق: admin.js فيه استدعاءين مباشرين
// لـ addDoc(notifications) خاصين بقبول/رفض حساب مندوب (حدث تسجيل مندوب، مش حدث طلب) — دول
// خارج نطاق هذا الـ Sprint فسابينهم زي ما هم، وبيشتغلوا بصلاحية الأدمن في القاعدة بشكل مستقل.

import { addDoc, collection, db, doc, query, serverTimestamp, setDoc, updateDoc, where } from './firebase.js';
import { esc, Logger, onListenersCleared, onSnapshot } from './utils.js';

// ===== إنشاء إشعار (Best-effort: فشل الإشعار لا يوقف أي عملية أساسية في التطبيق) =====
// جديد (Baseline Recovery - Notification Idempotency): لو orderId و eventKey اتبعتوا، بتتحط
// جوه مستند بمعرّف ثابت = orderId + eventKey + recipientUserId (بدل addDoc اللي بيولّد معرّف
// عشوائي في كل مرة). فايدة ده: أي محاولة تكرار لنفس الحدث بالظبط (نفس الطلب/نفس التغيير/نفس
// المستلم) - سواء من Retry شبكة، أو أكتر من مكان في الكود بينده نفس الحدث بالغلط - هتحاول
// تكتب على نفس المستند اللي أصلاً موجود، وFirestore Rules بترفض هذا كـ"تعديل" غير مسموح
// (راجع match /notifications/{id} في firestore.rules) فمفيش تكرار فعلي بيتسجل. الأحداث اللي
// معندهاش orderId (زي قرارات تسجيل مندوب من admin.js) بتفضل تستخدم addDoc العادي زي الأول.
export async function createNotification(userId, title, body, type = 'gn', orderId = null, eventKey = null) {
  if (!userId) return;
  try {
    const payload = { userId, title, body, type, orderId: orderId || null, read: false, createdAt: serverTimestamp() };
    if (orderId && eventKey) {
      // eventKey بيتحط كـ field صريح (مش بس جوه الـ ID) عشان firestore.rules تقدر تتحقق فعليًا
      // إن حالة الطلب الحالية بتطابق الحدث المذكور وقت الكتابة (راجع eventKeyMatchesOrderStatus
      // في firestore.rules) - ده اللي بيقفل ثغرة "حجز" إشعار لحدث لسه ماحصلش.
      await setDoc(doc(db, 'notifications', `${orderId}_${eventKey}_${userId}`), { ...payload, eventKey });
    } else {
      await addDoc(collection(db, 'notifications'), payload);
    }
  } catch (e) { Logger.error(e); }
}

// ===== عرض القائمة (Read/Unread) =====
function renderNotifList(docs) {
  const list = document.getElementById('notif-list');
  if (!list) return;
  if (!docs.length) {
    list.innerHTML = '<div class="empty-state"><div class="ei">🔔</div><p>لا توجد إشعارات</p></div>';
  } else {
    list.innerHTML = docs.map(d => {
      const n = d.data();
      const unread = n.read !== true;
      return `<div class="ni" style="cursor:pointer;opacity:${unread ? 1 : .55}" onclick="markNotifRead('${d.id}')">
        <div class="ni-dot ${esc(n.type || 'gn')}"></div>
        <div class="ni-info"><p style="${unread ? 'font-weight:800' : ''}">${esc(n.title || 'إشعار')}</p><small>${esc(n.body || '')}</small></div>
      </div>`;
    }).join('');
  }
  const unreadCount = docs.filter(d => d.data().read !== true).length;
  ['notif-c', 'adm-notif-c', 'drv-notif-c', 'merch-notif-c'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = unreadCount; });
}

// ===== الاستماع اللحظي (onSnapshot) — بيشتغل لأي دور (عميل/تاجر/مندوب/أدمن) بمجرد تسجيل الدخول =====
export let notifListenerStarted = false;
export function startNotifListener() {
  if (notifListenerStarted || !window.CU) return;
  notifListenerStarted = true;
  // بدون orderBy على السيرفر (يتطلب Composite Index)؛ الترتيب بيتم على الجهاز بعد الاستلام
  // — عدد إشعارات المستخدم صغير فمفيش مشكلة أداء حقيقية.
  const q = query(collection(db, 'notifications'), where('userId', '==', window.CU.uid));
  onSnapshot(q, snap => {
    const docs = snap.docs.slice().sort((a, b) => (b.data().createdAt?.seconds || 0) - (a.data().createdAt?.seconds || 0));
    renderNotifList(docs);
  }, () => {});
}

// ===== تحديد إشعار كمقروء (بيتنده من onclick في الواجهة) =====
export function markNotifRead(id) {
  updateDoc(doc(db, 'notifications', id), { read: true }).catch(() => {});
}

// ===== تصفير أعلام المتابعة عند تسجيل الخروج =====
export function registerNotificationsResets() {
  onListenersCleared(() => {
    notifListenerStarted = false;
  });
}
