// ===== rides.js — Ride Service: Architecture Foundation فقط (Phase 2) =====
// الملف ده مقصود يكون منفصل تمامًا عن orders.js (State Machine مستقلة للمشاوير، زي ما
// اتحدد صراحة)، عشان محدش يحتاج يلمس Delivery State Machine وقت ما Ride Lifecycle يتنفذ لاحقًا.
//
// مهم جدًا: الملف ده تصميم بس. مفيهوش:
// - أي كود بيكتب/يقرأ من Firestore (مفيش collection('rides') ولا addDoc ولا onSnapshot هنا).
// - أي دالة بتنفذ انتقال فعلي أو تربط حالة بطلب/مندوب حقيقي.
// - أي استدعاء من أي شاشة في الواجهة حاليًا (الملف مش متستورد من أي مكان لسه، ده متعمد).
// هيتفعّل ويتربط فعليًا بس وقت ما Ride Lifecycle Phase تبدأ صراحة.

// اسم الـ Collection المستقبلي (تعريف بس، مفيش استخدام فعلي للـ Firestore هنا)
export const RIDES_COLLECTION = 'rides';

// حالات المشوار المقترحة - أبسط من Delivery عمدًا لأن مفيش تاجر في السلسلة خالص
// (مفيش waiting_merchant / merchant_accepted / merchant_rejected)
export const RIDE_STATUS = {
  REQUESTED: 'requested',
  DRIVER_OFFERED: 'driver_offered',
  DRIVER_ASSIGNED: 'driver_assigned',
  DRIVER_ARRIVED: 'driver_arrived',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

// خريطة الانتقالات المسموحة - نفس فلسفة ORDER_TRANSITIONS في orders.js تمامًا (تصميم قابل
// لإعادة الاستخدام)، بس بحالات المشوار. مش متربطة بأي Transaction أو تنفيذ فعلي حاليًا.
export const RIDE_TRANSITIONS = {
  [RIDE_STATUS.REQUESTED]:       [RIDE_STATUS.DRIVER_OFFERED, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.DRIVER_OFFERED]:  [RIDE_STATUS.DRIVER_ASSIGNED, RIDE_STATUS.REQUESTED, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.DRIVER_ASSIGNED]: [RIDE_STATUS.DRIVER_ARRIVED, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.DRIVER_ARRIVED]:  [RIDE_STATUS.IN_PROGRESS, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.IN_PROGRESS]:     [RIDE_STATUS.COMPLETED], // بعد بدء الرحلة، مفيش رجوع أو إلغاء
  [RIDE_STATUS.COMPLETED]:       [], // نهائية
  [RIDE_STATUS.CANCELLED]:       [], // نهائية
};

// دالة تحقق نقية (Pure Function) بس - زي canTransition في orders.js، بدون أي أثر جانبي.
// جاهزة تُستخدم وقت ما transitionRide() فعلية تتكتب في مرحلة Ride Lifecycle.
export function canTransitionRide(fromStatus, toStatus) {
  const allowed = RIDE_TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

// حد أقصى للمسافة (كم) - القيمة من settings/pricing.ride.maxDistanceKm فقط (مفيش رقم Hardcoded).
export function isWithinMaxDistance(distanceKm, pricingRideCfg) {
  const max = Number(pricingRideCfg?.maxDistanceKm);
  if (!max || max <= 0) return true; // لو مش متحدد حد أقصى في الإعدادات، مفيش تقييد
  return Number(distanceKm) <= max;
}

// ===== Phase 3A — Ride Request Creation (تنفيذ فعلي) =====
// كل الكود من هنا لتحت هو أول تنفيذ حقيقي. لسه: صفر Dispatch، صفر Notification للمندوب،
// صفر تغيير حالة بعد الإنشاء. الهدف الوحيد: العميل يحدد نقطتين، يشوف السعر، ويأكد.

import { db, collection, addDoc, getDoc, getDocs, updateDoc, doc, query, where, runTransaction, arrayUnion, serverTimestamp, DEFAULT_LOC } from './firebase.js';
import { showToast, showScreen, RIDE_ELIGIBLE_VEHICLES, onListenersCleared, onSnapshot } from './utils.js';
import { getPricingConfig, calculateFare } from './pricing.js';
import { _distMeters, maybeStopGpsIfIdle } from './driver.js';
import { reverseGeocode } from './routing.js';
import { getRoute } from './routing.js';
import { createMapMarker, initRideStatusMap, updateRideStatusDriverLocation, clearRideStatusMap, invalidateRideStatusRoute,
         setDriverMapRideMode, setDriverMapIdleMode, addAttributionControl, OPENFREEMAP_STYLE } from './maps.js';

// أقصى عدد سائقين مرشحين لكل محاولة Dispatch - القيمة دي معمارية (جزء من التصميم المعتمد)
// مش تسعير، فمكانها هنا صح مش في settings/pricing.
const MAX_CANDIDATE_DRIVERS = 3;
// سقف صريح لطول dispatchLog عشان يفضل محدود (زي ما اتطلب صراحة)
const MAX_DISPATCH_LOG = 20;

function trimLog(log, entry) {
  return [...(Array.isArray(log) ? log : []), entry].slice(-MAX_DISPATCH_LOG);
}

let rrMap = null;
let rrPickup = null;   // {lat,lng}
let rrDropoff = null;  // {lat,lng}
let rrMarkerPickup = null;
let rrMarkerDropoff = null;
let rrVehicleType = null;
let rrPricingSnapshot = null;
let rrDistanceKm = null;
let rrTripEtaMinutes = null;  // Phase 4: ETA المتوقع للمشوار بالكامل، من Routing Engine
let rrRouteGeometry = null;   // Phase 4: Encoded Polyline لمسار الطريق الفعلي

function rrReset() {
  rrPickup = null; rrDropoff = null; rrVehicleType = null;
  rrPricingSnapshot = null; rrDistanceKm = null; rrTripEtaMinutes = null; rrRouteGeometry = null;
  rrMarkerPickup = null; rrMarkerDropoff = null;
  const vSel = document.getElementById('rr-vehicle'); if (vSel) vSel.value = '';
  const priceCard = document.getElementById('rr-price-card'); if (priceCard) priceCard.style.display = 'none';
  const confirmBtn = document.getElementById('rr-confirm-btn'); if (confirmBtn) confirmBtn.disabled = true;
  rrUpdateStepLabel();
}

// شاشة الدخول لطلب مشوار - بتتفتح من زرار في الرئيسية
export function openRideRequest() {
  if (!window.CU) { showScreen('screen-entry'); return; }
  showScreen('screen-ride-request');
  rrReset();
  if (typeof maplibregl === 'undefined') { showToast('تعذر تحميل الخريطة', 'err'); return; }
  if (rrMap) { rrMap.remove(); rrMap = null; }
  // Phase 2 (Controlled Map Fix): كان فيه رقم إحداثيات مكتوب يدويًا هنا ([32.2715, 30.5965])
  // بدل ما يترقّ من DEFAULT_LOC المركزية في firebase.js (نفس القيمة بالظبط، لكن مصدرين
  // منفصلين لنفس الحقيقة). دلوقتي نفس القيمة بترجع من DEFAULT_LOC نفسها (بترتيب [lat,lng]،
  // فبنعكسها هنا [lng,lat] زي ما maplibregl محتاجها بالظبط - نفس التحويل toLngLat() بتعمله
  // في maps.js، بس من غير ما نستورد الدالة نفسها عشان الملف ده يفضل مستقل عن maps.js
  // زي ما كان قبل كده - أقل تعديل ممكن).
  // جديد (P12.1 - GPS Truthy Check): كان "window.userLat && window.userLng" - truthy check
  // عادي بيفشل لو القيمة الفعلية 0 (خط الاستواء/خط غرينتش - نادر لكن ممكن رياضيًا)، ومايرفضش
  // NaN (NaN && NaN تقييمها false برضه بالمصادفة، لكن Infinity && Infinity تبقى true رغم إنها
  // مش إحداثية صالحة). Number.isFinite() هي الفحص الصحيح فعليًا لصلاحية إحداثية GPS.
  const center = Number.isFinite(window.userLat) && Number.isFinite(window.userLng) ? [window.userLng, window.userLat] : [DEFAULT_LOC[1], DEFAULT_LOC[0]];
  rrMap = new maplibregl.Map({ container: 'ride-request-map', style: OPENFREEMAP_STYLE, center, zoom: 15, attributionControl: false });
  addAttributionControl(rrMap); // جديد (P12.1 - Map Attribution): نفس الـ Control الموحّد المستخدم في باقي الخرائط (bottom-left, compact) - الشاشة دي مش بتستخدم addStandardControls أصلًا (مفيش Nav/Scale control ليها قبل كده، ومنضفهمش هنا عشان نفضل مقصورين على الـ Attribution بس)
  rrMap.on('click', rrHandleMapClick);
}

function rrUpdateStepLabel() {
  const lbl = document.getElementById('rr-step-label');
  if (!lbl) return;
  if (!rrPickup) lbl.textContent = 'اضغط على الخريطة لتحديد نقطة الانطلاق';
  else if (!rrDropoff) lbl.textContent = 'اضغط على الخريطة لتحديد نقطة الوصول';
  else lbl.textContent = 'تم تحديد النقطتين - اختر نوع المركبة';
}

function rrHandleMapClick(e) {
  const { lat, lng } = e.lngLat;
  if (!rrPickup) {
    rrPickup = { lat, lng };
    rrMarkerPickup = createMapMarker(rrMap, rrPickup, 'pickup');
  } else if (!rrDropoff) {
    rrDropoff = { lat, lng };
    rrMarkerDropoff = createMapMarker(rrMap, rrDropoff, 'dropoff');
    rrComputePrice(); // النقطتين اتحددوا - نحسب المسافة والسعر فورًا
  }
  rrUpdateStepLabel();
}

// جديد (P11 Phase 2 - Race/Generation Guard): لكل محاولة حساب سعر رقم فريد. الزرار "إعادة
// تحديد" (resetRideRequest) بيسمح للمستخدم يبدأ اختيار نقطتين جديدتين وrrComputePrice() لسه
// شغالة (async - بتستنى Pricing Config + Routing) من المحاولة القديمة - لو ردّت المحاولة
// القديمة بعد الجديدة، كانت هتكتب فوق rrDistanceKm/rrPricingSnapshot/الشاشة ببيانات نقطتين
// مش هما المعروضين على الخريطة دلوقتي (وأخطر حاجة: تفعّل زرار التأكيد بسعر غلط).
let _rrGen = 0;
export function resetRideRequest() {
  _rrGen++; // يُبطل فورًا أي rrComputePrice() لسه مستنية رد قديم من قبل الـ Reset ده
  if (rrMarkerPickup) { rrMarkerPickup.remove(); }
  if (rrMarkerDropoff) { rrMarkerDropoff.remove(); }
  rrReset();
}

// جديد (P10 - Ride Request Picker Map Leak، مؤكد من تقرير P9 ولسه موجود فعليًا في الكود قبل
// الإصلاح ده): زرار "رجوع" في شاشة "اطلب مشوار" (index.html) كان بينادي showScreen() مباشرة -
// نفس فئة الـ Bug اللي كانت في شاشتي تتبع الطلبات/المشاوير (closeTrack/rsCloseStatus)، لكن هنا
// كانت لسه من غير إصلاح. النتيجة: rrMap (خريطة MapLibre + الـ 'click' listener المربوط بيها -
// rrHandleMapClick) كانت بتفضل حيّة في الذاكرة لحد ما المستخدم يفتح شاشة طلب مشوار تانية (بتقفل
// القديمة أوتوماتيك جوه openRideRequest) أو يعمل Logout (registerRidesResets). دلوقتي الزرار
// بينادي rrClose() دي - نفس نمط closeTrack()/rsCloseStatus()/epCloseStatus() الموجود بالفعل
// للشاشات التلاتة التانية، وبتستخدم resetRideRequest() الموجودة بالفعل (بتشيل الـ Markers) بدل
// ما تخترع منطق تنظيف جديد.
export function rrClose() {
  resetRideRequest();
  if (rrMap) { rrMap.remove(); rrMap = null; }
  showScreen('screen-customer');
}

async function rrComputePrice() {
  const myGen = ++_rrGen; // هذه المحاولة - أي كتابة لاحقة لازم تتأكد إنها لسه أحدث محاولة قبل ما تلمس الحالة/الشاشة
  const priceCard = document.getElementById('rr-price-card');
  const confirmBtn = document.getElementById('rr-confirm-btn');
  if (confirmBtn) confirmBtn.disabled = true;

  // ===== فحص محلي رخيص قبل أي طلب شبكة (نفس النقطة بداية ونهاية) — Haversine هنا للفحص
  // السريع بس، مش للتسعير ولا لتخزينه. صفر طلب Routing لو أصلاً النقطتين متطابقتين. =====
  const straightMeters = _distMeters(rrPickup.lat, rrPickup.lng, rrDropoff.lat, rrDropoff.lng);
  if (!straightMeters || straightMeters <= 0 || isNaN(straightMeters) || !isFinite(straightMeters)) {
    showToast('لا يمكن تحديد نفس النقطة كبداية ونهاية', 'err');
    resetRideRequest();
    return;
  }

  // ===== Pricing Integration — بدون أي Default أو رقم Hardcoded =====
  let pricingCfg;
  try {
    pricingCfg = await getPricingConfig();
    if (myGen !== _rrGen) return; // اتبطلت أثناء الانتظار (Reset/محاولة جديدة) - متلمسش الحالة/الشاشة خالص
    if (!pricingCfg.ride) throw new Error('pricing-missing-ride');
  } catch (e) {
    if (myGen !== _rrGen) return; // نفس المبدأ - رد (نجاح أو فشل) من محاولة قديمة متأثرش على أي حاجة حالية
    showToast('خدمة المشاوير غير متاحة حاليًا', 'err');
    console.error('[rides] pricing config missing:', e);
    resetRideRequest();
    return;
  }

  // ===== Actual Road Distance + ETA + Geometry (Phase 4 - Routing Service Layer) =====
  // القرار المعتمد: صفر Haversine في التسعير، وصفر Fallback لو فشل الـ Routing — لو الطلب
  // فشل (شبكة/Timeout/مفيش مسار)، مفيش سعر بيتحسب ومفيش مشوار بيتعمل، بس رسالة واضحة.
  let route;
  try {
    route = await getRoute(rrPickup, rrDropoff);
    if (myGen !== _rrGen) return; // اتبطلت أثناء انتظار الـ Routing
  } catch (e) {
    if (myGen !== _rrGen) return;
    console.error('[rides] routing failed:', e);
    showToast('تعذر حساب مسار الطريق حاليًا، حاول مرة أخرى', 'err');
    resetRideRequest();
    return;
  }

  // ===== Maximum Distance — بيتحقق على المسافة الفعلية للطريق دلوقتي، مش الخط المستقيم =====
  if (!isWithinMaxDistance(route.distanceKm, pricingCfg.ride)) {
    showToast('المسافة خارج نطاق الخدمة', 'err');
    resetRideRequest();
    return;
  }

  const fare = calculateFare(pricingCfg, 'ride', {
    distanceKm: route.distanceKm,
    estimatedDurationMinutes: route.durationMinutes,
  });

  rrDistanceKm = route.distanceKm;
  rrTripEtaMinutes = route.durationMinutes;
  rrRouteGeometry = route.polyline;
  rrPricingSnapshot = fare;
  if (priceCard) {
    document.getElementById('rr-distance-val').textContent = rrDistanceKm + ' كم';
    const etaEl = document.getElementById('rr-eta-val');
    if (etaEl) etaEl.textContent = rrTripEtaMinutes + ' دقيقة';
    document.getElementById('rr-price-val').textContent = fare.finalFare + ' ج';
    priceCard.style.display = 'block';
  }
  rrCheckReady();
}

export function selectRideVehicle(type) {
  rrVehicleType = type;
  rrCheckReady();
}

function rrCheckReady() {
  const confirmBtn = document.getElementById('rr-confirm-btn');
  if (!confirmBtn) return;
  const ok = rrPickup && rrDropoff && rrPricingSnapshot && rrVehicleType && RIDE_ELIGIBLE_VEHICLES.includes(rrVehicleType);
  confirmBtn.disabled = !ok;
}

// ===== إنشاء المشوار الفعلي (المهمة 5+6+8) =====
export async function createRideRequest() {
  if (!window.CU) { showScreen('screen-entry'); return; }
  // إعادة تحقق كاملة قبل الكتابة - مانعتمدش إن الواجهة عطلت الزرار صح بس
  if (!rrPickup || !rrDropoff) { showToast('حدد نقطة الانطلاق والوصول أولاً', 'err'); return; }
  if (!rrVehicleType || !RIDE_ELIGIBLE_VEHICLES.includes(rrVehicleType)) {
    showToast('اختر نوع مركبة صحيح', 'err'); return;
  }
  if (!rrDistanceKm || rrDistanceKm <= 0 || isNaN(rrDistanceKm) || !isFinite(rrDistanceKm)) {
    showToast('المسافة غير صالحة، أعد التحديد', 'err'); return;
  }
  if (!rrPricingSnapshot) { showToast('السعر غير محسوب، أعد التحديد', 'err'); return; }
  // Phase 4: نفس فلسفة rrPricingSnapshot فوق - لو المسار (Geometry/ETA) مش موجود لأي سبب،
  // مانكملش، لأن القرار المعتمد إن Road Distance/ETA/Geometry لازم تكون موجودة قبل إنشاء أي Ride.
  if (!rrRouteGeometry || rrTripEtaMinutes == null) {
    showToast('بيانات المسار غير مكتملة، أعد التحديد', 'err'); return;
  }

  const btn = document.getElementById('rr-confirm-btn');
  if (btn) btn.disabled = true;
  try {
    const [pGeo, dGeo] = await Promise.all([
      reverseGeocode(rrPickup.lat, rrPickup.lng),
      reverseGeocode(rrDropoff.lat, rrDropoff.lng),
    ]);
    const rideDoc = {
      customerId: window.CU.uid,
      pickup: { lat: rrPickup.lat, lng: rrPickup.lng, address: pGeo.address || null },
      dropoff: { lat: rrDropoff.lat, lng: rrDropoff.lng, address: dGeo.address || null },
      vehicleType: rrVehicleType,
      status: RIDE_STATUS.REQUESTED,
      driverId: null, // Phase 3B: لازم يكون موجود من الإنشاء عشان قواعد Dispatch تتحقق منه
      distanceKm: rrDistanceKm, // Actual Road Distance (Phase 4 - Routing Service Layer، مش Haversine)
      tripEtaMinutes: rrTripEtaMinutes, // Trip ETA - الوقت المتوقع للمشوار بالكامل
      routeGeometry: rrRouteGeometry,   // Encoded Polyline لمسار الطريق - Immutable بعد الإنشاء
      routingProvider: 'osrm-public-demo', // للتوثيق/التتبع فقط - نفس القيمة اللي routing.js بترجعها
      pricingSnapshot: rrPricingSnapshot,
      createdAt: serverTimestamp(),
    };
    const rideRef = await addDoc(collection(db, RIDES_COLLECTION), rideDoc);
    resetRideRequest();
    rsShowStatus(rideRef.id, RIDE_STATUS.REQUESTED);
    showScreen('screen-ride-status');
    dispatchRide(rideRef.id); // فور الإنشاء - نفس Client، صفر Orchestrator منفصل (زي التصميم المعتمد)
  } catch (e) {
    console.error('[createRideRequest] failed:', e);
    showToast('حدث خطأ أثناء إنشاء الطلب، حاول مرة أخرى', 'err');
    if (btn) btn.disabled = false;
  }
}
// TECH DEBT (مسجل صراحة زي ما اتطلب): السعر النهائي هنا بيتحقق منه Client-side بس عن طريق
// previewFare(). Server-side expectedFare validation لمشاوير (مكافئ calculatePrice في
// firestore.rules الموجودة للتوصيل) لسه ملقتش تنفيذها في Phase 3A ده - محتاجة إضافة قبل أي
// تفعيل حقيقي لـ Dispatch/Finance، تمامًا زي ما orders.js بيعمل بالفعل.
// Future Improvement: Ride pricing validation requires server-side verification before production dispatch.
// ملاحظة: الفجوة دي اتقفلت فعليًا في Phase 3A Security Hardening (rideFareOk/rideDistanceOk
// في firestore.rules) - التعليق فوق اتسيب زي ما هو كسجل تاريخي بس.

// ===== Phase 3B — Driver Dispatch (Ranked Limited Broadcast) =====
// التصميم المعتمد: أقرب 3 سائقين مؤهلين بس، بث ليهم سويًا، أول Accept ناجح بـ Transaction يفوز.
// صفر Timeout، صفر Background Service، صفر Cloud Function - العميل نفسه (لسه حاضر فعليًا وقت
// الإنشاء) هو اللي بيبدأ أول محاولة Dispatch، وأي رجوع لـ requested بعد رفض الكل بيتم من نفس
// Client السائق اللي رفض آخر رفض (حاضر فعليًا وقتها هو كمان) - صفر حاجة محتاجة "تراقب" وقت.

export async function dispatchRide(rideId) {
  const rideRef = doc(db, RIDES_COLLECTION, rideId);
  const rideSnap = await getDoc(rideRef);
  if (!rideSnap.exists()) return;
  const ride = rideSnap.data();
  if (ride.status !== RIDE_STATUS.REQUESTED) return; // مش وقتها - حد تاني سبقنا أو الحالة اتغيرت

  // ===== Driver Selection (المهمة 2) — Query بسيط بدون vehicleType (مفيش فهرسة زيادة)،
  // فلترة النوع + الترتيب بالمسافة بيحصلوا Client-side =====
  // ملحوظة معمارية صريحة (Phase 4): الترتيب هنا بيستخدم Haversine (_distMeters) عمدًا،
  // مش Actual Road Distance. القرار المعتمد: Routing Provider (routing.js) يُستخدم للتسعير
  // والـ ETA بس (راجع rrComputePrice فوق) — مش لترتيب السائقين، لأن حساب مسار فعلي لكل
  // سائق مرشح في كل محاولة Dispatch هيبقى عدد كبير من طلبات Routing بدون فائدة تشغيلية
  // حقيقية تستاهل التكلفة. Driver Dispatch نفسه غير معدّل في هذه المرحلة زي ما اتحدد صراحة.
  const q = query(collection(db, 'users'),
    where('role', '==', 'driver'),
    where('status', '==', 'active'),
    where('isOnline', '==', true),
    where('activeRideId', '==', null), where('activeOrderId', '==', null), where('activeExternalPurchaseId', '==', null));
  const snap = await getDocs(q);

  const candidates = [];
  snap.forEach(d => {
    const u = d.data();
    if (!RIDE_ELIGIBLE_VEHICLES.includes(u.vehicleType)) return;
    if (typeof u.lat !== 'number' || typeof u.lng !== 'number') return; // مفيش موقع = مينفعش نرتبه بالمسافة
    const distM = _distMeters(ride.pickup.lat, ride.pickup.lng, u.lat, u.lng);
    candidates.push({ id: d.id, distM });
  });
  candidates.sort((a, b) => a.distM - b.distM);
  const top3 = candidates.slice(0, MAX_CANDIDATE_DRIVERS).map(c => c.id);

  if (top3.length === 0) {
    // لا يوجد سائقين مناسبين - الحالة تفضل requested زي ما هي (المهمة 3)
    rsSetLabel('لا يوجد سائقين متاحين حاليًا');
    rsShowRetry(true);
    return;
  }

  await updateDoc(rideRef, {
    status: RIDE_STATUS.DRIVER_OFFERED,
    candidateDriverIds: top3,
    rejectedDriverIds: [],
    offeredAt: serverTimestamp(),
    dispatchLog: trimLog(ride.dispatchLog, { event: 'dispatch_started', at: Date.now(), candidateCount: top3.length }),
  });
}

// إعادة محاولة يدوية من شاشة حالة المشوار - Recovery بسيط بدون أي Timer (المهمة 8)
export function retryDispatch() {
  if (!rsCurrentRideId) return;
  rsShowRetry(false);
  rsSetLabel('جاري البحث عن سائق...');
  dispatchRide(rsCurrentRideId);
}

// ===== Driver Accept (المهمة 5) — Transaction إلزامية =====
export async function acceptRideOffer() {
  if (!window.CU || !window.currentRideOfferId) return;
  const rideId = window.currentRideOfferId;
  const rideRef = doc(db, RIDES_COLLECTION, rideId);
  const driverRef = doc(db, 'users', window.CU.uid);

  // ===== Pickup ETA (Phase 4) — بيتحسب مرة واحدة قبل الـ Transaction، مش جواها، عشان مانديش
  // طلب Routing متكرر مع أي إعادة محاولة تحصل للـ Transaction نفسها لو فيه Contention. لو فشل
  // حساب الـ ETA (شبكة/مفيش موقع حالي للسائق)، القبول نفسه بيكمل عادي (Best-effort - زي فلسفة
  // GPS/notifications في باقي المشروع) لأن غياب رقم تقديري مش المفروض يمنع قبول مشوار حقيقي.
  let pickupEtaMinutes = null;
  try {
    const preSnap = await getDoc(rideRef);
    const preRide = preSnap.data();
    const driverLat = window.driverLat, driverLng = window.driverLng;
    if (preRide?.pickup && typeof driverLat === 'number' && typeof driverLng === 'number') {
      const pickupRoute = await getRoute({ lat: driverLat, lng: driverLng }, preRide.pickup);
      pickupEtaMinutes = pickupRoute.durationMinutes;
    }
  } catch (e) {
    console.error('[acceptRideOffer] pickup ETA calculation failed (non-fatal):', e);
  }

  try {
    await runTransaction(db, async (t) => {
      const [rideSnap, driverSnap] = await Promise.all([t.get(rideRef), t.get(driverRef)]);
      const ride = rideSnap.data();
      const drv = driverSnap.data();
      if (!ride || ride.status !== RIDE_STATUS.DRIVER_OFFERED) throw new Error('ride-not-offered');
      if (ride.driverId) throw new Error('already-assigned');
      if (!Array.isArray(ride.candidateDriverIds) || !ride.candidateDriverIds.includes(window.CU.uid)) throw new Error('not-a-candidate');
      if (!drv || drv.status !== 'active' || drv.isOnline !== true || drv.activeRideId || drv.activeOrderId || drv.activeExternalPurchaseId) throw new Error('driver-not-eligible');
      const updatePayload = {
        driverId: window.CU.uid,
        status: RIDE_STATUS.DRIVER_ASSIGNED,
        dispatchLog: trimLog(ride.dispatchLog, { event: 'driver_accepted', driverId: window.CU.uid, at: Date.now() }),
      };
      // Pickup ETA (Trip ETA للوصول لنقطة الالتقاط) - حقل إضافي بس، مش من ضمن rideCoreUnchanged()
      // في firestore.rules، فإضافته هنا متوافقة مع القواعد الحالية بدون أي تعديل عليها.
      if (pickupEtaMinutes != null) updatePayload.pickupEtaMinutes = pickupEtaMinutes;
      t.update(rideRef, updatePayload);
      t.update(driverRef, { activeRideId: rideId });
    });
    showToast('تم قبول المشوار', 'ok');
    hideRideOfferBanner();
    watchDriverActiveRide(rideId); // Phase 4B: يبدأ يتابع نفس المشوار فورًا (بانل + خريطة المندوب)
  } catch (e) {
    console.error('[acceptRideOffer] failed:', e);
    showToast('تعذر قبول المشوار (ربما اتاخد بالفعل)', 'err');
    hideRideOfferBanner();
  }
}

// ===== Driver Reject (المهمة 6) — Transaction برضه (منع Race بين رفضين في نفس اللحظة) =====
export async function rejectRideOffer() {
  if (!window.CU || !window.currentRideOfferId) return;
  const rideId = window.currentRideOfferId;
  const rideRef = doc(db, RIDES_COLLECTION, rideId);
  try {
    await runTransaction(db, async (t) => {
      const rideSnap = await t.get(rideRef);
      const ride = rideSnap.data();
      if (!ride || ride.status !== RIDE_STATUS.DRIVER_OFFERED) throw new Error('ride-not-offered');
      if (!Array.isArray(ride.candidateDriverIds) || !ride.candidateDriverIds.includes(window.CU.uid)) throw new Error('not-a-candidate');
      const already = Array.isArray(ride.rejectedDriverIds) ? ride.rejectedDriverIds : [];
      if (already.includes(window.CU.uid)) return; // رفض مسبقًا - لا حاجة لتكرار
      const newRejected = [...already, window.CU.uid];
      const log = trimLog(ride.dispatchLog, { event: 'driver_rejected', driverId: window.CU.uid, at: Date.now() });
      if (newRejected.length >= ride.candidateDriverIds.length) {
        // كل المرشحين رفضوا - رجوع لـ requested (المهمة 6)
        t.update(rideRef, { status: RIDE_STATUS.REQUESTED, candidateDriverIds: [], rejectedDriverIds: [], dispatchLog: log });
      } else {
        t.update(rideRef, { rejectedDriverIds: newRejected, dispatchLog: log });
      }
    });
  } catch (e) {
    console.error('[rejectRideOffer] failed:', e);
  }
  hideRideOfferBanner();
}

function hideRideOfferBanner() {
  window.currentRideOfferId = null;
  const b = document.getElementById('ride-offer-banner');
  if (b) b.style.display = 'none';
}

// =====================================================================================
// ===== Phase 4B — Ride Lifecycle Continuation (driver_assigned -> driver_arrived ->
// in_progress -> completed) =====
// نفس فلسفة acceptRideOffer/rejectRideOffer تمامًا: Transaction إلزامية، تحقق من إن اللي
// بينفذ هو المندوب المعيّن فعليًا على نفس المشوار وإن الحالة الحالية صح، وrideCoreUnchanged()
// (في firestore.rules) بيمنع أي لمس لبيانات الطلب/السعر مهما كان. صفر حقول إضافية هنا -
// بس status. تفريغ activeRideId بيتم بس عند completed (زي activeOrderId في orders.js تمامًا).
// =====================================================================================
async function transitionRideStep(fromStatus, toStatus, clearActiveRideId = false) {
  if (!window.CU) return;
  const rideId = activeRideId; // نفس المشوار اللي البانل بيتابعه حاليًا
  if (!rideId) return;
  const rideRef = doc(db, RIDES_COLLECTION, rideId);
  const driverRef = doc(db, 'users', window.CU.uid);
  try {
    await runTransaction(db, async (t) => {
      const rideSnap = await t.get(rideRef);
      const ride = rideSnap.data();
      if (!ride || ride.driverId !== window.CU.uid) throw new Error('not-your-ride');
      if (!canTransitionRide(ride.status, toStatus) || ride.status !== fromStatus) throw new Error('invalid-transition');
      t.update(rideRef, { status: toStatus });
      if (clearActiveRideId) t.update(driverRef, { activeRideId: null });
    });
  } catch (e) {
    console.error(`[transitionRideStep ${fromStatus}->${toStatus}] failed:`, e);
    showToast('تعذر تنفيذ الخطوة، حاول مرة أخرى', 'err');
  }
}
export function driverArrivedAtPickup() { return transitionRideStep(RIDE_STATUS.DRIVER_ASSIGNED, RIDE_STATUS.DRIVER_ARRIVED); }
export function driverStartTrip() { return transitionRideStep(RIDE_STATUS.DRIVER_ARRIVED, RIDE_STATUS.IN_PROGRESS); }
export function driverCompleteTrip() { return transitionRideStep(RIDE_STATUS.IN_PROGRESS, RIDE_STATUS.COMPLETED, true); }

// زرار واحد بس في البانل، فعله بيتغيّر حسب الحالة الحالية (زي ما اتطلب صراحة - Active Ride
// Panel بسيط، مش Dashboard، وأزرار الانتقالات المحددة بس)
export async function handleDriverRideAction() {
  const btn = document.getElementById('dar-action-btn');
  if (btn) btn.disabled = true;
  try {
    if (activeRideStatus === RIDE_STATUS.DRIVER_ASSIGNED) await driverArrivedAtPickup();
    else if (activeRideStatus === RIDE_STATUS.DRIVER_ARRIVED) await driverStartTrip();
    else if (activeRideStatus === RIDE_STATUS.IN_PROGRESS) await driverCompleteTrip();
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ===== Live Driver Location (Phase 4B - البند المؤجل) =====
// بتتنده من driver.js من جوه نفس نبضة GPS المتحكم فيها بالفعل (10 ثواني/30 متر) - صفر
// كتابات إضافية، بس كتابة تانية (rides/{rideId}) بتتضاف لنفس النبضة، وبس لما يكون فيه مشوار
// جاري في إحدى الحالات التلاتة دي (مش وقت Online بس، زي ما اتحدد صراحة).
const LOCATION_UPDATE_STATUSES = [RIDE_STATUS.DRIVER_ASSIGNED, RIDE_STATUS.DRIVER_ARRIVED, RIDE_STATUS.IN_PROGRESS];
export function updateDriverLocationForActiveRide(lat, lng) {
  if (!activeRideId || !LOCATION_UPDATE_STATUSES.includes(activeRideStatus)) return;
  updateDoc(doc(db, RIDES_COLLECTION, activeRideId), {
    driverLocation: { lat, lng, updatedAt: serverTimestamp() },
  }).catch(() => {});
}

// ===== Driver Active Ride Panel (Phase 4B) =====
let activeRideId = null;
let activeRideStatus = null;
let darUnsub = null;

// جديد (Maps & Tracking Hardening - P0 GPS Lifecycle): بيستخدمها driver.js (maybeStopGpsIfIdle)
// عشان يقرر هل المندوب لسه عنده مشوار جاري وقت ما يحاول يوقف GPS بعد ما يعمل Offline - لو
// عنده مشوار جاري، GPS لازم يفضل شغال (التتبع لسه مطلوب) حتى لو حط نفسه Offline.
export function isDriverRideActive() { return !!activeRideId; }
const DAR_ACTION_LABELS = {
  [RIDE_STATUS.DRIVER_ASSIGNED]: 'وصلت لنقطة الانطلاق',
  [RIDE_STATUS.DRIVER_ARRIVED]: 'ابدأ الرحلة',
  [RIDE_STATUS.IN_PROGRESS]: 'أنهِ الرحلة',
};

// بتتنده من driver.js عند فتح شاشة المندوب (تعالج حالة الرجوع للتطبيق ولسه فيه مشوار جاري)
export function initDriverActiveRideListener() {
  if (darUnsub || !window.CU) return;
  const rideId = window.CUD?.activeRideId;
  if (rideId) watchDriverActiveRide(rideId);
}

function watchDriverActiveRide(rideId) {
  if (darUnsub) { darUnsub(); darUnsub = null; }
  activeRideId = rideId;
  darUnsub = onSnapshot(doc(db, RIDES_COLLECTION, rideId), snap => {
    if (!snap.exists()) { stopDriverActiveRide(); return; }
    const d = snap.data();
    if (![RIDE_STATUS.DRIVER_ASSIGNED, RIDE_STATUS.DRIVER_ARRIVED, RIDE_STATUS.IN_PROGRESS].includes(d.status)) {
      stopDriverActiveRide();
      return;
    }
    activeRideStatus = d.status;
    renderDriverActiveRidePanel(d);
    setDriverMapRideMode(d);
  });
}

function stopDriverActiveRide() {
  if (darUnsub) { darUnsub(); darUnsub = null; }
  const finishedRideId = activeRideId; // نحتفظ بالـ id قبل ما نصفّره تحت - لازم للـ Self-Heal تحت
  activeRideId = null; activeRideStatus = null;
  const panel = document.getElementById('dar-panel');
  if (panel) panel.style.display = 'none';
  setDriverMapIdleMode(); // Driver Map يرجع تلقائيًا للوضع الطبيعي (زي ما اتطلب صراحة)
  // جديد (P0 GPS Lifecycle): المشوار خلص (completed/cancelled/doc اتشال) - لو المندوب حاطط
  // نفسه Offline بالفعل ومفيش عنده طلب توصيل جاري كمان، مفيش داعي GPS يفضل شغال بعد كده.
  maybeStopGpsIfIdle();
  // جديد (P10 - activeRideId Bug، نفس فئة activeOrderId المُصلحة في driver.js بالحرف):
  // transitionRideStep() (فوق) بتفضّي users/{uid}.activeRideId في Firestore بس لما المندوب
  // نفسه يعمل driverCompleteTrip() (completed). لو المشوار خلص بأي طريقة تانية - وصل هنا
  // (stopDriverActiveRide) لأن snap.exists() بقت false أو status بقى مش من الحالات النشطة - من
  // غير الإصلاح ده، activeRideId في Firestore كان هيفضل يشاور على مشوار منتهي للأبد، ويمنع
  // المندوب (busy check) من قبول أي طلب/مشوار/مشترى خارجي تاني للأبد. الـ Self-Heal ذاتي تمامًا
  // (المندوب بيعدّل مستنده الشخصي هو بس - مسموح بالفعل بالـ Rules الحالية بدون أي تعديل)، وبيتأكد
  // إن activeRideId لسه بيشاور فعليًا على نفس المشوار ده بالظبط قبل ما يفضّيه (لو اتقبل مشوار
  // تاني قبل ما نوصل هنا، مبيتلمسش خالص) - نفس ضمانات _healActiveOrderIdIfCancelled بالحرف.
  if (finishedRideId && window.CU) {
    const uRef = doc(db, 'users', window.CU.uid);
    runTransaction(db, async (t) => {
      const uSnap = await t.get(uRef);
      if (uSnap.data()?.activeRideId === finishedRideId) t.update(uRef, { activeRideId: null });
    }).catch(() => {});
  }
}

function renderDriverActiveRidePanel(d) {
  const panel = document.getElementById('dar-panel');
  if (!panel) return;
  panel.style.display = 'block';
  const statusLbl = document.getElementById('dar-status-label');
  if (statusLbl) statusLbl.textContent = RS_LABELS_FOR_DRIVER[d.status] || d.status;
  const pickupEl = document.getElementById('dar-pickup-val');
  if (pickupEl) pickupEl.textContent = d.pickup?.address || 'محدد على الخريطة';
  const dropoffEl = document.getElementById('dar-dropoff-val');
  if (dropoffEl) dropoffEl.textContent = d.dropoff?.address || 'محدد على الخريطة';
  const tripEtaEl = document.getElementById('dar-trip-eta-val');
  if (tripEtaEl) tripEtaEl.textContent = (typeof d.tripEtaMinutes === 'number') ? d.tripEtaMinutes + ' دقيقة' : '--';
  const pickupEtaRow = document.getElementById('dar-pickup-eta-row');
  const pickupEtaEl = document.getElementById('dar-pickup-eta-val');
  if (pickupEtaRow && pickupEtaEl) {
    if (typeof d.pickupEtaMinutes === 'number' && d.status === RIDE_STATUS.DRIVER_ASSIGNED) {
      pickupEtaEl.textContent = d.pickupEtaMinutes + ' دقيقة';
      pickupEtaRow.style.display = 'flex';
    } else {
      pickupEtaRow.style.display = 'none';
    }
  }
  const btn = document.getElementById('dar-action-btn');
  if (btn) btn.textContent = DAR_ACTION_LABELS[d.status] || '--';
}
const RS_LABELS_FOR_DRIVER = {
  [RIDE_STATUS.DRIVER_ASSIGNED]: 'توجّه لنقطة الانطلاق',
  [RIDE_STATUS.DRIVER_ARRIVED]: 'وصلت - في انتظار العميل',
  [RIDE_STATUS.IN_PROGRESS]: 'الرحلة جارية 🛣️',
};

// ===== Driver Listener (المهمة 7) — السائق يشوف بس العروض الموجهة له بالاسم =====
let driverOfferUnsub = null;
export function listenRideOffers() {
  if (driverOfferUnsub || !window.CU) return;
  const q = query(collection(db, RIDES_COLLECTION),
    where('candidateDriverIds', 'array-contains', window.CU.uid),
    where('status', '==', RIDE_STATUS.DRIVER_OFFERED));
  driverOfferUnsub = onSnapshot(q, snap => {
    const offer = snap.docs[0]; // نظريًا سائق ممكن يكون مرشح لأكتر من طلب - بناخد أول واحد بس
    const banner = document.getElementById('ride-offer-banner');
    if (!banner) return;
    if (offer) {
      window.currentRideOfferId = offer.id;
      const d = offer.data();
      document.getElementById('ride-offer-txt').textContent =
        (d.distanceKm ? d.distanceKm + ' كم - ' : '') +
        (d.tripEtaMinutes ? '~' + d.tripEtaMinutes + ' د - ' : '') +
        (d.pricingSnapshot?.finalFare ? d.pricingSnapshot.finalFare + ' ج' : '');
      banner.style.display = 'flex';
    } else {
      hideRideOfferBanner();
    }
  });
}

// ===== Customer Status Screen (Recovery فقط - بدون خريطة/تتبع حي) =====
let rsCurrentRideId = null;
let rsUnsub = null;
const RS_LABELS = {
  [RIDE_STATUS.REQUESTED]: 'جاري البحث عن سائق...',
  [RIDE_STATUS.DRIVER_OFFERED]: 'تم إرسال العرض لأقرب السائقين، في انتظار الرد',
  [RIDE_STATUS.DRIVER_ASSIGNED]: 'تم تعيين مندوب لك ✅',
  [RIDE_STATUS.DRIVER_ARRIVED]: 'المندوب وصل لنقطة الانطلاق 📍',
  [RIDE_STATUS.IN_PROGRESS]: 'الرحلة جارية 🛣️',
  [RIDE_STATUS.COMPLETED]: 'تم الوصول ✅',
  [RIDE_STATUS.CANCELLED]: 'تم إلغاء المشوار',
};
function rsSetLabel(text) {
  const el = document.getElementById('rs-status-label');
  if (el) el.textContent = text;
}
function rsShowRetry(show) {
  const btn = document.getElementById('rs-retry-btn');
  if (btn) btn.style.display = show ? 'block' : 'none';
}
// Phase 4B: هل خريطة حالة المشوار اتبنت فعلاً لنفس المحاولة الحالية؟ (تُبنى مرة واحدة بس،
// بعد كده كل Snapshot جديد بيحرّك نقطة المندوب بس - مش بيعيد بناء الخريطة كل تحديث)
let rsMapInitialized = false;
// جديد (P9 - Final Hardening، نفس الـ Bug اللي كان في زرار "رجوع للرئيسية" في شاشة تتبع
// الطلبات - راجع closeTrack() في orders.js لنفس الشرح بالتفصيل): زرار الرجوع في شاشة حالة
// المشوار (screen-ride-status) كان بينادي showScreen() مباشرة من غير ما يقفل rsUnsub
// (Firestore Listener على rides/{rideId}) ولا rsMap (خريطة MapLibre) - نفس فئة التسريب
// بالظبط. epCloseStatus() في external.js كانت فعلاً عاملة نفس الحاجة دي لـ External Purchase
// (زرار "شاشة حالة طلب الشراء" بينادي epCloseStatus() قبل showScreen())، فده مجرد توحيد نفس
// النمط الموجود بالفعل على الشاشة التالتة اللي كانت ناقصاه.
export function rsCloseStatus() {
  if (rsUnsub) { rsUnsub(); rsUnsub = null; }
  rsCurrentRideId = null; rsMapInitialized = false;
  clearRideStatusMap();
}
function rsSetMapVisible(show) {
  const wrap = document.getElementById('rs-map-wrap');
  if (wrap) wrap.style.display = show ? 'block' : 'none';
}
function rsSetInfoVisible(show) {
  const card = document.getElementById('rs-info-card');
  if (card) card.style.display = show ? 'block' : 'none';
}
// عرض Trip ETA دايمًا (موجودة من وقت إنشاء المشوار)، وPickup ETA بس وقت ما تكون محسوبة
// ومعقولة (بعد تعيين مندوب، وقبل ما يوصل فعليًا) - نفس الحقلين المخزّنين زي ما هما بدون تغيير اسم.
function rsUpdateEta(d) {
  rsSetInfoVisible(true);
  const tripEl = document.getElementById('rs-trip-eta-val');
  if (tripEl) tripEl.textContent = (typeof d.tripEtaMinutes === 'number') ? d.tripEtaMinutes + ' دقيقة' : '--';
  const pickupRow = document.getElementById('rs-pickup-eta-row');
  const pickupEl = document.getElementById('rs-pickup-eta-val');
  if (!pickupRow || !pickupEl) return;
  if (typeof d.pickupEtaMinutes === 'number' && [RIDE_STATUS.DRIVER_ASSIGNED, RIDE_STATUS.DRIVER_ARRIVED].includes(d.status)) {
    pickupEl.textContent = d.pickupEtaMinutes + ' دقيقة';
    pickupRow.style.display = 'flex';
  } else {
    pickupRow.style.display = 'none';
  }
}
// الخريطة بتتبنى أول مرة يكون فيها Pickup (يعني من أول تحديث، لأنها موجودة من وقت الإنشاء)،
// وبعد كده كل تحديث بيحرّك نقطة المندوب بس (driverLocation - Phase 4B، مش users/{driverId}).
function rsUpdateMap(d) {
  if (!d.pickup) return;
  // جديد (P9 - Final Hardening، Terminal State Resurrection): نفس فلسفة updateTrackDriverLocation
  // في maps.js بالظبط (خريطة تتبع الطلبات) - لو المشوار وصل لحالة نهائية (تم/اتلغى)، منمنعش أي
  // تحديث حي على ماركر المندوب خالص، حتى لو نبضة GPS متأخرة وصلت بموقع "أحدث" بعد التسليم/الإلغاء
  // (rsUnsub نفسه مقصود يفضل شغال - مسؤول عن نص الحالة "تم الوصول ✅"/"تم إلغاء المشوار" لسه،
  // بس من غير أي حركة تانية للماركر). rsSetMapVisible(true) لسه بيتنفذ عشان لو الخريطة كانت
  // ظاهرة بالفعل وقت الانتهاء، تفضل زي ما هي (مش تختفي فجأة) بدل ما تتحدّث بموقع غلط.
  const isTerminal = d.status === RIDE_STATUS.COMPLETED || d.status === RIDE_STATUS.CANCELLED;
  rsSetMapVisible(true);
  if (isTerminal) invalidateRideStatusRoute(); // يبطل أي رد Routing ديناميكي لسه Pending من قبل الوصول لحالة نهائية (P12)
  if (!rsMapInitialized) {
    if (isTerminal) return; // Late Snapshot وصل بحالة نهائية من غير ما الخريطة تتبني أصلًا - مفيش داعي نبنيها دلوقتي
    rsMapInitialized = true;
    initRideStatusMap(d);
  } else if (!isTerminal && d.driverLocation) {
    updateRideStatusDriverLocation(d.driverLocation, d.status, d.pickup, d.dropoff);
  }
}
function rsShowStatus(rideId, initialStatus) {
  rsCurrentRideId = rideId;
  rsMapInitialized = false;
  rsSetLabel(RS_LABELS[initialStatus] || initialStatus);
  rsShowRetry(false);
  rsSetMapVisible(false);
  rsSetInfoVisible(false);
  if (rsUnsub) { rsUnsub(); rsUnsub = null; }
  rsUnsub = onSnapshot(doc(db, RIDES_COLLECTION, rideId), snap => {
    if (!snap.exists()) return;
    const d = snap.data();
    const st = d.status;
    rsSetLabel(RS_LABELS[st] || st);
    rsShowRetry(st === RIDE_STATUS.REQUESTED);
    rsUpdateEta(d);
    rsUpdateMap(d);
  });
}

// ===== تصفير أعلام المتابعة عند تسجيل الخروج =====
// جديد (Phase 4B): rides.js ماكانش عنده تسجيل زي باقي الموديولات - ضروري دلوقتي عشان
// الـ Listeners الجديدة (البانل + خريطة الحالة) متفضلش شغالة بعد تسجيل الخروج.
// Phase 1 (Controlled Map Fix): rrMap (خريطة "طلب مشوار" - openRideRequest) كانت الخريطة
// الوحيدة في المشروع اللي مش بتتصفّر عند تسجيل الخروج (كل باقي الخرائط بتتصفّر فعليًا في
// registerMapsResets() جوه maps.js). لو المستخدم فتح شاشة طلب المشوار مرة واحدة بس في
// الجلسة وبعدين سجّل خروج من غير ما يفتحها تاني، الـ WebGL context + الـ 'click' listener
// (rrHandleMapClick) كانوا بيفضلوا حيّين في الذاكرة للأبد. الإصلاح هنا بس (نفس آلية
// onListenersCleared الموجودة بالفعل جوه نفس الدالة) - صفر تعديل في maps.js، وصفر تصدير
// لـ rrMap برّه الملف ده (يفضل private زي ما كان بالظبط).
export function registerRidesResets() {
  onListenersCleared(() => {
    driverOfferUnsub = null; rsUnsub = null; darUnsub = null;
    activeRideId = null; activeRideStatus = null; rsMapInitialized = false;
    if (rrMap) { rrMap.remove(); rrMap = null; }
  });
}
