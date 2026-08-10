// ===== Firebase Module =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getFirestore, collection, doc, addDoc, getDoc, getDocs, setDoc, updateDoc, onSnapshot, query, where, orderBy, serverTimestamp, limit, startAfter, deleteDoc, runTransaction, getCountFromServer, getAggregateFromServer, average, count, sum, arrayUnion } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, GoogleAuthProvider, EmailAuthProvider, signInWithRedirect, linkWithRedirect, linkWithCredential, fetchSignInMethodsForEmail, getRedirectResult, sendPasswordResetEmail, isSignInWithEmailLink, signInWithEmailLink, sendSignInLinkToEmail } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";

// ===== CONFIG =====
const FC = {
  apiKey: "AIzaSyAwwthF9s8YhroiDzOK79_rZtepVgml6f4",
  authDomain: "go-elmanayef.firebaseapp.com",
  projectId: "go-elmanayef",
  storageBucket: "go-elmanayef.firebasestorage.app",
  messagingSenderId: "147528629413",
  appId: "1:147528629413:web:c59a3b3757d42fa911614c",
  measurementId: "G-D8PD7CGK5R"
};

const app = initializeApp(FC);
const db = getFirestore(app);
const auth = getAuth(app);
const gProvider = new GoogleAuthProvider();

// ===== EXPORTS =====
export { db, auth, gProvider, collection, doc, addDoc, getDoc, getDocs, setDoc, updateDoc, onSnapshot, query, where, orderBy, serverTimestamp, limit, startAfter, deleteDoc, runTransaction, getCountFromServer, getAggregateFromServer, average, count, sum, arrayUnion, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, signInWithRedirect, linkWithRedirect, linkWithCredential, fetchSignInMethodsForEmail, EmailAuthProvider, getRedirectResult, sendPasswordResetEmail, isSignInWithEmailLink, signInWithEmailLink, sendSignInLinkToEmail };

// ===== CLOUDINARY CONFIG =====
export const CLOUDINARY_CLOUD = 'yfohr6xd';
export const CLOUDINARY_PRESET = 'manayef_docs2';

// ===== GLOBALS =====
window.CU = null; // current user
window.CUD = null; // current user data
window.cart = [];
window.agreedTerms = false;
window.selectedType = 'customer';
window.onlineStatus = true;
window.commRate = 10;
window.ratingTarget = 'store';
window.ratingStars = 5;
window.trackMap = null;
window.drvMap = null;
window.admMap = null;
window.driverMarker = null;
window.customerMarker = null;
window.storeMarker = null;
window._pendingOrdId = null;
window._currentTrackOrd = null;
window._gpsInterval = null;
window._gpsWatch = null;

// Store location (El-Manayef area)
export const STORE_LOC = [30.5965, 32.2715];
export const DEFAULT_LOC = [30.5965, 32.2715];
