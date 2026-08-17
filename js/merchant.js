// ===== merchant.js — شاشات التاجر: الطلبات والمنتجات =====

import { addDoc, collection, db, deleteDoc, doc, getDoc, limit, orderBy, query, runTransaction, serverTimestamp, updateDoc, where } from './firebase.js';
import { SC, SL, closeModal, esc, normalizeStatus, onListenersCleared, onSnapshot, showToast } from './utils.js';
import { logAudit, openEditProd } from './admin.js';
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
  if (!statusEl || !window.CU) return;
  try {
    const snap = await getDoc(doc(db, 'stores', window.CU.uid));
    const sd = snap.exists() ? snap.data() : null;
    if (sd && typeof sd.lat === 'number' && typeof sd.lng === 'number') {
      statusEl.textContent = '✅ الموقع محدد - اضغط للتعديل';
      window._merchStoreLoc = [sd.lat, sd.lng];
    } else {
      statusEl.textContent = 'لم يتم تحديد الموقع بعد - العملاء يشوفوا موقع افتراضي';
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
        showToast('✅ تم حفظ موقع المتجر', 'ok');
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
    if (snap.empty) { document.getElementById('merch-ords-list').innerHTML='<div class="empty-state"><div class="ei">📦</div><p>لا توجد طلبات بعد</p></div>'; return; }
    let html='';
    snap.forEach(d => {
      const o={...d.data(),id:d.id};
      const dt=o.createdAt?.toDate?o.createdAt.toDate():new Date();
      if(dt.toDateString()===today){tOrd++;tRev+=o.total||0;}
      const st = normalizeStatus(o.status);
      html+=`<div class="merch-ord-card">
        <div class="merch-ord-top"><span style="font-size:11px;font-weight:700;color:var(--mu)">#${d.id.slice(-6).toUpperCase()}</span><span class="${SC[o.status]||'sb sb-new'}">${SL[o.status]||'جديد'}</span></div>
        <div style="font-size:12px;color:var(--mu)">👤 ${esc(o.customerName)||'عميل'} • ${o.total||0} ج</div>
        <div style="font-size:11px;margin-top:4px">${(o.items||[]).map(i=>`${esc(i.name)} x${i.qty}`).join('، ')}</div>
        <div class="merch-ord-acts">
          ${st===ORDER_STATUS.WAITING_MERCHANT?`<button class="mo-btn mo-acc" onclick="merchAcceptOrd('${d.id}')">✅ قبول</button><button class="mo-btn mo-rej" onclick="merchRejectOrd('${d.id}')">❌ رفض</button>`:''}
          ${(st===ORDER_STATUS.MERCHANT_ACCEPTED||st===ORDER_STATUS.SEARCHING_DRIVER)?`<span style="font-size:11px;color:var(--mu);font-weight:600">🔎 جاري البحث عن مندوب...</span>`:''}
          ${(st===ORDER_STATUS.DRIVER_ASSIGNED||st===ORDER_STATUS.DRIVER_ARRIVED)?`<span style="font-size:11px;color:var(--ok);font-weight:600">🛵 المندوب في الطريق للاستلام</span>`:''}
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
    showToast('✅ تم قبول الطلب، جاري البحث عن مندوب','ok');
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
    if(snap.empty){document.getElementById('merch-prods-list').innerHTML='<div class="empty-state"><div class="ei">📦</div><p>لا توجد منتجات</p><small>اضغط "إضافة منتج"</small></div>';return;}
    let html='';
    snap.forEach(d=>{
      const p={...d.data(),id:d.id};
      html+=`<div style="background:#fff;border-radius:var(--r);padding:12px;margin-bottom:8px;box-shadow:var(--sh);border:1px solid var(--border);display:flex;gap:10px;align-items:center">
        <div style="width:48px;height:48px;border-radius:10px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0">${p.icon||'📦'}</div>
        <div style="flex:1"><strong style="font-size:13px;font-weight:800;display:block">${esc(p.name)}</strong><small style="color:var(--mu);font-size:11px">${esc(p.unit)}${p.stock!=null?' • الكمية: '+p.stock:''}</small>
          <div style="font-size:14px;font-weight:900;color:var(--p);margin-top:3px">${p.price} ج</div>
          <div style="display:flex;gap:5px;margin-top:6px">
            <button class="mb2 mb-view" onclick='openEditProd(${JSON.stringify(p).replace(/</g,"\\u003c")})'>✏️ تعديل</button>
            <button class="mb2 mb-rej" onclick="delProd('${d.id}')">🗑️ حذف</button>
            <span style="font-size:10px;font-weight:700;color:${p.available!==false?'var(--ok)':'var(--danger)'}">${p.available!==false?'✅ متاح':'❌ غير متاح'}</span>
          </div>
        </div>
      </div>`;
    });
    document.getElementById('merch-prods-list').innerHTML=html;
  });
}

export function openAddProd(){document.getElementById('add-prod-modal').classList.add('open');}
export async function saveProd(){
  const name=document.getElementById('ap-name').value.trim();
  const cat=document.getElementById('ap-cat').value;
  const unit=document.getElementById('ap-unit').value.trim();
  const price=parseFloat(document.getElementById('ap-price').value)||0;
  const icon=document.getElementById('ap-icon').value||'📦';
  if(!name||!price){showToast('يرجى تعبئة الاسم والسعر','err');return;}
  const merchantId = window.adminTargetStore || window.CU?.uid;
  if(!merchantId)return;
  try{
    const storeName = window.adminTargetStore
      ? (document.getElementById('sm-name')?.value || 'متجر')
      : (window.CUD?.storeName||window.CUD?.name||'متجر');
    await addDoc(collection(db,'products'),{merchantId,storeName,name,cat,unit,price,icon,available:true,createdAt:serverTimestamp()});
    closeModal('add-prod-modal');
    ['ap-name','ap-price','ap-unit','ap-icon'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
    if(window.adminTargetStore) logAudit('إضافة منتج (أدمن)', name+' — '+storeName);
    showToast('✅ تم إضافة المنتج','ok');
  }catch(e){showToast('حدث خطأ','err');}
}
export async function delProd(id){
  try{await deleteDoc(doc(db,'products',id));showToast('✅ تم حذف المنتج','ok');}catch(e){showToast('حدث خطأ','err');}
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
