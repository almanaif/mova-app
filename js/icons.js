// ===== icons.js — MOVA Icon System (Phase B: Design System) =====
// نقطة مركزية واحدة لكل أيقونات الواجهة. بديل موحّد للـ Emoji كأيقونات UI
// (راجع MOVA Design System v1.0 §2-5). ليس فيه أي منطق عمل — presentation فقط.
//
// الاستخدام:
//   import { icon, renderIcons } from './icons.js';
//   el.innerHTML = icon('home', 20);
// أو في HTML ثابت: <span data-icon="home" data-size="20"></span> ثم renderIcons() تستبدلها.
//
// كل الأيقونات بنفس الـ visual family: outline, stroke-width=2, viewBox 24x24,
// stroke="currentColor" (يورث اللون من CSS) — عشان الاتساق البصري في كل مكان.

const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

// Path data فقط (بدون <svg> wrapper) لكل أيقونة — Lucide-style outline icons.
const PATHS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M9.5 20v-6h5v6"/>',
  package: '<path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/><path d="M20 16.5V7.5a1 1 0 0 0-.5-.87l-7-4a1 1 0 0 0-1 0l-7 4a1 1 0 0 0-.5.87v9a1 1 0 0 0 .5.87l7 4a1 1 0 0 0 1 0l7-4a1 1 0 0 0 .5-.87Z"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21.1 7 14.2l-5-4.9 6.9-1Z"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  map: '<path d="M9 18.5 3.5 21V5.5L9 3l6 2.5 5.5-2.5v15.5L15 21l-6-2.5Z"/><path d="M9 3v15.5"/><path d="M15 5.5V21"/>',
  'bar-chart-2': '<path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/>',
  bell: '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M18.4 17H5.6a1 1 0 0 1-.8-1.6c1-1.3 2.2-2.4 2.2-6.4a5 5 0 0 1 10 0c0 4 1.2 5.1 2.2 6.4a1 1 0 0 1-.8 1.6Z"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.3 2.3 4.7-4.9"/>',
  'alert-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
  'alert-triangle': '<path d="M10.6 4.1 2.2 18.5a1.4 1.4 0 0 0 1.2 2.1h17.2a1.4 1.4 0 0 0 1.2-2.1L13.4 4.1a1.4 1.4 0 0 0-2.8 0Z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5"/><path d="M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  'chevron-left': '<path d="m15 5-7 7 7 7"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'arrow-left': '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m13 18 6-6-6-6"/>',
  phone: '<path d="M15 17.5a11.7 11.7 0 0 1-8.5-8.5L9 6l-1.6-3.6A1.5 1.5 0 0 0 5.8 1.5H3A1.5 1.5 0 0 0 1.5 3c0 10.8 8.7 19.5 19.5 19.5A1.5 1.5 0 0 0 22.5 21v-2.8a1.5 1.5 0 0 0-.9-1.4L18 15.2Z"/>',
  'map-pin': '<path d="M20 10.5c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10.5" r="2.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m4 17 5-4.5 3.5 3L18 11l2 2.5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M15 17l5-5-5-5"/><path d="M20 12H9"/>',
  inbox: '<path d="M3.5 12h4.2l1.6 2.5h5.4l1.6-2.5h4.2"/><path d="M5.5 5.5h13l2 6.5v7a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 19v-7Z"/>',
  'shopping-cart': '<circle cx="9" cy="21" r="1.3"/><circle cx="18" cy="21" r="1.3"/><path d="M2.5 3h2.3l2.3 12.2a2 2 0 0 0 2 1.6h8a2 2 0 0 0 2-1.6L21 7H5.3"/>',
  utensils: '<path d="M8 2v7a2 2 0 0 0 4 0V2"/><path d="M8 2v20"/><path d="M17 2c-1.5 0-2.5 1.5-2.5 4v4c0 1.3.8 2 2 2v8"/>',
  pill: '<path d="m9 16 7-7"/><rect x="4.5" y="7.5" width="17" height="9" rx="4.5" transform="rotate(-45 13 12)"/><path d="M13 5.5 18.5 11"/>',
  store: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V9"/><path d="M3.5 9h17l-.7 3.5a2.2 2.2 0 0 1-4.3 0 2.2 2.2 0 0 1-4.3 0 2.2 2.2 0 0 1-4.4 0 2.2 2.2 0 0 1-4.3 0Z"/><path d="M5 12.5V20h14v-7.5"/>',
  bike: '<circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="M6 17 10 8h4l3 5"/><path d="M9 8h3"/><path d="m14 13 4 4"/>',
  ticket: '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h15A1.5 1.5 0 0 1 21 8.5v2a2 2 0 0 0 0 3v2A1.5 1.5 0 0 1 19.5 17h-15A1.5 1.5 0 0 1 3 15.5v-2a2 2 0 0 0 0-3Z"/><path d="M10 7v10" stroke-dasharray="2.2 2.2"/>',
  'file-text': '<path d="M6 3h8l4.5 4.5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4.5H18.5"/><path d="M8.5 13h7"/><path d="M8.5 16.5h7"/>',
  wallet: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h13A1.5 1.5 0 0 1 19 7.5v2"/><path d="M3 7.5v9A1.5 1.5 0 0 0 4.5 18h15a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 19.5 9H16a2 2 0 0 0 0 4h4.5"/>',
  loader: '<path d="M12 3v3"/><path d="m18.4 5.6-2.1 2.1"/><path d="M21 12h-3"/><path d="m18.4 18.4-2.1-2.1"/><path d="M12 21v-3"/><path d="m5.6 18.4 2.1-2.1"/><path d="M3 12h3"/><path d="m5.6 5.6 2.1 2.1"/>',
};

/**
 * يرجّع inline SVG markup لأيقونة معينة.
 * @param {string} name اسم الأيقونة (مفتاح PATHS)
 * @param {number} size الحجم بالبكسل — استخدم فقط: 12,16,20,24,28,32 (Icon Size Tokens)
 * @param {string} className كلاسات إضافية اختيارية
 */
export function icon(name, size = 20, className = '') {
  const p = PATHS[name];
  if (!p) return '';
  return `<svg class="icon${className ? ' ' + className : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE} aria-hidden="true" focusable="false">${p}</svg>`;
}

/** يستبدل كل [data-icon] الموجودة تحت root بالـ SVG المناظر — للاستخدام مع markup ثابت في index.html */
export function renderIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.getAttribute('data-icon');
    const size = parseInt(el.getAttribute('data-size') || '20', 10);
    if (!el.querySelector('svg')) el.innerHTML = icon(name, size);
  });
}
