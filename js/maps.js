// ===== maps.js — خرائط MapLibre GL JS (Phase 4B: استبدل Leaflet بالكامل) =====
// كل الخرائط في المشروع (تتبع طلب التوصيل، طلب مشوار، حالة مشوار، خريطة المندوب، خريطة
// الأدمن، خريطة تسجيل مندوب جديد) بتستخدم MapLibre GL JS + OpenFreeMap Vector Tiles دلوقتي.
// نقطة واحدة للـ Style (OPENFREEMAP_STYLE) - أي تغيير مستقبلي للـ Style بيتم من هنا بس.
// ممنوع Mapbox، وممنوع Leaflet في أي مكان بعد دلوقتي (زي ما اتحدد صراحة في Phase 4B).

import { DEFAULT_LOC, STORE_LOC } from './firebase.js';
import { onListenersCleared, showToast } from './utils.js';
import { decodePolyline, getRoute, reverseGeocode, searchPlaces, searchPOICategory, POI_CATEGORIES } from './routing.js';
import { renderIcons } from './icons.js';
// P1 (توحيد المسافات - Maps & Tracking Hardening): _distMeters هي نفس دالة driver.js/rides.js
// الموحّدة (Haversine دقيقة). بنستوردها من geo-utils.js (موديول صفر Imports) مش من driver.js
// مباشرة - جرّبنا الاستيراد المباشر من driver.js الأول، لكن ثبت عمليًا (باختبار تحميل شجرة
// الموديولات كاملة) إنه بيكسر تحميل التطبيق كله بسبب Circular Import ordering مع admin.js/
// orders.js (راجع تعليق geo-utils.js للتفاصيل الكاملة). صفر تغيير في أي استخدام موجود لأي
// دالة هنا (راجع alias تحت).
import { distMeters as _distMeters } from './geo-utils.js';

// ===== OpenFreeMap Style (الـ Style الرسمي - liberty) =====
export const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

// ===== Arabic RTL Text Shaping (الحل الرسمي لـ MapLibre GL JS - Map Upgrade Sprint) =====
// من غير الـ plugin ده، حروف العربي (والعبري) بتتعرض مفككة/بترتيب غلط على labels الخريطة.
// ده الحل الرسمي الموثّق من MapLibre نفسه - بيتسجل مرة واحدة بس لكل الخريطة، وبيشتغل مع أي
// خريطة يتعمل لها init بعد كده تلقائيًا. صفر قلب نصوص يدوي، صفر تعديل على أي string في المشروع.
// الـ plugin (سكريبت خارجي صغير) بيتحمّل فورًا (lazy:false) بدل الانتظار لحد أول نص RTL،
// عشان نضمن جاهزيته قبل رسم أي label عربي - يقفل احتمال ظهور النص مفكك أول مرة.
// ملحوظة إصلاح (Phase 2A): الرابط القديم كان ناقص /dist/ (يعني بيطلب ملف مش موجود فعليًا في
// الباكدج على unpkg) ومثبّت على نسخة 0.3.0 اللي ليها مشكلة توثّق فشل تسجيل معروفة في بعض
// سياقات التحميل. النسخة 0.4.0 هي نفسها اللي مشروع OpenStreetMap.org الرسمي مستخدمها حاليًا
// مع نفس major version بتاع maplibre-gl (5.x) اللي المشروع ده شغّال بيه.
const RTL_PLUGIN_URL = 'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.4.0/dist/mapbox-gl-rtl-text.js';

function registerArabicRtlPlugin() {
  try {
    if (typeof maplibregl === 'undefined') return false;
    // الحالات الممكنة: 'unavailable' (لسه مسجّلش)، 'loading'، 'loaded'، 'error'.
    // القديم كان بيعتبر أي حاجة غير 'unavailable' = "متسجل بنجاح" وده غلط: لو الحالة 'error'
    // (يعني آخر محاولة فشلت) لازم نعيد المحاولة، مش نسيبها زي ما هي بصمت للأبد.
    const status = maplibregl.getRTLTextPluginStatus ? maplibregl.getRTLTextPluginStatus() : 'unavailable';
    if (status === 'loading' || status === 'loaded') return true; // فعلاً بيتحمّل أو خلص - منع Duplicate registration
    maplibregl.setRTLTextPlugin(
      RTL_PLUGIN_URL,
      false // eager load: تحميل فوري بدل الانتظار لحد أول نص RTL، عشان نضمن جاهزية الـ plugin
            // قبل رسم أي label عربي على الخريطة (بيقفل احتمال الـ race اللي كان يسبب النص
            // يظهر مفكك لو أول Arabic label اتعرض قبل ما الـ plugin يخلص تحميل)
    );
    return true;
  } catch (e) {
    console.error('تعذر تسجيل Arabic RTL plugin:', e);
    return false;
  }
}
// P3 (Controlled Map Fix): لو المحاولتين (فورية + window.load) فشلوا فعلاً، النصوص العربية على
// الخريطة هتظهر مفككة من غير ما المستخدم يعرف السبب. تحذير واحد بس، وبس لو فشل حقيقي مؤكد
// (status === 'error') - أبدًا وقت 'loading' (لسه ممكن ينجح، شبكة بطيئة) ولا وقت 'loaded' (نجح).
// showToast مستوردة بالفعل فوق (سطر 8) وبتُستخدم فعليًا في نفس الملف (مثلاً أخطاء admin map) -
// صفر مشكلة ترتيب تحميل، فمفيش داعي لأي آلية جديدة.
let rtlFailureWarned = false; // Session flag - يمنع تكرار التحذير أكتر من مرة واحدة
function checkRtlPluginOutcome() {
  if (rtlFailureWarned) return;
  if (typeof maplibregl === 'undefined' || !maplibregl.getRTLTextPluginStatus) return;
  if (maplibregl.getRTLTextPluginStatus() === 'error') {
    rtlFailureWarned = true;
    showToast('تعذر تحميل دعم اللغة العربية للخريطة. قد تظهر بعض أسماء الأماكن بشكل غير صحيح.', 'err');
  }
}
// محاولة فورية وقت تحميل الموديول (المتوقع إن maplibregl يبقى متاح وقتها، زي باقي كود الملف).
// لو لأي سبب (توقيت تحميل السكريبتات) لسه مش متاح، أو لو المحاولة الأولى فشلت (status 'error'),
// بنجرب تاني عند اكتمال تحميل الصفحة - Safety net بسيط بدون أي polling أو تكرار غير محدود.
if (registerArabicRtlPlugin()) {
  setTimeout(checkRtlPluginOutcome, 4000); // وقت معقول لإعطاء تحميل سكريبت الـ CDN فرصة يخلص
} else {
  window.addEventListener('load', () => {
    registerArabicRtlPlugin();
    setTimeout(checkRtlPluginOutcome, 4000);
  }, { once: true });
}

// ===== Controls موحّدة لكل خرائط المشروع (Zoom + Compass + Scale) =====
// دالة مركزية واحدة بدل تكرار نفس الكود في كل مكان بيتعمل فيه init لخريطة. بتتأكد إنها متتضافش
// مرتين على نفس الـ instance (لو اتنادت غلط أكتر من مرة على نفس الخريطة - Duplicate controls).
// المواقع (top-right / bottom-right) اتخيرت عشان متتعارضش مع زرار "توسيط"/"موقعي الحالي"
// الموجود (.map-recenter-btn) اللي بيقعد في الزاوية السفلية المقابلة (bottom + inset-inline-end).
// جديد (P12.1 - Map Attribution): AttributionControl واحد موحّد لكل الخرائط - OpenFreeMap/OSM
// بيتطلبوا Attribution ظاهر في أي استخدام إنتاجي (مش بس Admin). كل الخرائط بتتبنى بـ
// "attributionControl: false" في الـ constructor (تعطيل الزرار التلقائي بتاع MapLibre بس - مش
// حذف الـ Attribution نفسه)، وبعدين بنضيفه إحنا يدويًا هنا في مكان ثابت (bottom-left، compact)
// - عشان منتعارضش مع باقي الـ Controls الموجودة أصلًا في الركن التاني (ScaleControl bottom-right
// + زرار "توسيط" المخصص .map-recenter-btn المثبّت هو كمان bottom-right). compact:true بيخلي
// الـ Attribution يتقفل لأيقونة "ⓘ" صغيرة على الشاشات الضيقة (Mobile) وتتوسع بالضغط عليها -
// مناسب لمساحة الخريطة المحدودة من غير ما ياخد مكان كبير أو يتعارض مع RTL (نفس الزرار بيشتغل
// صح في الاتجاهين، مفيش نص متجه اتجاه معيّن بيتكسر).
export function addAttributionControl(map) {
  if (!map || map._attrControlAdded) return;
  map._attrControlAdded = true;
  try {
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  } catch (e) {
    console.error('تعذر إضافة Attribution Control:', e);
  }
}
function addStandardControls(map) {
  if (!map || map._stdControlsAdded) return;
  map._stdControlsAdded = true;
  try {
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-right');
  } catch (e) {
    console.error('تعذر إضافة map controls:', e);
  }
  addAttributionControl(map);
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

// P5 (Controlled Map Fix): استبدال الإيموجي بنظام SVG icons.js الموحّد. تعيين كل نوع Marker
// لأيقونة موجودة فعليًا (فحصت icons.js أولًا - bike/map-pin/store كلهم موجودين، صفر أيقونة
// مخترعة) + لون من Design Tokens الموجودة (:root في styles.css) بدل ما يكون اللون جوه الإيموجي
// نفسه. الألوان اتخيرت عشان تفضل متمايزة في كل مكان بيظهروا فيه مع بعض على نفس الخريطة
// (مثلاً trackMap بيعرض merchant+customer+driver مع بعض، وride-status بيعرض driver+pickup+dropoff
// مع بعض) - نفس فكرة تمايز 🏪/📍/🛵/🟢/🔴 القديمة بس بألوان بدل إيموجي مختلف شكليًا.
const MARKER_ICON_MAP = {
  driver:   { icon: 'bike',    color: 'var(--color-secondary)' }, // بديل 🛵
  customer: { icon: 'map-pin', color: 'var(--color-primary)'   }, // بديل 📍
  merchant: { icon: 'store',   color: 'var(--color-warning)'   }, // بديل 🏪
  pickup:   { icon: 'map-pin', color: 'var(--color-success)'   }, // بديل 🟢
  dropoff:  { icon: 'map-pin', color: 'var(--color-danger)'    }, // بديل 🔴
};

// ماركر بأيقونة SVG (بديل L.divIcon، ونسخة P5 من createEmojiMarker القديمة) - بيرجع نفس
// الـ maplibregl.Marker instance بالظبط زي الأول (setLngLat/addTo/remove كلهم شغالين بنفس
// الشكل تمامًا) - الفرق الوحيد إن آخر باراميتر بقى "نوع" (driver/customer/merchant/pickup/dropoff)
// بدل نص إيموجي خام. anchor فضل 'center' زي الأصل بالظبط (صفر تغيير في مكان تموضع الماركر
// فوق الإحداثية - قرار محافظ عشان نضمن صفر Regression بصري من غير اختبار على متصفح حقيقي).
export function createMapMarker(map, pt, type, size = 26) {
  if (!map || typeof maplibregl === 'undefined') return null;
  const cfg = MARKER_ICON_MAP[type];
  if (!cfg) return null; // نوع غير معروف - نفس سلوك الأصل لو الإيموجي فاضي (صفر Marker يترسم)
  const el = document.createElement('div');
  el.className = 'map-marker';
  el.style.color = cfg.color; // stroke="currentColor" جوه icon() بيورث اللون ده
  el.innerHTML = icon(cfg.icon, size);
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

// مسافة تقريبية (Haversine) لعرض "350 م" جنب نتيجة بحث POI بس - مش Routing حقيقي ومش بديل
// لـ getRoute()/OSRM؛ استخدام عرض فقط (البند 4 - Distance from current/selected point).
// P1 (توحيد المسافات): كانت نسخة مكرّرة بالحرف من _distMeters (driver.js) - دلوقتي Wrapper بس
// (مش top-level const binding مباشر - نفس نمط الحذر المتّبع فعليًا في rides.js مع الـ imports
// الدائرية من maps.js، الاستدعاء الفعلي بيحصل جوه استخدام الدالة بس مش وقت تحميل الموديول)،
// صفر تغيير في أي استدعاء موجود للاسم (haversineMeters(lat1,lng1,lat2,lng2) زي الأول تمامًا).
function haversineMeters(lat1, lng1, lat2, lng2) { return _distMeters(lat1, lng1, lat2, lng2); }
function formatDistanceLabel(m) {
  if (!Number.isFinite(m)) return '';
  return m < 1000 ? `${Math.round(m)} م` : `${(m / 1000).toFixed(1)} كم`;
}
// Debounce بسيط (البند 3-A: 500-800ms، وبند 12 - منع طلب لكل ضغطة زرار)
function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// =====================================================================================
// ===== LOCATION PICKER (Map Sprint - شاشة واحدة مشتركة، تستخدمها شاشة الشيك أوت للعميل
// وشاشة موقع المتجر للتاجر - بدل ما نعمل نسختين متطابقتين) =====
// Phase 2B: إضافة بحث بالعنوان (Nominatim) + بحث بالفئة/POI (Overpass) - نفس الـ picker،
// نفس الـ Confirm Flow (اختيار نتيجة = Preview بس، لسه لازم "تأكيد الموقع" صريح - البند 2).
// =====================================================================================
let locPickerMap = null;
let locPickerCurrentLoc = null; // آخر مركز فعلي للخريطة أثناء التحريك (بيتحدث في moveend)
let locPickerGeocodeSeq = 0;    // Race Guard: تحريك سريع متتالي ممكن يطلق أكتر من reverseGeocode
let locPickerOnConfirm = null;  // callback({lat,lng,address}) بيتنده بس لما المستخدم يضغط "تأكيد"

let locPickerLastGeo = null;    // {address, city, zone} - آخر نتيجة reverseGeocode فعلية (Race-Guard-safe) لتمريرها كاملة عند التأكيد
let locPickerSearchSeq = 0;     // Race Guard منفصل لبحث العنوان (Search A/B - البند 12: نتيجة A متكتبش فوق B)
let locPickerCategorySeq = 0;   // Race Guard منفصل لبحث الفئة/POI (مستقل عن بحث العنوان)

// ===== عرض العنوان بشكل واضح ومنظّم (البند 7) - صفر JSON خام، صفر OSM tags للمستخدم =====
function locPickerRenderAddress(state, geo) {
  const addrEl = document.getElementById('loc-picker-addr');
  if (!addrEl) return;
  if (state === 'loading') {
    addrEl.innerHTML = `<div class="loc-picker-addr-line loc-picker-addr-loading">جاري تحديد العنوان...</div>`;
    return;
  }
  if (state === 'error' || !geo || !geo.address) {
    addrEl.innerHTML = `<div class="loc-picker-addr-line">📍 تم تحديد الموقع على الخريطة</div>`;
    return;
  }
  let html = `<div class="loc-picker-addr-line loc-picker-addr-main">📍 ${geo.address}</div>`;
  if (geo.city) html += `<div class="loc-picker-addr-sub">المدينة: ${geo.city}</div>`;
  if (geo.zone) html += `<div class="loc-picker-addr-sub">المنطقة: ${geo.zone}</div>`;
  addrEl.innerHTML = html;
}

function locPickerUpdateAddress(lat, lng) {
  locPickerRenderAddress('loading');
  const mySeq = ++locPickerGeocodeSeq;
  reverseGeocode(lat, lng).then(geo => {
    if (mySeq !== locPickerGeocodeSeq) return; // رد قديم من تحريك سابق - نتجاهله
    locPickerLastGeo = geo;
    locPickerRenderAddress(geo.address ? 'ok' : 'error', geo);
  });
}
// P2 (Controlled Map Fix): كانت reverseGeocode بتتنفذ فورًا مع كل moveend - تحريك سريع متتالي
// (المستخدم بيقلّب على أماكن قريبة بسرعة) كان بيطلق عدة طلبات Nominatim في ثوانٍ معدودة من غير
// أي حد. نفس debounce() الموجودة بالفعل فوق (مستخدمة في locPickerDebouncedSearch) - صفر تطبيق
// Debounce تاني غير متوافق. locPickerGeocodeSeq (Race Guard) والـ Cache جوه routing.js فضلوا
// زي ما هما بالظبط - الـ Debounce بس بيأخر إطلاق الطلب نفسه لحد ما التحريك يهدى شوية (400ms).
const locPickerDebouncedUpdateAddress = debounce(locPickerUpdateAddress, 400);

// ===== نتائج البحث (مشتركة بين وضع العنوان ووضع الفئة - نفس الـ UI، مصدر بيانات مختلف) =====
function locPickerResultsEl() { return document.getElementById('loc-picker-results'); }
function locPickerSetResultsState(state, html) {
  const el = locPickerResultsEl();
  if (!el) return;
  el.dataset.state = state;
  el.innerHTML = html || '';
  el.style.display = state === 'idle' ? 'none' : 'block';
}
function escText(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

function locPickerRenderPlaceResults(results, centerLoc) {
  if (!results.length) { locPickerSetResultsState('empty', `<div class="loc-picker-result-msg">لا توجد نتائج مطابقة</div>`); return; }
  const withDist = results.map(r => ({
    ...r,
    distanceMeters: centerLoc ? haversineMeters(centerLoc[0], centerLoc[1], r.lat, r.lng) : null,
  }));
  const html = withDist.map((r, i) => `
    <button type="button" class="loc-picker-result-row" data-idx="${i}" data-kind="place">
      <span data-icon="map-pin" data-size="16"></span>
      <span class="loc-picker-result-txt">
        <span class="loc-picker-result-name">${escText(r.label)}</span>
        ${Number.isFinite(r.distanceMeters) ? `<span class="loc-picker-result-meta">${formatDistanceLabel(r.distanceMeters)}</span>` : ''}
      </span>
    </button>`).join('');
  locPickerSetResultsState('ok', html);
  window._locPickerLastPlaceResults = withDist;
  renderIcons();
}
function locPickerRenderPoiResults(results, centerLoc) {
  if (!results.length) {
    locPickerSetResultsState('empty', `<div class="loc-picker-result-msg">لا توجد نتائج قريبة في هذه الفئة</div>`);
    return;
  }
  const withDist = results.map(r => ({ ...r, distanceMeters: haversineMeters(centerLoc[0], centerLoc[1], r.lat, r.lng) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
  const html = withDist.map((r, i) => `
    <button type="button" class="loc-picker-result-row" data-idx="${i}" data-kind="poi">
      <span data-icon="map-pin" data-size="16"></span>
      <span class="loc-picker-result-txt">
        <span class="loc-picker-result-name">${escText(r.name)}</span>
        <span class="loc-picker-result-meta">${escText(r.category)} · ${formatDistanceLabel(r.distanceMeters)}${r.address ? ' · ' + escText(r.address) : ''}</span>
      </span>
    </button>`).join('');
  locPickerSetResultsState('ok', html);
  window._locPickerLastPoiResults = withDist;
  renderIcons();
}

// اختيار نتيجة (عنوان أو POI) = Preview بس - بتحرك الخريطة وتحدّث العنوان زي أي تحريك يدوي
// عادي، بس لسه لازم "تأكيد الموقع" صريح (البند 2 IMPORTANT + البند 4 - Do not silently commit).
function locPickerPickResult(kind, idx) {
  const list = kind === 'poi' ? window._locPickerLastPoiResults : window._locPickerLastPlaceResults;
  const r = list && list[idx];
  if (!r || !locPickerMap) return;
  locPickerMap.flyTo({ center: [r.lng, r.lat], zoom: 17 });
  locPickerSetResultsState('idle');
  const si = document.getElementById('loc-picker-search-inp'); if (si) si.value = '';
}

// ===== بحث بالعنوان (وضع A) - Debounce + Race Guard + حالات فشل واضحة (البند 3-A) =====
async function locPickerRunPlaceSearch(text) {
  const q = (text || '').trim();
  if (q.length < 2) { locPickerSetResultsState('idle'); return; }
  locPickerSetResultsState('loading', `<div class="loc-picker-result-msg">جاري البحث...</div>`);
  const mySeq = ++locPickerSearchSeq;
  try {
    const results = await searchPlaces(q, locPickerCurrentLoc ? { lat: locPickerCurrentLoc[0], lng: locPickerCurrentLoc[1] } : null);
    if (mySeq !== locPickerSearchSeq) return; // نتيجة بحث قديمة (المستخدم كتب حاجة تانية) - اتجاهلت
    locPickerRenderPlaceResults(results, locPickerCurrentLoc);
  } catch (e) {
    if (mySeq !== locPickerSearchSeq) return;
    locPickerSetResultsState('error', `<div class="loc-picker-result-msg loc-picker-result-err">تعذر البحث، تأكد من الاتصال وحاول مرة أخرى.</div>`);
  }
}
const locPickerDebouncedSearch = debounce(locPickerRunPlaceSearch, 600);

// ===== بحث بالفئة/POI (وضع B) - حول مركز الخريطة الحالي (البند 3-B: نطاق محدود مش العالم كله) =====
async function locPickerRunCategorySearch(categoryId) {
  if (!locPickerCurrentLoc) return;
  const [lat, lng] = locPickerCurrentLoc;
  locPickerSetResultsState('loading', `<div class="loc-picker-result-msg">جاري البحث عن أماكن قريبة...</div>`);
  const mySeq = ++locPickerCategorySeq;
  try {
    const results = await searchPOICategory(categoryId, lat, lng);
    if (mySeq !== locPickerCategorySeq) return;
    locPickerRenderPoiResults(results, [lat, lng]);
  } catch (e) {
    if (mySeq !== locPickerCategorySeq) return;
    // رسالة الفشل المطلوبة بالحرف (البند 11)
    locPickerSetResultsState('error', `<div class="loc-picker-result-msg loc-picker-result-err">تعذر تحميل الأماكن القريبة، يمكنك تحديد الموقع يدويًا من الخريطة.</div>`);
  }
}

// بتتنده من index.html (input/click handlers) - Wiring خفيف بس، المنطق الفعلي فوق
export function locPickerOnSearchInput(value) { locPickerDebouncedSearch(value); }
export function locPickerOnCategoryClick(categoryId) { locPickerRunCategorySearch(categoryId); }
export function locPickerOnResultClick(el) {
  if (!el) return;
  locPickerPickResult(el.dataset.kind, Number(el.dataset.idx));
}

function locPickerBuildCategoryChips() {
  const wrap = document.getElementById('loc-picker-categories');
  if (!wrap || wrap.childElementCount) return; // اتبنت قبل كده - مفيش داعي نكررها كل ما الـ picker يتفتح
  wrap.innerHTML = POI_CATEGORIES.map(c =>
    `<button type="button" class="loc-picker-chip" onclick="locPickerOnCategoryClick('${c.id}')">${c.label}</button>`
  ).join('');
}

// الـ modal نفسه Static في index.html (مبيتبنيش من الصفر كل مرة زي الخريطة) - فربط الـ
// Listeners على input البحث وقائمة النتائج لازم يحصل مرة واحدة بس، وإلا كل فتح للـ picker
// هيضيف Listener جديد فوق القديم (تكرار طلبات/تكرار تنفيذ). العلم ده بيضمن ده.
let locPickerStaticWired = false;
function locPickerWireStaticOnce() {
  if (locPickerStaticWired) return;
  locPickerStaticWired = true;
  const input = document.getElementById('loc-picker-search-inp');
  if (input) input.addEventListener('input', (e) => locPickerOnSearchInput(e.target.value));
  const results = locPickerResultsEl();
  if (results) results.addEventListener('click', (e) => {
    const row = e.target.closest('.loc-picker-result-row');
    if (row) locPickerOnResultClick(row);
  });
}

// jsdoc: opts = { initialLoc:[lat,lng]?, title:string?, onConfirm(loc) }
export function openLocationPicker(opts = {}) {
  const modal = document.getElementById('loc-picker-modal');
  if (!modal || typeof maplibregl === 'undefined') { showToast('تعذر فتح الخريطة، حاول لاحقًا', 'err'); return; }
  document.getElementById('loc-picker-title').textContent = opts.title || 'تحديد الموقع';
  locPickerOnConfirm = typeof opts.onConfirm === 'function' ? opts.onConfirm : null;
  modal.classList.add('open');
  // جديد (P12.1 - GPS Truthy Check): كان "window.userLat ? ... : STORE_LOC" - نفس فحص الـ
  // Truthy الخاطئ (Number.isFinite هي الفحص الصحيح لصلاحية GPS، راجع الشرح في orders.js).
  const start = opts.initialLoc || ((Number.isFinite(window.userLat) && Number.isFinite(window.userLng)) ? [window.userLat, window.userLng] : STORE_LOC);
  locPickerCurrentLoc = start;
  locPickerLastGeo = null;
  locPickerBuildCategoryChips();
  locPickerWireStaticOnce();
  locPickerSetResultsState('idle');
  const si = document.getElementById('loc-picker-search-inp'); if (si) si.value = '';
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
      locPickerDebouncedUpdateAddress(c.lat, c.lng);
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
    // جديد (P11 Phase 6/16 - Coordinate Validation): مفيش فحص قبل كده هنا قبل flyTo - إحداثية
    // NaN/Infinity (نادرة لكن ممكنة من بعض الأجهزة/المتصفحات) كانت ممكن توصل مباشرة لـ
    // flyTo() ولـ reverse geocoding بعدها (عبر moveend) بمركز فاسد.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      showToast('تعذر تحديد موقعك، حرّك الخريطة يدويًا لاختيار المكان', 'err');
      return;
    }
    if (locPickerMap) locPickerMap.flyTo({ center: [lng, lat], zoom: 16 });
  }, err => {
    // جديد (P11 Phase 6/3/4): تمييز "الإذن مرفوض" عن "GPS غير متاح" بدل رسالة واحدة عامة للحالتين.
    const msg = err && err.code === 1
      ? 'تم رفض إذن الموقع - حرّك الخريطة يدويًا لاختيار المكان'
      : 'تعذر تحديد موقعك، حرّك الخريطة يدويًا لاختيار المكان';
    showToast(msg, 'err');
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
// جديد (Delivery Tracking Hardening): كانت trackDriverUnsub بتخزن unsubscribe لـ Listener
// مباشر على users/{driverId} - اتشالت بالكامل (راجع updateTrackDriverLocation تحت). العميل
// أصلاً مالوش صلاحية قراءة users/{driverId} في firestore.rules (مقصورة على صاحب المستند نفسه
// أو الأدمن)، يعني الـ Listener القديم ده كان بيتقفل بصمت بـ permission-denied من غير ما
// يوصل أي تحديث موقع للعميل خالص - التتبع الحي كان معطّل فعليًا. لا داعي لمتغير Unsubscribe
// هنا أصلًا دلوقتي لأننا مبنفتحش Listener تاني منفصل - موقع المندوب بيوصل من نفس onSnapshot
// الموجود بالفعل على orders/{orderId} في orders.js (openTrack) عبر driverLocation.
let trackCustLoc = null; // آخر موقع عميل استخدمناه لحساب مسار (لازمة برة on('load') عشان updateTrackDriverLocation يقدر يوصلها من نداءات لاحقة)
let trackFitPoints = [];        // نقط الخريطة الحالية (متجر/عميل/مندوب) - يستخدمها زرار "توسيط"
let _trackRouteReqId = 0;       // Race Guard: كل طلب Routing بياخد رقم؛ بنطبق بس آخر رد وصل لآخر طلب اتبعت
let _trackRouteLastPos = null;  // آخر نقطة اتحسب المسار منها فعليًا (لتحديد "تحرك حقيقي" بعد كده)
let _trackRoutePhase = null;    // 'to-customer' (متجر/مندوب -> عميل) - نستخدمها لمعرفة هل المرحلة اتغيرت
// ===== P11 Phase 3/4/11 - Follow Mode + Smooth Marker Movement (Order Tracking) =====
// _trackFollowMode: هل الكاميرا "تتابع" المندوب تلقائيًا دلوقتي؟ true افتراضيًا (متابعة تلقائية
// معقولة في البداية زي ما اتطلب)، وبتتقفل أول ما المستخدم يسحب/يزوم الخريطة يدويًا (dragstart/
// zoomstart - أحداث تفاعل حقيقي بس، مش بتتفعّل من camera moves برمجية زي easeTo)، وترجع تاني
// بس لما يضغط زرار التوسيط (recenterTrackMap). فرق جوهري عن قبل: مفيش fitBounds مع كل GPS
// Update (كان هيخلي الخريطة "تهتز") - Follow Mode هنا معناه easeTo لمركز واحد بس (موقع
// المندوب)، بدون تغيير الزوم، فمفيش تعارض مع تفاعل المستخدم إلا لو هو نفسه بيسحب/يزوم.
let _trackFollowMode = true;
let _trackDriverAnimPos = null; // آخر نقطة اتعرض فعليًا على الماركر (نقطة بداية الـ Animation الجاية)
let _trackDriverAnimHolder = { id: null }; // مرجع ثابت لـ requestAnimationFrame الحالي - عشان نقدر نلغيه من أي مكان (Destroy/تحديث جديد)

// جديد (P11 Phase 4): حركة سلسة للماركر بين نقطتين GPS بدل قفزة مباشرة. مشترك بين خريطة تتبع
// الطلبات وخريطة حالة المشوار (كل واحدة عندها holder/lastPos منفصلين). قواعد صريحة:
// - لو المسافة صغيرة جدًا (<=1م) أو غير منطقية (>300م - أرجح قفزة GPS/إشارة ضعيفة مش حركة
//   فعلية) أو غير محدودة (NaN/Infinity)، نحط الماركر في مكانه الجديد فورًا من غير Animation.
// - أي Animation سابق لسه شغال (لو نبضة GPS جت قبل ما القديمة تخلص) بيتلغى فورًا قبل ما نبدأ
//   واحد جديد - صفر تراكم Animation Loops.
// - مفيش أي تأثير على Firestore أو أي state تاني غير موقع الـ DOM Marker نفسه بصريًا.
function animateMarkerMove(marker, fromLatLng, toLatLng, holder) {
  if (holder.id) { cancelAnimationFrame(holder.id); holder.id = null; }
  const meters = _distMeters(fromLatLng[0], fromLatLng[1], toLatLng[0], toLatLng[1]);
  if (!Number.isFinite(meters) || meters <= 1 || meters > 300) {
    marker.setLngLat([toLatLng[1], toLatLng[0]]);
    return;
  }
  const duration = 900;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    marker.setLngLat([
      fromLatLng[1] + (toLatLng[1] - fromLatLng[1]) * t,
      fromLatLng[0] + (toLatLng[0] - fromLatLng[0]) * t,
    ]);
    if (t < 1) holder.id = requestAnimationFrame(step);
    else holder.id = null;
  }
  holder.id = requestAnimationFrame(step);
}
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
    // جديد (P11 Phase 9): "آخر تحديث منذ Xث" بدل رسالة عامة - وضوح أكبر للعميل إن الموقع مش
    // Live دلوقتي من غير ما يبان إنه اختفى تمامًا. لو الوقت مش معروف (نادر)، رجوع للنص العام.
    const secs = routeInfo?.staleSeconds;
    if (etaEl) etaEl.textContent = Number.isFinite(secs) ? `📡 آخر تحديث منذ ${secs} ثانية` : '📡 موقع المندوب غير متاح حاليًا';
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

// P0 (Live Location State): تعتيم بصري بسيط لماركر المندوب لما موقعه يبقى STALE (بدل نص
// ETA بس) - صفر Marker جديد، صفر تغيير في مكانه، بس opacity أقل عشان العميل ياخد إشارة بصرية
// واضحة إن الموقع ده مش لايف دلوقتي. maplibregl.Marker.getElement() بترجع نفس الـ <div>
// المستخدم في createMapMarker() فوق.
function setDriverMarkerFreshness(isStale) {
  if (!window.driverMarker || typeof window.driverMarker.getElement !== 'function') return;
  const el = window.driverMarker.getElement();
  if (el) el.style.opacity = isStale ? '0.45' : '1';
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

// جديد (P9 - Final Hardening): استُخرجت من أول initTrackMap() تحت (كانت نفس الأسطر دي بالحرف
// هناك) لتُستخدم كمان من closeTrack() في orders.js (زرار "رجوع للرئيسية" في شاشة التتبع - كان
// بينادي showScreen() مباشرة من غير أي Cleanup: trackUnsub (Firestore Listener) و trackMap
// (خريطة MapLibre كاملة بكل مصادرها) كانوا بيفضلوا شغالين في الخلفية للأبد لحد ما العميل يفتح
// تتبع طلب تاني أو يعمل Logout - تسريب Listener/Memory/Battery حقيقي، بالظبط الحالة اللي
// البند "Open tracking → Close → Open → Close" بيطلب التأكد منها).
// كمان بتزود _trackRouteReqId هنا (مش بس تصفّرها لـ null زي المتغيرات التانية) - ده يبطّل فورًا
// أي Route Request قديم لسه Pending من الطلب اللي إحنا خارجين منه، حتى لو الطلب/الشاشة الجديدة
// (أو مفيش شاشة خالص) مبتطلبش Route جديد بنفسها فورًا (Race Condition حقيقي كان ممكن يخلي رد
// قديم لطلب A يترسم غلط على خريطة طلب B - راجع التقرير).
export function destroyTrackMap() {
  _trackRouteReqId++;
  if (_trackDriverAnimHolder.id) { cancelAnimationFrame(_trackDriverAnimHolder.id); _trackDriverAnimHolder.id = null; }
  _trackDriverAnimPos = null; _trackFollowMode = true;
  if (window.trackMap) { window.trackMap.remove(); window.trackMap = null; }
  window.driverMarker = null; window.customerMarker = null;
  trackFitPoints = []; _trackRouteLastPos = null; _trackRoutePhase = null; trackCustLoc = null;
}

export function initTrackMap(ordData, status) {
  destroyTrackMap();
  const etaEl = document.getElementById('track-eta');
  if (etaEl) etaEl.textContent = 'جاري تحميل الخريطة...';
  if (typeof maplibregl === 'undefined') return;
  const storeLoc = getEffectiveStoreLoc(ordData);
  window.trackMap = new maplibregl.Map({
    container: 'tracking-map', style: OPENFREEMAP_STYLE,
    center: toLngLat(storeLoc), zoom: 14, attributionControl: false,
  });
  addStandardControls(window.trackMap);
  // جديد (P11 Phase 3C/11): إيقاف Follow Mode بس لما المستخدم يتفاعل هو نفسه مع الخريطة
  // (سحب/زوم حقيقي) - dragstart/zoomstart بتتفعّل من تفاعل يدوي فعلي بس في MapLibre، مش من
  // حركات كاميرا برمجية زي easeTo() (اللي بنستخدمها إحنا في Follow Mode وزرار التوسيط، وده
  // بيطلق movestart/moveend بس مش dragstart/zoomstart) - فمفيش تعارض بين الاتنين.
  window.trackMap.on('dragstart', () => { _trackFollowMode = false; });
  window.trackMap.on('zoomstart', () => { _trackFollowMode = false; });
  markMapLoading('tracking-map');
  attachMapErrorHandling(window.trackMap, () => { if (etaEl) etaEl.textContent = 'تعذر تحميل الخريطة'; showMapErrorMsg('tracking-map', 'تعذر تحميل الخريطة'); });
  window.trackMap.on('load', () => {
    markMapLoaded('tracking-map');
    if (window.trackMap) window.trackMap.resize(); // تأكيد الأبعاد لو الحاوية كانت لسه بتتحرك/Layout بيستقر
    createMapMarker(window.trackMap, storeLoc, 'merchant');
    trackFitPoints.push(storeLoc);
    const custLoc = (typeof ordData?.customerLat === 'number' && typeof ordData?.customerLng === 'number')
      ? [ordData.customerLat, ordData.customerLng]
      // جديد (P12.1 - GPS Truthy Check): كان "window.userLat ? ... : null" - نفس الفحص الخاطئ.
      : ((Number.isFinite(window.userLat) && Number.isFinite(window.userLng)) ? [window.userLat, window.userLng] : null);
    if (custLoc) {
      window.customerMarker = createMapMarker(window.trackMap, custLoc, 'customer');
      trackFitPoints.push(custLoc);
    }
    trackCustLoc = custLoc;
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

    // جديد (Delivery Tracking Hardening - P7): كان هنا Listener مباشر على users/{driverId}
    // (راجع الشرح فوق trackCustLoc) - العميل مالوش صلاحية قراءته أصلًا في firestore.rules،
    // فده كان بيفشل بصمت وميجيبش أي تحديث موقع خالص. دلوقتي أول رسم للماركر (لو الموقع
    // موجود بالفعل في ordData وقت بناء الخريطة) بيحصل هنا مباشرة، وأي تحديث بعد كده بييجي من
    // نفس onSnapshot الموجود بالفعل على orders/{orderId} في orders.js (مفيش Listener إضافي).
    updateTrackDriverLocation(ordData, status);
  });
}

// جديد (Delivery Tracking Hardening - P7): بديل الـ Listener المباشر على users/{driverId}
// (اتشال بالكامل - راجع الشرح فوق). بتتنده من مكانين بس: (أ) هنا فوق مباشرة بعد بناء الخريطة
// لأول مرة لنفس الطلب، و(ب) من orders.js (openTrack) مع كل نبضة onSnapshot جديدة على نفس
// مستند الطلب - وهي نفس النبضة اللي بتوصل أصلًا مع كل تحديث GPS من المندوب (driver.js يكتب
// orders/{orderId}.driverLocation، مش users/{driverId} - راجع orders.js). صفر Listener جديد.
export function updateTrackDriverLocation(ordData, status) {
  if (!window.trackMap) return; // الخريطة لسه ماتبنتش (أو الشاشة اتقفلت) - هيتحدّث تاني مع أول نداء بعد initTrackMap
  // جديد (البند 9 - Terminal States): لو الطلب وصل لحالة نهائية، منمنعش رسم/تحديث ماركر
  // المندوب خالص - حتى لو نبضة متأخرة (late snapshot) وصلت بموقع "أحدث"، أو المندوب اتنقل
  // لطلب تاني وموقعه اتحدّث على مستند الطلب القديم قبل ما أي Listener يتقفل فعليًا.
  const isTerminal = status === 'delivered' || status === 'cancelled';
  if (isTerminal || !ordData?.driverId || !ordData?.driverLocation) return; // NO_LOCATION: لسه مفيش موقع فعلي - صفر Marker وهمي
  const d = ordData.driverLocation;
  if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
  // ===== P0 (Live Location State): NO_LOCATION / LIVE / STALE موحّدة. updatedAt (على مستند
  // الطلب نفسه) بتتحدّث مع كل كتابة GPS فعلية (driver.js -> startGPS -> orders.js)، فهي مقياس
  // "حداثة" موثوق بغض النظر عن مرحلة الطلب - بديل lastSeen على users/{driverId} القديم.
  const updatedAtMs = d.updatedAt?.toMillis ? d.updatedAt.toMillis() : null;
  const isStale = updatedAtMs == null || (Date.now() - updatedAtMs) > DRIVER_STALE_MS; // STALE لو مفيش وقت معروف أصلًا برضه - محافظ عمدًا
  const driverPos = [d.lat, d.lng];
  if (!window.driverMarker) {
    window.driverMarker = createMapMarker(window.trackMap, driverPos, 'driver');
    _trackDriverAnimPos = driverPos;
    // جديد (P11 Phase 3A): أول ظهور فعلي لموقع المندوب - الكاميرا توسّع لتشمله مع المتجر/العميل
    // مرة واحدة بس (مش fitBounds مع كل تحديث بعد كده - ده كان هيخلي الخريطة تهتز، ممنوع صراحة
    // في البند 11). لو المستخدم بعد كده سحب/زوم يدوي، Follow Mode بيتقفل تلقائيًا (dragstart/
    // zoomstart فوق) ومنلمسش الكاميرا تاني إلا لو ضغط زرار التوسيط.
    fitToPoints(window.trackMap, [...trackFitPoints, driverPos]);
  } else {
    const from = _trackDriverAnimPos || driverPos;
    animateMarkerMove(window.driverMarker, from, driverPos, _trackDriverAnimHolder);
    _trackDriverAnimPos = driverPos;
    // جديد (P11 Phase 3C/11): Follow Mode = توسيط الكاميرا على المندوب فقط (من غير تغيير الزوم)
    // مع كل تحديث موقع - مش fitBounds كامل (ده اللي كان هيخلي الخريطة "تهتز" مع كل GPS Update).
    if (_trackFollowMode) window.trackMap.easeTo({ center: [driverPos[1], driverPos[0]], duration: 900 });
  }
  // تعتيم الماركر لو الموقع STALE - بصريًا على الخريطة نفسها، مش بس نص الـ ETA، وفي كل المراحل
  // (مش POST_PICKUP بس) - "لا يظهر Driver Marker قديم للمستخدم وكأنه Live" (البند 12).
  setDriverMarkerFreshness(isStale);
  if (isStale && POST_PICKUP_STATUSES.includes(status)) {
    // جديد (P11 Phase 9): بدل رسالة عامة "غير متاح حاليًا"، نوضح من إمتى آخر تحديث فعلي - نص
    // أوضح للعميل من مجرد تعتيم الماركر (اللي بيفضل شغال برضه فوق).
    const secs = updatedAtMs == null ? null : Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000));
    updateTrackEtaDisplay('driver-stale', { staleSeconds: secs });
    return;
  }
  // بعد الاستلام: المسار لازم يبقى مندوب -> عميل، ويتحسب تاني بس لو المندوب اتحرك مسافة
  // فعلية (ROUTE_RECALC_METERS) - مش مع كل نبضة GPS (البند 10/14).
  if (trackCustLoc && POST_PICKUP_STATUSES.includes(status)) {
    const phaseChanged = _trackRoutePhase !== 'driver-to-customer';
    const movedFar = !_trackRouteLastPos ||
      _distMeters(_trackRouteLastPos[0], _trackRouteLastPos[1], driverPos[0], driverPos[1]) >= ROUTE_RECALC_METERS;
    if (phaseChanged || movedFar) {
      _trackRoutePhase = 'driver-to-customer';
      _trackRouteLastPos = driverPos;
      if (phaseChanged) removeRoute(window.trackMap, 'track-route'); // مسار المرحلة القديمة (متجر->عميل) يتشال قبل ما نرسم الجديد
      computeAndDrawTrackRoute(driverPos, trackCustLoc);
    }
  }
}
// جديد: زرار "توسيط" على خريطة تتبع الطلب - بيرجّع كل النقط المعروضة (متجر/عميل/مسار) في
// مجال النظر تاني، مفيد لو العميل زوّم/سحب الخريطة يدوي وعايز يرجعلها.
// جديد (P11 Phase 3B/11): دلوقتي كمان بيعيد تفعيل Follow Mode، ولو موقع المندوب معروف بالفعل
// بيوسّط الكاميرا عليه هو تحديدًا (مش fitBounds لكل النقط - المندوب هو اللي بيتحرك، فمتابعته
// هي المنطقية هنا)؛ لو لسه مفيش موقع مندوب، يرجع لسلوك "توسيط كل النقط" القديم.
export function recenterTrackMap() {
  if (!window.trackMap) return;
  _trackFollowMode = true;
  if (_trackDriverAnimPos) {
    window.trackMap.easeTo({ center: [_trackDriverAnimPos[1], _trackDriverAnimPos[0]], duration: 600 });
  } else if (trackFitPoints.length) {
    fitToPoints(window.trackMap, trackFitPoints);
  }
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
            drvSelfMarker = createMapMarker(window.drvMap, [window.driverLat, window.driverLng], 'driver');
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
  if (!drvSelfMarker) { drvSelfMarker = createMapMarker(window.drvMap, [lat, lng], 'driver'); }
  else { drvSelfMarker.setLngLat([lng, lat]); }
}

function applyDriverMapRideMode(rideData) {
  if (!window.drvMap) return;
  if (drvPickupMarker) { drvPickupMarker.remove(); drvPickupMarker = null; }
  if (rideData?.pickup) drvPickupMarker = createMapMarker(window.drvMap, rideData.pickup, 'pickup');
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
//
// P1 (Controlled Map Fix): كانت initAdminMap() بتهدم الخريطة بالكامل (map.remove()) وتبنيها
// من الصفر بكل الـ Markers مع كل تحديث Firestore - وده بيحصل كتير جدًا فعليًا، لأن admin.js
// بينده initAdminMap() من Listener على مجموعة users كاملة من غير فلترة (أي تحديث GPS لأي
// مندوب بيطلق onSnapshot) + Listener على المشاوير الجارية. النتيجة كانت: Flicker + فقدان
// Zoom/Pan اللي الأدمن مظبطه يدوي + إعادة تحميل Style/Tiles بلا داعي مع كل نبضة GPS.
// الحل: الخريطة (WebGL instance) بتتعمل مرة واحدة بس. بعد كده أي نداء لـ initAdminMap()
// بيعمل "تسوية" (Reconciliation) للـ Markers الموجودة فعليًا بدل هدم/بناء - بمفتاح ثابت
// (driver.id لكل مندوب، ride.id لكل مشوار) عشان نعرف مين لسه موجود، مين جديد، ومين اختفى.
let admRouteSources = [];
let admDriverMarkers = new Map(); // driverId (users/{uid}.id) -> maplibregl.Marker
let admRideMarkers = new Map();   // rideId -> { pickup, dropoff, driver, routeSourceId }
let admMapLatestDrivers = [];     // آخر بيانات وصلت (لو اتنده initAdminMap قبل ما أول تحميل يخلص)
let admMapLatestRides = [];

// تسوية Markers المناديب: تحديث موجود (setLngLat)، إنشاء جديد بس للي مش موجود، حذف اللي اختفى
// (المندوب فقد إحداثياته أو اتشال من القايمة تمامًا) - نفس منطق trackMap/driverMap الحالي.
function admReconcileDrivers(drivers) {
  if (!window.admMap) return;
  const seen = new Set();
  drivers.forEach(d => {
    if (!d || d.id == null || typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
    seen.add(d.id);
    const existing = admDriverMarkers.get(d.id);
    if (existing) existing.setLngLat([d.lng, d.lat]);
    else admDriverMarkers.set(d.id, createMapMarker(window.admMap, [d.lat, d.lng], 'driver'));
  });
  admDriverMarkers.forEach((marker, id) => {
    if (!seen.has(id)) { marker.remove(); admDriverMarkers.delete(id); }
  });
}

// تسوية Markers/مسار المشاوير: pickup/dropoff/routeGeometry ثابتين بعد الإنشاء (Immutable -
// موثّق في rides.js) فبيتعملوا مرة واحدة بس لكل ride.id، driverLocation بيتحدّث (setLngLat)
// لأنه بيتغيّر مع كل نبضة GPS، والمشوار اللي يخلص/يتلغي (يختفي من نتيجة الـ Query أصلًا لأن
// Listener admin.js فلترته على status محدد) بتتشال كل Markers بتاعته + مصدر المسار.
function admReconcileRides(rides) {
  if (!window.admMap) return;
  const seen = new Set();
  rides.forEach(r => {
    if (!r || r.id == null) return; // صفر ID = مينفعش نتابعه بين التحديثات - يترفض بأمان
    seen.add(r.id);
    let entry = admRideMarkers.get(r.id);
    if (!entry) { entry = { pickup: null, dropoff: null, driver: null, routeSourceId: null }; admRideMarkers.set(r.id, entry); }
    if (r.pickup && !entry.pickup) entry.pickup = createMapMarker(window.admMap, r.pickup, 'pickup', 22);
    if (r.dropoff && !entry.dropoff) entry.dropoff = createMapMarker(window.admMap, r.dropoff, 'dropoff', 22);
    if (r.driverLocation) {
      if (entry.driver) entry.driver.setLngLat([r.driverLocation.lng, r.driverLocation.lat]);
      else entry.driver = createMapMarker(window.admMap, r.driverLocation, 'driver', 22);
    } else if (entry.driver) { entry.driver.remove(); entry.driver = null; }
    if (r.routeGeometry && !entry.routeSourceId) {
      const sid = 'adm-ride-route-' + r.id;
      if (drawEncodedRoute(window.admMap, r.routeGeometry, sid)) { entry.routeSourceId = sid; admRouteSources.push(sid); }
    }
  });
  admRideMarkers.forEach((entry, id) => {
    if (seen.has(id)) return;
    if (entry.pickup) entry.pickup.remove();
    if (entry.dropoff) entry.dropoff.remove();
    if (entry.driver) entry.driver.remove();
    if (entry.routeSourceId) { removeRoute(window.admMap, entry.routeSourceId); admRouteSources = admRouteSources.filter(s => s !== entry.routeSourceId); }
    admRideMarkers.delete(id);
  });
}

export function initAdminMap(drivers = [], rides = []) {
  admMapLatestDrivers = drivers; admMapLatestRides = rides;
  if (window.admMap) {
    // الخريطة موجودة بالفعل - تسوية تدريجية بس، صفر remove()/rebuild (P1). resize() لسه لازمة
    // هنا لأن الأدمن ممكن يكون سايب تبويب الخريطة (الحاوية بقت display:none) ورجعلها تاني -
    // نفس السبب بالظبط اللي driver map بتعمله في toggleDriverMap() للحالة المطابقة.
    window.admMap.resize();
    if (window.admMap.loaded && window.admMap.loaded()) {
      admReconcileDrivers(drivers);
      admReconcileRides(rides);
    }
    // لو لسه مش loaded (نادر جدًا - أول نداء لسه ماخلصش)، الـ 'load' handler تحت هيطبّق آخر
    // بيانات وصلت (admMapLatestDrivers/Rides) أول ما يخلص - صفر بيانات ضايعة.
    return;
  }
  if (typeof maplibregl === 'undefined') return;
  admDriverMarkers = new Map(); admRideMarkers = new Map(); admRouteSources = [];
  setTimeout(() => {
    window.admMap = new maplibregl.Map({
      container: 'admin-map', style: OPENFREEMAP_STYLE,
      center: toLngLat(DEFAULT_LOC), zoom: 13, attributionControl: false,
    });
    addStandardControls(window.admMap);
    markMapLoading('admin-map');
    attachMapErrorHandling(window.admMap, () => { showToast('تعذر تحميل خريطة الأدمن', 'err'); showMapErrorMsg('admin-map', 'تعذر تحميل الخريطة'); });
    window.admMap.on('load', () => {
      markMapLoaded('admin-map');
      window.admMap.resize();
      admReconcileDrivers(admMapLatestDrivers);
      admReconcileRides(admMapLatestRides);
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
// ===== P11 Phase 5 - نفس معاملة Follow Mode/Smooth Movement بتاعة خريطة تتبع الطلبات فوق،
// لكن instance منفصلة تمامًا (خريطة مختلفة، حالة مختلفة) =====
let _rsFollowMode = true;
let _rsDriverAnimPos = null;
let _rsDriverAnimHolder = { id: null };
let _rsFitPoints = []; // pickup/dropoff (وnقطة المندوب أول ما توصل) - يستخدمها زرار التوسيط
// ===== P12 (استكمال البند المؤجل من تقرير P11 - "Ride route does not dynamically recompute") =====
// كانت rsMap بترسم خط المسار الثابت المحسوب وقت إنشاء المشوار (pickup->dropoff) بس، ومتغيرش
// بعد كده أبدًا مهما تحرك المندوب - خلاف خريطة تتبع الطلبات (computeAndDrawTrackRoute فوق)
// اللي بتعيد حساب المسار ديناميكيًا. دلوقتي: قبل الاستلام (driver_assigned/driver_arrived) -
// المسار = مندوب->نقطة الالتقاط؛ بعد الاستلام (in_progress) - المسار = مندوب->الوجهة. نفس
// بالظبط فلسفة _trackRouteReqId/_trackRoutePhase/ROUTE_RECALC_METERS فوق، Instance منفصلة.
let _rsRouteReqId = 0;
let _rsRoutePhase = null;       // 'to-pickup' | 'to-destination'
let _rsRouteLastPos = null;     // آخر نقطة اتحسب المسار الديناميكي منها فعليًا
// Strings حرفية عمدًا (مش RIDE_STATUS.x من rides.js) - maps.js مالوش import من rides.js أصلًا
// (العكس هو الموجود: rides.js بيستورد من maps.js)، فاستيراد RIDE_STATUS هنا كان هيعمل Circular
// Import جديد. نفس أسلوب POST_PICKUP_STATUSES تحت بالحرف لنفس السبب بالظبط.
const RS_PRE_PICKUP_STATUSES = ['driver_assigned', 'driver_arrived'];
const RS_POST_PICKUP_STATUSES = ['in_progress'];
// جديد (P12 - Terminal State Race): لو طلب Routing ديناميكي كان لسه Pending واتلغى الرد بعد
// ما المشوار بقى Terminal (تم/اتلغى) - الخريطة نفسها لسه ظاهرة (rsCloseStatus بس هي اللي بتقفلها
// فعليًا، مش وصول Terminal Status - راجع القرار المتعمد ده في rsUpdateMap) - فلو معملناش
// كده، رد متأخر كان ممكن يرسم مسار جديد فوق خريطة مشوار خلص بالفعل. بتتنده من rsUpdateMap في
// rides.js بس أول ما يوصل Terminal، بدون ما تلمس الخريطة/الماركرز نفسهم (زي clearRideStatusMap
// اللي دي جزء منها أصلًا، لكن هنا من غير الهدم الكامل).
export function invalidateRideStatusRoute() {
  _rsRouteReqId++;
}
function rsComputeAndDrawRoute(origin, destination) {
  const myReqId = ++_rsRouteReqId;
  getRoute({ lat: origin[0], lng: origin[1] }, { lat: destination[0], lng: destination[1] })
    .then(r => {
      // Race Guard: نفس مبدأ computeAndDrawTrackRoute بالحرف - رد قديم من طلب سابق (مثلًا
      // المندوب اتحرك تاني، أو الشاشة اتقفلت) لازم يتجاهل نفسه لو مش آخر طلب اتبعت.
      if (myReqId !== _rsRouteReqId || !rsMap) return;
      drawEncodedRoute(rsMap, r.polyline, 'rs-route');
    })
    .catch(() => {}); // فشل حساب المسار الديناميكي - المسار القديم (لو موجود) يفضل زي ما هو، صفر UI جديد لهيك
}
export function initRideStatusMap(rideData) {
  clearRideStatusMap();
  if (typeof maplibregl === 'undefined' || !rideData?.pickup) return;
  rsMap = new maplibregl.Map({
    container: 'ride-status-map', style: OPENFREEMAP_STYLE,
    center: toLngLat(rideData.pickup), zoom: 13, attributionControl: false,
  });
  addStandardControls(rsMap);
  // جديد (P11 Phase 5/11): نفس منطق dragstart/zoomstart في خريطة تتبع الطلبات - تفاعل يدوي
  // حقيقي بس بيوقف Follow Mode، مش camera moves برمجية (easeTo).
  rsMap.on('dragstart', () => { _rsFollowMode = false; });
  rsMap.on('zoomstart', () => { _rsFollowMode = false; });
  markMapLoading('ride-status-map');
  attachMapErrorHandling(rsMap, () => { showToast('تعذر تحميل خريطة المشوار', 'err'); showMapErrorMsg('ride-status-map', 'تعذر تحميل الخريطة'); });
  rsMap.on('load', () => {
    if (!rsMap) return; // ممكن اتشالت قبل ما الـ load event يحصل (تغيير سريع للشاشة)
    markMapLoaded('ride-status-map');
    rsMap.resize();
    createMapMarker(rsMap, rideData.pickup, 'pickup');
    if (rideData.dropoff) createMapMarker(rsMap, rideData.dropoff, 'dropoff');
    if (rideData.routeGeometry) drawEncodedRoute(rsMap, rideData.routeGeometry, 'rs-route');
    _rsFitPoints = [rideData.pickup, rideData.dropoff].filter(Boolean);
    if (rideData.driverLocation) {
      // جديد (P12): بدل ما ننشئ الماركر هنا يدويًا (كان كده قبل كده ومش بيحسب مسار ديناميكي
      // أول مرة)، بنستخدم updateRideStatusDriverLocation() نفسها - نفس المسار اللي كل تحديث
      // GPS تاني بيعدي عليه، فلو المشوار اتفتح Reload وسط الطريق (مثلًا) والمندوب معروف
      // موقعه من أول لحظة، المسار الديناميكي (مندوب->التقاط/وجهة) بيتحسب فورًا مش بس المسار
      // الثابت (pickup->dropoff) اللي فوق.
      updateRideStatusDriverLocation(rideData.driverLocation, rideData.status, rideData.pickup, rideData.dropoff);
    } else {
      fitToPoints(rsMap, _rsFitPoints);
    }
  });
}
export function updateRideStatusDriverLocation(loc, status, pickup, dropoff) {
  // جديد (P11 Phase 16 - Coordinate Validation): مفيش فحص NaN/Infinity هنا قبل كده (خلاف
  // updateTrackDriverLocation في خريطة تتبع الطلبات اللي عندها الفحص ده بالفعل) - إحداثية
  // فاسدة كانت هتوصل مباشرة لـ createMapMarker/animateMarkerMove.
  if (!rsMap || !loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return;
  const toPos = [loc.lat, loc.lng];
  if (!rsDriverMarker) {
    rsDriverMarker = createMapMarker(rsMap, loc, 'driver');
    _rsDriverAnimPos = toPos;
    // جديد (P11 Phase 5A): أول ظهور لموقع المندوب بعد بناء الخريطة (لو ماكانش معروف وقت
    // initRideStatusMap) - نفس مبدأ خريطة تتبع الطلبات: توسيع مرة واحدة بس يشمله.
    fitToPoints(rsMap, [..._rsFitPoints, loc]);
  } else {
    const from = _rsDriverAnimPos || toPos;
    animateMarkerMove(rsDriverMarker, from, toPos, _rsDriverAnimHolder);
    _rsDriverAnimPos = toPos;
    if (_rsFollowMode) rsMap.easeTo({ center: [loc.lng, loc.lat], duration: 900 });
  }
  // جديد (P12): المسار الديناميكي - مندوب->التقاط قبل الاستلام، مندوب->وجهة بعد الاستلام.
  // بيتحسب تاني بس لو المرحلة اتغيرت أو المندوب اتحرك مسافة فعلية (ROUTE_RECALC_METERS) -
  // مش مع كل نبضة GPS (نفس مبدأ خريطة تتبع الطلبات بالحرف).
  const dest = RS_PRE_PICKUP_STATUSES.includes(status) ? pickup
             : RS_POST_PICKUP_STATUSES.includes(status) ? dropoff
             : null;
  if (dest && Number.isFinite(dest.lat) && Number.isFinite(dest.lng)) {
    const phase = RS_PRE_PICKUP_STATUSES.includes(status) ? 'to-pickup' : 'to-destination';
    const phaseChanged = _rsRoutePhase !== phase;
    const movedFar = !_rsRouteLastPos || _distMeters(_rsRouteLastPos[0], _rsRouteLastPos[1], toPos[0], toPos[1]) >= ROUTE_RECALC_METERS;
    if (phaseChanged || movedFar) {
      _rsRoutePhase = phase;
      _rsRouteLastPos = toPos;
      rsComputeAndDrawRoute(toPos, [dest.lat, dest.lng]);
    }
  }
}
// جديد (P11 Phase 5B): زرار توسيط لخريطة حالة المشوار - نفس فلسفة recenterTrackMap بالحرف
// (يفعّل Follow Mode تاني، ويوسّط على المندوب لو موقعه معروف، أو على نقط الرحلة لو لسه لأ).
export function recenterRideStatusMap() {
  if (!rsMap) return;
  _rsFollowMode = true;
  if (_rsDriverAnimPos) {
    rsMap.easeTo({ center: [_rsDriverAnimPos[1], _rsDriverAnimPos[0]], duration: 600 });
  } else if (_rsFitPoints.length) {
    fitToPoints(rsMap, _rsFitPoints);
  }
}
export function clearRideStatusMap() {
  if (_rsDriverAnimHolder.id) { cancelAnimationFrame(_rsDriverAnimHolder.id); _rsDriverAnimHolder.id = null; }
  _rsDriverAnimPos = null; _rsFollowMode = true; _rsFitPoints = [];
  _rsRouteReqId++; _rsRoutePhase = null; _rsRouteLastPos = null; // يبطل أي رد Routing ديناميكي لسه Pending
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
  window._locMap.on('load', () => { markMapLoaded('loc-map'); window._locMap.resize(); createMapMarker(window._locMap, [lat, lng], 'customer'); });
}
// جديد (P10 - MapLibre Leak): dregBack() في driver.js بتخرج بره شاشة التسجيل بالكامل
// (showScreen('screen-entry')) لما المستخدم يرجع من أول خطوة - من غير الدالة دي، window._locMap
// (خريطة اختيار موقع المندوب وقت التسجيل) كانت بتفضل حيّة (WebGL Context + الـ 'load' listener
// بتاعها) للأبد لحد ما المستخدم يرجع لشاشة التسجيل تاني في نفس الجلسة (initDriverRegLocationMap
// بتهدم أي نسخة قديمة أوتوماتيك في أول سطرين ليها) - سيناريو نادر (مرة واحدة في الغالب لكل
// جهاز) لكنه Leak حقيقي زي باقي الخرائط.
export function destroyDriverRegLocationMap() {
  if (window._locMap) { window._locMap.remove(); window._locMap = null; }
}

// ===== تصفير أعلام المتابعة عند تسجيل الخروج (بيتنفذ من utils.js عبر clearAllListeners) =====
export function registerMapsResets() {
  onListenersCleared(() => {
    trackCustLoc = null;
    drvSelfMarker = null; drvPickupMarker = null; driverMapRideData = null;
    // جديد (P10 - MapLibre Leak, Logout Cleanup): window.drvMap (خريطة المندوب الذاتية -
    // toggleDriverMap في نفس الملف) كانت الخريطة الوحيدة المتبقية اللي مش بتتهدم هنا عند تسجيل
    // الخروج - كل الخرائط التانية (admMap تحت، trackMap/rsMap/locPickerMap/rrMap) عندها هدم
    // فعلي إما هنا أو في registerRidesResets المكافئة. من غيرها: toggleDriverMap() بتفحص فقط
    // "if (!window.drvMap)" قبل ما تبني خريطة جديدة - يعني بعد Logout ثم تسجيل دخول تاني (بنفس
    // الـ Tab من غير Refresh)، كانت هتستخدم نفس WebGL Context/الخريطة القديمة (لسه مربوطة
    // بمركز خرائط المستخدم السابق) بدل ما تُبنى من جديد لحاوية "driver-map" الحالية.
    if (window.drvMap) { window.drvMap.remove(); window.drvMap = null; }
    // P1: تسجيل الخروج = "هدم حقيقي" (زي ما اتطلب صراحة - الحالة الوحيدة اللي لسه بنعمل فيها
    // remove() لخريطة الأدمن). صفر تسوية تدريجية هنا عمدًا - الجلسة خلصت فعلاً.
    if (window.admMap) { window.admMap.remove(); window.admMap = null; }
    admDriverMarkers = new Map(); admRideMarkers = new Map();
    admMapLatestDrivers = []; admMapLatestRides = [];
    admRouteSources = [];
    clearRideStatusMap();
  });
}
