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
  merchNav('dashboard', document.querySelector('#screen-merchant .nav-item'));
  loadMerchantOrders();
  loadMerchantProds();
  refreshMerchantLocStatus();
}

// ===== P15 — لوحة تحكم التاجر الاحترافية: تنقّل بـ 5 أقسام (لوحة التحكم/الطلبات/المنتجات/
// المتجر/الحساب) بدل الشاشة الواحدة المزدحمة. نفس النمط بالحرف المستخدم فعليًا في drvNav
// (driver.js) - Tabs بـ style.display، صفر مكتبة routing جديدة، صفر Listener إضافي (الطلبات
// والمنتجات بيتحمّلوا مرة واحدة زي الأول عبر merchantOrdersUnsub/merchantProdsUnsub الموجودين
// أصلًا، والتبديل بين الأقسام مجرد إخفاء/إظهار Divs). =====
export function merchNav(tab, el) {
  document.querySelectorAll('#screen-merchant .nav-item').forEach(n=>n.classList.remove('active'));
  if (el) el.classList.add('active');
  const tabs = { dashboard:'merch-dash-tab', orders:'merch-orders-tab', products:'merch-products-tab', store:'merch-store-tab', account:'merch-account-tab' };
  Object.entries(tabs).forEach(([t,id])=>{ const e=document.getElementById(id); if(e) e.style.display = t===tab?'block':'none'; });
  if (tab==='dashboard') { renderMerchDashStatus(); renderMerchAlerts(); }
  else if (tab==='store') mstLoadProfile();
  else if (tab==='account') loadMerchantAccount();
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
    // جديد (P15 - Dashboard): نفس مستند stores/{uid} اللي اتقرا فوق بيحمل isOpen كمان - بنستخدمه
    // كمصدر حالة "مفتوح/مغلق" للوحة التحكم بدل ما نعمل getDoc تاني منفصل لنفس المستند.
    window._mstIsOpen = sd ? (sd.isOpen !== false) : true;
    renderMerchDashStatus();
    renderMerchAlerts();
  } catch (e) { /* Best-effort - فشل القراءة مايكسرش لوحة التاجر */ }
}

// ===== P15 — حالة المتجر (مفتوح/مغلق) + تنبيهات لوحة التحكم =====
function renderMerchDashStatus() {
  const el = document.getElementById('merch-dash-status');
  if (!el) return;
  const isOpen = window._mstIsOpen !== false;
  el.innerHTML = `<span class="status ${isOpen?'status--success':'status--danger'}">${icon(isOpen?'check-circle':'x-circle',12)} ${isOpen?'المتجر مفتوح':'المتجر مغلق'}</span>`;
}

function renderMerchAlerts() {
  const box = document.getElementById('merch-alerts');
  if (!box) return;
  let html = '';
  if (window._mstIsOpen === false) {
    html += `<div class="menu-item menu-item--urgent"><div class="mi-ic">${icon('alert-triangle',18)}</div><div class="mi-text"><strong>المتجر مغلق حاليًا</strong><small>العملاء مش هيقدروا يطلبوا منك دلوقتي</small></div></div>`;
  }
  if (window._merchStoreLoc == null) {
    html += `<button class="menu-item menu-item--urgent" style="width:100%" onclick="openMerchantLocationPicker()"><div class="mi-ic">${icon('map-pin',18)}</div><div class="mi-text"><strong>موقع المتجر غير محدد</strong><small>حدد موقعك عشان تستقبل طلبات توصيل دقيقة</small></div><span class="mi-arr">${icon('chevron-left',16)}</span></button>`;
  }
  if (_merchUnavailCount > 0) {
    html += `<button class="menu-item" style="width:100%" onclick="merchNav('products', document.querySelectorAll('#screen-merchant .nav-item')[2])"><div class="mi-ic">${icon('package',18)}</div><div class="mi-text"><strong>${_merchUnavailCount} منتج غير متاح</strong><small>راجع منتجاتك في قسم المنتجات</small></div></button>`;
  }
  box.innerHTML = html;
  box.style.display = html ? 'flex' : 'none';
}

// تبديل سريع لحالة المتجر من لوحة التحكم مباشرة - نفس حقل isOpen بالظبط اللي بتحفظه شاشة
// "المتجر" (mstSaveProfile)، وبنفس صلاحية الكتابة المضافة في firestore.rules.
export async function merchQuickToggleOpen() {
  if (!window.CU) return;
  const next = !(window._mstIsOpen !== false);
  try {
    await updateDoc(doc(db,'stores',window.CU.uid), { isOpen: next, updatedAt: serverTimestamp() });
    window._mstIsOpen = next;
    renderMerchDashStatus(); renderMerchAlerts();
    showToast(next?'المتجر مفتوح الآن':'المتجر مغلق الآن','ok');
  } catch(e) { showToast('حدث خطأ','err'); }
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
          ${(st===ORDER_STATUS.MERCHANT_ACCEPTED||st===ORDER_STATUS.SEARCHING_DRIVER)?`<span style="font-size:11px;color:var(--mu);font-weight:600;display:inline-flex;align-items:center;gap:4px">${icon('search',13)} جاري البحث عن كابتن...</span>`:''}
          ${(st===ORDER_STATUS.DRIVER_ASSIGNED||st===ORDER_STATUS.DRIVER_ARRIVED)?`<span style="font-size:11px;color:var(--ok);font-weight:600;display:inline-flex;align-items:center;gap:4px">${icon('bike',13)} الكابتن في الطريق للاستلام</span>`:''}
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
    showToast('تم قبول الطلب، جاري البحث عن كابتن','ok');
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
let _merchUnavailCount = 0;
export function loadMerchantProds() {
  if(!window.CU)return;
  if(merchantProdsUnsub)return;
  const q=query(collection(db,'products'),where('merchantId','==',window.CU.uid));
  merchantProdsUnsub=onSnapshot(q,snap=>{
    document.getElementById('m-prods').textContent=snap.size;
    _merchUnavailCount = 0;
    if(snap.empty){document.getElementById('merch-prods-list').innerHTML='<div class="empty-state"><div class="ei">'+icon('package',40)+'</div><p>لا توجد منتجات</p><small>اضغط "إضافة منتج"</small></div>';renderMerchAlerts();return;}
    let html='';
    snap.forEach(d=>{
      const p={...d.data(),id:d.id};
      if (p.available===false) _merchUnavailCount++;
      html+=`<div class="row-card">
        <div class="thumb-md">${prodThumbHtml(p,22)}</div>
        <div style="flex:1"><strong style="font-size:13px;font-weight:800;display:block">${esc(p.name)}</strong><small style="color:var(--mu);font-size:11px">${esc(p.unit)}${p.stock!=null?' • الكمية: '+p.stock:''}</small>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:3px">
            <div style="font-size:14px;font-weight:900;color:var(--p)">${p.price} ج</div>
            <span style="font-size:10px;font-weight:700;color:${p.available!==false?'var(--ok)':'var(--danger)'};display:inline-flex;align-items:center;gap:3px">${p.available!==false?icon('check-circle',12)+' متاح':icon('x-circle',12)+' غير متاح'}</span>
          </div>
          <div style="display:flex;gap:5px;margin-top:6px;align-items:center">
            <button class="mb2 mb-view" onclick='openEditProd(${JSON.stringify(p).replace(/</g,"\\u003c")})'>${icon('edit',13)} تعديل</button>
            <button class="mb2 ${p.available!==false?'mb-rej':'mb-acc'}" onclick="merchToggleProdAvail('${d.id}',${p.available!==false})">${p.available!==false?icon('pause',13)+' إيقاف':icon('play',13)+' تفعيل'}</button>
            <button class="mb2 mb-rej" onclick="delProd('${d.id}')">${icon('trash',13)} حذف</button>
          </div>
        </div>
      </div>`;
    });
    document.getElementById('merch-prods-list').innerHTML=html;
    renderMerchAlerts();
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

// ===== P15.1 — تفعيل/إيقاف المنتج (كانت ناقصة من شاشة "المنتجات" رغم إنها كانت مطلوبة في P15
// الأصلي). عمدًا دالة منفصلة عن toggleProdAvail المشتركة في admin.js بدل استدعائها مباشرة: تلك
// الدالة بتنده logAudit() في الآخر، وده بيكتب في auditLog اللي قاعدته Admin-only في
// firestore.rules - نداءها من حساب تاجر كان هيفشل بصمت (try/catch فاضي) في كل مرة يفعّل/يوقف
// فيها منتج. هنا نفس منطق التحديث بالظبط على المنتج (مسموح بالفعل للتاجر مالك المنتج حسب قاعدة
// products/{id} الحالية - صفر تغيير في firestore.rules) من غير أي كتابة لسجل الأدمن.
export async function merchToggleProdAvail(id, current) {
  try {
    await updateDoc(doc(db,'products',id), { available: !current, updatedAt: serverTimestamp() });
    showToast(current?'تم إيقاف المنتج':'تم تفعيل المنتج','ok');
  } catch(e) { showToast('حدث خطأ','err'); }
}

// ===== P15 — شاشة "المتجر" (بيانات العمل التجاري الخاصة بالتاجر نفسه) =====
// منفصلة تمامًا عن شاشة إدارة المتجر بتاعة الأدمن (screen-store-manage/sm-* في admin.js) -
// نفس الفكرة العامة (بيانات متجر + Firestore stores/{uid}) لكن نموذج أصغر بحقول ذات id مختلف
// (mst-*) وحقول أقل (زي ما طلب Brief التاجر بالظبط: الاسم/الشعار/الفئة/الوصف/الهاتف/
// الحالة/الموقع) - صفر تعارض DOM id مع شاشة الأدمن، وصفر تغيير على smSaveProfile/admin.js.
// الحقول اللي بتتكتب هنا (description/isOpen/logoUrl/address) اتضافت لأول مرة لصلاحية
// الكتابة الذاتية للتاجر في firestore.rules (كانت Admin-only قبل كده) - أضيق تعديل ممكن،
// بنفس أسلوب فحص lat/lng الموجود بالفعل في نفس الـ Rule.
export async function mstLoadProfile() {
  if (!window.CU) return;
  try {
    const snap = await getDoc(doc(db, 'stores', window.CU.uid));
    const s = snap.exists() ? snap.data() : {};
    const set = (id,val) => { const e=document.getElementById(id); if(e) e.value = val; };
    set('mst-name', s.storeName||'');
    set('mst-desc', s.description||'');
    set('mst-phone', s.storePhone||'');
    set('mst-addr', s.address||'');
    const catSel = document.getElementById('mst-cat');
    if (catSel) catSel.value = ['بقالة','مطعم','صيدلية'].includes(s.category) ? s.category : 'بقالة';
    const logoBox = document.getElementById('mst-logo-box');
    if (logoBox) { logoBox.style.backgroundImage = s.logoUrl?`url('${s.logoUrl}')`:'none'; logoBox.innerHTML = s.logoUrl?'':icon('store',26); }
    mstSetOpen(s.isOpen !== false);
  } catch(e) { showToast('تعذر تحميل بيانات المتجر','err'); }
}
export function mstSetOpen(isOpen) {
  window._mstFormOpen = isOpen;
  document.getElementById('mst-open-btn')?.classList.toggle('active', isOpen);
  document.getElementById('mst-closed-btn')?.classList.toggle('active', !isOpen);
}
export async function mstSaveProfile() {
  if (!window.CU) return;
  const storeName = document.getElementById('mst-name').value.trim();
  const description = document.getElementById('mst-desc').value.trim();
  const storePhone = document.getElementById('mst-phone').value.trim();
  const address = document.getElementById('mst-addr').value.trim();
  const category = document.getElementById('mst-cat')?.value || 'بقالة';
  const isOpen = window._mstFormOpen !== false;
  if (!storeName) { showToast('اسم المتجر مطلوب','err'); return; }
  try {
    await updateDoc(doc(db,'stores',window.CU.uid), { storeName, description, storePhone, address, category, isOpen, updatedAt: serverTimestamp() });
    document.getElementById('merch-name').textContent = storeName;
    window.CUD = { ...window.CUD, storeName };
    window._mstIsOpen = isOpen;
    renderMerchDashStatus(); renderMerchAlerts();
    showToast('تم حفظ بيانات المتجر','ok');
  } catch(e) { showToast('حدث خطأ في الحفظ','err'); }
}
export function mstUploadLogo() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file || !window.CU) return;
    if (!file.type.startsWith('image/')) { showToast('لازم ترفع صورة بس (JPG أو PNG)', 'err'); return; }
    showToast('جارٍ رفع الشعار...','ok');
    try {
      const compressed = await compressImage(file);
      const url = await secureCloudinaryUpload(compressed);
      await updateDoc(doc(db,'stores',window.CU.uid), { logoUrl: url, updatedAt: serverTimestamp() });
      const logoBox = document.getElementById('mst-logo-box');
      if (logoBox) { logoBox.style.backgroundImage = `url('${url}')`; logoBox.innerHTML=''; }
      showToast('تم تحديث الشعار','ok');
    } catch(e) { showToast('فشل رفع الصورة','err'); }
  };
  inp.click();
}

// ===== P15 — شاشة "الحساب" (بيانات صاحب المتجر - للعرض فقط) =====
// عمدًا للعرض بس (بدون تعديل): جرد firestore.rules الحالي (users/{uid} - فرع Merchant) بيأكد
// إن مفيش أي مسار self-update لمستند users بتاع التاجر أصلًا (قرار أمني سابق ومتعمد - راجع
// تعليق "P14.3 - البند 8" في الملف). إضافة تعديل هنا كانت هتعني توسيع الصلاحية دي من غير أي
// Use Case حقيقي في الكود - فالحساب هنا للعرض والخروج بس، ومطابق تمامًا لتعليمات عدم توسيع
// الأمان إلا لو محتاج فعليًا.
export function loadMerchantAccount() {
  const ud = window.CUD || {};
  const set = (id,val)=>{ const e=document.getElementById(id); if(e) e.textContent = val; };
  set('mac-name', ud.name || '--');
  set('mac-store', ud.storeName || '');
  const phoneLine = document.getElementById('mac-phone-line');
  if (phoneLine) { const has = !!ud.ownerPhone; phoneLine.style.display = has?'flex':'none'; if(has) set('mac-phone', ud.ownerPhone); }
  const emailLine = document.getElementById('mac-email-line');
  const email = window.CU?.email;
  if (emailLine) { emailLine.style.display = email?'flex':'none'; if(email) set('mac-email', email); }
  const joinedLine = document.getElementById('mac-joined-line');
  const joined = ud.createdAt?.toDate ? ud.createdAt.toDate() : null;
  if (joinedLine) { joinedLine.style.display = joined?'flex':'none'; if(joined) set('mac-joined', joined.toLocaleDateString('ar-EG')); }
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
  _merchUnavailCount = 0; window._mstIsOpen = null; window._mstFormOpen = null;
  });
}
