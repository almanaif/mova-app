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
