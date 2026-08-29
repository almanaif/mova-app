// ===== location-permission.js — First-Launch Location Permission Gate (Phase 2A) =====
// شاشة تشرح للمستخدم ليه محتاجين موقعه قبل ما نطلب إذن الموقع الحقيقي من المتصفح/النظام.
// مهم جدًا: الشاشة دي بس بتشرح وبعدين بتنده navigator.geolocation الحقيقية - صفر محاكاة أو
// تزييف لأي نافذة إذن نظام. لو الإذن كان already granted أو already denied، الشاشة دي متتعرضش
// خالص (منضمن مانضايقش المستخدم بطلب متكرر) والتطبيق بيكمل عادي زي ما هو دلوقتي.
//
// الموديول ده منفصل تمامًا عن getLocation()/startGPS() الموجودين في driver.js - مش بيلفهم
// ولا بيكررهم، بس بيقرر إمتى نعرض الشرح قبل ما أي حاجة تانية في التطبيق تحتاج الموقع.

import { icon } from './icons.js';

const SHOWN_FLAG_KEY = 'mova_loc_perm_explained_v1';
const DISMISSED_FLAG_KEY = 'mova_loc_perm_dismissed_v1';

function wasDismissedBefore() {
  try { return !!(window.localStorage && window.localStorage.getItem(DISMISSED_FLAG_KEY)); }
  catch (e) { return false; }
}
function markDismissed() {
  try { if (window.localStorage) window.localStorage.setItem(DISMISSED_FLAG_KEY, '1'); }
  catch (e) { /* localStorage غير متاح - هيتعرض تاني المرة الجاية بس مش هيقفل استخدام التطبيق */ }
}

function buildScreen() {
  if (document.getElementById('screen-location-permission')) return;
  const el = document.createElement('div');
  el.id = 'screen-location-permission';
  el.className = 'location-permission-screen';
  el.innerHTML = `
    <div class="location-permission-card">
      ${icon('map', 32, 'location-permission-icon')}
      <h2>يحتاج التطبيق الوصول لموقعك</h2>
      <ul class="location-permission-reasons">
        <li>${icon('check-circle', 18)} تحديد موقع العميل بدقة</li>
        <li>${icon('check-circle', 18)} حساب وتحديد مكان التوصيل</li>
        <li>${icon('check-circle', 18)} مساعدة المندوب على الوصول إليك</li>
        <li>${icon('check-circle', 18)} تحسين دقة العنوان المعروض</li>
      </ul>
      <button type="button" class="btn btn--primary btn-block" id="loc-perm-allow-btn">السماح بالموقع</button>
      <button type="button" class="location-permission-skip" id="loc-perm-skip-btn">ليس الآن</button>
      <p class="location-permission-note" id="loc-perm-note"></p>
    </div>
  `;
  document.body.appendChild(el);
  document.getElementById('loc-perm-allow-btn').addEventListener('click', requestRealGeolocation);
  // "ليس الآن" - لازم يكون موجود عشان المستخدم يقدر يكمل استخدام التطبيق من غير ما يتحبس
  // وراء الشاشة دي لو مش عايز يقرر دلوقتي؛ التطبيق بيكمل عادي ومميزات الموقع تطلب الإذن
  // تاني وقت الحاجة زي ما هو معمول بالفعل في باقي التطبيق.
  document.getElementById('loc-perm-skip-btn').addEventListener('click', () => {
    markDismissed();
    hideScreenEl();
  });
}

function showScreenEl() { buildScreen(); document.getElementById('screen-location-permission').classList.add('open'); }
function hideScreenEl() { const el = document.getElementById('screen-location-permission'); if (el) el.classList.remove('open'); }

function setNote(msg) {
  const n = document.getElementById('loc-perm-note');
  if (n) n.textContent = msg || '';
}

// الحالات الأربعة المطلوبة: denied / unavailable (بما فيها location services disabled على
// مستوى النظام، اللي المتصفح مش بيميزها عن unavailable بكود مختلف) / timeout.
function geolocationErrorMessage(err) {
  if (!err || typeof err.code !== 'number') return 'تعذر تحديد الموقع، حاول مرة أخرى.';
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'تم رفض إذن الموقع. يمكنك تفعيله لاحقًا من إعدادات المتصفح أو الجهاز.';
    case err.POSITION_UNAVAILABLE:
      return 'تعذر تحديد الموقع - تأكد من تفعيل خدمة الموقع (GPS) على جهازك.';
    case err.TIMEOUT:
      return 'استغرق تحديد الموقع وقتًا طويلاً. تأكد من اتصالك وحاول مرة أخرى.';
    default:
      return 'تعذر تحديد الموقع، حاول مرة أخرى.';
  }
}

function requestRealGeolocation() {
  setNote('جاري تحديد موقعك...');
  if (!('geolocation' in navigator)) {
    setNote('متصفحك لا يدعم تحديد الموقع.');
    setTimeout(hideScreenEl, 1200);
    return;
  }
  // النداء الحقيقي الوحيد - ده اللي بيطلع نافذة إذن المتصفح/النظام الفعلية، مفيش أي بديل مزيّف.
  navigator.geolocation.getCurrentPosition(
    () => { hideScreenEl(); },
    (err) => {
      setNote(geolocationErrorMessage(err));
      setTimeout(hideScreenEl, 2200);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

// نقطة الدخول الوحيدة: بتتنده مرة واحدة عند فتح التطبيق (main.js). بتفحص حالة الإذن الحالية
// وبتقرر تعرض الشاشة ولا لأ - مفيش أي تكرار لو الإذن اتحدد قبل كده (granted أو denied).
export function initLocationPermissionGate() {
  try {
    if (!('geolocation' in navigator)) return; // مفيش داعي نعرض شاشة لموقع مش مدعوم أصلاً
    if (wasDismissedBefore()) return; // المستخدم قال "ليس الآن" قبل كده - منعرضهاش تاني
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' })
        .then((status) => {
          if (status.state === 'granted' || status.state === 'denied') return; // كمل عادي، صفر شاشة
          showScreenEl();
        })
        .catch(() => {
          // بعض المتصفحات بترفض الاستعلام ده حتى لو الـ API نفسها موجودة - نرجع لنفس fallback
          // الـ localStorage تحت عشان منزعجش المستخدم بشاشة على كل تحميل صفحة.
          fallbackShowOnce();
        });
    } else {
      fallbackShowOnce(); // متصفح من غير Permissions API خالص (زي بعض نسخ Safari القديمة)
    }
  } catch (e) {
    console.error('تعذر فحص حالة إذن الموقع:', e);
  }
}

function fallbackShowOnce() {
  try {
    if (window.localStorage && window.localStorage.getItem(SHOWN_FLAG_KEY)) return; // اتعرضت قبل كده
    if (window.localStorage) window.localStorage.setItem(SHOWN_FLAG_KEY, '1');
  } catch (e) { /* localStorage غير متاح - نكمل ونعرض الشاشة مرة واحدة بس لهذا التحميل */ }
  showScreenEl();
}
