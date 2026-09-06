// ===== geo-utils.js =====
// جديد (Maps & Tracking Hardening - P1 توحيد المسافات).
//
// ليه ملف منفصل بالذات؟ أول محاولة كانت إن maps.js يعمل import مباشر لـ _distMeters من
// driver.js (زي ما rides.js و external.js بيعملوا فعلاً من قبل من غير مشاكل). لكن ثبت
// بالاختبار الفعلي (تحميل شجرة الموديولات كاملة) إن ده بيكسر التطبيق بالكامل عند التحميل:
// maps.js موجود في مكان "فوقاني" جدًا في شجرة الاعتماديات (orders.js بيعمله import، وdriver.js
// نفسه بيعمله import، وmerchant.js كمان) - فلما maps.js نفسه يعمل import لـ driver.js، بيتقفل
// Cycle جديد يخلي admin.js (اللي بيعمل import لـ driver.js قبل orders.js في نفس السطور) يوصل
// لسطره اللي بيستخدم ORDER_STATUS.* على مستوى الموديول (FILTER_GROUPS) قبل ما orders.js يكون
// خلص تنفيذ export const ORDER_STATUS بتاعته فعليًا - النتيجة: ReferenceError "Cannot access
// 'ORDER_STATUS' before initialization" في تحميل التطبيق كله، مش بس في التتبع. اتأكد الاختبار
// ده بعزل السطر وإرجاعه (راجع تقرير QA للتفاصيل).
//
// الحل: دالة الـ Haversine الموحّدة بتتحط هنا في موديول مالوش أي import خالص، عشان محدش
// يقدر يعمل بيها Cycle مهما كان مكانه في الشجرة. driver.js بيعمل Re-export منها بنفس الاسم
// القديم (_distMeters) عشان أي كود موجود بيستوردها من driver.js (rides.js, external.js) يفضل
// شغال زي ما هو من غير أي تعديل. maps.js بيستوردها هنا مباشرة.
export function distMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
