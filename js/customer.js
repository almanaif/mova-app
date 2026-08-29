// ===== customer.js — شاشات العميل: تصفح المتاجر/المنتجات، السلة، الطلبات، التقييم، طلبات عامة =====

import { addDoc, collection, db, getCountFromServer, limit, orderBy, query, serverTimestamp, where } from './firebase.js';
import { SL, NEW_STEPS, NEW_STEP_ICONS, NEW_STEP_LABELS, callStore, closeModal, debounce, esc, escJs, filterProds, normalizeStatus, onListenersCleared, onSnapshot, openWA, orderStatusBadge, showScreen, showToast } from './utils.js';
import { ORDER_STATUS, custCancelOrder, openTrack } from './orders.js';
import { icon } from './icons.js';
import { openLocationPicker } from './maps.js';

// ===== LOCATION PICKER WIRING (Map Sprint - القسم 2: العميل مش لازم يقتصر على GPS بس) =====
// جديد: زرار العنوان أعلى الشاشة كان بيعرض نص عنوان ثابت (Hardcoded) طول الوقت مهما كان
// موقع العميل الحقيقي إيه، وبيضغط بس getLocation() (GPS صامت من غير أي تأكيد). دلوقتي بيفتح
// شاشة اختيار موقع حقيقية (خريطة + تحريك + تأكيد)، وبيحدّث نص العنوان بالعنوان المؤكد فعليًا.
// GPS التلقائي عند تسجيل الدخول (auth.js) اتساب زي ما هو تمامًا كـ"نقطة بداية مريحة" فقط -
// لسه مطلوب من العميل يأكد الموقع صراحة عشان يتغير فعليًا عنوان الطلب.
export function openCustomerLocationPicker() {
  openLocationPicker({
    title: 'تحديد موقع التسليم',
    initialLoc: window.userLat ? [window.userLat, window.userLng] : null,
    onConfirm: ({ lat, lng, address, city, zone }) => {
      window.userLat = lat; window.userLng = lng;
      window.userLocAddress = address || null; // بيتقرأ في goCheckout() بدل تكرار reverseGeocode لنفس النقطة
      window.userLocCity = city || null; window.userLocZone = zone || null;
      window.userLocAddressFor = { lat, lng }; // للتأكد إن العنوان المخزّن لسه بيطابق آخر إحداثيات فعلية (راجع goCheckout)
      const hdrEl = document.querySelector('.hdr-loc strong');
      if (hdrEl) hdrEl.textContent = address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      showToast('✅ تم تأكيد موقع التسليم', 'ok');
    },
  });
}

// ===== PRODUCTS LOADER (from Firestore) =====
export let PRODS = [];
export let productsUnsub = null;
export function loadProducts() {
  if (productsUnsub) return;
  const q = query(collection(db,'products'), where('available','==',true));
  productsUnsub = onSnapshot(q, snap => {
    PRODS = snap.docs.map(d => {
      const p = d.data();
      return { id:d.id, name:p.name, unit:p.unit, price:p.price, imageUrl:p.imageUrl||null, cat:p.cat||'other',
               available:p.available!==false, merchantId:p.merchantId, storeName:p.storeName||'متجر' };
    });
    const activeBtn = document.querySelector('#screen-store .pc-btn.active');
    const activeCat = activeBtn ? (activeBtn.dataset.cat || 'all') : 'all';
    if (document.getElementById('screen-store')?.classList.contains('active')) renderProds(activeCat);
  }, err => { showToast('تعذر تحميل المنتجات','err'); });
}


// ===== COUPONS LOADER =====
export let couponsUnsub = null;
export function loadCoupons() {
  if (couponsUnsub) return;
  const q = query(collection(db,'coupons'), orderBy('order','asc'));
  couponsUnsub = onSnapshot(q, snap => {
    const now = new Date();
    const items = [];
    snap.forEach(d => {
      const c = d.data();
      if (c.active === false) return;
      if (c.expiryDate && new Date(c.expiryDate) < now) return;
      items.push({id:d.id, ...c});
    });
    const sec = document.getElementById('off-sec');
    const scroll = document.getElementById('off-scroll');
    if (!items.length) { if (sec) sec.style.display='none'; return; }
    if (sec) sec.style.display='block';
    if (scroll) scroll.innerHTML = items.map(c =>
      `<div class="off-card"><div class="off-badge">${esc(c.badge)}</div><div class="off-icon">${c.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="${esc(c.title)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">` : icon('ticket',22)}</div><h4>${esc(c.title)}</h4><p>${esc(c.description)}</p><div class="off-code">${esc(c.code)}</div></div>`
    ).join('');
  });
}


// ===== BANNERS LOADER =====
export let bannersUnsub = null;
export function loadBanners() {
  if (bannersUnsub) return;
  const q = query(collection(db,'banners'), orderBy('order','asc'));
  bannersUnsub = onSnapshot(q, snap => {
    const now = new Date();
    const items = [];
    snap.forEach(d => {
      const b = d.data();
      if (b.active === false) return;
      if (b.startDate && new Date(b.startDate) > now) return;
      if (b.endDate && new Date(b.endDate) < now) return;
      items.push({id:d.id, ...b});
    });
    const sec = document.getElementById('banner-sec');
    const scroll = document.getElementById('banner-scroll');
    if (!items.length) { if (sec) sec.style.display='none'; return; }
    if (sec) sec.style.display='block';
    if (scroll) scroll.innerHTML = items.map(b => {
      const bg = b.imageUrl ? `background-image:url('${esc(b.imageUrl)}');background-size:cover;background-position:center` : `background:linear-gradient(135deg,#FF6B00,#FF4500)`;
      return `<div class="bcard" style="${bg}" onclick="${b.storeId?`openStore('${esc(b.storeId)}')`:''}"><div class="bc"><span class="btag">${esc(b.tag)}</span><h3>${esc(b.title)}</h3><p>${esc(b.description)}</p></div></div>`;
    }).join('');
  });
}


// ===== CATEGORIES LOADER =====
export let CATS = {};
export let categoriesUnsub = null;
export function loadCategories() {
  if (categoriesUnsub) return;
  const q = query(collection(db,'categories'), orderBy('order','asc'));
  categoriesUnsub = onSnapshot(q, snap => {
    CATS = {};
    const items = [];
    snap.forEach(d => { const c = d.data(); CATS[d.id] = esc(c.label||''); items.push({id:d.id, ...c}); });
    const pcScroll = document.getElementById('pc-scroll');
    if (pcScroll) {
      pcScroll.innerHTML = `<button class="pc-btn active" onclick="filterProds('all',this)">الكل</button>` +
        items.map(c => `<button class="pc-btn" onclick="filterProds('${c.id}',this)">${c.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="${esc(c.label)}" style="width:16px;height:16px;object-fit:cover;border-radius:4px;vertical-align:middle">` : icon('tag',14)} ${esc(c.label)}</button>`).join('');
    }
    const apCat = document.getElementById('ap-cat');
    if (apCat) apCat.innerHTML = items.map(c => `<option value="${c.id}">${esc(c.label)}</option>`).join('') || '<option value="other">عام</option>';
  });
}


// ===== STORES LOADER (from Firestore - NO DUMMY DATA) =====
// جديد: كان بيقرا من /users فين role=='merchant' وده كان بيسرّب بيانات التاجر الخاصة
// (docs/ownerPhone/email) لأي حد مسجل دخول. دلوقتي بيقرا من /stores اللي فيها بس
// البيانات العامة الآمنة للعرض.
export let storesUnsub = null;
export function loadStores() {
  if (!window.CU) return;
  if (storesUnsub) return;
  const q = query(collection(db,'stores'), where('status','==','active'));
  storesUnsub = onSnapshot(q, snap => {
    const list = document.getElementById('stores-list');
    if (snap.empty) {
      list.innerHTML = `<div class="empty-state"><div class="ei">${icon('store',26)}</div><p>لا توجد متاجر متاحة حالياً</p><small>سيتم إضافة متاجر قريباً</small></div>`;
      return;
    }
    let html = '';
    snap.forEach(d => {
      const m = d.data();
      const catMap = {'بقالة':'super','مطعم':'food','صيدلية':'pharma','متجر':'shop','حلويات':'food','خدمات':'shop'};
      const cat = catMap[m.category] || 'super';
      const sName = m.storeName || m.name || 'متجر';
      const sPhone = m.storePhone || m.phone || '';
      html += `<div class="store-card" data-cat="${cat}">
        <div class="store-img" style="background:linear-gradient(135deg,#1A1A2E,#0F3460)">${icon('store',44)}<div class="s-open s-on">مفتوح</div></div>
        <div class="store-body">
          <h3>${esc(sName)}</h3>
          <div class="store-meta"><span>${icon('package',13)} توصيل متاح</span><span>${icon('bike',13)} رسوم التوصيل متاحة</span></div>
          <div class="store-tags"><span class="store-tag">${esc(m.category)||'بقالة'}</span></div>
          <div class="store-acts">
            <button class="sa-btn sa-call" onclick="event.stopPropagation();callStore('${escJs(sPhone)}')">${icon('phone',13)} اتصال</button>
            <button class="sa-btn sa-wa" onclick="event.stopPropagation();openWA('${escJs(sPhone)}','${escJs(sName)}')">${icon('message-circle',13)} واتساب</button>
            <button class="sa-btn sa-order" onclick="showScreen('screen-store');loadProductsByStore('${d.id}','${escJs(sName)}','${escJs(sPhone)}')">${icon('shopping-cart',13)} اطلب</button>
          </div>
        </div>
      </div>`;
    });
    list.innerHTML = html;
  });
}


// ===== LOAD PRODUCTS BY STORE =====
export let productsByStoreUnsub = null;
export function loadProductsByStore(storeId, storeName, storePhone) {
  window.currentStoreName = storeName || 'متجر';
  window.currentStorePhone = storePhone || '';
  const nameEl = document.getElementById('store-detail-name');
  if (nameEl) nameEl.textContent = window.currentStoreName;
  if (productsByStoreUnsub) { try { productsByStoreUnsub(); } catch(e){} productsByStoreUnsub = null; }
  const q = query(collection(db,'products'), where('merchantId','==',storeId), where('available','==',true));
  productsByStoreUnsub = onSnapshot(q, snap => {
    PRODS = snap.docs.map(d => {
      const p = d.data();
      return { id:d.id, name:p.name, unit:p.unit, price:p.price, imageUrl:p.imageUrl||null, cat:p.cat||'other',
               available:p.available!==false, merchantId:p.merchantId||storeId, storeName: storeName||'متجر' };
    });
    renderProds('all');
  });
}


// ===== RENDER PRODUCTS =====
export function renderProds(cat) {
  const prods = cat==='all'?PRODS:PRODS.filter(p=>p.cat===cat);
  const grouped = {};
  prods.forEach(p => { if(!grouped[p.cat]) grouped[p.cat]=[]; grouped[p.cat].push(p); });
  let html = '';
  Object.keys(grouped).forEach(c => {
    html += `<div class="prod-sec-t pst" data-sec="${c}">${CATS[c]||c}</div><div class="prods-grid pst" data-sec="${c}">`;
    grouped[c].forEach(p => {
      const inCart = window.cart.find(x=>x.id===p.id);
      const qty = inCart?.qty||0;
      html += `<div class="prod-card"><div class="prod-img">${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" style="width:100%;height:100%;object-fit:cover">` : icon('image',26)}</div><div class="prod-body"><h4>${esc(p.name)}</h4><div class="prod-unit">${esc(p.unit)}</div><div class="prod-foot"><span class="prod-price">${p.price} ج</span>
        ${p.available ? qty>0
          ? `<div class="qty-ctrl"><button class="qty-btn" onclick="chgQty('${p.id}',-1)">${icon('minus',13)}</button><span class="qty-num" id="qty-${p.id}">${qty}</span><button class="qty-btn" onclick="chgQty('${p.id}',1)">${icon('plus',13)}</button></div>`
          : `<button class="prod-add" onclick="addCart('${p.id}')">${icon('plus',15)}</button>`
          : '<span class="prod-unavail">غير متاح</span>'}
      </div></div></div>`;
    });
    html += '</div>';
  });
  document.getElementById('prods-section').innerHTML = html;
}


// ===== SEARCH =====
export const doSearch = debounce(function (val) {
  const res = document.getElementById('search-results');
  if (!val.trim()) { res.style.display='none'; res.innerHTML=''; return; }
  const v = val.toLowerCase();
  const matches = PRODS.filter(p => p.name.toLowerCase().includes(v) || (p.unit||'').toLowerCase().includes(v));
  const storeMatches = []; // will be populated from stores list
  res.style.display = 'block';
  if (!matches.length) { res.innerHTML='<div class="empty-state" style="padding:16px"><p>لا توجد نتائج</p></div>'; return; }
  res.innerHTML = matches.slice(0,8).map(p =>
    `<div class="res-item" onclick="showScreen('screen-store');renderProds('all')">
      <div class="thumb-sm">${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">` : icon('image',18)}</div>
      <div class="res-info"><strong>${esc(p.name)}</strong><small>${esc(p.unit)} • ${esc(p.storeName)}</small></div>
      <span class="res-price">${p.price} ج</span>
    </div>`
  ).join('');
}, 250);


// ===== FILTER CATEGORIES =====
export function filterCat(cat, el) {
  document.querySelectorAll('.cat-item').forEach(i=>i.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('.store-card').forEach(c => {
    c.style.display = (cat==='all'||c.dataset.cat===cat) ? 'block' : 'none';
  });
}


// ===== CART =====
export function addCart(id) {
  const p = PRODS.find(x=>x.id===id); if(!p) return;
  const ex = window.cart.find(x=>x.id===id);
  if (ex) ex.qty++; else window.cart.push({...p,qty:1});
  updateCartUI(); renderProds('all');
  showToast('أضيف للسلة','ok');
}
export function chgQty(id,d) {
  const item = window.cart.find(x=>x.id===id); if(!item) return;
  item.qty += d;
  if (item.qty <= 0) window.cart = window.cart.filter(x=>x.id!==id);
  updateCartUI(); renderProds('all');
}
export function removeCartItem(id) {
  window.cart = window.cart.filter(x=>x.id!==id);
  updateCartUI(); renderProds('all');
}
export function renderCartScreen() {
  const list = document.getElementById('cart-items-list');
  const lbl = document.getElementById('cart-item-count-lbl');
  const barTotal = document.getElementById('cart-total-full');
  const bar = document.getElementById('cart-bar-screen');
  if (!list) return;
  const count = window.cart.reduce((a,c)=>a+c.qty,0);
  const total = window.cart.reduce((a,c)=>a+c.price*c.qty,0);
  if (lbl) lbl.textContent = count ? count+' عنصر' : 'السلة فارغة';
  if (barTotal) barTotal.textContent = total+' ج';
  if (bar) bar.style.display = count>0 ? 'block' : 'none';
  if (!window.cart.length) {
    list.innerHTML = `<div class="empty-state"><div class="ei">${icon('shopping-cart',26)}</div><p>السلة فارغة</p><small>أضف منتجات من أي متجر</small></div>`;
    return;
  }
  list.innerHTML = window.cart.map(c => `
    <div class="card" style="margin-bottom:10px;display:flex;align-items:center;gap:10px">
      <div class="thumb-sm">${c.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="${esc(c.name)}" style="width:100%;height:100%;object-fit:cover">` : icon('image',22)}</div>
      <div style="flex:1;min-width:0">
        <h4 style="font-size:13px;font-weight:800;margin-bottom:2px">${esc(c.name)}</h4>
        <div style="font-size:11px;color:var(--color-text-muted)">${esc(c.storeName)||''}</div>
        <div class="t-price" style="color:var(--color-primary);margin-top:4px">${c.price} ج</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
        <div class="qty-ctrl"><button class="qty-btn" onclick="chgQty('${c.id}',-1)">${icon('minus',13)}</button><span class="qty-num">${c.qty}</span><button class="qty-btn" onclick="chgQty('${c.id}',1)">${icon('plus',13)}</button></div>
        <button onclick="removeCartItem('${c.id}')" style="background:none;border:none;color:var(--color-danger);font-size:11px;cursor:pointer;display:flex;align-items:center;gap:3px">${icon('trash',13)} حذف</button>
      </div>
    </div>`).join('');
}
export function updateCartUI() {
  const count = window.cart.reduce((a,c)=>a+c.qty,0);
  const total = window.cart.reduce((a,c)=>a+c.price*c.qty,0);
  document.getElementById('cart-b').textContent = count;
  const cs = document.getElementById('cart-count-s'); if(cs) cs.textContent=count;
  const ts = document.getElementById('cart-total-s'); if(ts) ts.textContent=total+' ج';
  const bar = document.getElementById('cart-bar-store'); if(bar) bar.style.display=count>0?'block':'none';
  if (document.getElementById('screen-cart')?.classList.contains('active')) renderCartScreen();
}
export function openCart() {
  const active = document.querySelector('.screen.active');
  if (active && active.id !== 'screen-cart') window.cartReturnScreen = active.id;
  showScreen('screen-cart');
  renderCartScreen();
}


// ===== CUSTOMER FUNCTIONS =====
export function loadCustomerData() {
  if (!window.CUD) return;
  const ud = window.CUD;
  document.getElementById('cust-name').textContent = ud.name || '--';
  const greetEl = document.getElementById('hdr-greet');
  if (greetEl) { const first = (ud.name||'').trim().split(' ')[0]; greetEl.textContent = first ? `أهلاً ${first}` : 'أهلاً بيك'; }
  const pts = ud.points || 0;
  ['user-pts','pts-big','pts-prof','pts-menu'].forEach(id => { const el=document.getElementById(id); if(el) el.textContent=pts; });
  if (ud.photoURL) {
    ['cust-av'].forEach(id => { const el=document.getElementById(id); if(el) el.innerHTML=`<img src="${esc(ud.photoURL)}" alt="avatar">`; });
  }
  // إعادة تصميم صفحة "حسابي": عرض الهاتف/العنوان بس لو موجودين فعليًا (بدون بيانات وهمية)
  const phoneLine = document.getElementById('cust-phone-line');
  if (phoneLine) { if (ud.phone) { document.getElementById('cust-phone').textContent = ud.phone; phoneLine.style.display = 'flex'; } else phoneLine.style.display = 'none'; }
  const addrLine = document.getElementById('cust-address-line');
  if (addrLine) { if (ud.address) { document.getElementById('cust-address').textContent = ud.address; addrLine.style.display = 'flex'; } else addrLine.style.display = 'none'; }
  loadOrders();
  loadStores();
}

// عدد الطلبات الحقيقي (Count دقيق عبر getCountFromServer، مش من قائمة الـ 10 الأخيرة المحدودة
// اللي بيعرضها loadOrders() - عشان الرقم يكون صحيح مش مضلِّل لعميل عنده أكتر من 10 طلبات).
// بيتحمّل مرة واحدة بس لما شاشة "حسابي" تتفتح فعليًا، مش من أول تسجيل دخول.
let profileStatsLoaded = false;
export async function loadProfileStats() {
  if (profileStatsLoaded || !window.CU) return;
  profileStatsLoaded = true;
  const el = document.getElementById('acc-ord-count');
  if (!el) return;
  try {
    const cAgg = await getCountFromServer(query(collection(db,'orders'), where('customerId','==',window.CU.uid)));
    el.textContent = cAgg.data().count;
  } catch (e) { el.textContent = '--'; }
}

export let ordersUnsub = null;
export function loadOrders() {
  if (!window.CU) return;
  if (ordersUnsub) return;
  try {
    const q = query(collection(db,'orders'), where('customerId','==',window.CU.uid), orderBy('createdAt','desc'), limit(10));
    ordersUnsub = onSnapshot(q, snap => {
      const lists = document.querySelectorAll('.orders-list-el');
      if (!lists.length) return;
      if (snap.empty) { lists.forEach(list => list.innerHTML = `<div class="empty-state"><div class="ei">${icon('package',26)}</div><p>لا توجد طلبات</p><small>اطلب من أي متجر</small></div>`); return; }
      let html = '';
      snap.forEach(d => {
        const o = {...d.data(), id:d.id};
        const st = normalizeStatus(o.status);
        const isEnded = st === ORDER_STATUS.CANCELLED || st === ORDER_STATUS.MERCHANT_REJECTED;
        const si = NEW_STEPS.indexOf(st);
        const stepsHtml = isEnded
          ? `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;color:var(--color-danger);font-size:12px;font-weight:700">${icon('alert-circle',14)} ${st===ORDER_STATUS.MERCHANT_REJECTED?'تم رفض الطلب من المتجر':'تم إلغاء الطلب'}</div>`
          : NEW_STEPS.map((s,i) => {
              return `<div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:38px"><div style="width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid ${i<=si?i<si?'var(--color-success)':'var(--color-primary)':'var(--color-border)'};background:${i<si?'var(--color-success)':i===si?'var(--color-primary)':'var(--color-surface)'};color:${i<=si?'#fff':'var(--color-text-muted)'}">${NEW_STEP_ICONS[i]}</div><div style="font-size:8px;color:${i===si?'var(--color-primary)':'var(--color-text-muted)'};text-align:center;margin-top:2px;white-space:nowrap;font-weight:${i===si?800:600}">${NEW_STEP_LABELS[i]}</div></div>`;
            }).join('');
        html += `<div class="order-track-card card" style="margin-bottom:10px;cursor:pointer" onclick="openTrack('${d.id}')">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <span style="font-size:11px;font-weight:700;color:var(--color-text-muted)">#${d.id.slice(-6).toUpperCase()}</span>
            ${orderStatusBadge(o.status)}
          </div>
          <div style="display:flex;gap:4px;margin-bottom:8px;overflow-x:auto">${stepsHtml}</div>
          <div style="display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid var(--color-border);font-size:12px">
            <span style="color:var(--color-text-muted);display:flex;align-items:center;gap:4px">${icon('store',13)} ${esc(o.storeName)||'--'}</span>
            <span class="t-price" style="color:var(--color-primary)">${o.total||0} ج</span>
          </div>
        </div>`;
      });
      lists.forEach(list => list.innerHTML = html);
    });
  } catch(e) { console.log(e); }
}

export function custNav(tab, el) {
  document.querySelectorAll('#screen-customer .nav-item').forEach(n=>n.classList.remove('active'));
  if(el) el.classList.add('active');
  document.getElementById('tab-home').style.display = tab==='home'?'block':'none';
  document.getElementById('tab-orders').style.display = tab==='orders'?'block':'none';
  document.getElementById('tab-rewards').style.display = tab==='rewards'?'block':'none';
  document.getElementById('tab-profile').style.display = tab==='profile'?'block':'none';
  if (tab==='profile') loadProfileStats();
}


// ===== CANCELLATION (Baseline Recovery) =====
// بيتنده من زرار "إلغاء الطلب" اللي orders.js بيعرضه في شاشة التتبع (openTrack) بس والحالة
// لسه مسموح فيها بالإلغاء. الحماية الحقيقية (مين يقدر يلغي وامتى) في Firestore Rules - هنا
// بس تأكيد + استدعاء custCancelOrder (اللي بيستخدم transitionOrder/runTransaction الحقيقيين).
export async function custCancelOrderUI(orderId) {
  if (!orderId || !window.CU) return;
  if (!confirm('هل أنت متأكد من إلغاء الطلب؟')) return;
  try {
    await custCancelOrder(orderId, { type: 'customer', uid: window.CU.uid });
    showToast('✅ تم إلغاء الطلب', 'ok');
  } catch (e) {
    showToast(e?.message === 'invalid-transition' ? 'لا يمكن إلغاء الطلب في هذه المرحلة' : 'حدث خطأ، حاول مرة أخرى', 'err');
  }
}

// ===== RATING =====
export function selectRatingTarget(target) {
  window.ratingTarget = target;
  document.querySelectorAll('.rt-card').forEach(c=>c.classList.remove('active'));
  document.getElementById('rt-'+target).classList.add('active');
}
export function setStar(n) {
  window.ratingStars = n;
  document.querySelectorAll('.star').forEach((s,i)=>s.classList.toggle('active',i<n));
}
export async function submitRating() {
  if (!window.CU || !window._currentTrackOrd) return;
  const o = window._currentTrackOrd;
  try {
    await addDoc(collection(db,'ratings'), {
      orderId: o.id, targetId: window.ratingTarget==='store'?o.storeId:o.driverId,
      targetType: window.ratingTarget, stars: window.ratingStars,
      comment: document.getElementById('rating-comment').value||'',
      customerId: window.CU.uid, createdAt: serverTimestamp()
    });
    showToast('شكراً لتقييمك!','ok');
    document.getElementById('rating-section').style.display='none';
  } catch(e) { showToast('حدث خطأ','err'); }
}


// ===== JOIN MERCHANT =====
export function selMCat(btn){document.querySelectorAll('.cat-g-btn').forEach(b=>b.classList.remove('sel'));btn.classList.add('sel');}
export async function submitMerchant(){
  const name=document.getElementById('jm-name').value.trim();
  const phone=document.getElementById('jm-phone').value.trim();
  const addr=document.getElementById('jm-addr').value.trim();
  if(!name||!phone){showToast('يرجى تعبئة اسم المتجر والهاتف','err');return;}
  try{
    await addDoc(collection(db,'merchant_requests'),{storeName:name,phone,address:addr,status:'pending',createdAt:serverTimestamp()});
    showToast('تم إرسال طلب الانضمام! سنتواصل خلال 24 ساعة','ok');
    setTimeout(()=>showScreen('screen-entry'),2500);
  }catch(e){showToast('حدث خطأ أثناء إرسال الطلب، حاول مرة أخرى','err');console.error('[submitMerchant]',e);}
}


// ===== ANY REQUEST =====
export function openAnyReq(){document.getElementById('any-req-modal').classList.add('open');}
export function quickReq(txt){document.getElementById('any-req-txt').value=txt;}
export async function sendAnyReq(){
  const txt=document.getElementById('any-req-txt').value.trim();
  if(!txt){showToast('يرجى كتابة طلبك','err');return;}
  try{
    await addDoc(collection(db,'any_requests'),{customerId:window.CU?.uid||'guest',customerName:window.CUD?.name||'عميل',request:txt,address:document.getElementById('any-req-addr').value,status:'new',createdAt:serverTimestamp()});
    closeModal('any-req-modal');showToast('تم إرسال طلبك! سيتواصل معك المندوب قريباً','ok');
  }catch(e){closeModal('any-req-modal');showToast('حدث خطأ أثناء إرسال الطلب، حاول مرة أخرى','err');console.error('[sendAnyReq]',e);}
}


// ===== تصفير أعلام المتابعة عند تسجيل الخروج (بيتنفذ من utils.js عبر clearAllListeners) =====
export function registerCustomerResets() {
  onListenersCleared(() => {
  productsUnsub = null; couponsUnsub = null; bannersUnsub = null; categoriesUnsub = null;
  storesUnsub = null; ordersUnsub = null; productsByStoreUnsub = null;
  });
}
