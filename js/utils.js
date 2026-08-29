// ===== utils.js — أدوات عامة مشتركة (Logger, XSS escaping, debounce, listener registry, offline handling, رفع Cloudinary, helpers عامة للواجهة) =====

import { onSnapshot as _onSnapshotRaw } from './firebase.js';
import { renderProds } from './customer.js';
import { dregInit } from './driver.js';
import { icon } from './icons.js';

// Toast type ('ok'/'err'/'inf') → أيقونة موحدة (Design System §18) بدل الاعتماد على اللون بس
const TOAST_ICON = { ok: 'check-circle', err: 'alert-circle', inf: 'info' };

// ===== LISTENER REGISTRY (تنظيف onSnapshot تلقائيًا عند تسجيل الخروج) =====
// أي كود في الملف بينده onSnapshot(...) بيتسجل هنا تلقائيًا من غير ما نلمس كل مكان مستخدم فيه.
// ده بيحل مشكلتين: تسريب الذاكرة (listeners بتفضل شغالة بعد تسجيل الخروج)، وتسريب بيانات
// مستخدم لمستخدم تاني بيسجل دخول بعده على نفس الجهاز من غير ما الصفحة تتعمل لها reload.
export const _listeners = [];
const _resetCallbacks = [];
export function onSnapshot(...args) {
  const unsub = _onSnapshotRaw(...args);
  _listeners.push(unsub);
  return unsub;
}
// كل موديول يملك أعلام "already subscribed" (زي productsUnsub) بيسجل هنا دالة تصفّرها،
// بدل ما clearAllListeners يعرف بأسماء متغيرات موديولات تانية (ده كان مستحيل أصلاً بعد
// تقسيم الملف لموديولات ES، لأن مينفعش تعدّل متغير let مستورد من موديول تاني مباشرة).
export function onListenersCleared(cb) { _resetCallbacks.push(cb); }
export function clearAllListeners() {
  _listeners.forEach(u => { try { u(); } catch (e) { Logger.error(e); } });
  _listeners.length = 0;
  _resetCallbacks.forEach(cb => { try { cb(); } catch (e) { Logger.error(e); } });
}


// ===== VEHICLE TYPES (جديد - Phase 2: Ride Foundation) =====
// الأنواع المعتمدة الجديدة. bicycle اتسابت تحت في VEHICLE_LABELS بس عشان العرض فقط
// (سائقين مسجلين بيها فعليًا من قبل) - ممنوع تُستخدم في أي أهلية Ride/Delivery جديدة،
// زي ما اتحدد صراحة. محدش بيقرأ من هنا لسه (Schema جاهز للاستخدام في مراحل لاحقة فقط).
export const VEHICLE_TYPES = ['motorcycle', 'tuktuk', 'car', 'tricycle'];
export const VEHICLE_LABELS_AR = { motorcycle:'موتوسيكل', tuktuk:'توك توك', car:'عربية', tricycle:'تروسيكل', bicycle:'عجلة' };
// أهلية كل نوع مركبة لكل خدمة - bicycle مش موجودة هنا عمدًا (Legacy فقط، مش خيار جديد)
export const DELIVERY_ELIGIBLE_VEHICLES = ['motorcycle', 'tricycle'];
export const RIDE_ELIGIBLE_VEHICLES = ['motorcycle', 'tuktuk', 'car'];


// ===== ORDER STATUS CONSTANTS =====
// ملحوظة: الحالات القديمة (new/accepted/preparing/ready/delivering/done) اتسابت هنا زي ما هي
// عشان أي طلبات موجودة بالفعل في قاعدة البيانات بالحالات دي تفضل تتعرض صح. الحالات الجديدة
// (created/waiting_merchant/...) هي اللي بقى يستخدمها Order Engine الجديد في orders.js.
export const SL = {new:'جديد',accepted:'تم القبول',preparing:'جاري التحضير',ready:'جاهز',delivering:'في الطريق',done:'تم التسليم',cancelled:'ملغي',
  created:'تم إنشاء الطلب', waiting_merchant:'بانتظار موافقة التاجر', merchant_accepted:'تم قبول التاجر',
  merchant_rejected:'تم رفض الطلب من التاجر', searching_driver:'جاري البحث عن مندوب',
  driver_assigned:'تم تعيين مندوب', driver_arrived:'المندوب وصل للمتجر', picked_up:'تم استلام الطلب',
  on_the_way:'في الطريق إليك', delivered:'تم التسليم'};
export const SC = {new:'sb sb-new',accepted:'sb sb-accepted',preparing:'sb sb-preparing',ready:'sb sb-ready',delivering:'sb sb-delivering',done:'sb sb-done',cancelled:'sb sb-cancelled',
  created:'sb sb-new', waiting_merchant:'sb sb-new', merchant_accepted:'sb sb-accepted',
  merchant_rejected:'sb sb-cancelled', searching_driver:'sb sb-accepted', driver_assigned:'sb sb-preparing',
  driver_arrived:'sb sb-preparing', picked_up:'sb sb-ready', on_the_way:'sb sb-delivering', delivered:'sb sb-done'};
// ===== Phase 2 (Premium UI/UX): اعتماد نظام .status/.status--* الموجود بالفعل في التصميم (كان
// معرّف في CSS بس مش مستخدم في أي مكان في المشروع) بدل نظام .sb/.sb-* القديم لعرض حالة الطلب.
// SC نفسها اتسابت زي ما هي بالظبط (لسه Export، لسه بتتستخدم بنفس القيم القديمة لو حد محتاجها) -
// ده إضافة جنبها مش تعديل فيها. المعنى الفعلي لكل حالة هو اللي بيحدد اللون دلوقتي (مش لون
// عشوائي مختلف لكل حالة زي القديم): معلّق فعلًا (pending) / لسه شغالة (progress) / خلصت بنجاح
// (success) / اتلغت أو اترفضت (danger). كل الحالات اللي معناها "الطلب لسه ماشي"
// (accepted/preparing/ready/delivering/...) بتاخد نفس لون status--progress عشان المعنى المشترك
// ده أهم حاجة تتلاحظ بنظرة سريعة - والتفرقة بين كل مرحلة وتانية بتفضل واضحة عن طريق الأيقونة
// المختلفة لكل حالة، مش الاختفاء تمامًا.
const ORDER_STATUS_META = {
  new:['status--pending','clock'], created:['status--pending','clock'], waiting_merchant:['status--pending','clock'],
  accepted:['status--progress','check-circle'], merchant_accepted:['status--progress','check-circle'],
  preparing:['status--progress','utensils'], searching_driver:['status--progress','search'],
  ready:['status--progress','package'], driver_assigned:['status--progress','bike'],
  driver_arrived:['status--progress','map-pin'], picked_up:['status--progress','package'],
  delivering:['status--progress','bike'], on_the_way:['status--progress','bike'],
  done:['status--success','check-circle'], delivered:['status--success','check-circle'],
  cancelled:['status--danger','x-circle'], merchant_rejected:['status--danger','x-circle'],
};
export function orderStatusBadge(status) {
  const [cls, ic] = ORDER_STATUS_META[status] || ['status--neutral','clock'];
  return `<span class="status ${cls}">${icon(ic,12)} ${SL[status]||'--'}</span>`;
}
// STEPS القديمة (لسه موجودة، مفيش حاجة تانية بتعتمد عليها غير الطلبات القديمة جدًا لو لقيناها)
export const STEPS = ['new','accepted','preparing','ready','delivering','done'];
export const STEP_LABELS = ['جديد','تم القبول','جاري التحضير','جاهز للاستلام','في الطريق','تم التسليم'];
// خطوات التتبع الجديدة (Order Engine) — دي اللي شاشة تتبع الطلب بتستخدمها دلوقتي
export const NEW_STEPS = ['waiting_merchant','merchant_accepted','searching_driver','driver_assigned','driver_arrived','picked_up','on_the_way','delivered'];
export const NEW_STEP_ICON_NAMES = ['clock','store','search','bike','map-pin','package','bike','check-circle'];
export const NEW_STEP_ICONS = NEW_STEP_ICON_NAMES.map(n => icon(n, 14));
export const NEW_STEP_LABELS = ['بانتظار التاجر','تم قبول التاجر','بحث عن مندوب','تم تعيين مندوب','وصل المندوب','تم الاستلام','في الطريق','تم التسليم'];
// تطبيع حالة أي طلب قديم لأقرب حالة في النظام الجديد (لأغراض العرض فقط، مفيش أي تعديل على البيانات المخزنة)
const LEGACY_STATUS_MAP = {new:'waiting_merchant',accepted:'merchant_accepted',preparing:'searching_driver',ready:'driver_assigned',delivering:'on_the_way',done:'delivered',cancelled:'cancelled'};
export function normalizeStatus(status) { return LEGACY_STATUS_MAP[status] || status; }


// ===== LOGGER (بديل موحد لـ console.log) =====
const DEV_MODE = false; // خليها true وقت التطوير فقط
export const Logger = {
  info: (...a) => { if (DEV_MODE) console.log('[INFO]', ...a); },
  warn: (...a) => { if (DEV_MODE) console.warn('[WARN]', ...a); },
  error: (...a) => { console.error('[ERROR]', ...a); } // الأخطاء تتسجل دايمًا
};


// ===== DEBOUNCE =====
export function debounce(fn, wait = 300) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}


// ===== OFFLINE HANDLING =====
export function initOfflineHandling() {
  window.addEventListener('offline', () => showToast('لا يوجد اتصال بالإنترنت', 'err'));
  window.addEventListener('online', () => showToast('تم استعادة الاتصال', 'ok'));
}


// ===== XSS PROTECTION =====
// أي نص جاي من قاعدة البيانات (اسم منتج، اسم متجر، اسم مستخدم...) لازم يعدي من هنا
// قبل ما يتحط جوه innerHTML، عشان محدش يقدر يحط <script> أو onerror داخل اسمه ويشغّل كود عند غيره.
export function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
// نسخة خاصة بالنصوص اللي بتتحط جوه onclick="...('نص')" لأن السياق هنا HTML attribute
// وجوّاه كود JS في نفس الوقت، فلازم نأمّن الاتنين مع بعض.
export function escJs(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


// ===== SECURE CLOUDINARY UPLOAD =====
// بدل ما نستخدم upload_preset مفتوح (أي حد يقدر يرفع بيه من برة التطبيق)،
// بنجيب توقيع (signature) صالح لمدة دقايق من الـ Worker قبل كل رفعة، والتوقيع ده مربوط
// بالتوقيت فبيبقى صالح لفترة قصيرة بس، فمينفعش حد يستخدمه غير من جوه التطبيق وقت الرفع.
export const CLOUDINARY_SIGN_URL = 'https://manayef-cloudinary-sign.mohamedselim3121998.workers.dev';
export async function secureCloudinaryUpload(file) {
  const signRes = await fetch(CLOUDINARY_SIGN_URL);
  if (!signRes.ok) throw new Error('sign failed');
  const { timestamp, signature, apiKey, cloudName, folder } = await signRes.json();
  const fd = new FormData();
  fd.append('file', file);
  fd.append('api_key', apiKey);
  fd.append('timestamp', timestamp);
  fd.append('signature', signature);
  fd.append('folder', folder);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method:'POST', body:fd });
  const result = await res.json();
  if (!result.secure_url) throw new Error('upload failed');
  return result.secure_url;
}


// ===== HELPERS =====
export function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active');window.scrollTo(0,0);if(id==='screen-driver-register')dregInit();}
export function showToast(msg,type=''){const t=document.getElementById('toast');const ic=TOAST_ICON[type]||'info';t.innerHTML=icon(ic,18)+'<span>'+esc(msg)+'</span>';t.className='toast'+(type?' '+type:'');t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000);}
export function showErr(msg){const e=document.getElementById('err-msg');e.textContent=msg;e.style.display='block';e.scrollIntoView({behavior:'smooth',block:'center'});}
export function setLoad(btnId,spId,on){const btn=document.getElementById(btnId);const sp=spId?document.getElementById(spId):null;if(btn)btn.disabled=on;if(sp)sp.style.display=on?'block':'none';}
export function callStore(num){window.location.href='tel:'+num;}
export function openWA(num,name){window.open('https://wa.me/'+num+'?text=أهلاً، أريد الطلب من '+name,'_blank');}
export function callCurrentStore(){ if(!window.currentStorePhone){showToast('رقم المتجر غير متاح','err');return;} callStore(window.currentStorePhone); }
export function waCurrentStore(){ if(!window.currentStorePhone){showToast('رقم المتجر غير متاح','err');return;} openWA(window.currentStorePhone, window.currentStoreName||'المتجر'); }
export function closeModal(id){document.getElementById(id).classList.remove('open');}
export function openNotifs(){document.getElementById('notif-overlay').classList.add('open');}

export function filterProds(cat, btn) {
  document.querySelectorAll('.pc-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderProds(cat);
}
