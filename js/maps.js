// ===== maps.js — خرائط MapLibre GL JS (Phase 4B: استبدل Leaflet بالكامل) =====
// كل الخرائط في المشروع (تتبع طلب التوصيل، طلب مشوار، حالة مشوار، خريطة المندوب، خريطة
// الأدمن، خريطة تسجيل مندوب جديد) بتستخدم MapLibre GL JS + OpenFreeMap Vector Tiles دلوقتي.
// نقطة واحدة للـ Style (OPENFREEMAP_STYLE) - أي تغيير مستقبلي للـ Style بيتم من هنا بس.
// ممنوع Mapbox، وممنوع Leaflet في أي مكان بعد دلوقتي (زي ما اتحدد صراحة في Phase 4B).

import { DEFAULT_LOC, STORE_LOC, db, doc } from './firebase.js';
import { onListenersCleared, onSnapshot, showToast } from './utils.js';
import { decodePolyline, getRoute, reverseGeocode } from './routing.js';

// ===== OpenFreeMap Style (الـ Style الرسمي - liberty) =====
export const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

// ===== Arabic RTL Text Shaping (الحل الرسمي لـ MapLibre GL JS - Map Upgrade Sprint) =====
// من غير الـ plugin ده، حروف العربي (والعبري) بتتعرض مفككة/بترتيب غلط على labels الخريطة.
// ده الحل الرسمي الموثّق من MapLibre نفسه - بيتسجل مرة واحدة بس لكل الخريطة، وبيشتغل مع أي
// خريطة يتعمل لها init بعد كده تلقائيًا. صفر قلب نصوص يدوي، صفر تعديل على أي string في المشروع.
// lazy:true يعني الـ plugin نفسه (سكريبت خارجي صغير) يتحمّل بس أول لحظة يحتاج فيها الـ style
// نص RTL فعلي - مفيش تكلفة تحميل إضافية لو مفيش نصوص عربي على الـ style أصلاً.
function registerArabicRtlPlugin() {
  try {
    if (typeof maplibregl === 'undefined') return false;
    if (maplibregl.getRTLTextPluginStatus && maplibregl.getRTLTextPluginStatus() !== 'unavailable') return true; // متسجل بالفعل - منع Duplicate registration
    maplibregl.setRTLTextPlugin(
      'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.3.0/mapbox-gl-rtl-text.js',
      true // lazy load
    );
    return true;
  } catch (e) {
    console.error('تعذر تسجيل Arabic RTL plugin:', e);
    return false;
  }
}
// محاولة فورية وقت تحميل الموديول (المتوقع إن maplibregl يبقى متاح وقتها، زي باقي كود الملف).
// لو لأي سبب (توقيت تحميل السكريبتات) لسه مش متاح، بنجرب تاني مرة واحدة عند اكتمال تحميل
// الصفحة - Safety net بسيط بدون أي polling أو تكرار غير محدود.
if (!registerArabicRtlPlugin()) {
  window.addEventListener('load', () => registerArabicRtlPlugin(), { once: true });
}

// ===== Controls موحّدة لكل خرائط المشروع (Zoom + Compass + Scale) =====
// دالة مركزية واحدة بدل تكرار نفس الكود في كل مكان بيتعمل فيه init لخريطة. بتتأكد إنها متتضافش
// مرتين على نفس الـ instance (لو اتنادت غلط أكتر من مرة على نفس الخريطة - Duplicate controls).
// المواقع (top-right / bottom-right) اتخيرت عشان متتعارضش مع زرار "توسيط"/"موقعي الحالي"
// الموجود (.map-recenter-btn) اللي بيقعد في الزاوية السفلية المقابلة (bottom + inset-inline-end).
function addStandardControls(map) {
  if (!map || map._stdControlsAdded) return;
  map._stdControlsAdded = true;
  try {
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-right');
  } catch (e) {
    console.error('تعذر إضافة map controls:', e);
  }
}

// دالة مشتركة لمعالجة أخطاء تهيئة الخريطة (Loading / Init errors) - بتعرض رسالة واضحة للمستخدم
// بدل خريطة فاضية بصمت، من غير ما تكسر أي حاجة تانية في الصفحة.
function attachMapErrorHandling(map, onFail) {
  if (!map) return;
  map.on('error', (e) => {
    console.error('Map error:', e && e.error ? e.error : e);
    if (typeof onFail === 'function') onFail(e);
  });
}

// حالة تحميل الخريطة (CSS Shimmer) - بتتشال بمجرد ما الـ style/tiles توصل فعليًا (حدث 'load')،
// عشان مستخدم Mobile يشوف حالة تحميل واضحة بدل مربع رمادي ثابت (راجع css/styles.css).
function markMapLoaded(containerId) {
  const el = document.getElementById(containerId);
  if (el) el.classList.add('mv-map-loaded');
}
function markMapLoading(containerId) {
  const el = document.getElementById(containerId);
  if (el) { el.classList.remove('mv-map-loaded'); const err = el.querySelector('.mv-map-error-msg'); if (err) err.remove(); }
}
// رسالة خطأ واضحة مكان الخريطة (بدل ما تفضل فاضية بصمت لو فشل تحميل الـ Style/Tiles فعليًا).
function showMapErrorMsg(containerId, text) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.classList.add('mv-map-loaded'); // وقف الـ shimmer
  if (el.querySelector('.mv-map-error-msg')) return; // رسالة موجودة بالفعل - مفيش داعي نكررها
  const msg = document.createElement('div');
  msg.className = 'mv-map-error-msg';
  msg.textContent = text || 'تعذر تحميل الخريطة';
  el.appendChild(msg);
}

// ===== أدوات مشتركة =====
// كل إحداثيات المشروع مخزّنة {lat,lng} أو [lat,lng] (نفس نظام Leaflet القديم) - MapLibre
// بياخد [lng,lat] (GeoJSON)، فأي نقطة بتتحول هنا بس قبل ما توصل لأي MapLibre API.
function toLngLat(pt) {
  if (Array.isArray(pt)) return [pt[1], pt[0]]; // [lat,lng] -> [lng,lat]
  return [pt.lng, pt.lat];
}

// ماركر بإيموجي (بديل L.divIcon) - بيرجع الـ Marker instance عشان تقدر تحرّكه/تشيله بعدين.
export function createEmojiMarker(map, pt, emoji, size = 26) {
  if (!map || typeof maplibregl === 'undefined') return null;
  const el = document.createElement('div');
  el.style.fontSize = size + 'px';
  el.style.lineHeight = '1';
  el.textContent = emoji;
  return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(toLngLat(pt)).addTo(map);
}

// رسم مسار من Encoded Polyline مخزّن (decodePolyline من routing.js - صفر Routing جديد هنا).
// بيرجع true لو اترسم فعلاً، عشان اللي بينده يقرر يعمل fitBounds ولا لأ.
export function drawEncodedRoute(map, encodedPolyline, sourceId) {
  if (!map || !encodedPolyline) return false;
  const points = decodePolyline(encodedPolyline); // [[lat,lng], ...]
  if (!points.length) return false;
  const coords = points.map(p => [p[1], p[0]]); // -> [lng,lat] لـ GeoJSON
  const geojson = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
  if (map.getSource(sourceId)) {
    map.getSource(sourceId).setData(geojson);
  } else {
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    map.addLayer({
      id: sourceId + '-layer', type: 'line', source: sourceId,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#FF6B00', 'line-width': 4, 'line-opacity': 0.85 },
    });
  }
  return true;
}
export function removeRoute(map, sourceId) {
  if (!map) return;
  if (map.getLayer(sourceId + '-layer')) map.removeLayer(sourceId + '-layer');
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}
function fitToPoints(map, pts) {
  if (!map || !pts.length) return;
  const bounds = pts.reduce((b, p) => b.extend(toLngLat(p)), new maplibregl.LngLatBounds(toLngLat(pts[0]), toLngLat(pts[0])));
  map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 0 });
}

// =====================================================================================
// ===== LOCATION PICKER (Map Sprint - شاشة واحدة مشتركة، تستخدمها شاشة الشيك أوت للعميل
// وشاشة موقع المتجر للتاجر - بدل ما نعمل نسختين متطابقتين) =====
// =====================================================================================
let locPickerMap = null;
let locPickerCurrentLoc = null; // آخر مركز فعلي للخريطة أثناء التحريك (بيتحدث في moveend)
let locPickerGeocodeSeq = 0;    // Race Guard: تحريك سريع متتالي ممكن يطلق أكتر من reverseGeocode
let locPickerOnConfirm = null;  // callback({lat,lng,address}) بيتنده بس لما المستخدم يضغط "تأكيد"

let locPickerLastGeo = null;    // {address, city, zone} - آخر نتيجة reverseGeocode فعلية (Race-Guard-safe) لتمريرها كاملة عند التأكيد

function locPickerUpdateAddress(lat, lng) {
  const addrEl = document.getElementById('loc-picker-addr');
  if (addrEl) addrEl.textContent = 'جاري تحديد العنوان...';
  const mySeq = ++locPickerGeocodeSeq;
  reverseGeocode(lat, lng).then(geo => {
    if (mySeq !== locPickerGeocodeSeq || !addrEl) return; // رد قديم من تحريك سابق - نتجاهله
    locPickerLastGeo = geo;
    addrEl.textContent = geo.address || `${lat.toFixed(5)}, ${lng.toFixed(5)} (تعذر تحديد اسم العنوان)`;
  });
}

// jsdoc: opts = { initialLoc:[lat,lng]?, title:string?, onConfirm(loc) }
export function openLocationPicker(opts = {}) {
  const modal = document.getElementById('loc-picker-modal');
  if (!modal || typeof maplibregl === 'undefined') { showToast('تعذر فتح الخريطة، حاول لاحقًا', 'err'); return; }
  document.getElementById('loc-picker-title').textContent = opts.title || 'تحديد الموقع';
  locPickerOnConfirm = typeof opts.onConfirm === 'function' ? opts.onConfirm : null;
  modal.classList.add('open');
  const start = opts.initialLoc || (window.userLat ? [window.userLat, window.userLng] : STORE_LOC);
  locPickerCurrentLoc = start;
  locPickerLastGeo = null;
  if (locPickerMap) { locPickerMap.remove(); locPickerMap = null; }
  locPickerMap = new maplibregl.Map({
    container: 'loc-picker-map', style: OPENFREEMAP_STYLE,
    center: toLngLat(start), zoom: 15, attributionControl: false,
  });
  addStandardControls(locPickerMap);
  markMapLoading('loc-picker-map');
  attachMapErrorHandling(locPickerMap, () => showMapErrorMsg('loc-picker-map', 'تعذر تحميل الخريطة'));
  locPickerMap.on('load', () => {
    markMapLoaded('loc-picker-map');
    setTimeout(() => { if (locPickerMap) locPickerMap.resize(); }, 50); // المودال كان display:none لحظة الإنشاء - تأكيد الأبعاد
    locPickerUpdateAddress(start[0], start[1]);
    locPickerMap.on('moveend', () => {
      const c = locPickerMap.getCenter();
      locPickerCurrentLoc = [c.lat, c.lng];
      locPickerUpdateAddress(c.lat, c.lng);
    });
  });
}

// جديد: "استخدام موقعي الحالي" جوه منتقي الموقع - GPS بس مانتحرش (fly) الخريطة لمكان
// المستخدم، وموقع الـ GPS بيفضل مجرد اقتراح بداية - التأكيد النهائي لسه محتاج ضغطة "تأكيد
// الموقع" صريحة (الطلب بيستخدم الموقع المؤكد، مش GPS مباشرة).
export function locPickerUseCurrent() {
  if (!navigator.geolocation) { showToast('المتصفح مايدعمش تحديد الموقع', 'err'); return; }
  showToast('📍 جاري تحديد موقعك...', '');
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    if (locPickerMap) locPickerMap.flyTo({ center: [lng, lat], zoom: 16 });
  }, err => {
    showToast('تعذر تحديد موقعك، حرّك الخريطة يدويًا لاختيار المكان', 'err');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
}

// جديد (Final Map QA): زرار "إلغاء" كان بينده closeModal() العام اللي بيشيل كلاس 'open' بس -
// من غير ما يهدم Instance الخريطة (WebGL Context) ولا الـ Listeners بتاعتها (moveend). يعني
// كل إلغاء كان بيسيب خريطة MapLibre شغالة (مخفية بس display:none) لحد ما المستخدم يفتح
// المنتقي تاني (وقتها openLocationPicker بتهدمها فعلًا) - استهلاك ذاكرة/GPU بلا داعي في
// الفترة بينهم. دلوقتي زرار الإلغاء بينده الدالة دي اللي بتهدم الخريطة فورًا.
export function closeLocationPicker() {
  document.getElementById('loc-picker-modal').classList.remove('open');
  if (locPickerMap) { locPickerMap.remove(); locPickerMap = null; }
  locPickerOnConfirm = null;
}

export function locPickerConfirm() {
  if (!locPickerCurrentLoc) return;
  const [lat, lng] = locPickerCurrentLoc;
  const address = locPickerLastGeo?.address || null;
  const cb = locPickerOnConfirm;
  const geo = locPickerLastGeo;
  closeLocationPicker(); // بعد التأكيد كمان مفيش داعي نسيب الخريطة شغالة (نفس منطق الإلغاء)
  if (cb) cb({ lat, lng, address, city: geo?.city || null, zone: geo?.zone || null });
}

// =====================================================================================
// ===== TRACKING MAP (Delivery) =====
// =====================================================================================
export let trackDriverUnsub = null;
let trackFitPoints = [];        // نقط الخريطة الحالية (متجر/عميل/مندوب) - يستخدمها زرار "توسيط"
let _trackRouteReqId = 0;       // Race Guard: كل طلب Routing بياخد رقم؛ بنطبق بس آخر رد وصل لآخر طلب اتبعت
let _trackRouteLastPos = null;  // آخر نقطة اتحسب المسار منها فعليًا (لتحديد "تحرك حقيقي" بعد كده)
let _trackRoutePhase = null;    // 'to-customer' (متجر/مندوب -> عميل) - نستخدمها لمعرفة هل المرحلة اتغيرت
const ROUTE_RECALC_METERS = 150; // أقل مسافة تحرك بيها المندوب عشان نطلب مسار جديد (بعد الاستلام)
const DRIVER_STALE_MS = 90000;   // لو آخر تحديث موقع للمندوب أقدم من 90 ثانية، نعتبره "غير متاح حاليًا"

// جديد (Sprint 3.7): حالات الطلب اللي المسار المفروض فيها يبقى "مندوب -> عميل" بدل "متجر ->
// عميل" - بعد ما المندوب يستلم الطلب فعليًا من المتجر، عرض مسار المتجر بقى غير منطقي تمامًا
// (البند 14 - IMPORTANT ROUTE LOGIC). القيم string حرفية (مش import من orders.js) عشان
// orders.js أصلاً بيعمل import لـ maps.js - أي import عكسي هنا هيعمل Circular Dependency.
const POST_PICKUP_STATUSES = ['picked_up', 'on_the_way'];
const PRE_PICKUP_ROUTABLE = ['merchant_accepted', 'searching_driver', 'driver_assigned', 'driver_arrived'];

function updateTrackEtaDisplay(state, routeInfo) {
  const etaEl = document.getElementById('track-eta');
  const distEl = document.getElementById('track-distance');
  if (state === 'ok' && routeInfo) {
    if (etaEl) etaEl.textContent = routeInfo.durationMinutes + ' دقيقة';
    if (distEl) distEl.textContent = routeInfo.distanceKm + ' كم';
  } else if (state === 'loading') {
    if (etaEl) etaEl.textContent = 'جاري حساب المسار...';
    if (distEl) distEl.textContent = '--';
  } else if (state === 'no-driver') {
    if (etaEl) etaEl.textContent = 'جاري البحث عن مندوب';
    if (distEl) distEl.textContent = '--';
  } else if (state === 'driver-stale') {
    // جديد (البند 16 - DRIVER LOCATION UNAVAILABLE): بدل ما نسيب آخر وقت محسوب معروض وهو
    // بقى غير دقيق (المندوب ممكن يكون اتحرك كتير من ساعتها)، نوضح صراحة إن الموقع مش متاح.
    if (etaEl) etaEl.textContent = '📡 موقع المندوب غير متاح حاليًا';
  } else if (state === 'delivered') {
    // جديد (Final Map QA): الحالتين delivered/cancelled معندهمش أي branch قبل كده - يعني
    // نص الوقت/المسافة كان بيفضل عالق على آخر قيمة قبل التسليم (أو "جاري تحميل الخريطة..."
    // لو كانت أول Init). بند 8 من الـ Sprint اللي فات كان طلب صراحة "delivered: show final
    // state cleanly" - ده التنفيذ الفعلي المفقود.
    if (etaEl) etaEl.textContent = '✅ تم التسليم';
    if (distEl) distEl.textContent = '--';
  } else if (state === 'cancelled') {
    if (etaEl) etaEl.textContent = '❌ تم إلغاء الطلب';
    if (distEl) distEl.textContent = '--';
  } else {
    // فشل حساب المسار فعليًا (Routing Provider مش متاح/Timeout/لا يوجد مسار) - رسالة صادقة
    // بدل رقم تقريبي مختلق (البند 23 - NO FAKE ETA). الخريطة والـ Markers بيفضلوا شغالين.
    if (etaEl) etaEl.textContent = 'تعذر حساب وقت الوصول حاليًا';
    if (distEl) distEl.textContent = '--';
  }
}

function getEffectiveStoreLoc(ordData) {
  // جديد (Sprint 3.7 - القسم 3): لو الطلب معاه storeLat/storeLng حقيقيين (اتسجلوا وقت
  // الإنشاء لو وثيقة المتجر كانت عندها إحداثيات - راجع goCheckout في orders.js)، نستخدمهم.
  // لو مش موجودين (كل المتاجر الحالية دلوقتي، لأن /stores مفيهاش lat/lng خالص لسه)، نرجع
  // للنقطة الثابتة القديمة STORE_LOC كـ Fallback واضح - صفر بيانات مُختلقة، وده موثّق في
  // التقرير النهائي كـ Data Migration مطلوبة على وثائق /stores.
  if (typeof ordData?.storeLat === 'number' && typeof ordData?.storeLng === 'number') {
    return [ordData.storeLat, ordData.storeLng];
  }
  return STORE_LOC;
}

// بيحسب/يرسم مسار جديد (Best-effort + Race Guard) بين نقطتين، ويحدّث عرض الوقت/المسافة.
function computeAndDrawTrackRoute(origin, destination) {
  const myReqId = ++_trackRouteReqId;
  updateTrackEtaDisplay('loading');
  getRoute({ lat: origin[0], lng: origin[1] }, { lat: destination[0], lng: destination[1] })
    .then(r => {
      // Race Guard (البند 10): لو طلب Routing أحدث اتبعت بعد ده (مثلًا المندوب اتحرك تاني
      // قبل ما الرد القديم يوصل)، بنتجاهل الرد القديم عشان ميكتبش فوق نتيجة أحدث بالغلط.
      if (myReqId !== _trackRouteReqId || !window.trackMap) return;
      drawEncodedRoute(window.trackMap, r.polyline, 'track-route');
      updateTrackEtaDisplay('ok', r);
    })
    .catch(() => { if (myReqId === _trackRouteReqId) updateTrackEtaDisplay('fail'); });
}

// جديد: مفتاح "مرحلة" الحالة - بيستخدمه orders.js عشان يقرر هل لازم يعيد initTrackMap()
// (وبالتالي يفتح Listener جديد بقيمة status محدّثة) لما حالة الطلب تعدّي من قبل الاستلام
// لبعد الاستلام أو العكس - orders.js مش بيبعت driverId تاني في الحالة دي، فلو معملناش كده
// الـ Listener القديم هيفضل شغال بـ status قديم متسرّب جوه الـ closure بتاعته.
export function trackPhaseKey(status) {
  if (POST_PICKUP_STATUSES.includes(status)) return 'post';
  if (PRE_PICKUP_ROUTABLE.includes(status)) return 'pre';
  return 'other';
}

export function initTrackMap(ordData, status) {
  if (window.trackMap) { window.trackMap.remove(); window.trackMap = null; }
  window.driverMarker = null; window.customerMarker = null;
  trackFitPoints = []; _trackRouteLastPos = null; _trackRoutePhase = null;
  const etaEl = document.getElementById('track-eta');
  if (etaEl) etaEl.textContent = 'جاري تحميل الخريطة...';
  if (typeof maplibregl === 'undefined') return;
  const storeLoc = getEffectiveStoreLoc(ordData);
  window.trackMap = new maplibregl.Map({
    container: 'tracking-map', style: OPENFREEMAP_STYLE,
    center: toLngLat(storeLoc), zoom: 14, attributionControl: false,
  });
  addStandardControls(window.trackMap);
  markMapLoading('tracking-map');
  attachMapErrorHandling(window.trackMap, () => { if (etaEl) etaEl.textContent = 'تعذر تحميل الخريطة'; showMapErrorMsg('tracking-map', 'تعذر تحميل الخريطة'); });
  window.trackMap.on('load', () => {
    markMapLoaded('tracking-map');
    if (window.trackMap) window.trackMap.resize(); // تأكيد الأبعاد لو الحاوية كانت لسه بتتحرك/Layout بيستقر
    createEmojiMarker(window.trackMap, storeLoc, '🏪');
    trackFitPoints.push(storeLoc);
    const custLoc = (typeof ordData?.customerLat === 'number' && typeof ordData?.customerLng === 'number')
      ? [ordData.customerLat, ordData.customerLng]
      : (window.userLat ? [window.userLat, window.userLng] : null);
    if (custLoc) {
      window.customerMarker = createEmojiMarker(window.trackMap, custLoc, '📍');
      trackFitPoints.push(custLoc);
    }
    // قبل الاستلام: مسار متجر -> عميل (لو الحالة فعلًا في مرحلة يبقى فيها المسار منطقي).
    // بعد الاستلام: هيتحسب مسار مندوب -> عميل تحت في Listener الموقع نفسه (محتاج موقع مندوب
    // حي أولًا، مش متوفر لحظة تحميل الخريطة).
    if (custLoc && PRE_PICKUP_ROUTABLE.includes(status)) {
      _trackRoutePhase = 'store-to-customer';
      computeAndDrawTrackRoute(storeLoc, custLoc);
    } else if (status === 'delivered') {
      updateTrackEtaDisplay('delivered');
    } else if (status === 'cancelled') {
      updateTrackEtaDisplay('cancelled');
    } else if (!ordData?.driverId) {
      updateTrackEtaDisplay('no-driver');
    }
    fitToPoints(window.trackMap, trackFitPoints);

    if (trackDriverUnsub) { try { trackDriverUnsub(); } catch (e) {} trackDriverUnsub = null; }
    // جديد (Final Map QA): الطلبات المنتهية (delivered/cancelled) كانت لسه بتفتح Listener حي
    // على موقع المندوب لو كان معيّن، رغم إن مفيش داعي نتابعه بعد انتهاء الطلب فعليًا - استهلاك
    // Firestore Listener بلا فايدة طول ما شاشة التتبع فاضلة مفتوحة. القسم 13 (Sprint سابق)
    // طلب صراحة "cancelled: stop unnecessary live tracking" - نفس المنطق بينطبق على delivered.
    const isTerminal = status === 'delivered' || status === 'cancelled';
    if (ordData?.driverId && !isTerminal) {
      trackDriverUnsub = onSnapshot(doc(db, 'users', ordData.driverId), snap => {
        const d = snap.data();
        const lastSeenMs = d?.lastSeen?.toMillis ? d.lastSeen.toMillis() : null;
        const isStale = lastSeenMs != null && (Date.now() - lastSeenMs) > DRIVER_STALE_MS;
        if (!d?.lat || !d?.lng) return; // مفيش موقع للمندوب لسه (لسه ماحرّكش GPS) - مفيش داعي نكسر أي حاجة
        if (isStale && POST_PICKUP_STATUSES.includes(status)) { updateTrackEtaDisplay('driver-stale'); return; }
        const driverPos = [d.lat, d.lng];
        if (!window.driverMarker) {
          window.driverMarker = createEmojiMarker(window.trackMap, driverPos, '🛵');
        } else {
          window.driverMarker.setLngLat([d.lng, d.lat]); // تحديث نقطة موجودة - صفر Marker جديد (البند 8/9 - مفيش سرقة كاميرا)
        }
        // بعد الاستلام: المسار لازم يبقى مندوب -> عميل، ويتحسب تاني بس لو المندوب اتحرك
        // مسافة فعلية (ROUTE_RECALC_METERS) - مش مع كل نبضة GPS (البند 10).
        if (custLoc && POST_PICKUP_STATUSES.includes(status)) {
          const phaseChanged = _trackRoutePhase !== 'driver-to-customer';
          const movedFar = !_trackRouteLastPos ||
            Math.hypot(driverPos[0] - _trackRouteLastPos[0], driverPos[1] - _trackRouteLastPos[1]) * 111000 >= ROUTE_RECALC_METERS;
          if (phaseChanged || movedFar) {
            _trackRoutePhase = 'driver-to-customer';
            _trackRouteLastPos = driverPos;
            if (phaseChanged) removeRoute(window.trackMap, 'track-route'); // مسار المرحلة القديمة (متجر->عميل) يتشال قبل ما نرسم الجديد
            computeAndDrawTrackRoute(driverPos, custLoc);
          }
        }
      });
    }
  });
}
// جديد: زرار "توسيط" على خريطة تتبع الطلب - بيرجّع كل النقط المعروضة (متجر/عميل/مسار) في
// مجال النظر تاني، مفيد لو العميل زوّم/سحب الخريطة يدوي وعايز يرجعلها.
export function recenterTrackMap() {
  if (!window.trackMap || !trackFitPoints.length) return;
  fitToPoints(window.trackMap, trackFitPoints);
}

// =====================================================================================
// ===== DRIVER MAP (خريطة المندوب الشخصية - Idle / Ride Mode) =====
// =====================================================================================
// Idle: موقع المندوب بس. Ride: + Pickup + Route. نفس الخريطة (#driver-map) في الحالتين -
// بترجع تلقائيًا للوضع الطبيعي (Idle) لما المشوار يخلص (completed/cancelled).
let drvSelfMarker = null;
let drvPickupMarker = null;
let driverMapRideData = null; // لو موجودة، يبقى فيه مشوار جاري - نستخدمها وقت إنشاء الخريطة لو اتفتحت أثناء مشوار

export function toggleDriverMap() {
  const sec = document.getElementById('drv-map-sec');
  if (!sec) return;
  // إصلاح (Map Upgrade Sprint - المشكلة رقم 1): زرار "خريطة" في الشريط السفلي كان مش بينده
  // drvNav() زي باقي الأزرار، فلو المندوب كان في تبويب "إحصائيات"/"حسابي" وقت الضغط، قسم
  // الخريطة (#drv-map-sec) كان بيتفتح فعليًا (display:block) لكن جوه #drv-home-tab اللي هو نفسه
  // مخفي (display:none) - يعني الخريطة "شغالة" بس مش ظاهرة للمستخدم خالص. هنا بنتأكد إن تبويب
  // الرئيسية ظاهر أولًا (بنفس منطق drvNav في driver.js بالظبط، من غير ما نعدّل driver.js نفسه).
  const homeTab = document.getElementById('drv-home-tab');
  const homeWasHidden = homeTab && homeTab.style.display === 'none';
  if (homeWasHidden) {
    document.querySelectorAll('#screen-driver .nav-item').forEach(n => n.classList.remove('active'));
    homeTab.style.display = 'block';
    const statsTab = document.getElementById('drv-stats-tab');
    const profTab = document.getElementById('drv-profile-tab');
    const extra = document.getElementById('drv-extra');
    if (statsTab) statsTab.style.display = 'none';
    if (profTab) profTab.style.display = 'none';
    if (extra) extra.style.display = 'grid';
    const mapNavBtn = document.querySelector('#screen-driver .bottom-nav .nav-item:last-child');
    if (mapNavBtn) mapNavBtn.classList.add('active');
  }
  const show = homeWasHidden || sec.style.display === 'none';
  sec.style.display = show ? 'block' : 'none';
  if (!show) return; // كان ظاهر بالفعل والمستخدم بيقفله - مفيش داعي نبني/نـresize خريطة هتتخبي

  if (!window.drvMap) {
    if (typeof maplibregl === 'undefined') { showToast('تعذر تحميل الخريطة، حاول لاحقًا', 'err'); return; }
    setTimeout(() => {
      try {
        // استخدام موقع GPS الحقيقي للمندوب لو متاح فعلاً وقت فتح الخريطة، وإلا DEFAULT_LOC
        // (المنايف - الإسماعيلية) كـ fallback - نفس المتغيرات المستخدمة بالفعل في driver.js.
        const startLoc = (typeof window.driverLat === 'number' && typeof window.driverLng === 'number')
          ? [window.driverLat, window.driverLng] : DEFAULT_LOC;
        window.drvMap = new maplibregl.Map({
          container: 'driver-map', style: OPENFREEMAP_STYLE,
          center: toLngLat(startLoc), zoom: 14, attributionControl: false,
        });
        addStandardControls(window.drvMap);
        markMapLoading('driver-map');
        attachMapErrorHandling(window.drvMap, () => { showToast('تعذر تحميل خريطة المندوب', 'err'); showMapErrorMsg('driver-map', 'تعذر تحميل الخريطة'); });
        drvSelfMarker = null; drvPickupMarker = null;
        window.drvMap.on('load', () => {
          markMapLoaded('driver-map');
          if (typeof window.driverLat === 'number' && typeof window.driverLng === 'number') {
            drvSelfMarker = createEmojiMarker(window.drvMap, [window.driverLat, window.driverLng], '🛵');
          }
          if (driverMapRideData) applyDriverMapRideMode(driverMapRideData);
          if (window.drvMap) window.drvMap.resize(); // تأكيد الأبعاد فور التحميل - منع Canvas رمادي/فاضي
        });
      } catch (err) {
        console.error('تعذر تهيئة خريطة المندوب:', err);
        showToast('تعذر تحميل الخريطة، حاول لاحقًا', 'err');
      }
    }, 100);
  } else {
    // الخريطة كانت متبنية بالفعل بس الحاوية كانت مخفية (display:none على القسم أو التبويب) -
    // MapLibre محتاج resize() صريح عشان يعيد حساب أبعاد الـ Canvas الصحيحة، وإلا هتفضل خريطة
    // رمادية/فاضية أو مقصوصة لحد ما المستخدم يعمل Zoom/Pan يدوي (البند الأساسي في المشكلة رقم 1).
    setTimeout(() => { if (window.drvMap) window.drvMap.resize(); }, 60);
  }
}

// بتتنده من driver.js في كل نبضة GPS (بعد نفس منطق throttle الحالي - صفر كتابات إضافية) عشان
// تحرّك نقطة المندوب على خريطته الشخصية، سواء في وضع Idle أو Ride.
export function updateDriverSelfLocation(lat, lng) {
  if (!window.drvMap) return;
  if (!drvSelfMarker) { drvSelfMarker = createEmojiMarker(window.drvMap, [lat, lng], '🛵'); }
  else { drvSelfMarker.setLngLat([lng, lat]); }
}

function applyDriverMapRideMode(rideData) {
  if (!window.drvMap) return;
  if (drvPickupMarker) { drvPickupMarker.remove(); drvPickupMarker = null; }
  if (rideData?.pickup) drvPickupMarker = createEmojiMarker(window.drvMap, rideData.pickup, '🟢');
  if (rideData?.routeGeometry) drawEncodedRoute(window.drvMap, rideData.routeGeometry, 'drv-ride-route');
}

// بتتنده من rides.js لما المندوب يبقى عنده مشوار جاري (driver_assigned/driver_arrived/in_progress)
export function setDriverMapRideMode(rideData) {
  driverMapRideData = rideData;
  if (window.drvMap && window.drvMap.loaded && window.drvMap.loaded()) applyDriverMapRideMode(rideData);
}

// بتتنده من rides.js لما المشوار يخلص (completed/cancelled) - رجوع تلقائي للوضع الطبيعي
export function setDriverMapIdleMode() {
  driverMapRideData = null;
  if (!window.drvMap) return;
  if (drvPickupMarker) { drvPickupMarker.remove(); drvPickupMarker = null; }
  removeRoute(window.drvMap, 'drv-ride-route');
}

// =====================================================================================
// ===== ADMIN MAP =====
// =====================================================================================
// المناديب (زي ما هي) + المشاوير الجارية فوقها (Pickup/Dropoff/Route/Driver Live Location) -
// كله من البيانات المخزّنة بالفعل، صفر Routing جديد (routeGeometry مخزّنة من وقت إنشاء المشوار).
let admRouteSources = [];
export function initAdminMap(drivers = [], rides = []) {
  if (window.admMap) { window.admMap.remove(); window.admMap = null; }
  if (typeof maplibregl === 'undefined') return;
  admRouteSources = [];
  setTimeout(() => {
    window.admMap = new maplibregl.Map({
      container: 'admin-map', style: OPENFREEMAP_STYLE,
      center: toLngLat(DEFAULT_LOC), zoom: 13, attributionControl: true,
    });
    addStandardControls(window.admMap);
    markMapLoading('admin-map');
    attachMapErrorHandling(window.admMap, () => { showToast('تعذر تحميل خريطة الأدمن', 'err'); showMapErrorMsg('admin-map', 'تعذر تحميل الخريطة'); });
    window.admMap.on('load', () => {
      markMapLoaded('admin-map');
      window.admMap.resize();
      drivers.forEach(d => {
        if (typeof d.lat === 'number' && typeof d.lng === 'number') createEmojiMarker(window.admMap, [d.lat, d.lng], '🛵');
      });
      rides.forEach((r, i) => {
        if (r.pickup) createEmojiMarker(window.admMap, r.pickup, '🟢', 22);
        if (r.dropoff) createEmojiMarker(window.admMap, r.dropoff, '🔴', 22);
        if (r.driverLocation) createEmojiMarker(window.admMap, r.driverLocation, '🛵', 22);
        if (r.routeGeometry) {
          const sid = 'adm-ride-route-' + i;
          if (drawEncodedRoute(window.admMap, r.routeGeometry, sid)) admRouteSources.push(sid);
        }
      });
    });
  }, 150);
}

// =====================================================================================
// ===== RIDE STATUS MAP (Customer - Phase 4B: جديد بالكامل) =====
// =====================================================================================
// Pickup + Dropoff + Route (كلهم من ride doc، مخزّنين من وقت الإنشاء) + Driver Live Location
// (rides/{rideId}.driverLocation - Phase 4B، بديل قراءة users/{driverId} القديمة للمشاوير).
let rsMap = null;
let rsDriverMarker = null;
export function initRideStatusMap(rideData) {
  clearRideStatusMap();
  if (typeof maplibregl === 'undefined' || !rideData?.pickup) return;
  rsMap = new maplibregl.Map({
    container: 'ride-status-map', style: OPENFREEMAP_STYLE,
    center: toLngLat(rideData.pickup), zoom: 13, attributionControl: false,
  });
  addStandardControls(rsMap);
  markMapLoading('ride-status-map');
  attachMapErrorHandling(rsMap, () => { showToast('تعذر تحميل خريطة المشوار', 'err'); showMapErrorMsg('ride-status-map', 'تعذر تحميل الخريطة'); });
  rsMap.on('load', () => {
    if (!rsMap) return; // ممكن اتشالت قبل ما الـ load event يحصل (تغيير سريع للشاشة)
    markMapLoaded('ride-status-map');
    rsMap.resize();
    createEmojiMarker(rsMap, rideData.pickup, '🟢');
    if (rideData.dropoff) createEmojiMarker(rsMap, rideData.dropoff, '🔴');
    if (rideData.routeGeometry) drawEncodedRoute(rsMap, rideData.routeGeometry, 'rs-route');
    fitToPoints(rsMap, [rideData.pickup, rideData.dropoff].filter(Boolean));
    if (rideData.driverLocation) rsDriverMarker = createEmojiMarker(rsMap, rideData.driverLocation, '🛵');
  });
}
export function updateRideStatusDriverLocation(loc) {
  if (!rsMap || !loc) return;
  if (!rsDriverMarker) { rsDriverMarker = createEmojiMarker(rsMap, loc, '🛵'); }
  else { rsDriverMarker.setLngLat([loc.lng, loc.lat]); }
}
export function clearRideStatusMap() {
  if (rsMap) { rsMap.remove(); rsMap = null; }
  rsDriverMarker = null;
}

// =====================================================================================
// ===== DRIVER REGISTRATION LOCATION MAP =====
// =====================================================================================
export function initDriverRegLocationMap(lat, lng) {
  if (typeof maplibregl === 'undefined') return;
  if (window._locMap) { window._locMap.remove(); window._locMap = null; }
  window._locMap = new maplibregl.Map({
    container: 'loc-map', style: OPENFREEMAP_STYLE,
    center: [lng, lat], zoom: 16, attributionControl: false,
  });
  addStandardControls(window._locMap);
  markMapLoading('loc-map');
  attachMapErrorHandling(window._locMap, () => showMapErrorMsg('loc-map', 'تعذر تحميل الخريطة'));
  window._locMap.on('load', () => { markMapLoaded('loc-map'); window._locMap.resize(); createEmojiMarker(window._locMap, [lat, lng], '📍'); });
}

// ===== تصفير أعلام المتابعة عند تسجيل الخروج (بيتنفذ من utils.js عبر clearAllListeners) =====
export function registerMapsResets() {
  onListenersCleared(() => {
    trackDriverUnsub = null;
    drvSelfMarker = null; drvPickupMarker = null; driverMapRideData = null;
    admRouteSources = [];
    clearRideStatusMap();
  });
}
