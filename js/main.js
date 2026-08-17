// ===== main.js — نقطة الدخول: يجمّع كل الموديولات، يربطها بـ window عشان أزرار onclick في
// الواجهة تلاقيها، يجهّز PWA، ويستمع لحالة تسجيل الدخول في Firebase =====

import { db, auth, doc, getDoc, onAuthStateChanged, getRedirectResult,
         isSignInWithEmailLink, signInWithEmailLink } from './firebase.js';
import { Logger, initOfflineHandling, callCurrentStore, callStore, closeModal, filterProds, openNotifs, openWA, setLoad, showErr, showScreen, showToast, waCurrentStore } from './utils.js';
import { markNotifRead, startNotifListener, registerNotificationsResets } from './notifications.js';
import { initAdminMap, initTrackMap, closeLocationPicker, locPickerConfirm, locPickerUseCurrent, recenterTrackMap, toggleDriverMap, registerMapsResets } from './maps.js';
import { goCheckout, openTrack, registerOrdersResets } from './orders.js';
import { addCart, chgQty, custCancelOrderUI, custNav, doSearch, filterCat, loadBanners, loadCategories, loadCoupons, loadCustomerData, loadOrders, loadProducts, loadProductsByStore, loadStores, openAnyReq, openCart, openCustomerLocationPicker, quickReq, removeCartItem, renderProds, selMCat, selectRatingTarget, sendAnyReq, setStar, submitMerchant, submitRating, updateCartUI, registerCustomerResets } from './customer.js';
import { acceptOrd, agreeTermsModal, buildChart, closeTermsModal, closeZoom, dregBack, dregGetLocation, dregInit, dregNext, dregRestart, dregSaveDraft, dregSetExp, drvNav, getLocation, listenNewOrders, loadDriverData, loadDriverOrders, openTermsModal, removeUploadedDoc, startGPS, submitDrvReg, toggleAgree, toggleOnline, updOrdStatus, uploadDoc, zoomDoc, registerDriverResets } from './driver.js';
import { delProd, loadMerchantData, loadMerchantOrders, loadMerchantProds, merchAcceptOrd, merchCancelOrdUI, merchRejectOrd, openAddProd, openMerchantLocationPicker, saveProd, registerMerchantResets } from './merchant.js';
import { admAccDrv, admAccStore, admDelProd, admLogoutConfirm, admNav, admRejDrv, admRejStore, admUpdOrd, closeReasonModal, closeStoreManage, confirmReasonModal, delBanner, delCat, delCoupon, editBanner, editCat, editCoupon, filtDrvs, filtOrds, loadAdminData, loadAuditLog, loadMoreDrivers, loadMoreMerchants, loadMoreOrders, logAudit, openAddBanner, openAddCat, openAddCoupon, openDrvModal, openEditProd, openReasonModal, openStoreManage, renderAdminBanners, renderAdminCats, renderAdminCoupons, saveBanner, saveCat, saveComm, savePricingSettings, saveCoupon, saveEditProd, smDeleteCover, smDeleteStore, smQuickActivate, smQuickPause, smSaveProfile, smSetAccountStatus, smSetOpen, smTab, smUploadCover, smUploadLogo, toggleProdAvail, uploadBannerImg, registerAdminResets } from './admin.js';
import { onCustomerSearchInput, filterCustomersByStatus, loadMoreCustomers, openCustomerDetails, closeCustomerDetails, saveCustomerBasicInfo, toggleCustomerBlock, softDeleteCustomer, loadMoreCustomerOrders, registerCustomerListReset } from './admin-customers.js';
import { loadMoreMerchantRequests, loadMoreAnyRequests, acceptMerchantRequest, rejectMerchantRequest, addNoteToMerchantRequest, acceptAnyRequest, rejectAnyRequest, addNoteToAnyRequest } from './admin-requests.js';
import { completeRegistration, doLogin, doLogout, doRegister, firebaseAuthErrorMessage, handleGoogleAccountConflict, hideLoading, loginGoogle, pickEntryType, routeUser, selCMCat, showEmailOTP, showForgot, submitMerchantProfile, switchTab, syncToHubSpot, updateEntryLabel } from './auth.js';
import { openRideRequest, resetRideRequest, selectRideVehicle, createRideRequest, acceptRideOffer, rejectRideOffer, retryDispatch, handleDriverRideAction, registerRidesResets } from './rides.js';
import { sendExternalPurchase, retryExternalDispatch, acceptExternalOffer, rejectExternalOffer, handleDriverExternalAction, reportItemUnavailableFromPanel, reportBudgetExceededFromPanel, epCustomerCancel, epCustomerContinue, epCloseStatus, registerExternalResets } from './external.js';
import { renderIcons } from './icons.js';

// MOVA Design System v1.0: يملأ كل عناصر [data-icon] الثابتة في index.html بالـ SVG
// المناظر من نظام الأيقونات الموحد (بديل الـ Emoji). Presentation فقط — صفر منطق عمل.
renderIcons();

// كل موديول عنده أعلام subscribe (زي productsUnsub) بيسجّل دالة تصفيرها هنا -- لازم يتنفذوا
// بعد ما كل الموديولات خلصت تحميل (يعني هنا في main.js تحديدًا) عشان نتجنب مشكلة
// "Cannot access '...' before initialization" الناتجة عن الاستيراد الدائري بين utils.js
// والموديولات التانية لو نادينا onListenersCleared من جوه الموديولات نفسها مباشرة.
registerCustomerResets();
registerNotificationsResets();
registerOrdersResets();
registerMapsResets();
registerDriverResets();
registerMerchantResets();
registerAdminResets();
registerCustomerListReset();
registerRidesResets();
registerExternalResets();

// ===== EXPOSE TO WINDOW =====
// app.js (اتقسم دلوقتي لموديولات) بيتحمّل كـ ES module، فالدوال في الأعلى مش بتبقى
// global تلقائيًا. index.html بينده الدوال دي من onclick="..." واللي بتدور عليها في
// window بس. من غير الكتلة دي، أي زرار في التطبيق هيفشل بصمت.
Object.assign(window, {
  callCurrentStore, callStore, closeModal, filterProds, openNotifs, openWA, setLoad, showErr,
  showScreen, showToast, waCurrentStore, markNotifRead, startNotifListener, initAdminMap,
  initTrackMap, recenterTrackMap, toggleDriverMap, goCheckout, openTrack, addCart, chgQty, custNav, doSearch,
  locPickerConfirm, locPickerUseCurrent, openCustomerLocationPicker, closeLocationPicker,
  filterCat, loadBanners, loadCategories, loadCoupons, loadCustomerData, loadOrders,
  loadProducts, loadProductsByStore, loadStores, openAnyReq, openCart, quickReq,
  removeCartItem, renderProds, selMCat, selectRatingTarget, sendAnyReq, setStar,
  submitMerchant, submitRating, updateCartUI, custCancelOrderUI, acceptOrd, agreeTermsModal, buildChart,
  closeTermsModal, closeZoom, dregBack, dregGetLocation, dregInit, dregNext, dregRestart,
  dregSaveDraft, dregSetExp, drvNav, getLocation, listenNewOrders, loadDriverData,
  loadDriverOrders, openTermsModal, removeUploadedDoc, startGPS, submitDrvReg, toggleAgree,
  toggleOnline, updOrdStatus, uploadDoc, zoomDoc, delProd, loadMerchantData,
  loadMerchantOrders, loadMerchantProds, merchAcceptOrd, merchCancelOrdUI, merchRejectOrd, openAddProd, openMerchantLocationPicker, saveProd, admAccDrv,
  admAccStore, admDelProd, admLogoutConfirm, admNav, admRejDrv, admRejStore, admUpdOrd,
  closeReasonModal, closeStoreManage, confirmReasonModal, delBanner, delCat, delCoupon,
  editBanner, editCat, editCoupon, filtDrvs, filtOrds, loadAdminData, loadAuditLog, loadMoreCustomers, loadMoreDrivers, loadMoreMerchants, loadMoreOrders, logAudit, onCustomerSearchInput, filterCustomersByStatus, openCustomerDetails, closeCustomerDetails, saveCustomerBasicInfo, toggleCustomerBlock, softDeleteCustomer, loadMoreCustomerOrders, loadMoreMerchantRequests, loadMoreAnyRequests, acceptMerchantRequest, rejectMerchantRequest, addNoteToMerchantRequest, acceptAnyRequest, rejectAnyRequest, addNoteToAnyRequest,
  openAddBanner, openAddCat, openAddCoupon, openDrvModal, openEditProd, openReasonModal,
  openStoreManage, renderAdminBanners, renderAdminCats, renderAdminCoupons, saveBanner,
  saveCat, saveComm, savePricingSettings, saveCoupon, saveEditProd, smDeleteCover, smDeleteStore, smQuickActivate,
  smQuickPause, smSaveProfile, smSetAccountStatus, smSetOpen, smTab, smUploadCover,
  smUploadLogo, toggleProdAvail, uploadBannerImg, doLogin, doLogout, doRegister, hideLoading,
  loginGoogle, pickEntryType, routeUser, completeRegistration, submitMerchantProfile, selCMCat, showEmailOTP, showForgot, switchTab,
  syncToHubSpot, updateEntryLabel, openRideRequest, resetRideRequest, selectRideVehicle, createRideRequest,
  acceptRideOffer, rejectRideOffer, retryDispatch, handleDriverRideAction,
  sendExternalPurchase, retryExternalDispatch, acceptExternalOffer, rejectExternalOffer,
  handleDriverExternalAction, reportItemUnavailableFromPanel, reportBudgetExceededFromPanel,
  epCustomerCancel, epCustomerContinue, epCloseStatus
});

// ===== PWA =====
// ملحوظة: أي خطأ هنا (خصوصًا تسجيل service worker من blob: URL، اللي ممكن يرفضه المتصفح)
// كان بيوقف تنفيذ باقي الملف بالكامل — بما فيه مستمع onAuthStateChanged اللي بيقفل شاشة
// التحميل. لف الكود ده في try/catch يضمن إن فشل جزء PWA (ثانوي) مايوقفش تحميل التطبيق كله.
try {
  const mf={name:'MOVA',short_name:'MOVA',start_url:'/',display:'standalone',background_color:'#1A1A2E',theme_color:'#FF6B00',description:'توصيل سريع في المنايف',icons:[{src:'https://via.placeholder.com/192x192/FF6B00/FFFFFF?text=GO',sizes:'192x192',type:'image/png'},{src:'https://via.placeholder.com/512x512/FF6B00/FFFFFF?text=GO',sizes:'512x512',type:'image/png'}]};
  const mb=new Blob([JSON.stringify(mf)],{type:'application/json'});
  const manifestLink = document.getElementById('manifest-link');
  if(manifestLink) manifestLink.setAttribute('href',URL.createObjectURL(mb));
  if('serviceWorker' in navigator){const sw=`const C='mg-v1';self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(['/']))));self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))));`;const sb=new Blob([sw],{type:'application/javascript'});navigator.serviceWorker.register(URL.createObjectURL(sb)).catch(()=>{});}
} catch(e) { Logger.error('PWA setup failed (non-fatal):', e); }

// ===== AUTH STATE LISTENER =====
getRedirectResult(auth).catch(e => {
  console.log('Redirect result error:', e);
  if (e?.code === 'auth/account-exists-with-different-credential') {
    setTimeout(() => handleGoogleAccountConflict(e), 800);
  } else if (e?.code && e.code !== 'auth/no-auth-event') {
    setTimeout(() => showToast(firebaseAuthErrorMessage(e), 'err'), 1500);
  }
});

if (isSignInWithEmailLink(auth, window.location.href)) {
  let emailForLink = window.localStorage?.getItem('emailForSignIn');
  if (!emailForLink) emailForLink = prompt('أدخل بريدك الإلكتروني لتأكيد الدخول:');
  if (emailForLink) {
    signInWithEmailLink(auth, emailForLink, window.location.href)
      .then(() => {
        window.localStorage?.removeItem('emailForSignIn');
        window.history.replaceState({}, document.title, window.location.pathname);
      })
      .catch(e => {
        showToast(firebaseAuthErrorMessage(e), 'err');
        window.history.replaceState({}, document.title, window.location.pathname);
      });
  }
}

initOfflineHandling();

onAuthStateChanged(auth, async user => {
  if (user) {
    window.CU = user;
    try {
      const ud = await getDoc(doc(db,'users',user.uid));
      if (ud.exists()) {
        window.CUD = ud.data();
        // Resume Registration (Auth V2): تاجر عنده users/{uid} لكن من غير stores/{uid} - تسجيل
        // قديم لم يكتمل (كان ده الـ Bug المكتشف في مراجعة Google Sign-In). يُعامل كتسجيل غير
        // مكتمل، صفر مستند جديد بيتعمل، بس بيرجعله لنفس الخطوة الناقصة.
        if (window.CUD.role === 'merchant') {
          const sd = await getDoc(doc(db,'stores',user.uid));
          if (!sd.exists()) { hideLoading(); showScreen('screen-complete-merchant'); return; }
        }
        hideLoading();
        routeUser();
      } else {
        // Authentication Gateway (V2): الـ Gateway هنا مسؤول عن القراءة والتوجيه بس - صفر كتابة
        // Business Document من هنا لأي Provider (Email/Google/أي حاجة مستقبلية). أي مستخدم جديد
        // بيتوجه لشاشة اختيار الدور، والإنشاء الفعلي بيحصل في completeRegistration() (auth.js)
        // بس لحظة ما المستخدم يختار دوره فعليًا.
        hideLoading();
        showScreen('screen-role-select');
      }
    } catch(e) {
      console.error('Auth routing error:', e);
      hideLoading();
      showToast(firebaseAuthErrorMessage(e), 'err');
      showScreen('screen-entry');
    }
  } else {
    window.CU = null; window.CUD = null;
    hideLoading();
    showScreen('screen-entry');
  }
});
