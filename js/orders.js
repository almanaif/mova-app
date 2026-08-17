// ===== orders.js — Professional Order Engine: State Machine, Dispatch Engine, Checkout, Tracking =====

import { addDoc, collection, db, doc, getDoc, runTransaction, serverTimestamp, updateDoc, query, where } from './firebase.js';
import { getPricingConfig, calculateFare } from './pricing.js';
import { NEW_STEPS, NEW_STEP_ICONS, NEW_STEP_LABELS, SL, esc, normalizeStatus, onListenersCleared, onSnapshot, showScreen, showToast } from './utils.js';
import { custNav, updateCartUI } from './customer.js';
import { createNotification } from './notifications.js';
import { initTrackMap, trackPhaseKey } from './maps.js';
import { reverseGeocode } from './routing.js';

// =====================================================================================
// ORDER STATE MACHINE
// =====================================================================================
// دورة حياة الطلب الاحترافية. كل حالة ليها انتقالات مسموحة بس، وأي محاولة تنتقل لحالة
// غير مسموحة بترفض فورًا (canTransition) بدل ما تتنفذ بصمت زي ما كان حاصل قبل كده
// (كان أي حد يقدر ينده updateDoc(.... {status:'أي حاجة'}) من غير أي تحقق).
export const ORDER_STATUS = {
  CREATED: 'created',
  WAITING_MERCHANT: 'waiting_merchant',
  MERCHANT_ACCEPTED: 'merchant_accepted',
  MERCHANT_REJECTED: 'merchant_rejected',
  SEARCHING_DRIVER: 'searching_driver',
  DRIVER_ASSIGNED: 'driver_assigned',
  DRIVER_ARRIVED: 'driver_arrived',
  PICKED_UP: 'picked_up',
  ON_THE_WAY: 'on_the_way',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
};

// =====================================================================================
// NOTIFICATION EVENTS (نقطة تجميع واحدة لكل رسائل تغييرات حالة الطلب)
// =====================================================================================
// كل حالة جديدة (toStatus) بتتحول ليها transitionOrder() بتتوصل تلقائيًا هنا وتاخد رسالتها
// المناسبة، فمفيش أي تكرار لكود إنشاء الإشعار في driver.js/merchant.js/admin.js - كلهم بينادوا
// transitionOrder أو merchantRespond أو acceptOrderAsDriver واللي بدورهم بينادوا createNotification()
// من notifications.js (نقطة الإنشاء الحقيقية الوحيدة في Firestore).
const STATUS_NOTIF = {
  [ORDER_STATUS.MERCHANT_ACCEPTED]: { to: 'customerId', title: '✅ التاجر وافق على طلبك', body: 'جاري تجهيز طلبك الآن', type: 'or' },
  [ORDER_STATUS.MERCHANT_REJECTED]: { to: 'customerId', title: '❌ تم رفض طلبك', body: 'للأسف رفض المتجر طلبك، تواصل معه لمعرفة السبب', type: 'yw' },
  [ORDER_STATUS.SEARCHING_DRIVER]:  { to: 'customerId', title: '🔎 جاري البحث عن مندوب', body: 'هنبلغك فور ما يتم تعيين مندوب لطلبك', type: 'gn' },
  [ORDER_STATUS.DRIVER_ARRIVED]:    { to: 'customerId', title: '📍 المندوب وصل للمتجر', body: 'المندوب استلم مكان التجهيز وهيتحرك قريب', type: 'bl' },
  [ORDER_STATUS.PICKED_UP]:         { to: 'customerId', title: '📦 تم استلام طلبك', body: 'المندوب استلم طلبك من المتجر', type: 'bl' },
  [ORDER_STATUS.ON_THE_WAY]:        { to: 'customerId', title: '🛵 طلبك في الطريق', body: 'المندوب في طريقه إليك الآن', type: 'bl' },
  [ORDER_STATUS.DELIVERED]:         { to: 'customerId', title: '✅ تم التسليم', body: 'نتمنى تكون استمتعت بطلبك، قيّم تجربتك!', type: 'gn' },
  [ORDER_STATUS.CANCELLED]:         { to: 'customerId', title: '❌ تم إلغاء الطلب', body: 'تم إلغاء طلبك', type: 'yw' },
};
function notifyStatusChange(orderId, order, toStatus) {
  if (!order) return;
  const cfg = STATUS_NOTIF[toStatus];
  if (cfg) {
    const recipientId = order[cfg.to];
    // eventKey = toStatus بالظبط: بيدي كل إشعار تغيير حالة هوية ثابتة (orderId + toStatus +
    // recipient)، فلو نفس الانتقال اتحاول يتنفذ تاني (Retry شبكة، أكتر من Listener شغال...)
    // Firestore Rules هترفض محاولة "الإنشاء" التانية لنفس الـ ID (راجع notifications.js).
    if (recipientId) createNotification(recipientId, cfg.title, cfg.body, cfg.type, orderId, toStatus);
  }
  // عند الإلغاء بعد ما يكون فيه مندوب معيّن بالفعل، يتبلّغ هو كمان (مش بس العميل)
  if (toStatus === ORDER_STATUS.CANCELLED && order.driverId) {
    createNotification(order.driverId, '❌ تم إلغاء الطلب', 'تم إلغاء الطلب اللي كنت مكلف بيه', 'yw', orderId, 'cancelled_driver');
  }
}

// خريطة الانتقالات المسموحة: من كل حالة، مسموح تروح لأي حالة من اللي جوه المصفوفة بس.
// ملحوظة (تنظيف Sprint 2.2): ORDER_STATUS.CREATED اتشالت من هنا لأنها مش حالة حقيقية في
// الـ Live State Machine - status الطلب مبيبقاش 'created' أبدًا فعليًا (goCheckout بيحطه
// waiting_merchant على طول)، الاسم ده بيتستخدم بس كعنصر أول شكلي جوه statusHistory وقت
// الإنشاء (سجل تاريخي: "الطلب اتعمل")، مش كحالة بيتم التحقق من الانتقال منها أو ليها.
// كانت موجودة هنا كـ Dead State (مش متعرّفة أصلاً في isValidOrderTransition بالـ Rules).
const ORDER_TRANSITIONS = {
  [ORDER_STATUS.WAITING_MERCHANT]:   [ORDER_STATUS.MERCHANT_ACCEPTED, ORDER_STATUS.MERCHANT_REJECTED, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.MERCHANT_ACCEPTED]:  [ORDER_STATUS.SEARCHING_DRIVER, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.MERCHANT_REJECTED]:  [], // نهائية
  [ORDER_STATUS.SEARCHING_DRIVER]:   [ORDER_STATUS.DRIVER_ASSIGNED, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.DRIVER_ASSIGNED]:    [ORDER_STATUS.DRIVER_ARRIVED, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.DRIVER_ARRIVED]:     [ORDER_STATUS.PICKED_UP, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.PICKED_UP]:          [ORDER_STATUS.ON_THE_WAY], // بعد الاستلام، مفيش رجوع أو إلغاء
  [ORDER_STATUS.ON_THE_WAY]:         [ORDER_STATUS.DELIVERED],
  [ORDER_STATUS.DELIVERED]:          [], // نهائية
  [ORDER_STATUS.CANCELLED]:          [], // نهائية
};

export function canTransition(fromStatus, toStatus) {
  const allowed = ORDER_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

// نقطة الدخول الوحيدة لتغيير حالة أي طلب. بتشتغل جوه Transaction عشان:
// 1) تقرأ الحالة الحالية الحقيقية من السيرفر (مش من الشاشة).
// 2) ترفض الانتقال لو مش مسموح (رجوع للخلف، أو قفزة غير منطقية).
// 3) تسجّل كل انتقال في statusHistory (من / إلى / وقت / مين اللي عمل التغيير) = Audit Log.
export async function transitionOrder(orderId, toStatus, actor, extra = {}) {
  const orderRef = doc(db, 'orders', orderId);
  let orderForNotif = null; // بنلقط بيانات الطلب قبل التحديث عشان نستخدمها في الإشعار بعد نجاح الـ Transaction
  const result = await runTransaction(db, async (t) => {
    const snap = await t.get(orderRef);
    if (!snap.exists()) throw new Error('order-not-found');
    const cur = snap.data();
    orderForNotif = cur;
    const fromStatus = cur.status;
    if (!canTransition(fromStatus, toStatus)) {
      const err = new Error('invalid-transition');
      err.fromStatus = fromStatus; err.toStatus = toStatus;
      throw err;
    }
    const historyEntry = { from: fromStatus, to: toStatus, at: Date.now(), by: actor || 'system' };
    // ملحوظة: مبنستخدمش serverTimestamp() جوه عناصر Array لأن Firestore مبيحلهاش صح
    // (السنتينل بتاعها بيتخزن كما هو من غير ما يتحول لتاريخ حقيقي) — فبنستخدم Date.now() هنا.
    const history = Array.isArray(cur.statusHistory) ? [...cur.statusHistory, historyEntry] : [historyEntry];
    t.update(orderRef, { status: toStatus, updatedAt: serverTimestamp(), statusHistory: history, ...extra });
    return { fromStatus, toStatus };
  });
  // إشعار Best-effort بعد نجاح التحديث فعليًا - فشل الإشعار (لو حصل) ميرجعش الحالة تتلغي
  notifyStatusChange(orderId, orderForNotif, toStatus);
  return result;
}

// إلغاء الطلب (أدمن أو عميل) — بيتحقق تلقائيًا إن الإلغاء لسه مسموح في الحالة الحالية
// (زي ما اتطلب: مينفعش تلغي طلب بعد ما المندوب يكون استلمه).
export async function cancelOrder(orderId, actor, reason = '') {
  return transitionOrder(orderId, ORDER_STATUS.CANCELLED, actor, reason ? { cancelReason: reason } : {});
}

// الحالات اللي لسه يقدر فيها العميل يلغي طلبه بنفسه (لحد ما يتعيّن مندوب فعليًا). مطابقة
// لنفس القائمة الموجودة في firestore.rules (طبقة الحماية الحقيقية) - القائمة هنا للواجهة بس
// (تحديد وقت ظهور زرار الإلغاء)، الـ Rules هي اللي بترفض فعليًا أي محاولة خارج النطاق ده.
export const CUSTOMER_CANCELLABLE_STATUSES = [
  ORDER_STATUS.WAITING_MERCHANT, ORDER_STATUS.MERCHANT_ACCEPTED,
  ORDER_STATUS.SEARCHING_DRIVER, ORDER_STATUS.DRIVER_ASSIGNED,
];
// نفس الفكرة للتاجر - يقدر يلغي لحد ما المندوب يوصل فعليًا (driver_arrived)، بعد كده لأ.
export const MERCHANT_CANCELLABLE_STATUSES = [
  ORDER_STATUS.MERCHANT_ACCEPTED, ORDER_STATUS.SEARCHING_DRIVER,
  ORDER_STATUS.DRIVER_ASSIGNED, ORDER_STATUS.DRIVER_ARRIVED,
];

// إلغاء العميل لطلبه - بيستخدم نفس معمارية cancelOrder/transitionOrder/runTransaction
// (مفيش updateDoc مباشر من واجهة العميل). الحماية الحقيقية (مين يقدر يلغي وامتى) موجودة في
// Firestore Rules - الفحص هنا بس عشان رسالة خطأ واضحة للمستخدم قبل حتى ما نبعت الطلب.
export async function custCancelOrder(orderId, actor, reason = '') {
  return cancelOrder(orderId, actor, reason);
}

// إلغاء التاجر لطلب متجره - نفس المعمارية بالظبط، بدون أي آلية موازية.
export async function merchCancelOrd(orderId, actor, reason = '') {
  return cancelOrder(orderId, actor, reason);
}

// =====================================================================================
// DISPATCH ENGINE
// =====================================================================================
// المرحلة الحالية: أول مندوب Online يشوف الطلب (لسه محدّدش المسافة) هو اللي بيقبله؛ القفل
// الذري (Transaction) في acceptOrderAsDriver هو اللي بيضمن إن مندوب واحد بس ياخده لو
// أكتر من مندوب ضغط قبول في نفس اللحظة.
//
// نقطة التوسّع الجاهزة: عايز تحدد أقرب مندوب بدل "أول واحد يشوف"؟ ماتلمسش باقي النظام —
// كل اللي محتاجه إنك تملي الدالة rankCandidateDrivers() تحت دي بمنطق حساب المسافة (زي
// _distMeters الموجودة في driver.js)، وتستخدم نتيجتها في driver.js listenNewOrders لعرض
// الطلب بالترتيب بدل ما كل المندوبين يشوفوه في نفس اللحظة. الـ Dispatch query ورقم الـ
// Transaction في acceptOrderAsDriver مش هيحتاجوا أي تعديل.
export function getDispatchQuery() {
  return query(collection(db, 'orders'), where('status', '==', ORDER_STATUS.SEARCHING_DRIVER), where('driverId', '==', null));
}

// Stub جاهز للمستقبل - دلوقتي بيرجّع نفس القائمة من غير ترتيب (لحد ما تتوفر إحداثيات المتجر
// والمندوبين بشكل موثوق في كل الطلبات).
export function rankCandidateDrivers(order, onlineDrivers) {
  return onlineDrivers;
}

// المندوب بيقبل الطلب: بيتأكد إن الطلب لسه searching_driver ومفيهوش مندوب، وإن المندوب
// نفسه مش مشغول بطلب تاني حاليًا (activeOrderId) - كله في نفس الـ Transaction الذرية.
// جديد (حماية رقم العميل - Option B): customerPhone بقى بيتحط جوه الطلب هنا بس، لحظة تعيين
// المندوب، ومصدره الحقيقي هو مستند العميل نفسه (users/{customerId}) - مش أي قيمة بيبعتها
// المتصفح. قبل كده الرقم كان بيتخزن وقت إنشاء الطلب، فأي مندوب Online كان يقدر يقراه
// وهو لسه searching_driver قبل ما يقبل الطلب أصلاً. دلوقتي محدش يشوف الرقم غير المندوب
// المعيّن فعليًا (Firestore Rules بترفض غير كده - راجع firestore.rules).
export async function acceptOrderAsDriver(orderId, driverUid, driverName, driverPhone) {
  const orderRef = doc(db, 'orders', orderId);
  const userRef = doc(db, 'users', driverUid);
  let orderForNotif = null;
  await runTransaction(db, async (t) => {
    const uSnap = await t.get(userRef);
    if (uSnap.data()?.activeOrderId || uSnap.data()?.activeRideId || uSnap.data()?.activeExternalPurchaseId) throw new Error('busy');
    const oSnap = await t.get(orderRef);
    const cur = oSnap.data();
    if (!cur || cur.driverId) throw new Error('taken');
    if (!canTransition(cur.status, ORDER_STATUS.DRIVER_ASSIGNED)) throw new Error('invalid-transition');
    const custSnap = await t.get(doc(db, 'users', cur.customerId));
    const customerPhone = custSnap.data()?.phone || '';
    orderForNotif = cur;
    const historyEntry = { from: cur.status, to: ORDER_STATUS.DRIVER_ASSIGNED, at: Date.now(), by: { type: 'driver', uid: driverUid, name: driverName } };
    const history = Array.isArray(cur.statusHistory) ? [...cur.statusHistory, historyEntry] : [historyEntry];
    t.update(orderRef, {
      status: ORDER_STATUS.DRIVER_ASSIGNED, driverId: driverUid, driverName: driverName || '', driverPhone: driverPhone || '',
      customerPhone, acceptedAt: serverTimestamp(), updatedAt: serverTimestamp(), statusHistory: history,
    });
    t.update(userRef, { activeOrderId: orderId });
  });
  if (orderForNotif) {
    createNotification(orderForNotif.customerId, '🛵 تم تعيين مندوب لطلبك', `${driverName || 'المندوب'} في طريقه لاستلام طلبك من المتجر`, 'or', orderId, 'driver_assigned');
  }
}

// التاجر بيوافق أو يرفض الطلب. الموافقة بتتم على خطوتين متتاليتين (merchant_accepted ثم
// searching_driver فورًا) عشان الاثنين يتسجلوا في statusHistory زي ما اتطلب بالظبط، وبرضه
// يبقى فيه لحظة merchant_accepted واضحة في الـ Audit Log لو حبينا نفصل بينهم مستقبلًا (مثلاً
// لو التاجر عايز وقت تحضير قبل ما نبحث عن مندوب).
export async function merchantRespond(orderId, accept, actor) {
  if (accept) {
    await transitionOrder(orderId, ORDER_STATUS.MERCHANT_ACCEPTED, actor);
    await transitionOrder(orderId, ORDER_STATUS.SEARCHING_DRIVER, actor);
  } else {
    await transitionOrder(orderId, ORDER_STATUS.MERCHANT_REJECTED, actor);
  }
}

// =====================================================================================
// CHECKOUT
// =====================================================================================
// جديد: الطلب بقى لازم يتحفظ ومعاه pickupLocation (خط عرض/طول + عنوان نصي لو اتحدد + مدينة/منطقة
// لو نجح تحديدهم من الإحداثيات). لو فشل تحديد العنوان النصي، برضه بيتحفظ الموقع الجغرافي
// (مطلوب صراحة). عشان نضمن "العميل يختار موقعه" فعليًا (مش يبعت طلب من غير أي موقع)، بقى
// إتمام الطلب يشترط إن getLocation() يكون اتضغط قبل كده في نفس الجلسة (window.userLat/Lng).
// reverseGeocode() نُقلت لـ routing.js (Map Sprint) عشان maps.js يقدر يستخدمها كمان من غير Circular Import.

export async function goCheckout() {
  if (!window.cart.length) { showToast('السلة فارغة!', 'err'); return; }
  if (!window.CU) { showScreen('screen-entry'); return; }
  if (window.cart.length > 12) { showToast('الحد الأقصى 12 صنف مختلف في الطلب الواحد', 'err'); return; }
  if (!window.userLat || !window.userLng) {
    showToast('حدد موقعك أولاً من زر 📍 قبل إتمام الطلب', 'err');
    return;
  }
  try {
    const total = window.cart.reduce((a, c) => a + c.price * c.qty, 0);
    const comm = Math.round(total * window.commRate / 100);
    let pricingSnapshot;
    try {
      const pricingCfg = await getPricingConfig();
      pricingSnapshot = calculateFare(pricingCfg, 'delivery', {});
    } catch (e) {
      // إعدادات التسعير لسه مش متحطة (settings/pricing) - نفشل بوضوح وأمان بدل ما نرجع
      // لرقم Hardcoded أو نكسر الشاشة برسالة خطأ غير مفهومة.
      showToast('خدمة الطلبات غير متاحة مؤقتًا، حاول لاحقًا', 'err');
      console.error('[goCheckout] pricing config missing:', e);
      return;
    }
    const fee = pricingSnapshot.finalFare;
    const firstItem = window.cart[0];
    const orderStoreId = firstItem?.merchantId || null;
    const orderStoreName = firstItem?.storeName || 'متجر';
    if (!orderStoreId) { showToast('حدث خطأ في تحديد المتجر', 'err'); return; }

    // جديد: العنوان المخزّن من منتقي الموقع مايتستخدمش إلا لو لسه بيطابق آخر إحداثيات فعلية
    // (userLat/Lng) - لو getLocation() (GPS تلقائي) اشتغل تاني بعد كده وغيّرهم من غير ما
    // العميل يفتح المنتقي تاني، العنوان القديم يبقى غير موثوق فنرجع لـ reverseGeocode حقيقي.
    const locMatches = window.userLocAddressFor &&
      window.userLocAddressFor.lat === window.userLat && window.userLocAddressFor.lng === window.userLng;
    const geo = (window.userLocAddress && locMatches)
      ? { address: window.userLocAddress, city: window.userLocCity || null, zone: window.userLocZone || null } // العميل أكّد الموقع فعليًا من منتقي الموقع - نفس البيانات اللي شافها بالظبط، بدل طلب reverseGeocode تاني لنفس الإحداثيات
      : await reverseGeocode(window.userLat, window.userLng);
    const pickupLocation = {
      latitude: window.userLat, longitude: window.userLng,
      address: geo.address, city: geo.city, zone: geo.zone,
    };
    // جديد (Sprint 3.7 - Store Location): وثائق /stores الحالية مفيهاش lat/lng على الإطلاق
    // (اتفحصت فعليًا - صفر متجر عنده إحداثيات مسجلة دلوقتي)، فكل خرائط التوصيل كانت بترسم
    // "المتجر" على نقطة ثابتة واحدة (STORE_LOC) لكل المتاجر - مش حقيقية. مفيش افتراض بيانات
    // هنا: بنحاول نقرا lat/lng من وثيقة المتجر لو موجودة (Best-effort، مفيش تأثير لو مش
    // موجودة)، ولو موجودة بتتحفظ على الطلب نفسه (زي customerLat/Lng بالظبط) عشان خريطة
    // التتبع تستخدمها لو موجودة، وترجع تلقائيًا للنقطة الثابتة القديمة (fallback في maps.js)
    // لو مش موجودة - صفر بيانات مُخترعة، وصفر كسر لأي متجر حالي.
    let storeLat = null, storeLng = null;
    try {
      const storeSnap = await getDoc(doc(db, 'stores', orderStoreId));
      const sd = storeSnap.exists() ? storeSnap.data() : null;
      if (sd && typeof sd.lat === 'number' && typeof sd.lng === 'number') { storeLat = sd.lat; storeLng = sd.lng; }
    } catch (e) { /* Best-effort - فشل قراءة إحداثيات المتجر مايوقفش إنشاء الطلب */ }

    const now = Date.now();
    // جديد (حماية رقم العميل - Option B): customerPhone متسابش هنا وقت الإنشاء خالص.
    // بيتحط جوه الطلب بس لحظة تعيين المندوب فعليًا - راجع acceptOrderAsDriver تحت.
    const ref = await addDoc(collection(db, 'orders'), {
      customerId: window.CU.uid, customerName: window.CUD?.name || 'عميل',
      storeId: orderStoreId, storeName: orderStoreName,
      items: window.cart.map(c => ({ id: c.id, name: c.name, price: c.price, qty: c.qty })),
      total, commission: comm, driverFee: fee,
      pricingSnapshot,
      status: ORDER_STATUS.WAITING_MERCHANT, driverId: null, driverName: null,
      pickupLocation,
      // للتوافق مع الكود القديم اللي بيقرأ customerLat/Lng مباشرة (خرائط التتبع مثلاً)
      customerLat: window.userLat, customerLng: window.userLng,
      // جديد (Sprint 3.7): null لحد ما المتاجر تتجهز بإحداثيات حقيقية - راجع الشرح فوق
      storeLat, storeLng,
      statusHistory: [
        { from: null, to: ORDER_STATUS.CREATED, at: now, by: { type: 'customer', uid: window.CU.uid } },
        { from: ORDER_STATUS.CREATED, to: ORDER_STATUS.WAITING_MERCHANT, at: now, by: 'system' },
      ],
      createdAt: serverTimestamp(),
    });
    window.cart = []; updateCartUI();
    showToast('✅ تم إرسال طلبك بنجاح!', 'ok');
    const newPts = (window.CUD?.points || 0) + Math.floor(total / 10);
    await updateDoc(doc(db, 'users', window.CU.uid), { points: newPts });
    window.CUD = { ...window.CUD, points: newPts };
    showScreen('screen-customer');
    custNav('orders', document.querySelectorAll('#screen-customer .nav-item')[1]);
    createNotification(orderStoreId, '🆕 طلب جديد', `طلب جديد من ${window.CUD?.name || 'عميل'} بقيمة ${total} ج`, 'or', ref.id, 'order_created_merchant');
    createNotification(window.CU.uid, '✅ تم استقبال طلبك!', 'بانتظار موافقة المتجر على طلبك', 'or', ref.id, 'order_created_customer');
    setTimeout(() => openTrack(ref.id), 1500);
  } catch (e) {
    if (e?.code === 'permission-denied') showToast('حسابك موقوف حاليًا، تواصل مع الدعم', 'err');
    else showToast('حدث خطأ، حاول مرة أخرى', 'err');
    console.log(e);
  }
}


// =====================================================================================
// ORDER TRACKING
// =====================================================================================
export let trackUnsub = null;
// جديد (Map Professionalization Sprint): initTrackMap(o) كانت بتتنادى في كل مرة الـ Listener
// يستقبل أي تحديث للطلب (حتى لو التحديث مالوش علاقة بالخريطة، زي statusHistory أو total) -
// يعني إعادة إنشاء الخريطة بالكامل (map.remove() + إعادة بناء) + دلوقتي كمان طلب Routing جديد
// (OSRM) - في كل نبضة Firestore. بنحتفظ هنا بآخر orderId/driverId عملنا عليهم init فعليًا،
// ومنعيدش الـ init إلا لو الطلب اتغير فعلًا أو المندوب اتعيّن/اتغيّر (المسار والمتجر والعميل
// ثابتين، فمفيش داعي لإعادة الحساب لمجرد تحديث حالة أو إجمالي).
let _trackMapFor = { orderId: null, driverId: undefined, phase: undefined };
export function openTrack(ordId) {
  showScreen('screen-track');
  if (trackUnsub) { try { trackUnsub(); } catch (e) {} trackUnsub = null; }
  document.getElementById('track-order-id').textContent = '#' + ordId.slice(-6).toUpperCase();
  trackUnsub = onSnapshot(doc(db, 'orders', ordId), snap => {
    if (!snap.exists()) return;
    const o = { ...snap.data(), id: snap.id };
    window._currentTrackOrd = o;
    const status = normalizeStatus(o.status || 'waiting_merchant');
    document.getElementById('track-driver').textContent = o.driverName || 'بانتظار المندوب...'; // textContent آمنة أصلاً ومش محتاجة esc()
    // جديد (Map Professionalization Sprint): كان في نص ثابت "15-25 دقيقة" لكل الطلبات هنا -
    // اتشال. initTrackMap() في maps.js دلوقتي هي المسؤولة عن حساب/عرض وقت التوصيل الحقيقي
    // (ومسافة حقيقية كمان) لأنها هي اللي عندها بيانات المسار الفعلي (متجر->عميل).
    document.getElementById('track-total').textContent = (o.total || 0) + ' ج';

    // بيانات اتصال المندوب — تظهر فقط بعد تعيين مندوب فعليًا (driver_assigned فأعلى)، عشان
    // العميل ميشوفش رقم أي حد قبل ما يتأكد فعليًا مين اللي هيوصله الطلب.
    const contactBox = document.getElementById('track-driver-contact');
    if (contactBox) {
      const driverAssigned = !!o.driverId && status !== ORDER_STATUS.SEARCHING_DRIVER && status !== ORDER_STATUS.WAITING_MERCHANT && status !== ORDER_STATUS.MERCHANT_ACCEPTED;
      if (driverAssigned && o.driverPhone) {
        contactBox.style.display = 'flex';
        contactBox.innerHTML = `<button class="ha-btn ha-call" onclick="callStore('${esc(o.driverPhone)}')">📞 اتصل بالمندوب</button><button class="ha-btn ha-wa" onclick="openWA('${esc(o.driverPhone)}','${esc(o.driverName||'المندوب')}')">💬 واتساب</button>`;
      } else {
        contactBox.style.display = 'none';
        contactBox.innerHTML = '';
      }
    }

    // Timeline
    if (status === ORDER_STATUS.CANCELLED || status === ORDER_STATUS.MERCHANT_REJECTED) {
      const isRejected = status === ORDER_STATUS.MERCHANT_REJECTED;
      document.getElementById('track-timeline').innerHTML =
        `<div class="tt-item"><div class="tt-left"><div class="tt-dot" style="background:var(--danger);color:#fff">❌</div></div>
          <div class="tt-right"><strong style="color:var(--danger)">${isRejected ? 'تم رفض الطلب من المتجر' : 'تم إلغاء الطلب'}</strong><small>يمكنك التواصل مع المتجر لمعرفة السبب</small></div></div>`;
    } else {
      const si = NEW_STEPS.indexOf(status);
      let tHtml = '';
      NEW_STEPS.forEach((s, i) => {
        const done = i < si;
        const active = i === si;
        tHtml += `<div class="tt-item"><div class="tt-left"><div class="tt-dot ${done ? 'done' : ''} ${active ? 'active' : ''}">${NEW_STEP_ICONS[i]}</div>${i < NEW_STEPS.length - 1 ? `<div class="tt-line ${done ? 'done' : ''}"></div>` : ''}</div><div class="tt-right"><strong>${NEW_STEP_LABELS[i]}</strong><small>${SL[s]}</small>${active ? '<span class="tt-time">الحالة الحالية</span>' : ''}${done ? '<span class="tt-time" style="color:var(--ok)">✓ مكتمل</span>' : ''}</div></div>`;
      });
      document.getElementById('track-timeline').innerHTML = tHtml;
    }
    // Rating section
    document.getElementById('rating-section').style.display = status === ORDER_STATUS.DELIVERED ? 'block' : 'none';
    // زرار إلغاء الطلب - بيظهر بس والحالة لسه ضمن الحالات المسموح فيها للعميل يلغي (راجع
    // custCancelOrder في orders.js) - إخفاء الزرار هنا UX بس، الحماية الحقيقية في Rules.
    const cancelBox = document.getElementById('track-cancel-box');
    if (cancelBox) {
      if (CUSTOMER_CANCELLABLE_STATUSES.includes(status)) {
        cancelBox.style.display = 'block';
        cancelBox.innerHTML = `<button class="btn-p" style="background:var(--danger)" onclick="custCancelOrderUI('${ordId}')">إلغاء الطلب</button>`;
      } else {
        cancelBox.style.display = 'none';
        cancelBox.innerHTML = '';
      }
    }
    // Init map - بس لو أول مرة لنفس الطلب، أو المندوب اتغيّر، أو "مرحلة" الحالة اتغيّرت (قبل/بعد
    // الاستلام - عشان اتجاه المسار يتحدّث فعليًا، راجع trackPhaseKey في maps.js) - مش مع كل تحديث
    const phase = trackPhaseKey(status);
    if (_trackMapFor.orderId !== ordId || _trackMapFor.driverId !== (o.driverId || null) || _trackMapFor.phase !== phase) {
      _trackMapFor = { orderId: ordId, driverId: o.driverId || null, phase };
      initTrackMap(o, status);
    }
  });
}


// ===== SETTINGS LISTENER (العمولة مركزية بدل قيمة ثابتة في المتصفح) =====
export let settingsUnsub = null;
export function listenSettings() {
  if (settingsUnsub) return;
  settingsUnsub = onSnapshot(doc(db, 'settings', 'commission'), snap => {
    if (snap.exists() && typeof snap.data().rate === 'number') window.commRate = snap.data().rate;
  }, () => {});
}


// ===== تصفير أعلام المتابعة عند تسجيل الخروج (بيتنفذ من utils.js عبر clearAllListeners) =====
export function registerOrdersResets() {
  onListenersCleared(() => {
    settingsUnsub = null; trackUnsub = null;
    _trackMapFor = { orderId: null, driverId: undefined, phase: undefined };
  });
}
