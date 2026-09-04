// ===== merchant.js — شاشات التاجر: الطلبات والمنتجات =====

import { addDoc, collection, db, deleteDoc, doc, getDoc, limit, orderBy, query, runTransaction, serverTimestamp, updateDoc, where } from './firebase.js';
import { SL, closeModal, esc, normalizeStatus, onListenersCleared, onSnapshot, orderStatusBadge, secureCloudinaryUpload, showToast } from './utils.js';
import { icon } from './icons.js';
import { logAudit, openEditProd } from './admin.js';
import { compressImage } from './driver.js';
import { MERCHANT_CANCELLABLE_STATUSES, ORDER_STATUS, merchCancelOrd, merchantRespond, transitionOrder } from './orders.js';
import { openLocationPicker } from './maps.js';

// ===== MERCHANT FUNCTIONS =====
export function loadMerchantData() {
  const ud = window.CUD;
  if (ud) document.getElementById('merch-name').textContent = ud.storeName||ud.name||'متجرك';
  loadMerchantOrders();
  loadMerchantProds();
  refreshMerchantLocStatus();
}

// ===== STORE LOCATION (Map Sprint - القسم 3/12) =====
// جديد: كانت وثائق /stores مفيهاش lat/lng خالص وممنوع Rules-يًا حتى لو حاول التاجر يبعتهم -
// اتفتح المسار في firestore.rules Sprint اللي فات، ودلوقتي هنا أول واجهة فعلية بتستخدمه.
async function refreshMerchantLocStatus() {
  const statusEl = document.getElementById('merch-loc-status');
  const btnEl = document.getElementById('merch-loc-btn');
  const titleEl = document.getElementById('merch-loc-title');
  if (!statusEl || !window.CU) return;
  try {
    const snap = await getDoc(doc(db, 'stores', window.CU.uid));
    const sd = snap.exists() ? snap.data() : null;
    if (sd && typeof sd.lat === 'number' && typeof sd.lng === 'number') {
      if (titleEl) titleEl.textContent = 'موقع المتجر';
      statusEl.innerHTML = icon('check-circle', 12) + ' الموقع محدد - اضغط للتعديل';
      if (btnEl) btnEl.classList.remove('menu-item--urgent');
      window._merchStoreLoc = [sd.lat, sd.lng];
    } else {
      // جديد (P5 - Launch Polish): الحالة دي كانت شكلها زي أي حقل عادي غير مهم، مع إن مسافة
      // التوصيل الفعلية (P4) بتتحسب من موقع المتجر - لسه صفر تغيير في منطق الحفظ/القراءة نفسه.
      if (titleEl) titleEl.textContent = 'أكمل موقع متجرك لاستقبال طلبات التوصيل';
      statusEl.innerHTML = icon('alert-triangle', 12) + ' لم يتم التحديد بعد - اضغط للتحديد الآن';
      if (btnEl) btnEl.classList.add('menu-item--urgent');
      window._merchStoreLoc = null;
    }
  } catch (e) { /* Best-effort - فشل القراءة مايكسرش لوحة التاجر */ }
}

export function openMerchantLocationPicker() {
  if (!window.CU) return;
  openLocationPicker({
    title: 'تحديد موقع المتجر',
    initialLoc: window._merchStoreLoc || null,
    onConfirm: async ({ lat, lng }) => {
      try {
        await updateDoc(doc(db, 'stores', window.CU.uid), { lat, lng, updatedAt: serverTimestamp() });
        window._merchStoreLoc = [lat, lng];
        showToast('تم حفظ موقع المتجر', 'ok');
        refreshMerchantLocStatus();
      } catch (e) {
        showToast('تعذر حفظ الموقع، حاول مرة أخرى', 'err');
      }
    },
  });
}

export let merchantOrdersUnsub = null;
export function loadMerchantOrders() {
  if (!window.CU) return;
  if (merchantOrdersUnsub) return;
  const q = query(collection(db,'orders'), where('storeId','==',window.CU.uid), orderBy('createdAt','desc'), limit(20));
  merchantOrdersUnsub = onSnapshot(q, snap => {
    const today = new Date().toDateString(); let tOrd=0, tRev=0;
    if (snap.empty) { document.getElementById('merch-ords-list').innerHTML='<div class="empty-state"><div class="ei">'+icon('package',40)+'</div><p>لا توجد طلبات بعد</p></div>'; return; }
    let html='';
    snap.forEach(d => {
      const o={...d.data(),id:d.id};
      const dt=o.createdAt?.toDate?o.createdAt.toDate():new Date();
      if(dt.toDateString()===today){tOrd++;tRev+=o.total||0;}
      const st = normalizeStatus(o.status);
      html+=`<div class="merch-ord-card">
        <div class="merch-ord-top"><span style="font-size:11px;font-weight:700;color:var(--mu)">#${d.id.slice(-6).toUpperCase()}</span>${orderStatusBadge(o.status)}</div>
        <div style="font-size:12px;color:var(--mu);display:flex;align-items:center;gap:4px">${icon('user',13)} ${esc(o.customerName)||'عميل'} • ${o.total||0} ج</div>
        <div style="font-size:11px;margin-top:4px">${(o.items||[]).map(i=>`${esc(i.name)} x${i.qty}`).join('، ')}</div>
        <div class="merch-ord-acts">
          ${st===ORDER_STATUS.WAITING_MERCHANT?`<button class="mo-btn mo-acc" onclick="merchAcceptOrd('${d.id}')">${icon('check-circle',13)} قبول</button><button class="mo-btn mo-rej" onclick="merchRejectOrd('${d.id}')">${icon('x-circle',13)} رفض</button>`:''}
          ${(st===ORDER_STATUS.MERCHANT_ACCEPTED||st===ORDER_STATUS.SEARCHING_DRIVER)?`<span style="font-size:11px;color:var(--mu);font-weight:600;display:inline-flex;align-items:center;gap:4px">${icon('search',13)} جاري البحث عن مندوب...</span>`:''}
          ${(st===ORDER_STATUS.DRIVER_ASSIGNED||st===ORDER_STATUS.DRIVER_ARRIVED)?`<span style="font-size:11px;color:var(--ok);font-weight:600;display:inline-flex;align-items:center;gap:4px">${icon('bike',13)} المندوب في الطريق للاستلام</span>`:''}
          ${MERCHANT_CANCELLABLE_STATUSES.includes(st)?`<button class="mo-btn mo-rej" onclick="merchCancelOrdUI('${d.id}')">إلغاء الطلب</button>`:''}
        </div>
      </div>`;
    });
    document.getElementById('merch-ords-list').innerHTML=html;
    document.getElementById('m-today-ords').textContent=tOrd;
    document.getElementById('m-today-rev').textContent=tRev+' ج';
  });
}

export async function merchAcceptOrd(id) {
  try {
    const actor = { type: 'merchant', uid: window.CU?.uid, name: window.CUD?.storeName || window.CUD?.name };
    await merchantRespond(id, true, actor);
    showToast('تم قبول الطلب، جاري البحث عن مندوب','ok');
  } catch(e) { showToast(e?.message==='invalid-transition' ? 'تم اتخاذ إجراء على هذا الطلب بالفعل' : 'حدث خطأ','err'); }
}
export async function merchRejectOrd(id) {
  try {
    const actor = { type: 'merchant', uid: window.CU?.uid, name: window.CUD?.storeName || window.CUD?.name };
    await merchantRespond(id, false, actor);
    showToast('تم رفض الطلب','ok');
  } catch(e) { showToast(e?.message==='invalid-transition' ? 'تم اتخاذ إجراء على هذا الطلب بالفعل' : 'حدث خطأ','err'); }
}

// إلغاء التاجر لطلب من متجره - بيستخدم نفس معمارية transitionOrder/runTransaction (زي زراير
// القبول/الرفض بالظبط)، مفيش updateDoc مباشر. الحماية الحقيقية (لحد أي حالة يقدر يلغي) في
// Firestore Rules، والقائمة اللي بتحدد ظهور الزرار (MERCHANT_CANCELLABLE_STATUSES) مستوردة
// من orders.js عشان تفضل مصدر واحد للحقيقة مع باقي التطبيق.
export async function merchCancelOrdUI(id) {
  if (!confirm('هل أنت متأكد من إلغاء هذا الطلب؟')) return;
  try {
    const actor = { type: 'merchant', uid: window.CU?.uid, name: window.CUD?.storeName || window.CUD?.name };
    await merchCancelOrd(id, actor);
    showToast('تم إلغاء الطلب', 'ok');
  } catch (e) {
    showToast(e?.message === 'invalid-transition' ? 'لا يمكن إلغاء الطلب في هذه المرحلة' : 'حدث خطأ', 'err');
  }
}

export let merchantProdsUnsub = null;
export function loadMerchantProds() {
  if(!window.CU)return;
  if(merchantProdsUnsub)return;
  const q=query(collection(db,'products'),where('merchantId','==',window.CU.uid));
  merchantProdsUnsub=onSnapshot(q,snap=>{
    document.getElementById('m-prods').textContent=snap.size;
    if(snap.empty){document.getElementById('merch-prods-list').innerHTML='<div class="empty-state"><div class="ei">'+icon('package',40)+'</div><p>لا توجد منتجات</p><small>اضغط "إضافة منتج"</small></div>';return;}
    let html='';
    snap.forEach(d=>{
      const p={...d.data(),id:d.id};
      html+=`<div class="row-card">
        <div class="thumb-md">${prodThumbHtml(p,22)}</div>
        <div style="flex:1"><strong style="font-size:13px;font-weight:800;display:block">${esc(p.name)}</strong><small style="color:var(--mu);font-size:11px">${esc(p.unit)}${p.stock!=null?' • الكمية: '+p.stock:''}</small>
          <div style="font-size:14px;font-weight:900;color:var(--p);margin-top:3px">${p.price} ج</div>
          <div style="display:flex;gap:5px;margin-top:6px;align-items:center">
            <button class="mb2 mb-view" onclick='openEditProd(${JSON.stringify(p).replace(/</g,"\\u003c")})'>${icon('edit',13)} تعديل</button>
            <button class="mb2 mb-rej" onclick="delProd('${d.id}')">${icon('trash',13)} حذف</button>
            <span style="font-size:10px;font-weight:700;color:${p.available!==false?'var(--ok)':'var(--danger)'};display:inline-flex;align-items:center;gap:3px">${p.available!==false?icon('check-circle',12)+' متاح':icon('x-circle',12)+' غير متاح'}</span>
          </div>
        </div>
      </div>`;
    });
    document.getElementById('merch-prods-list').innerHTML=html;
  });
}

export function openAddProd(){
  removeProductImage('ap'); // تصفير أي صورة من محاولة إضافة سابقة اتلغت - نفس مبدأ الأمان المطبق على Location Picker (Phase 2B)
  document.getElementById('add-prod-modal').classList.add('open');
}

// ===== صورة المنتج (بدل خاصية "أيقونة emoji") =====
// بتعيد استخدام بالظبط نفس الـ pipeline المستخدم فعليًا لرفع مستندات المندوب (driver.js):
// نفس فحص النوع/الحجم، نفس compressImage()، نفس secureCloudinaryUpload() الموجودة بالفعل في
// utils.js - صفر Storage provider جديد وصفر مكتبة جديدة. state منفصلة لكل نموذج (ap = إضافة،
// ep = تعديل) عشان الاتنين يشتغلوا مستقلين عن بعض من غير تعارض.
const pendingProdImg = { ap: null, ep: null, ac: null, ac2: null };
export function getPendingProdImage(prefix) { return pendingProdImg[prefix] ?? null; }

export function uploadProductImage(prefix) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('لازم ترفع صورة بس (JPG أو PNG)', 'err'); return; }
    const maxSizeMB = 8;
    if (file.size > maxSizeMB * 1024 * 1024) { showToast(`حجم الصورة كبير جدًا (الحد الأقصى ${maxSizeMB} ميجا)`, 'err'); return; }
    const wrap = document.getElementById(prefix + '-img-wrap');
    wrap.innerHTML = `<div class="upload-box"><div class="u-ic">${icon('loader', 24)}</div><p style="font-size:12px">جارٍ ضغط ورفع الصورة...</p></div>`;
    try {
      const compressed = await compressImage(file);
      const url = await secureCloudinaryUpload(compressed);
      pendingProdImg[prefix] = url;
      renderProdImgPreview(prefix, url);
    } catch (e) {
      wrap.innerHTML = `<div class="upload-box" onclick="uploadProductImage('${prefix}')"><div class="u-ic">${icon('camera', 24)}</div><p style="font-size:12px;color:#E11">فشل الرفع، اضغط للمحاولة تاني</p></div>`;
      showToast('فشل رفع الصورة، حاول تاني', 'err');
    }
  };
  inp.click();
}
export function renderProdImgPreview(prefix, url) {
  pendingProdImg[prefix] = url;
  const wrap = document.getElementById(prefix + '-img-wrap');
  if (!wrap) return;
  wrap.innerHTML = `<div class="doc-preview">
    <img src="${esc(url)}" alt="صورة المنتج">
    <div class="doc-preview-acts">
      <button onclick="uploadProductImage('${prefix}')">${icon('refresh', 14)} تغيير</button>
      <button onclick="removeProductImage('${prefix}')">${icon('trash', 14)} حذف</button>
    </div>
  </div>`;
}
export function removeProductImage(prefix) {
  pendingProdImg[prefix] = null;
  const wrap = document.getElementById(prefix + '-img-wrap');
  if (!wrap) return;
  wrap.innerHTML = `<div class="upload-box" onclick="uploadProductImage('${prefix}')"><div class="u-ic">${icon('camera', 24)}</div><p>اختر صورة المنتج</p></div>`;
}

// أيقونة/صورة محايدة احترافية بدل أي fallback بـ Emoji - تُستخدم في كل مكان يُعرض فيه منتج
// من غير صورة (سواء منتج جديد من غير صورة، أو منتج قديم لسه معاه الحقل القديم icon فقط).
export function prodThumbHtml(p, size) {
  if (p.imageUrl) return `<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" style="width:100%;height:100%;object-fit:cover">`;
  return icon('image', size);
}
export async function saveProd(){
  const name=document.getElementById('ap-name').value.trim();
  const cat=document.getElementById('ap-cat').value;
  const unit=document.getElementById('ap-unit').value.trim();
  const price=parseFloat(document.getElementById('ap-price').value)||0;
  const imageUrl = pendingProdImg.ap || null;
  if(!name||!price){showToast('يرجى تعبئة الاسم والسعر','err');return;}
  const merchantId = window.adminTargetStore || window.CU?.uid;
  if(!merchantId)return;
  try{
    const storeName = window.adminTargetStore
      ? (document.getElementById('sm-name')?.value || 'متجر')
      : (window.CUD?.storeName||window.CUD?.name||'متجر');
    await addDoc(collection(db,'products'),{merchantId,storeName,name,cat,unit,price,imageUrl,available:true,createdAt:serverTimestamp()});
    closeModal('add-prod-modal');
    ['ap-name','ap-price','ap-unit'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
    removeProductImage('ap');
    if(window.adminTargetStore) logAudit('إضافة منتج (أدمن)', name+' — '+storeName);
    showToast('تم إضافة المنتج','ok');
  }catch(e){showToast('حدث خطأ','err');}
}
export async function delProd(id){
  try{await deleteDoc(doc(db,'products',id));showToast('تم حذف المنتج','ok');}catch(e){showToast('حدث خطأ','err');}
}

// --- رقم طلب تسلسلي: D1001, D1002, D1003... باستخدام عداد مركزي في Firestore ---
export async function getNextRequestId(counterName, prefix){
  const counterRef = doc(db,'counters',counterName);
  const seq = await runTransaction(db, async (t) => {
    const snap = await t.get(counterRef);
    const current = snap.exists() ? snap.data().seq : 1000;
    const next = current + 1;
    if (snap.exists()) t.update(counterRef, { seq: next });
    else t.set(counterRef, { seq: next });
    return next;
  });
  return prefix + seq;
}



// ===== تصفير أعلام المتابعة عند تسجيل الخروج (بيتنفذ من utils.js عبر clearAllListeners) =====
export function registerMerchantResets() {
  onListenersCleared(() => {
  merchantOrdersUnsub = null; merchantProdsUnsub = null;
  });
}
