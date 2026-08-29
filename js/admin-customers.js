// ===== admin-customers.js — Sprint 3: Customers Management =====
// Phase B: القائمة + بحث موحّد Auto-detect + فلتر حالة.
// Phase C: صفحة تفاصيل العميل (Side Panel) - بيانات أساسية، KPIs، سجل طلبات، إجراءات إدارية.
// نفس نمط admin-pagination.js تمامًا (Sprint 2.3): كل Listener مرتبط بعمر الشاشة، limit()+startAfter()،
// مفيش Full Collection Scan.

import { collection, db, doc, getAggregateFromServer, getCountFromServer, getDoc, orderBy, query, sum, updateDoc, where } from './firebase.js';
import { debounce, esc, onListenersCleared, showToast } from './utils.js';
import { icon } from './icons.js';
import { createPaginatedListener } from './admin-pagination.js';
import { logAudit } from './admin.js';

const PAGE_SIZE = 20;
let listPager = null;
let currentStatusFilter = 'all';

// خرائط الحالة → تسمية عرض (نفس فلسفة SC/SL في utils.js بس محصورة على العميل)
const STATUS_LABEL = { active: icon('check-circle',11)+' نشط', blocked: icon('x-circle',11)+' محظور' };

function rowTemplate(u) {
  const statusLbl = STATUS_LABEL[u.status] || STATUS_LABEL.active; // مفيش status = نشط (Backward Compatible، نفس منطق Phase A)
  return `<div class="drv-row2" style="cursor:pointer" onclick="openCustomerDetails('${u.id}')"><div class="drv-av2">${icon('user',18)}</div><div class="drv-info2"><strong>${esc(u.name)||'--'}</strong><small style="display:inline-flex;align-items:center;gap:3px">${icon('phone',11)} ${esc(u.phone||u.email)||'--'} | ${u.points||0} نقطة | <span style="display:inline-flex;align-items:center;gap:3px">${statusLbl}</span></small></div></div>`;
}

function renderPage(id, moreId, isFirstPage, rowsHtml, accRef) {
  accRef.rows = isFirstPage ? rowsHtml : accRef.rows.concat(rowsHtml);
  const el = document.getElementById(id);
  if (el) el.innerHTML = accRef.rows.length ? accRef.rows.join('') : '<div class="empty-state" style="padding:14px"><p style="font-size:12px">لا توجد نتائج</p></div>';
}

// ===== القائمة الافتراضية (بدون بحث) - بتحترم فلتر الحالة الحالي =====
export function startCustomersListener() {
  if (listPager) { listPager.stop(); listPager = null; }
  const filters = [where('role','==','customer')];
  if (currentStatusFilter !== 'all') filters.push(where('status','==',currentStatusFilter));
  const baseQuery = query(collection(db,'users'), ...filters, orderBy('createdAt','desc'));
  const acc = { rows: [] };
  listPager = createPaginatedListener({
    baseQuery, pageSize: PAGE_SIZE,
    onPage(docs, meta) {
      const rows = docs.map(d => rowTemplate({ ...d.data(), id: d.id }));
      renderPage('adm-users-list', 'adm-users-more', meta.isFirstPage, rows, acc);
      const moreBtn = document.getElementById('adm-users-more'); if (moreBtn) moreBtn.style.display = meta.hasMore ? 'block' : 'none';
    },
  });
}
export function stopCustomersListener() { if (listPager) { listPager.stop(); listPager = null; } }
export function loadMoreCustomers() { if (listPager) listPager.loadMore(); }

// ===== فلتر الحالة (نشط/محظور/الكل) - بيمسح أي بحث نشط ويرجع للقائمة الافتراضية =====
export function filterCustomersByStatus(status, btn) {
  document.querySelectorAll('#adm-users .fc2').forEach(c=>c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  currentStatusFilter = status;
  const searchInput = document.getElementById('adm-cust-search');
  if (searchInput) searchInput.value = ''; // البحث والفلتر مش متزامنين في الفيز دي (قرار مقصود للسرعة - راجع الملاحظة في التقرير)
  startCustomersListener();
}

// ===== البحث الموحّد (auto-detect: هاتف / بريد / اسم) =====
// نفس فكرة اللي اتفقنا عليها في الـ Design Review - المستخدم مش بيختار نوع البحث، النظام بيحدده.
function detectSearchType(raw) {
  const v = raw.trim();
  if (!v) return { type: 'none' };
  if (v.includes('@')) return { type: 'email', value: v.toLowerCase() };
  // رقم هاتف: أرقام بس (ممكن تسبقها + أو مسافات/شرطات) وطولها 6 أرقام فأكتر
  const digitsOnly = v.replace(/[\s\-+]/g, '');
  if (/^\d{6,}$/.test(digitsOnly)) return { type: 'phone', value: digitsOnly };
  return { type: 'name', value: v };
}

function runSearch({ type, value }) {
  if (listPager) { listPager.stop(); listPager = null; }
  if (type === 'none') { startCustomersListener(); return; }
  let baseQuery;
  if (type === 'email') {
    baseQuery = query(collection(db,'users'), where('role','==','customer'), where('email','==',value));
  } else if (type === 'phone') {
    baseQuery = query(collection(db,'users'), where('role','==','customer'), where('phone','==',value));
  } else {
    baseQuery = query(collection(db,'users'), where('role','==','customer'), where('name','>=',value), where('name','<=',value+'\uf8ff'), orderBy('name'));
  }
  const acc = { rows: [] };
  listPager = createPaginatedListener({
    baseQuery, pageSize: PAGE_SIZE,
    onPage(docs, meta) {
      const rows = docs.map(d => rowTemplate({ ...d.data(), id: d.id }));
      renderPage('adm-users-list', 'adm-users-more', meta.isFirstPage, rows, acc);
      const moreBtn = document.getElementById('adm-users-more'); if (moreBtn) moreBtn.style.display = meta.hasMore ? 'block' : 'none';
    },
  });
}

const debouncedSearch = debounce((raw) => runSearch(detectSearchType(raw)), 350);
export function onCustomerSearchInput(raw) {
  // البحث بيلغي فلتر الحالة (بيرجعه "الكل" بصريًا) - نفس القرار المقصود فوق، لتبسيط النطاق في هذه الفيز
  currentStatusFilter = 'all';
  document.querySelectorAll('#adm-users .fc2').forEach(c=>c.classList.remove('active'));
  const allBtn = document.querySelector('#adm-users .fc2[data-status="all"]'); if (allBtn) allBtn.classList.add('active');
  debouncedSearch(raw);
}

export function registerCustomerListReset() {
  // الـ Listener نفسه بيتقفل تلقائيًا عبر نظام clearAllListeners الموجود في utils.js (لأنه
  // بيستخدم onSnapshot المغلّفة من جوه admin-pagination.js) - هنا بس بنصفّر أعلام المتابعة المحلية
  // عند تسجيل الخروج، بنفس نمط باقي الملفات (registerAdminResets, registerOrdersResets...).
  onListenersCleared(() => {
    listPager = null;
    currentStatusFilter = 'all';
    if (detailOrdersPager) { detailOrdersPager.stop(); detailOrdersPager = null; }
    currentDetailId = null;
  });
}

// =====================================================================================
// Phase C — صفحة تفاصيل العميل (Side Panel)
// =====================================================================================
let currentDetailId = null;
let detailOrdersPager = null;

export async function openCustomerDetails(id) {
  currentDetailId = id;
  document.getElementById('screen-cust-detail').style.display = 'block';
  document.getElementById('cd-title').textContent = 'جاري التحميل...';
  try {
    const snap = await getDoc(doc(db,'users',id));
    if (!snap.exists()) { showToast('العميل غير موجود', 'err'); closeCustomerDetails(); return; }
    const u = snap.data();
    document.getElementById('cd-title').textContent = u.name || 'تفاصيل العميل';
    document.getElementById('cd-name').value = u.name || '';
    document.getElementById('cd-phone').value = u.phone || '';
    document.getElementById('cd-address').value = u.address || '';
    document.getElementById('cd-email').value = u.email || '';
    document.getElementById('cd-created').textContent = u.createdAt?.toDate ? u.createdAt.toDate().toLocaleDateString('ar-EG') : '--';
    const blockBtn = document.getElementById('cd-block-btn');
    if (blockBtn) {
      const blocked = u.status === 'blocked';
      blockBtn.innerHTML = blocked ? icon('check-circle',13)+' إلغاء الحظر' : icon('x-circle',13)+' حظر العميل';
      blockBtn.className = blocked ? 'mb2 mb-view' : 'mb2 mb-acc';
    }
  } catch (e) { showToast('حدث خطأ في تحميل بيانات العميل', 'err'); console.log(e); }

  loadCustomerKpis(id);
  startCustomerOrdersListener(id);
}

export function closeCustomerDetails() {
  document.getElementById('screen-cust-detail').style.display = 'none';
  if (detailOrdersPager) { detailOrdersPager.stop(); detailOrdersPager = null; }
  currentDetailId = null;
}

// KPIs: عدّاد + مجموع عبر Aggregation Queries (نفس نمط Sprint 2.3 لشاشة المتاجر) - صفر تنزيل
// مستندات كاملة بس عشان رقمين.
async function loadCustomerKpis(id) {
  ['cd-kpi-ordcount','cd-kpi-spend'].forEach(elId => { const el = document.getElementById(elId); if (el) el.textContent = '...'; });
  try {
    const ordersQ = query(collection(db,'orders'), where('customerId','==',id));
    const [cAgg, sAgg] = await Promise.all([
      getCountFromServer(ordersQ),
      getAggregateFromServer(ordersQ, { total: sum('total') }),
    ]);
    document.getElementById('cd-kpi-ordcount').textContent = cAgg.data().count;
    document.getElementById('cd-kpi-spend').textContent = (sAgg.data().total || 0) + ' ج';
  } catch (e) {
    document.getElementById('cd-kpi-ordcount').textContent = '--';
    document.getElementById('cd-kpi-spend').textContent = '--';
  }
}

// سجل الطلبات: Listener مرتبط بعمر الصفحة (بيتوقف مع closeCustomerDetails) - نفس نمط Sprint 2.3
function startCustomerOrdersListener(id) {
  if (detailOrdersPager) { detailOrdersPager.stop(); detailOrdersPager = null; }
  const baseQuery = query(collection(db,'orders'), where('customerId','==',id), orderBy('createdAt','desc'));
  let allRows = [];
  let isFirst = true;
  detailOrdersPager = createPaginatedListener({
    baseQuery, pageSize: 10,
    onPage(docs, meta) {
      const rows = docs.map(d => {
        const o = { ...d.data(), id: d.id };
        const dt = o.createdAt?.toDate ? o.createdAt.toDate().toLocaleDateString('ar-EG') : '--';
        return `<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;display:flex;justify-content:space-between"><span style="display:inline-flex;align-items:center;gap:3px">#${o.id.slice(-6).toUpperCase()} • ${icon('store',11)} ${esc(o.storeName)||'--'}</span><span>${o.total||0} ج • ${dt}</span></div>`;
      });
      allRows = meta.isFirstPage ? rows : allRows.concat(rows);
      const el = document.getElementById('cd-orders-list');
      if (el) el.innerHTML = allRows.length ? allRows.join('') : '<div class="empty-state" style="padding:14px"><p style="font-size:12px">لا توجد طلبات</p></div>';
      const moreBtn = document.getElementById('cd-orders-more'); if (moreBtn) moreBtn.style.display = meta.hasMore ? 'block' : 'none';
      // آخر طلب = أول عنصر في أول صفحة (مرتبة الأحدث أولًا) - إعادة استخدام نفس القراءة، صفر Query إضافي
      if (isFirst) {
        isFirst = false;
        const lastOrdEl = document.getElementById('cd-kpi-lastord');
        if (lastOrdEl) lastOrdEl.textContent = docs.length ? (docs[0].data().createdAt?.toDate ? docs[0].data().createdAt.toDate().toLocaleDateString('ar-EG') : '--') : 'لا يوجد';
      }
    },
  });
}
export function loadMoreCustomerOrders() { if (detailOrdersPager) detailOrdersPager.loadMore(); }

// ===== الإجراءات الإدارية (كل واحدة بتتسجل في Audit Log) =====
export async function saveCustomerBasicInfo() {
  if (!currentDetailId) return;
  const name = document.getElementById('cd-name').value.trim();
  const phone = document.getElementById('cd-phone').value.trim();
  const address = document.getElementById('cd-address').value.trim();
  if (!name) { showToast('الاسم مطلوب', 'err'); return; }
  try {
    await updateDoc(doc(db,'users',currentDetailId), { name, phone, address });
    logAudit('تعديل بيانات عميل', `${currentDetailId} — ${name}`);
    showToast('تم الحفظ', 'ok');
  } catch (e) { showToast('حدث خطأ أثناء الحفظ', 'err'); console.log(e); }
}

export async function toggleCustomerBlock() {
  if (!currentDetailId) return;
  try {
    const snap = await getDoc(doc(db,'users',currentDetailId));
    const cur = snap.data();
    const newStatus = cur.status === 'blocked' ? 'active' : 'blocked';
    if (!confirm(newStatus === 'blocked' ? 'تأكيد حظر هذا العميل؟' : 'تأكيد إلغاء الحظر؟')) return;
    await updateDoc(doc(db,'users',currentDetailId), { status: newStatus });
    logAudit(newStatus === 'blocked' ? 'حظر عميل' : 'إلغاء حظر عميل', currentDetailId);
    showToast(newStatus === 'blocked' ? 'تم حظر العميل' : 'تم إلغاء الحظر', 'ok');
    openCustomerDetails(currentDetailId); // إعادة تحميل الحالة على نفس الشاشة
  } catch (e) { showToast('حدث خطأ', 'err'); console.log(e); }
}

export async function softDeleteCustomer() {
  if (!currentDetailId) return;
  if (!confirm('تأكيد حذف هذا العميل؟ (حذف ناعم - يقدر الأدمن يراجعه لاحقًا من قاعدة البيانات)')) return;
  try {
    await updateDoc(doc(db,'users',currentDetailId), { status: 'deleted' });
    logAudit('حذف عميل (ناعم)', currentDetailId);
    showToast('تم حذف العميل', 'ok');
    closeCustomerDetails();
  } catch (e) { showToast('حدث خطأ', 'err'); console.log(e); }
}

