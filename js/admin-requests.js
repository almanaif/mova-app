// ===== admin-requests.js — إدارة "الطلبات الواردة" (merchant_requests + any_requests) =====
// اكتُشف في المراجعة النهائية (Final Acceptance Audit) إن الكود بيكتب في الكوليكشنين دول
// من customer.js (submitMerchant, sendAnyReq) بنجاح، لكن مفيش أي شاشة أدمن كانت بتقرأهم أو
// تتعامل معهم. هذا الملف يستكمل الميزة الموجودة بالفعل من ناحية الإدارة، بنفس نمط الترقيم
// ودورة عمر الشاشة المتبع في admin-customers.js/admin-pagination.js.

import { collection, db, doc, orderBy, query, updateDoc } from './firebase.js';
import { esc, showToast } from './utils.js';
import { icon } from './icons.js';
import { createPaginatedListener } from './admin-pagination.js';
import { logAudit } from './admin.js';

const PAGE_SIZE = 20;
let merchReqPager = null;
let anyReqPager = null;

function fmtDate(ts) {
  return ts?.toDate ? ts.toDate().toLocaleString('ar-EG') : '--';
}

function statusBadge(status) {
  if (status === 'accepted') return `<span class="status status--success">${icon('check-circle',11)} مقبول</span>`;
  if (status === 'rejected') return `<span class="status status--danger">${icon('x-circle',11)} مرفوض</span>`;
  return `<span class="status status--pending">${icon('clock',11)} بانتظار المراجعة</span>`;
}

// ===== طلبات انضمام التجار (merchant_requests) =====
function merchReqRow(r) {
  return `<div class="drv-row2" style="display:block;padding:10px 0">
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><strong>${esc(r.storeName)||'--'}</strong>${statusBadge(r.status)}</div>
    <div style="font-size:12px;color:var(--mu);display:flex;align-items:center;gap:3px">${icon('phone',12)} ${esc(r.phone)||'--'} ${r.address?('| '+icon('map-pin',12)+' '+esc(r.address)):''}</div>
    <div style="font-size:10px;color:var(--mu);margin-top:2px;display:flex;align-items:center;gap:3px">${icon('clock',10)} ${fmtDate(r.createdAt)}</div>
    ${r.adminNote ? `<div style="font-size:11px;color:var(--p);margin-top:4px;display:flex;align-items:center;gap:3px">${icon('file-text',11)} ${esc(r.adminNote)}</div>` : ''}
    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
      ${r.status==='pending' ? `<button class="mb2 mb-acc" onclick="acceptMerchantRequest('${r.id}')">قبول</button><button class="mb2 mb-rej" onclick="rejectMerchantRequest('${r.id}')">رفض</button>` : ''}
      <button class="mb2 mb-view" onclick="addNoteToMerchantRequest('${r.id}')">${icon('file-text',12)} ملاحظة</button>
    </div>
  </div>`;
}

export function startMerchantRequestsListener() {
  if (merchReqPager) { merchReqPager.stop(); merchReqPager = null; }
  const baseQuery = query(collection(db,'merchant_requests'), orderBy('createdAt','desc'));
  let allRows = [];
  merchReqPager = createPaginatedListener({
    baseQuery, pageSize: PAGE_SIZE,
    onPage(docs, meta) {
      const rows = docs.map(d => merchReqRow({ ...d.data(), id: d.id }));
      allRows = meta.isFirstPage ? rows : allRows.concat(rows);
      const el = document.getElementById('adm-merchreq-list');
      if (el) el.innerHTML = allRows.length ? allRows.join('') : '<div class="empty-state" style="padding:14px"><p style="font-size:12px">لا توجد طلبات انضمام</p></div>';
      const moreBtn = document.getElementById('adm-merchreq-more'); if (moreBtn) moreBtn.style.display = meta.hasMore ? 'block' : 'none';
    },
  });
}
export function loadMoreMerchantRequests() { if (merchReqPager) merchReqPager.loadMore(); }

export async function acceptMerchantRequest(id) {
  try {
    await updateDoc(doc(db,'merchant_requests',id), { status: 'accepted' });
    logAudit('قبول طلب انضمام تاجر', id);
    showToast('تم قبول الطلب', 'ok');
  } catch (e) { showToast('حدث خطأ', 'err'); console.error('[acceptMerchantRequest]', e); }
}
export async function rejectMerchantRequest(id) {
  try {
    await updateDoc(doc(db,'merchant_requests',id), { status: 'rejected' });
    logAudit('رفض طلب انضمام تاجر', id);
    showToast('تم رفض الطلب', 'ok');
  } catch (e) { showToast('حدث خطأ', 'err'); console.error('[rejectMerchantRequest]', e); }
}
export async function addNoteToMerchantRequest(id) {
  const note = prompt('ملاحظة الإدارة على طلب الانضمام ده:');
  if (note === null) return;
  try {
    await updateDoc(doc(db,'merchant_requests',id), { adminNote: note.trim() });
    logAudit('إضافة ملاحظة على طلب انضمام تاجر', id);
    showToast('تم حفظ الملاحظة', 'ok');
  } catch (e) { showToast('حدث خطأ', 'err'); console.error('[addNoteToMerchantRequest]', e); }
}

// ===== الطلبات الحرة (any_requests) =====
function anyReqRow(r) {
  return `<div class="drv-row2" style="display:block;padding:10px 0">
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><strong>${esc(r.customerName)||'عميل'}</strong>${statusBadge(r.status==='new'?'pending':r.status)}</div>
    <div style="font-size:12px">${esc(r.request)||'--'}</div>
    <div style="font-size:11px;color:var(--mu);margin-top:2px;display:flex;align-items:center;gap:3px">${r.address?(icon('map-pin',11)+' '+esc(r.address)):''}</div>
    <div style="font-size:10px;color:var(--mu);margin-top:2px;display:flex;align-items:center;gap:3px">${icon('clock',10)} ${fmtDate(r.createdAt)}</div>
    ${r.adminNote ? `<div style="font-size:11px;color:var(--p);margin-top:4px;display:flex;align-items:center;gap:3px">${icon('file-text',11)} ${esc(r.adminNote)}</div>` : ''}
    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
      ${r.status==='new' ? `<button class="mb2 mb-acc" onclick="acceptAnyRequest('${r.id}')">قبول</button><button class="mb2 mb-rej" onclick="rejectAnyRequest('${r.id}')">رفض</button>` : ''}
      <button class="mb2 mb-view" onclick="addNoteToAnyRequest('${r.id}')">${icon('file-text',12)} ملاحظة</button>
    </div>
  </div>`;
}

export function startAnyRequestsListener() {
  if (anyReqPager) { anyReqPager.stop(); anyReqPager = null; }
  const baseQuery = query(collection(db,'any_requests'), orderBy('createdAt','desc'));
  let allRows = [];
  anyReqPager = createPaginatedListener({
    baseQuery, pageSize: PAGE_SIZE,
    onPage(docs, meta) {
      const rows = docs.map(d => anyReqRow({ ...d.data(), id: d.id }));
      allRows = meta.isFirstPage ? rows : allRows.concat(rows);
      const el = document.getElementById('adm-anyreq-list');
      if (el) el.innerHTML = allRows.length ? allRows.join('') : '<div class="empty-state" style="padding:14px"><p style="font-size:12px">لا توجد طلبات</p></div>';
      const moreBtn = document.getElementById('adm-anyreq-more'); if (moreBtn) moreBtn.style.display = meta.hasMore ? 'block' : 'none';
    },
  });
}
export function loadMoreAnyRequests() { if (anyReqPager) anyReqPager.loadMore(); }

export async function acceptAnyRequest(id) {
  try {
    await updateDoc(doc(db,'any_requests',id), { status: 'accepted' });
    logAudit('قبول طلب حر', id);
    showToast('تم قبول الطلب', 'ok');
  } catch (e) { showToast('حدث خطأ', 'err'); console.error('[acceptAnyRequest]', e); }
}
export async function rejectAnyRequest(id) {
  try {
    await updateDoc(doc(db,'any_requests',id), { status: 'rejected' });
    logAudit('رفض طلب حر', id);
    showToast('تم رفض الطلب', 'ok');
  } catch (e) { showToast('حدث خطأ', 'err'); console.error('[rejectAnyRequest]', e); }
}
export async function addNoteToAnyRequest(id) {
  const note = prompt('ملاحظة الإدارة على الطلب ده:');
  if (note === null) return;
  try {
    await updateDoc(doc(db,'any_requests',id), { adminNote: note.trim() });
    logAudit('إضافة ملاحظة على طلب حر', id);
    showToast('تم حفظ الملاحظة', 'ok');
  } catch (e) { showToast('حدث خطأ', 'err'); console.error('[addNoteToAnyRequest]', e); }
}

// ===== دورة حياة الشاشة (مرتبطة بعمر الصفحة، نفس نمط admin.js) =====
export function startIncomingRequestsListeners() {
  startMerchantRequestsListener();
  startAnyRequestsListener();
}
export function stopIncomingRequestsListeners() {
  if (merchReqPager) { merchReqPager.stop(); merchReqPager = null; }
  if (anyReqPager) { anyReqPager.stop(); anyReqPager = null; }
}
