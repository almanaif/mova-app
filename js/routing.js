// ===== routing.js — Routing Service Layer (Phase 4) =====
// نقطة الدخول الوحيدة لأي Routing في المشروع. ممنوع أي موديول/شاشة تانية تتعامل مباشرة مع أي
// مزود Routing — كل استدعاء يعدي من هنا بس. أي تغيير مستقبلي للمزود (OSRM Public Demo →
// Self-Hosted OSRM → أو أي مزود تاني) بيتم بتغيير الإعدادات جوه الملف ده فقط، من غير ما أي
// كود تاني (rides.js أو أي مكان مستقبلي زي Delivery) يحتاج يتغير — نفس الواجهة الموحدة
// (getRoute) والـ Response Shape ثابتين.

// ===== إعدادات المزود (نقطة التغيير الوحيدة وقت الانتقال لاحقًا لـ Self-Hosted OSRM) =====
const OSRM_BASE_URL = 'https://router.project-osrm.org';
// ملحوظة: OSRM Public Demo مفيهوش profile مخصص لموتوسيكل/توك توك — 'driving' هو الأقرب
// المتاح فعليًا لكل أنواع المركبات المؤهلة للمشاوير حاليًا (RIDE_ELIGIBLE_VEHICLES). القرار
// موثّق هنا صراحة لحد ما ننتقل لـ Self-Hosted OSRM ببروفايلات مخصصة لكل نوع مركبة.
const OSRM_PROFILE = 'driving';
const ROUTING_TIMEOUT_MS = 8000;
const PROVIDER_NAME = 'osrm-public-demo';

// ===== SESSION CACHE (المهمة 8 - Memory فقط، بيتصفر عند إعادة تحميل الصفحة عمدًا) =====
// صفر Firestore، صفر localStorage، صفر أي تخزين دائم — Map عادية في الذاكرة بس، عشان لو
// نفس العميل رجع لنفس النقطتين (بالظبط) في نفس الجلسة، مانديش طلب Routing تاني بدون داعي.
const _routeCache = new Map();
const CACHE_COORD_PRECISION = 5; // ~1.1 متر دقة - كفاية لاعتبار نفس النقطتين "نفس المسار"
const CACHE_MAX_ENTRIES = 50; // سقف بسيط يمنع تضخم الـ Map لو المستخدم قلّب كتير في نفس الجلسة

function _cacheKey(origin, destination) {
  const r = (n) => Number(n).toFixed(CACHE_COORD_PRECISION);
  return `${r(origin.lat)},${r(origin.lng)}|${r(destination.lat)},${r(destination.lng)}`;
}

// =====================================================================================
// getRoute — الواجهة الموحدة الوحيدة المستخدمة في باقي المشروع (المهمة 4)
// =====================================================================================
// origin/destination: {lat, lng} (WGS84 - نفس نظام الإحداثيات المعتمد في كل المشروع)
// بيرجع: {distanceKm, durationMinutes, polyline, provider}
// بيرمي Error لو فشل (صفر Fallback، صفر حساب بالخط المستقيم بدل منه - القرار المعتمد صراحة)
export async function getRoute(origin, destination) {
  const key = _cacheKey(origin, destination);
  if (_routeCache.has(key)) return _routeCache.get(key);

  const url = `${OSRM_BASE_URL}/route/v1/${OSRM_PROFILE}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=polyline&steps=false`;

  // Timeout واضح (المهمة 11) - حتى لا يظل إنشاء الرحلة معلقًا لو الـ Routing Provider بطيء
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ROUTING_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timeoutId);
    throw new Error('routing-failed: ' + (e.name === 'AbortError' ? 'timeout' : (e.message || 'network-error')));
  }
  clearTimeout(timeoutId);
  if (!res.ok) throw new Error('routing-failed: http-' + res.status);

  const data = await res.json();
  if (data.code !== 'Ok' || !Array.isArray(data.routes) || !data.routes[0]) {
    throw new Error('routing-failed: no-route');
  }
  const route = data.routes[0];

  // ===== Standard Routing Response (المهمة 4) — نفس الشكل الموحد بغض النظر عن المزود
  // الفعلي وراها، عشان باقي المشروع محتاجش يعرف تفاصيل OSRM تحديدًا =====
  const result = {
    distanceKm: Math.round((route.distance / 1000) * 100) / 100, // Actual Road Distance
    durationMinutes: Math.round(route.duration / 60),
    polyline: route.geometry, // Encoded Polyline (Google Polyline Algorithm, precision 5) - نفس المهمة 5
    provider: PROVIDER_NAME,
  };

  if (_routeCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = _routeCache.keys().next().value;
    _routeCache.delete(oldestKey);
  }
  _routeCache.set(key, result);
  return result;
}

// =====================================================================================
// decodePolyline — فك تشفير Encoded Polyline لعرضه على أي خريطة (المهمة 5)
// =====================================================================================
// تنفيذ خوارزمية Google Encoded Polyline (precision 5) القياسية محليًا، بدون إضافة أي
// Library خارجية جديدة للمشروع — الخوارزمية قصيرة ومعيارية ومفيش داعي لـ Dependency عشانها.
// بترجع مصفوفة [lat, lng] لكل نقطة على المسار. جاهزة للاستخدام وقت ما شاشة عرض مسار فعلية
// (Trip Tracking Map) تتضاف لاحقًا - مش مستخدمة في أي واجهة حاليًا في هذه المرحلة.
export function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

// ===== REVERSE GEOCODING (Nominatim - نفس المزوّد الحالي، منقول من orders.js) =====
// جديد (Map Sprint - Location Picker): كانت الدالة دي جوه orders.js بس (خاصة بإنشاء الطلب).
// دلوقتي محتاجينها كمان في maps.js عشان "منتقي الموقع" (Location Picker) الجديد يعرض عنوان
// نصي أثناء تحريك الخريطة - ونقلها هنا بدل orders.js عشان maps.js أصلًا معمول عليه import
// من orders.js، فأي import عكسي كان هيعمل Circular Dependency. الدالة نفسها متغيرتش حرف واحد.
export async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&accept-language=ar`);
    if (!res.ok) throw new Error('geocode-failed');
    const data = await res.json();
    const a = data.address || {};
    return {
      address: data.display_name || null,
      city: a.city || a.town || a.county || null,
      zone: a.suburb || a.neighbourhood || a.quarter || null,
    };
  } catch (e) {
    return { address: null, city: null, zone: null }; // فشل تحديد العنوان النصي - الموقع الجغرافي هيتحفظ برضه
  }
}

// =====================================================================================
// PLACE / ADDRESS SEARCH (Phase 2B - وضع A) — Nominatim Forward Geocoding
// =====================================================================================
// ===== المزوّدات المستخدمة في وضعي البحث تحت (Phase 2B) - نفس نمط التوثيق فوق لـ OSRM =====
// Nominatim: instance عام (nominatim.openstreetmap.org) - مفيش SLA مضمون، خاضع لحد استخدام
// معلن (usage policy) قد يتغير أو يتشدد من غير إخطار. لسه مقبول للمرحلة دي (مصرّح صراحة في
// Phase 2B)، بس موثّق هنا عشان أي قرار مستقبلي بالانتقال لـ Self-Hosted يبقى واضح مصدره.
const NOMINATIM_PROVIDER_NAME = 'nominatim-public-instance';
// نفس المزوّد المستخدم بالفعل لـ reverseGeocode (اتجاه عكسي بس) - صفر Dependency جديدة.
// بترمي Error عند timeout/network-failure عشان الطرف المستدعي (maps.js) يقرر رسالة الخطأ
// المناسبة للمستخدم (البند 3-A و11 - صفر كسر للـ picker لو Nominatim فشل).
const GEOCODE_TIMEOUT_MS = 8000;
export async function searchPlaces(queryText, biasLoc) {
  const q = (queryText || '').trim();
  if (q.length < 2) return [];
  let url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&accept-language=ar&limit=8&countrycodes=eg`;
  // Bias بسيط لصالح منطقة الخريطة الحالية (viewbox غير ملزم - bounded=0 يسيب نتائج برا المنطقة
  // كمان لو محتاجة، بس بيرتبها الأقرب أولًا) - مفيدة لما المستخدم يدور على اسم مكان محلي قصير.
  if (biasLoc && typeof biasLoc.lat === 'number' && typeof biasLoc.lng === 'number') {
    const d = 0.15; // ~16 كم تقريبًا - نطاق تحيّز معقول من غير ما يقفل نتائج أبعد فعلاً مقصودة
    url += `&viewbox=${biasLoc.lng - d},${biasLoc.lat + d},${biasLoc.lng + d},${biasLoc.lat - d}`;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timeoutId);
    throw new Error('search-failed: ' + (e.name === 'AbortError' ? 'timeout' : (e.message || 'network-error')));
  }
  clearTimeout(timeoutId);
  if (!res.ok) throw new Error('search-failed: http-' + res.status);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(d => ({
    label: d.display_name || q,
    lat: Number(d.lat), lng: Number(d.lon),
  })).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

// أداة البحث الصحيحة للبحث بالفئة ("كل الصيدليات القريبة") - نفس منظومة OSM المستخدمة بالفعل
// (نفس بيانات الخريطة المعروضة أصلًا)، صفر Provider جديد. بحث حول نقطة بنطاق محدود (متر) -
// مش استعلام على العالم كله (البند 3-B صراحة).
// Overpass: instance عام (overpass-api.de) - نفس ملحوظة عدم ضمان SLA فوق بالظبط، مفيش تعديل
// على الـ Headers أو محاولة تجاوز أي حد استخدام (Hardening Pass - البند 8: صفر Headers مزيّفة).
const OVERPASS_PROVIDER_NAME = 'overpass-public-instance';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_TIMEOUT_MS = 10000;
const POI_SEARCH_RADIUS_M = 2000; // نطاق معقول لتطبيق توصيل محلي - مش استعلام عالمي
const POI_RESULT_LIMIT = 25;

// تطبيع تصنيفات OSM لأسماء عربية مفهومة للمستخدم (البند 3-B - Example mapping بالحرف)
export const POI_CATEGORIES = [
  { id: 'pharmacy', label: 'صيدليات', singular: 'صيدلية', filter: '["amenity"="pharmacy"]' },
  { id: 'mosque', label: 'مساجد', singular: 'مسجد', filter: '["amenity"="place_of_worship"]["religion"="muslim"]' },
  { id: 'supermarket', label: 'سوبر ماركت', singular: 'سوبر ماركت', filter: '["shop"="supermarket"]' },
  { id: 'restaurant', label: 'مطاعم', singular: 'مطعم', filter: '["amenity"="restaurant"]' },
  { id: 'hospital', label: 'مستشفيات', singular: 'مستشفى', filter: '["amenity"="hospital"]' },
  { id: 'clinic', label: 'عيادات', singular: 'عيادة', filter: '["amenity"="clinic"]' },
  { id: 'school', label: 'مدارس', singular: 'مدرسة', filter: '["amenity"="school"]' },
  { id: 'fuel', label: 'محطات بنزين', singular: 'محطة بنزين', filter: '["amenity"="fuel"]' },
  { id: 'shop', label: 'متاجر', singular: 'متجر', filter: '["shop"]' },
];

function poiCategoryById(id) { return POI_CATEGORIES.find(c => c.id === id) || null; }

function poiAddressFromTags(tags) {
  const parts = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean);
  return parts.length ? parts.join(' ') : (tags['addr:city'] || null);
}

// ===== Hardening Pass (Cache + De-dup) - البند 2 =====
// كاش بسيط في الذاكرة (نفس نمط _routeCache فوق بالظبط - صفر Firestore/localStorage) + منع
// طلبات مكررة لنفس الفئة/المنطقة وهي لسه شغالة. مفتاح الكاش = الفئة + مركز الخريطة مقرّب لأقرب
// ~100م (مش دقة كاملة - "لم تتحرك الخريطة بشكل ملموس" زي ما اتطلب بالحرف، مش نفس النقطة تمامًا).
const _poiCache = new Map();      // key -> { at: timestamp, data: [...] }
const _poiInFlight = new Map();   // key -> Promise (لطلب لسه شغال لنفس المفتاح)
const POI_CACHE_TTL_MS = 2 * 60 * 1000; // دقيقتين - كفاية لضغطات متكررة على نفس الفئة، مش طويلة لدرجة عرض بيانات قديمة فعليًا
const POI_CACHE_COORD_PRECISION = 3; // ~110م دقة تقريب - "لم تتحرك الخريطة بشكل ملموس"

function _poiCacheKey(categoryId, lat, lng) {
  const r = (n) => Number(n).toFixed(POI_CACHE_COORD_PRECISION);
  return `${categoryId}|${r(lat)},${r(lng)}`;
}

// بترجع [] لو مفيش نتائج (حالة "Empty" منفصلة عن "Error" - البند 11)، وبترمي Error عند
// timeout/network/http failure عشان maps.js يعرض رسالة "تعذر تحميل الأماكن القريبة..." بالظبط.
// Hardening Pass (البند 1): node و way مع بعض (مش node بس) - أماكن كتير في OSM متمثّلة كـ
// way (مبنى بمساحة) مش node واحدة، خصوصًا مستشفيات/مدارس كبيرة. "out center" بيديّنا نقطة
// مركزية للـ way نستخدمها زي أي نتيجة عادية من غير تعقيد إضافي (صفر Relation geometry - مش
// محتاجينها هنا فعليًا).
export async function searchPOICategory(categoryId, lat, lng) {
  const cat = poiCategoryById(categoryId);
  if (!cat || typeof lat !== 'number' || typeof lng !== 'number') return [];

  const key = _poiCacheKey(categoryId, lat, lng);
  const cached = _poiCache.get(key);
  if (cached && (Date.now() - cached.at) < POI_CACHE_TTL_MS) return cached.data; // نفس الفئة + نفس المنطقة تقريبًا - إعادة استخدام
  if (_poiInFlight.has(key)) return _poiInFlight.get(key); // طلب شغال بالفعل لنفس المفتاح - منضاعفش الطلب

  const reqPromise = (async () => {
    const ql = `[out:json][timeout:${Math.floor(OVERPASS_TIMEOUT_MS / 1000)}];(node${cat.filter}(around:${POI_SEARCH_RADIUS_M},${lat},${lng});way${cat.filter}(around:${POI_SEARCH_RADIUS_M},${lat},${lng}););out center tags ${POI_RESULT_LIMIT};`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(OVERPASS_URL, { method: 'POST', body: 'data=' + encodeURIComponent(ql), signal: controller.signal });
    } catch (e) {
      clearTimeout(timeoutId);
      throw new Error('poi-search-failed: ' + (e.name === 'AbortError' ? 'timeout' : (e.message || 'network-error')));
    }
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('poi-search-failed: http-' + res.status);
    const data = await res.json();
    if (!Array.isArray(data.elements)) return [];
    const results = data.elements.map(el => {
      const tags = el.tags || {};
      // node: el.lat/el.lon مباشرة. way: النقطة الفعلية في el.center (بسبب "out center") - مفيش lat/lon على مستوى الـ element نفسه لـ way.
      const elLat = el.type === 'way' ? el.center?.lat : el.lat;
      const elLng = el.type === 'way' ? el.center?.lon : el.lon;
      return {
        id: `osm-${el.type}-${el.id}`,
        name: tags.name || tags['name:ar'] || (cat.singular + ' قريبة'), // Fallback مفيد بدل ما نعرض OSM tags خام (البند 4)
        category: cat.singular,
        address: poiAddressFromTags(tags),
        lat: elLat, lng: elLng,
      };
    }).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    _poiCache.set(key, { at: Date.now(), data: results });
    return results;
  })();

  _poiInFlight.set(key, reqPromise);
  try { return await reqPromise; }
  finally { _poiInFlight.delete(key); }
}
