// ===== pricing.js — Shared Pricing Engine (Ride Service Integration Plan، القرار 3) =====
// نقطة واحدة فقط لحساب أي سعر في التطبيق (توصيل أو مشاوير مستقبلًا). صفر أسعار Hardcoded هنا
// أو في أي مكان تاني - كل حاجة بتيجي من settings/pricing. نفس المنطق بالظبط مطبّق تاني في
// firestore.rules (دالة calculatePrice المكافئة) للتحقق السيرفري - لازم أي تعديل هنا يترافق
// بتعديل مطابق هناك (موثّق فوق كل دالة في الـ Rules بنفس الاسم للتسهيل).

import { collection, db, doc, getDoc, serverTimestamp, setDoc } from './firebase.js';

// ===== قراءة إعدادات التسعير الحالية (نسخة واحدة، تُقرأ عند الحاجة - مش Listener دائم لأن
// التسعير مش بيتغيّر كتير، وده يوفّر قراءات مستمرة غير ضرورية) =====
export async function getPricingConfig() {
  const snap = await getDoc(doc(db, 'settings', 'pricing'));
  if (!snap.exists()) throw new Error('pricing-not-configured');
  return snap.data();
}

// ===== المحرك: نفس المعادلة لأي خدمة =====
// finalFare = max(minimumFare, baseFare + (distanceKm × perKmRate) + bookingFee)
// serviceType: 'delivery' | 'ride'
// params: { distanceKm } (اختياري - لو مش موجودة بتتحسب كـ 0، يعني سعر ثابت بدون مكوّن مسافة)
export function calculateFare(pricingConfig, serviceType, params = {}) {
  const cfg = pricingConfig?.[serviceType];
  if (!cfg) throw new Error(`pricing-missing-${serviceType}`);
  const distanceKm = Number(params.distanceKm) || 0;
  const baseFare = Number(cfg.baseFare) || 0;
  const perKmRate = Number(cfg.perKmRate) || 0;
  const minimumFare = Number(cfg.minimumFare) || 0;
  const bookingFee = Number(cfg.bookingFee) || 0;
  const subtotal = baseFare + (distanceKm * perKmRate) + bookingFee;
  const finalFare = Math.max(subtotal, minimumFare);
  return {
    pricingVersion: pricingConfig.pricingVersion || 1,
    serviceType,
    baseFare, perKmRate, minimumFare, bookingFee,
    calculatedDistanceKm: distanceKm,
    estimatedDurationMinutes: params.estimatedDurationMinutes ?? null,
    subtotal: Math.round(subtotal),
    finalFare: Math.round(finalFare),
    calculatedAt: Date.now(),
  };
}

// دالة مساعدة تجمع الاتنين (قراءة الإعدادات + الحساب) - بتُستخدم مباشرة من شاشات الحجز
// (Checkout الحالي، وحجز المشوار لاحقًا) لعمل Preview قبل التأكيد.
export async function previewFare(serviceType, params = {}) {
  const cfg = await getPricingConfig();
  return calculateFare(cfg, serviceType, params);
}

// ===== لوحة الإدارة: تحديث الإعدادات + ترقيم الإصدار تلقائيًا (القرار 6) =====
// P17 (D3): third optional param لتسعير "اطلب أي حاجة" (external_purchase) - بنفس أسلوب
// ride/delivery بالحرف (merge:true، صفر قيم افتراضية Hardcoded، نفس ترقيم pricingVersion).
export async function savePricingConfig(newRideCfg, newDeliveryCfg, newExternalCfg) {
  const current = await getDoc(doc(db, 'settings', 'pricing'));
  const nextVersion = (current.exists() ? (current.data().pricingVersion || 1) : 0) + 1;
  const payload = { pricingVersion: nextVersion, updatedAt: serverTimestamp() };
  if (newRideCfg) payload.ride = newRideCfg;
  if (newDeliveryCfg) payload.delivery = newDeliveryCfg;
  if (newExternalCfg) payload.external_purchase = newExternalCfg;
  // merge:true عشان لو عدّلنا خدمة واحدة بس، إعدادات باقي الخدمات (لو مش موجودة أو لسه ما
  // اتحطتش) متتمسحش ومحتاجش تتحط بقيمة افتراضية Hardcoded عشان نحميها.
  await setDoc(doc(db, 'settings', 'pricing'), payload, { merge: true });
  return nextVersion;
}
