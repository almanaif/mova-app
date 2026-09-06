// ===== external.js — External Purchase Service ("لديك طلب؟ اطلبه") =====
// نفس فلسفة rides.js بالحرف: Collection مستقل تمامًا، State Machine مستقلة، Dispatch بنفس
// نمط "أقرب 3 مرشحين + Broadcast محدود"، صفر لمسة على orders.js أو rides.js نفسهم.
// القرار المعماري المعتمد (راجع MOVA Phase 3 Architecture Review): الخدمة دي مش Merchant Order
// ومش Ride - Collection مستقل بالكامل: external_purchases.

import { db, collection, addDoc, getDoc, getDocs, updateDoc, doc, query, where, runTransaction, serverTimestamp } from './firebase.js';
import { showToast, showScreen, RIDE_ELIGIBLE_VEHICLES, onListenersCleared, onSnapshot, closeModal } from './utils.js';
import { getPricingConfig, calculateFare } from './pricing.js';
import { _distMeters, maybeStopGpsIfIdle } from './driver.js';
import { createNotification } from './notifications.js';
import { openLocationPicker } from './maps.js';

export const EXTERNAL_COLLECTION = 'external_purchases';

// ===== State Machine (نفس فلسفة RIDE_TRANSITIONS في rides.js تمامًا) =====
export const EP_STATUS = {
  REQUESTED: 'requested',
  DRIVER_OFFERED: 'driver_offered',
  DRIVER_ASSIGNED: 'driver_assigned',
  SHOPPING: 'shopping',
  ITEM_UNAVAILABLE: 'item_unavailable',
  BUDGET_EXCEEDED: 'budget_exceeded',
  PURCHASED: 'purchased',
  DELIVERING: 'delivering',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

export const EP_TRANSITIONS = {
  [EP_STATUS.REQUESTED]:         [EP_STATUS.DRIVER_OFFERED, EP_STATUS.CANCELLED],
  [EP_STATUS.DRIVER_OFFERED]:    [EP_STATUS.DRIVER_ASSIGNED, EP_STATUS.REQUESTED, EP_STATUS.CANCELLED],
  [EP_STATUS.DRIVER_ASSIGNED]:   [EP_STATUS.SHOPPING, EP_STATUS.CANCELLED],
  [EP_STATUS.SHOPPING]:          [EP_STATUS.ITEM_UNAVAILABLE, EP_STATUS.BUDGET_EXCEEDED, EP_STATUS.PURCHASED, EP_STATUS.CANCELLED],
  [EP_STATUS.ITEM_UNAVAILABLE]:  [EP_STATUS.SHOPPING, EP_STATUS.CANCELLED], // العميل وافق على بديل -> يرجع يشتري | ألغى
  [EP_STATUS.BUDGET_EXCEEDED]:   [EP_STATUS.PURCHASED, EP_STATUS.CANCELLED], // العميل وافق على السعر المُبلَّغ بالفعل -> يكمل مباشرة (السعر مقفول، صفر إعادة إدخال) | ألغى
  [EP_STATUS.PURCHASED]:         [EP_STATUS.DELIVERING],
  [EP_STATUS.DELIVERING]:        [EP_STATUS.COMPLETED],
  [EP_STATUS.COMPLETED]:         [],
  [EP_STATUS.CANCELLED]:         [],
};
export function canTransitionEP(fromStatus, toStatus) {
  const allowed = EP_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

const MAX_CANDIDATE_DRIVERS = 3;
const MAX_DISPATCH_LOG = 20;
// نفس دالة trimLog() الموجودة في rides.js بالحرف - مش مُصدَّرة من هناك (rides.js ملف Ride
// Service مستقر ممنوع لمسه)، فبتتكرر هنا كـ Utility من 3 أسطر بس - مش تكرار منطق عمل حقيقي.
function trimLog(log, entry) {
  return [...(Array.isArray(log) ? log : []), entry].slice(-MAX_DISPATCH_LOG);
}

let epRequestInProgress = false;
let epPendingLocation = null; // {lat,lng,address,city,zone} - من الـ Location Picker المشترك بس (البند 8/9 - إشارة موقع واحدة موثوقة)

// جديد (Phase 2B): فتح نفس الـ Location Picker المشترك المستخدم في الشيك أوت العادي وموقع
// المتجر - بدل حقل نص حر منفصل تمامًا عن أي GPS/Geocoding حقيقي (المشكلة الأصلية في البند 5
// من Phase 2B). اختيار الموقع هنا Preview بس لحد "تأكيد الموقع" جوه الـ Picker نفسه.
export function epOpenLocationPicker() {
  openLocationPicker({
    title: 'موقع التسليم',
    initialLoc: epPendingLocation ? [epPendingLocation.lat, epPendingLocation.lng] : undefined,
    onConfirm: (loc) => {
      epPendingLocation = loc;
      const el = document.getElementById('ep-loc-summary');
      if (el) el.textContent = loc.address || 'تم تحديد الموقع على الخريطة ✅';
    },
  });
}

// تصفير حالة الموقع عند إلغاء/إغلاق المودال - عشان طلب جديد لاحقًا يبدأ نضيف، مش يورّث موقع
// طلب سابق بالغلط.
export function epCancelAnyReq() {
  epPendingLocation = null;
  const el = document.getElementById('ep-loc-summary');
  if (el) el.textContent = 'اختيار الموقع من الخريطة';
  closeModal('any-req-modal');
}

// ===== Customer: إنشاء الطلب =====
// Phase 2B: الموقع بقى بيجي من الـ Location Picker المؤكد (lat/lng/address/city/zone) بدل
// GPS صامت في الخلفية + عنوان نصي منفصل ممكن يختلفوا. صفر مصدرين متعارضين للموقع دلوقتي.
// السعر لسه بدون مكوّن مسافة (distanceKm=0 ضمنيًا زي ما كان بالظبط) - التسعير مش جزء من
// المرحلة دي (البند 10 IMPORTANT - DO NOT change pricing).
export async function sendExternalPurchase() {
  if (!window.CU || epRequestInProgress) return;
  const placeName = document.getElementById('ep-place-name')?.value?.trim();
  const items = document.getElementById('any-req-txt')?.value?.trim();
  const additionalNotes = document.getElementById('any-req-addr')?.value?.trim() || '';
  const approxBudget = Number(document.getElementById('ep-budget')?.value) || 0;
  if (!placeName || !items || !epPendingLocation) {
    showToast('يرجى تعبئة اسم المكان والطلب وتحديد الموقع من الخريطة', 'err');
    return;
  }
  epRequestInProgress = true;
  try {
    const cfg = await getPricingConfig();
    const fare = calculateFare(cfg, 'external_purchase', {});
    const commSnap = await getDoc(doc(db, 'settings', 'commission'));
    const externalRate = Number(commSnap.data()?.externalRate) || 10;
    const commission = Math.round(fare.finalFare * externalRate / 100);
    const data = {
      customerId: window.CU.uid,
      customerName: window.CUD?.name || 'عميل',
      driverId: null, candidateDriverIds: [], rejectedDriverIds: [], dispatchLog: [],
      placeName, placeAddress: placeName, items, notes: '', approxBudget,
      // البند 9 - Data Model الجديد: موقع منظّم واحد (نفس شكل pickupLocation في orders.js) +
      // ملاحظات اختيارية منفصلة. مستندات قديمة فيها deliveryAddress/deliveryLocation بتفضل
      // قابلة للقراءة زي ما هي (صفر Migration - البند 9 صراحة) عبر fallback في نقاط القراءة.
      pickupLocation: {
        latitude: epPendingLocation.lat, longitude: epPendingLocation.lng,
        address: epPendingLocation.address || null, city: epPendingLocation.city || null, zone: epPendingLocation.zone || null,
      },
      additionalNotes,
      actualProductPrice: null,
      paymentResponsibility: 'captain_advances_cash',
      pricingSnapshot: { ...fare, commission, commissionRate: externalRate },
      status: EP_STATUS.REQUESTED,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    };
    const ref = await addDoc(collection(db, EXTERNAL_COLLECTION), data);
    showToast('تم إرسال طلبك، جاري البحث عن كابتن... 🛍️', 'ok');
    const closeM = document.getElementById('any-req-modal'); if (closeM) closeM.classList.remove('open');
    epPendingLocation = null;
    const summaryEl = document.getElementById('ep-loc-summary'); if (summaryEl) summaryEl.textContent = 'اختيار الموقع من الخريطة';
    epCurrentId = ref.id;
    epShowStatus(ref.id);
    dispatchExternalPurchase(ref.id);
  } catch (e) {
    showToast(e.message === 'pricing-not-configured' || String(e.message).includes('pricing-missing')
      ? 'الخدمة غير متاحة حاليًا، حاول لاحقًا' : 'حدث خطأ، حاول مرة أخرى', 'err');
  } finally { epRequestInProgress = false; }
}

// ===== Dispatch (نفس نمط dispatchRide في rides.js بالحرف - أقرب 3 مرشحين + Broadcast) =====
// الفرق الوحيد المتعمد: فحص الـ "مشغولية" هنا بيتحقق من الحقول الثلاثة مع بعض
// (activeRideId/activeOrderId/activeExternalPurchaseId) - قرار معماري صريح (راجع Final
// Architecture Review، قسم Dispatch Exclusivity) عشان الخدمة الجديدة بس متضيفش احتمال حجز
// ثلاثي جديد، من غير ما نلمس Ride Dispatch أو Merchant Dispatch الحاليين إطلاقًا.
export async function dispatchExternalPurchase(purchaseId) {
  const ref = doc(db, EXTERNAL_COLLECTION, purchaseId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const ep = snap.data();
  if (ep.status !== EP_STATUS.REQUESTED) return;

  const q = query(collection(db, 'users'),
    where('role', '==', 'driver'), where('status', '==', 'active'), where('isOnline', '==', true),
    where('activeRideId', '==', null), where('activeOrderId', '==', null), where('activeExternalPurchaseId', '==', null));
  const usnap = await getDocs(q);
  const candidates = [];
  usnap.forEach(d => {
    const u = d.data();
    if (!RIDE_ELIGIBLE_VEHICLES.includes(u.vehicleType)) return;
    if (typeof u.lat !== 'number' || typeof u.lng !== 'number') return;
    const target = (ep.pickupLocation && typeof ep.pickupLocation.latitude === 'number')
      ? { lat: ep.pickupLocation.latitude, lng: ep.pickupLocation.longitude }
      : (ep.deliveryLocation || { lat: u.lat, lng: u.lng }); // مستند قديم من غير pickupLocation - fallback للحقل القديم
    candidates.push({ id: d.id, distM: _distMeters(target.lat, target.lng, u.lat, u.lng) });
  });
  candidates.sort((a, b) => a.distM - b.distM);
  const top3 = candidates.slice(0, MAX_CANDIDATE_DRIVERS).map(c => c.id);

  if (top3.length === 0) {
    epSetLabel('لا يوجد كباتن متاحين حاليًا');
    epShowRetry(true);
    return;
  }
  await updateDoc(ref, {
    status: EP_STATUS.DRIVER_OFFERED, candidateDriverIds: top3, rejectedDriverIds: [],
    offeredAt: serverTimestamp(), updatedAt: serverTimestamp(),
    dispatchLog: trimLog(ep.dispatchLog, { event: 'dispatch_started', at: Date.now(), candidateCount: top3.length }),
  });
}

export function retryExternalDispatch() {
  if (!epCurrentId) return;
  epShowRetry(false);
  epSetLabel('جاري البحث عن كابتن...');
  dispatchExternalPurchase(epCurrentId);
}

// ===== Driver: قبول/رفض العرض (نفس نمط Transaction في acceptRideOffer/rejectRideOffer) =====
export async function acceptExternalOffer() {
  if (!window.CU || !window.currentEpOfferId) return;
  const purchaseId = window.currentEpOfferId;
  const ref = doc(db, EXTERNAL_COLLECTION, purchaseId);
  try {
    await runTransaction(db, async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists()) throw new Error('gone');
      const ep = snap.data();
      if (ep.status !== EP_STATUS.DRIVER_OFFERED) throw new Error('already-handled');
      if (ep.driverId) throw new Error('already-assigned');
      if (!(ep.candidateDriverIds || []).includes(window.CU.uid)) throw new Error('not-candidate');
      const driverRef = doc(db, 'users', window.CU.uid);
      const drvSnap = await t.get(driverRef);
      if (drvSnap.data()?.activeRideId || drvSnap.data()?.activeOrderId || drvSnap.data()?.activeExternalPurchaseId) throw new Error('busy');
      // Closure Audit Fix (#3 - Customer Phone Privacy): نفس نمط orders.js بالحرف - رقم العميل
      // بيتحط جوه الطلب بس لحظة تعيين الكابتن، مش قبلها (مندوب مرشح لسه مش متعيّن ميقدرش يشوفه).
      const custSnap = await t.get(doc(db, 'users', ep.customerId));
      const customerPhone = custSnap.data()?.phone || '';
      t.update(ref, {
        status: EP_STATUS.DRIVER_ASSIGNED, driverId: window.CU.uid, customerPhone, updatedAt: serverTimestamp(),
        dispatchLog: trimLog(ep.dispatchLog, { event: 'driver_accepted', driverId: window.CU.uid, at: Date.now() }),
      });
      t.update(driverRef, { activeExternalPurchaseId: purchaseId });
    });
    window.currentEpOfferId = null;
    const banner = document.getElementById('ep-offer-banner'); if (banner) banner.style.display = 'none';
    showToast('تم قبول طلب الشراء ✅', 'ok');
    const snap2 = await getDoc(ref);
    if (snap2.exists()) createNotification(snap2.data().customerId, 'تم تعيين كابتن', 'كابتن في طريقه لتنفيذ طلبك', 'or', purchaseId);
    initDriverActiveExternalListener();
  } catch (e) {
    showToast(e.message === 'busy' ? 'أنت مشغول بمهمة أخرى حاليًا' : 'الطلب لم يعد متاحًا', 'err');
    window.currentEpOfferId = null;
    const banner = document.getElementById('ep-offer-banner'); if (banner) banner.style.display = 'none';
  }
}

export async function rejectExternalOffer() {
  if (!window.CU || !window.currentEpOfferId) return;
  const purchaseId = window.currentEpOfferId;
  const ref = doc(db, EXTERNAL_COLLECTION, purchaseId);
  try {
    await runTransaction(db, async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists()) return;
      const ep = snap.data();
      if (ep.status !== EP_STATUS.DRIVER_OFFERED) return;
      if (!(ep.candidateDriverIds || []).includes(window.CU.uid)) return;
      if ((ep.rejectedDriverIds || []).includes(window.CU.uid)) return;
      const newRejected = [...(ep.rejectedDriverIds || []), window.CU.uid];
      const log = trimLog(ep.dispatchLog, { event: 'driver_rejected', driverId: window.CU.uid, at: Date.now() });
      if (newRejected.length >= (ep.candidateDriverIds || []).length) {
        t.update(ref, { status: EP_STATUS.REQUESTED, candidateDriverIds: [], rejectedDriverIds: [], dispatchLog: log, updatedAt: serverTimestamp() });
      } else {
        t.update(ref, { rejectedDriverIds: newRejected, dispatchLog: log, updatedAt: serverTimestamp() });
      }
    });
  } catch (e) {}
  window.currentEpOfferId = null;
  const banner = document.getElementById('ep-offer-banner'); if (banner) banner.style.display = 'none';
}

// ===== Driver Lifecycle Actions =====
async function epTransition(purchaseId, toStatus, extra = {}) {
  const ref = doc(db, EXTERNAL_COLLECTION, purchaseId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return false;
  const ep = snap.data();
  if (!canTransitionEP(ep.status, toStatus)) return false;
  await updateDoc(ref, { status: toStatus, updatedAt: serverTimestamp(), ...extra });
  return true;
}
export async function epStartShopping(purchaseId) {
  if (await epTransition(purchaseId, EP_STATUS.SHOPPING)) {
    const snap = await getDoc(doc(db, EXTERNAL_COLLECTION, purchaseId));
    if (snap.exists()) createNotification(snap.data().customerId, 'بدأ الشراء', 'الكابتن بدأ تنفيذ طلبك الآن', 'or', purchaseId);
  }
}
export async function epReportItemUnavailable(purchaseId) {
  if (await epTransition(purchaseId, EP_STATUS.ITEM_UNAVAILABLE)) {
    const snap = await getDoc(doc(db, EXTERNAL_COLLECTION, purchaseId));
    if (snap.exists()) createNotification(snap.data().customerId, 'المنتج غير متوفر', 'الكابتن لم يجد المنتج، يرجى اتخاذ قرار', 'yw', purchaseId);
    showToast('تم إبلاغ العميل، بانتظار قراره', 'inf');
  }
}
export async function epReportBudgetExceeded(purchaseId, actualPrice) {
  const price = Number(actualPrice);
  if (!price || price <= 0) { showToast('أدخل السعر الفعلي أولًا', 'err'); return; }
  if (await epTransition(purchaseId, EP_STATUS.BUDGET_EXCEEDED, { actualProductPrice: price })) {
    const snap = await getDoc(doc(db, EXTERNAL_COLLECTION, purchaseId));
    if (snap.exists()) createNotification(snap.data().customerId, 'السعر أعلى من المتوقع', `السعر الفعلي ${price} ج.م، يرجى الموافقة أو الإلغاء`, 'yw', purchaseId);
    showToast('تم إبلاغ العميل بالسعر، بانتظار قراره', 'inf');
  }
}
export async function epMarkPurchased(purchaseId, actualPrice) {
  const price = Number(actualPrice);
  if (!price || price <= 0) { showToast('أدخل السعر الفعلي أولًا', 'err'); return; }
  // Closure Audit Fix (Critical #2): إنفاذ فعلي لقاعدة budget_exceeded - السعر الحرفي أكبر من
  // approxBudget (لو العميل حدد ميزانية أصلًا؛ approxBudget<=0 يعني العميل ماحددش ميزانية،
  // فمفيش أساس نقارن بيه). صفر نسبة مُخترعة - المقارنة حرفية زي ما اسم الحالة نفسه بيقول.
  const snapPre = await getDoc(doc(db, EXTERNAL_COLLECTION, purchaseId));
  if (snapPre.exists()) {
    const epPre = snapPre.data();
    if (epPre.approxBudget > 0 && price > epPre.approxBudget) {
      showToast('السعر أعلى من الميزانية المتوقعة - يجب إبلاغ العميل وانتظار موافقته أولًا', 'err');
      return epReportBudgetExceeded(purchaseId, price);
    }
  }
  if (await epTransition(purchaseId, EP_STATUS.PURCHASED, { actualProductPrice: price })) {
    const snap = await getDoc(doc(db, EXTERNAL_COLLECTION, purchaseId));
    if (snap.exists()) createNotification(snap.data().customerId, 'تم الشراء ✅', 'الكابتن اشترى طلبك وفي طريقه إليك', 'gn', purchaseId);
  }
}
export async function epStartDelivering(purchaseId) {
  if (await epTransition(purchaseId, EP_STATUS.DELIVERING)) {
    const snap = await getDoc(doc(db, EXTERNAL_COLLECTION, purchaseId));
    if (snap.exists()) createNotification(snap.data().customerId, 'في الطريق إليك 🛵', 'الكابتن خرج للتوصيل', 'or', purchaseId);
  }
}
export async function epCompleteDelivery(purchaseId) {
  const ref = doc(db, EXTERNAL_COLLECTION, purchaseId);
  const snap = await getDoc(ref);
  if (!snap.exists() || !canTransitionEP(snap.data().status, EP_STATUS.COMPLETED)) return;
  await runTransaction(db, async (t) => {
    t.update(ref, { status: EP_STATUS.COMPLETED, updatedAt: serverTimestamp() });
    t.update(doc(db, 'users', window.CU.uid), { activeExternalPurchaseId: null });
  });
  createNotification(snap.data().customerId, 'تم التسليم ✅', 'تم تسليم طلبك بنجاح، شكرًا لاستخدامك MOVA', 'gn', purchaseId);
  showToast('تم إنهاء الطلب بنجاح 🎉', 'ok');
}

// ===== Customer Decisions (item_unavailable / budget_exceeded) =====
export async function epCustomerCancel(purchaseId) {
  const ref = doc(db, EXTERNAL_COLLECTION, purchaseId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const ep = snap.data();
  if (ep.customerId !== window.CU?.uid || !canTransitionEP(ep.status, EP_STATUS.CANCELLED)) return;
  await runTransaction(db, async (t) => {
    t.update(ref, { status: EP_STATUS.CANCELLED, updatedAt: serverTimestamp() });
    if (ep.driverId) t.update(doc(db, 'users', ep.driverId), { activeExternalPurchaseId: null });
  });
  if (ep.driverId) createNotification(ep.driverId, 'تم إلغاء الطلب', 'العميل ألغى طلب الشراء الخارجي', 'yw', purchaseId);
  showToast('تم إلغاء الطلب', 'ok');
}
export async function epCustomerContinue(purchaseId) {
  const ref = doc(db, EXTERNAL_COLLECTION, purchaseId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const ep = snap.data();
  if (ep.customerId !== window.CU?.uid) return;
  // Closure Audit Fix: الهدف يتحدد حسب الحالة الحالية - item_unavailable ترجع shopping (السعر
  // لسه مش مقفول)، budget_exceeded تروح مباشرة purchased (السعر مقفول بالفعل من وقت الإبلاغ،
  // العميل بيوافق على نفس الرقم المعروض له بالظبط، صفر إعادة إدخال ممكن تفتح ثغرة سعر تاني).
  const target = ep.status === EP_STATUS.BUDGET_EXCEEDED ? EP_STATUS.PURCHASED : EP_STATUS.SHOPPING;
  if (!canTransitionEP(ep.status, target)) return;
  await updateDoc(ref, { status: target, updatedAt: serverTimestamp() });
  if (ep.driverId) createNotification(ep.driverId,
    target === EP_STATUS.PURCHASED ? 'العميل وافق على السعر' : 'العميل وافق على المتابعة',
    target === EP_STATUS.PURCHASED ? 'يمكنك إكمال التوصيل الآن' : 'يمكنك إكمال عملية الشراء', 'gn', purchaseId);
  showToast(target === EP_STATUS.PURCHASED ? 'تم تأكيد السعر، الكابتن في طريقه إليك' : 'تم إبلاغ الكابتن بالمتابعة', 'ok');
}

// ===== Customer UI: شاشة الحالة + الاستماع اللحظي =====
let epCurrentId = null, epUnsub = null;
function epSetLabel(txt) { const el = document.getElementById('ep-status-label'); if (el) el.textContent = txt; }
function epShowRetry(show) { const el = document.getElementById('ep-retry-btn'); if (el) el.style.display = show ? 'block' : 'none'; }
const EP_LABELS = {
  requested: 'جاري البحث عن كابتن...', driver_offered: 'جاري البحث عن كابتن...',
  driver_assigned: 'تم تعيين كابتن، في الطريق للمكان', shopping: 'الكابتن بيشتري طلبك الآن',
  item_unavailable: 'المنتج غير متوفر — بانتظار قرارك', budget_exceeded: 'السعر أعلى من المتوقع — بانتظار قرارك',
  purchased: 'تم الشراء، جاري التجهيز للتوصيل', delivering: 'الكابتن في الطريق إليك',
  completed: 'تم التسليم بنجاح ✅', cancelled: 'تم إلغاء الطلب',
};
export function epShowStatus(purchaseId) {
  epCurrentId = purchaseId;
  window.currentEpStatusId = purchaseId;
  showScreen('screen-ep-status');
  if (epUnsub) { epUnsub(); epUnsub = null; }
  epUnsub = onSnapshot(doc(db, EXTERNAL_COLLECTION, purchaseId), snap => {
    if (!snap.exists()) return;
    const ep = snap.data();
    epSetLabel(EP_LABELS[ep.status] || ep.status);
    epShowRetry(false);
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('ep-place-val', ep.placeName || '--');
    set('ep-items-val', ep.items || '--');
    set('ep-budget-val', ep.approxBudget ? `${ep.approxBudget} ج تقريبًا` : '--');
    set('ep-price-val', ep.actualProductPrice ? `${ep.actualProductPrice} ج` : '--');
    const decisionBox = document.getElementById('ep-decision-box');
    if (decisionBox) decisionBox.style.display = (ep.status === EP_STATUS.ITEM_UNAVAILABLE || ep.status === EP_STATUS.BUDGET_EXCEEDED) ? 'block' : 'none';
    const earlyCancelBtn = document.getElementById('ep-early-cancel-btn');
    if (earlyCancelBtn) earlyCancelBtn.style.display = [EP_STATUS.REQUESTED, EP_STATUS.DRIVER_OFFERED, EP_STATUS.DRIVER_ASSIGNED].includes(ep.status) ? 'block' : 'none';
    const decisionMsg = document.getElementById('ep-decision-msg');
    if (decisionMsg) decisionMsg.textContent = ep.status === EP_STATUS.ITEM_UNAVAILABLE
      ? 'المنتج مش متوفر، تحب تكمل ببديل يقترحه الكابتن ولا تلغي الطلب؟'
      : `السعر الفعلي ${ep.actualProductPrice || '--'} ج.م، أعلى من ميزانيتك. تحب تكمل ولا تلغي؟`;
  });
}
export function epCloseStatus() {
  if (epUnsub) { epUnsub(); epUnsub = null; }
  epCurrentId = null;
  window.currentEpStatusId = null;
}

// ===== Driver UI: عرض جديد + مهمة نشطة =====
let epDriverOfferUnsub = null;
export function listenExternalOffers() {
  if (epDriverOfferUnsub || !window.CU) return;
  const q = query(collection(db, EXTERNAL_COLLECTION), where('candidateDriverIds', 'array-contains', window.CU.uid), where('status', '==', EP_STATUS.DRIVER_OFFERED));
  epDriverOfferUnsub = onSnapshot(q, snap => {
    let offer = null;
    snap.forEach(d => { if (!offer) offer = { id: d.id, ...d.data() }; });
    const banner = document.getElementById('ep-offer-banner');
    if (offer && !(offer.rejectedDriverIds || []).includes(window.CU.uid)) {
      window.currentEpOfferId = offer.id;
      const txt = document.getElementById('ep-offer-txt'); if (txt) txt.textContent = `${offer.placeName} — ${offer.items}`.slice(0, 60);
      if (banner) banner.style.display = 'flex';
    } else if (banner) { banner.style.display = 'none'; window.currentEpOfferId = null; }
  });
}

let epActiveUnsub = null;
// جديد (P8 - External Purchase GPS Lifecycle): مصدر الحقيقة الحي لـ "هل عند المندوب External
// Purchase نشطة دلوقتي" - نفس فلسفة activeRideId/isDriverRideActive في rides.js بالحرف، لكن
// هنا القيمة بتتحدّث من نفس الـ Query الحي الموجود بالفعل (epActiveUnsub تحت) بدل Listener
// جديد. صفر Watcher/Timer/Query إضافي - استخدام لنتيجة onSnapshot الموجودة أصلًا.
let _activeEpId = null;
export function isDriverExternalActive() { return !!_activeEpId; }
export function initDriverActiveExternalListener() {
  const activeId = window.CUD?.activeExternalPurchaseId;
  if (!activeId && !window.CU) return;
  const uid = window.CU?.uid;
  if (!uid) return;
  if (epActiveUnsub) { epActiveUnsub(); epActiveUnsub = null; }
  // بنسمع لمستند المستخدم نفسه عشان نعرف فيه شغلانة نشطة ولا لأ (نفس فلسفة initDriverActiveRideListener)
  const q = query(collection(db, EXTERNAL_COLLECTION), where('driverId', '==', uid), where('status', 'in',
    [EP_STATUS.DRIVER_ASSIGNED, EP_STATUS.SHOPPING, EP_STATUS.ITEM_UNAVAILABLE, EP_STATUS.BUDGET_EXCEEDED, EP_STATUS.PURCHASED, EP_STATUS.DELIVERING]));
  epActiveUnsub = onSnapshot(q, snap => {
    let active = null;
    snap.forEach(d => { if (!active) active = { id: d.id, ...d.data() }; });
    // جديد (P8 - External Purchase GPS Lifecycle): نفس نبضة الـ Snapshot دي هي مصدر الحقيقة -
    // لو مفيش External Purchase نشطة دلوقتي وكانت فيه واحدة قبل كده (اتسلّمت/اتلغت)، ولو
    // المندوب حاطط نفسه Offline بالفعل ومفيش عنده طلب توصيل أو مشوار جاري كمان، نوقف GPS فورًا
    // (زي stopDriverActiveRide في rides.js بالظبط) بدل ما يفضل شغال بلا داعي.
    const wasActive = !!_activeEpId;
    _activeEpId = active ? active.id : null;
    if (wasActive && !_activeEpId) maybeStopGpsIfIdle();
    const panel = document.getElementById('ep-active-panel');
    if (!panel) return;
    if (!active) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    window.currentEpActiveId = active.id;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('ep-active-status', EP_LABELS[active.status] || active.status);
    set('ep-active-place', active.placeName || '--');
    set('ep-active-items', active.items || '--');
    set('ep-active-addr', active.pickupLocation?.address || active.deliveryAddress || '--');
    const btn = document.getElementById('ep-active-btn');
    const priceRow = document.getElementById('ep-active-price-row');
    if (btn) {
      if (active.status === EP_STATUS.DRIVER_ASSIGNED) { btn.textContent = 'بدأت الشراء'; btn.style.display = 'block'; if (priceRow) priceRow.style.display = 'none'; }
      else if (active.status === EP_STATUS.SHOPPING) { btn.textContent = 'تم الشراء'; btn.style.display = 'block'; if (priceRow) priceRow.style.display = 'flex'; }
      else if (active.status === EP_STATUS.PURCHASED) { btn.textContent = 'بدء التوصيل'; btn.style.display = 'block'; if (priceRow) priceRow.style.display = 'none'; }
      else if (active.status === EP_STATUS.DELIVERING) { btn.textContent = 'تم التسليم'; btn.style.display = 'block'; if (priceRow) priceRow.style.display = 'none'; }
      else { btn.style.display = 'none'; if (priceRow) priceRow.style.display = active.status === EP_STATUS.BUDGET_EXCEEDED ? 'flex' : 'none'; }
    }
  });
}
export function handleDriverExternalAction() {
  const id = window.currentEpActiveId;
  if (!id) return;
  const btn = document.getElementById('ep-active-btn');
  const label = btn?.textContent;
  if (label === 'بدأت الشراء') epStartShopping(id);
  else if (label === 'تم الشراء') {
    const price = document.getElementById('ep-active-price-inp')?.value;
    epMarkPurchased(id, price);
  } else if (label === 'بدء التوصيل') epStartDelivering(id);
  else if (label === 'تم التسليم') epCompleteDelivery(id);
}
export function reportItemUnavailableFromPanel() { if (window.currentEpActiveId) epReportItemUnavailable(window.currentEpActiveId); }
export function reportBudgetExceededFromPanel() {
  const price = document.getElementById('ep-active-price-inp')?.value;
  if (window.currentEpActiveId) epReportBudgetExceeded(window.currentEpActiveId, price);
}

// ===== Listener Registry Cleanup (نفس فلسفة registerRidesResets تمامًا) =====
export function registerExternalResets() {
  onListenersCleared(() => {
    epDriverOfferUnsub = null; epActiveUnsub = null; epUnsub = null; epCurrentId = null; _activeEpId = null;
  });
}
