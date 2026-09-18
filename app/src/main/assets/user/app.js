import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, sendEmailVerification, reload, signOut
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where,
  orderBy, limit, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyC7edqJT1jxXHT6Xwk2M06bf3UVTDEQh_w',
  authDomain: 'kaido-follow-b597e.firebaseapp.com',
  databaseURL: 'https://kaido-follow-b597e-default-rtdb.firebaseio.com',
  projectId: 'kaido-follow-b597e',
  storageBucket: 'kaido-follow-b597e.firebasestorage.app',
  messagingSenderId: '521250677507',
  appId: '1:521250677507:web:c5f3f834fe15994c03ff36'
};

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);
const API = 'https://us-central1-kaido-follow-b597e.cloudfunctions.net/api';

let me = null;
let profile = {};
let cats = [];
let allServices = [];
let orders = [];
let paymentMethods = [];
let activeMethod = null;
let service = null;
let selectedOrder = null;
let settings = {};
let currentPage = 'home';
let orderFilter = 'ALL';
let unsubscribers = [];

const $ = id => document.getElementById(id);
const money = n => '$' + Number(n || 0).toFixed(4);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dt = t => {
  try {
    const d = t?.toDate ? t.toDate() : new Date(t);
    if (!d || Number.isNaN(d.getTime())) return '-';
    return new Intl.DateTimeFormat('ar-IQ', { dateStyle:'medium', timeStyle:'short' }).format(d);
  } catch { return '-'; }
};
const safeMedia = u => {
  try { const x = new URL(String(u || '')); return ['https:','http:'].includes(x.protocol) ? x.href : ''; }
  catch { return ''; }
};

function toast(text) {
  $('toast').textContent = String(text || '');
  $('toast').classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => $('toast').classList.remove('show'), 3000);
}
function loading(v) { $('loader').classList.toggle('on', !!v); }
function clearListeners() {
  unsubscribers.forEach(fn => { try { fn(); } catch {} });
  unsubscribers = [];
}
function errorText(e) {
  const code = String(e?.message || '');
  const map = {
    INSUFFICIENT_BALANCE:'الرصيد غير كافٍ',
    ACCOUNT_BANNED:'الحساب موقوف',
    INVALID_COUPON:'الكوبون غير صحيح',
    COUPON_ALREADY_USED:'تم استخدام هذا الكوبون مسبقاً',
    COUPON_DISABLED:'الكوبون متوقف',
    COUPON_EXPIRED:'انتهت صلاحية الكوبون',
    COUPON_LIMIT_REACHED:'اكتمل عدد استخدامات الكوبون',
    MINIMUM_5_USD:'الحد الأدنى للتحويل هو 5$',
    EMAIL_NOT_VERIFIED:'يجب توثيق البريد أولاً',
    USERNAME_TAKEN:'اسم المستخدم مستخدم بالفعل',
    INVALID_USERNAME:'اسم المستخدم غير صالح',
    RATE_LIMITED:'محاولات كثيرة، حاول بعد قليل',
    REFILL_NOT_SUPPORTED:'هذه الخدمة لا تدعم إعادة التعبئة',
    CANCEL_NOT_SUPPORTED:'هذه الخدمة لا تدعم الإلغاء',
    ORDER_NOT_CANCELABLE:'لا يمكن إلغاء هذا الطلب حالياً',
    PAYMENT_METHOD_UNAVAILABLE:'طريقة الشحن غير متاحة',
    RECHARGE_AMOUNT_OUT_OF_RANGE:'المبلغ خارج الحد المسموح',
    PROVIDER_NETWORK_UNKNOWN:'الطلب قيد المراجعة بسبب عدم وصول تأكيد نهائي من المزود'
  };
  for (const [k,v] of Object.entries(map)) if (code.includes(k)) return v;
  return code.replace(/^Firebase:\s*/,'').slice(0,220) || 'حدث خطأ غير متوقع';
}
async function api(path, body = {}, method = 'POST') {
  if (!me) throw new Error('UNAUTHENTICATED');
  const token = await me.getIdToken();
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type':'application/json', authorization:'Bearer ' + token },
    body: method === 'GET' ? undefined : JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || 'API_ERROR');
  return data;
}
function setOnlineState() {
  $('offline').classList.toggle('hide', navigator.onLine);
}
window.addEventListener('online', setOnlineState);
window.addEventListener('offline', setOnlineState);
setOnlineState();

window.authMode = mode => {
  $('login').classList.toggle('hide', !!mode);
  $('reg').classList.toggle('hide', !mode);
};
window.login = async () => {
  const email = $('le').value.trim();
  const pass = $('lp').value;
  if (!email || !pass) return toast('أدخل البريد وكلمة المرور');
  loading(true);
  try { await signInWithEmailAndPassword(auth, email, pass); }
  catch { toast('بيانات الدخول غير صحيحة'); }
  loading(false);
};
window.register = async () => {
  const name = $('rn').value.trim();
  const username = $('ru').value.trim();
  const email = $('re').value.trim();
  const pass = $('rp').value;
  const pass2 = $('rp2').value;
  const referralCode = $('rr').value.trim().toUpperCase();

  if (name.length < 2 || username.length < 3 || !email) return toast('تحقق من الاسم واسم المستخدم والبريد');
  if (pass.length < 8) return toast('كلمة المرور يجب أن تكون 8 أحرف أو أكثر');
  if (pass !== pass2) return toast('كلمتا المرور غير متطابقتين');
  if (!$('terms').checked) return toast('يجب الموافقة على الشروط وسياسة الخصوصية');

  loading(true);
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    me = cred.user;
    await api('/auth/bootstrap-profile', { name, username, referralCode });
    await sendEmailVerification(cred.user);
    toast('تم إنشاء الحساب. أرسلنا رابط توثيق إلى بريدك');
  } catch (e) {
    toast(errorText(e));
  }
  loading(false);
};
window.resetPass = async () => {
  const email = $('le').value.trim();
  if (!email) return toast('اكتب البريد الإلكتروني أولاً');
  try { await sendPasswordResetEmail(auth, email); toast('تم إرسال رابط تغيير كلمة المرور'); }
  catch (e) { toast(errorText(e)); }
};
window.resetCurrentPassword = async () => {
  if (!me?.email) return;
  try { await sendPasswordResetEmail(auth, me.email); toast('تم إرسال رابط تغيير كلمة المرور'); }
  catch (e) { toast(errorText(e)); }
};
window.logout = () => signOut(auth);

window.resendVerification = async () => {
  if (!me) return;
  loading(true);
  try { await sendEmailVerification(me); toast('تم إرسال رابط التوثيق'); }
  catch (e) { toast(errorText(e)); }
  loading(false);
};
window.refreshVerification = async () => {
  if (!me) return;
  loading(true);
  try {
    await reload(me);
    me = auth.currentUser;
    await api('/auth/sync-verification');
    renderVerification();
    toast(me.emailVerified ? 'تم توثيق البريد' : 'لم يتم التوثيق بعد');
  } catch (e) { toast(errorText(e)); }
  loading(false);
};

onAuthStateChanged(auth, async user => {
  clearListeners();
  me = user;
  $('auth').classList.toggle('hide', !!user);
  $('app').classList.toggle('hide', !user);
  if (!user) return;

  loading(true);
  try {
    const s = await getDoc(doc(db, 'users', user.uid));
    if (!s.exists()) {
      toast('الحساب غير مهيأ في نسخة المستخدم');
      await signOut(auth);
      return;
    }
    profile = s.data();
    initUserApp();
  } catch (e) {
    toast('تعذر تحميل الحساب');
  } finally {
    loading(false);
  }
});

function initUserApp() {
  listenProfile();
  listenCatalog();
  listenOrders();
  listenWallet();
  listenNotifications();
  listenChat();
  listenPayments();
  listenRechargeRequests();
  listenSettings();
  listenAnnouncements();
}

function renderVerification() {
  const verified = !!me?.emailVerified || !!profile.emailVerified;
  $('verifyBox').classList.toggle('hide', verified);
  $('verifyState').innerHTML = verified
    ? '<span class="ok">البريد موثق</span>'
    : '<span class="warn">البريد غير موثق</span>';
}
function listenProfile() {
  unsubscribers.push(onSnapshot(doc(db, 'users', me.uid), snap => {
    if (!snap.exists()) return;
    profile = snap.data();
    $('who').textContent = profile.name || me.email || '';
    $('pname').textContent = profile.name || '';
    $('pemail').textContent = me.email || '';
    $('puid').textContent = 'UID: ' + me.uid.slice(0, 14) + '…';
    $('accountId').textContent = me.uid.slice(0, 12);
    $('ename').value = profile.name || '';
    $('euser').value = profile.username || '';
    $('bal').textContent = $('wbal').textContent = money(profile.balance);
    $('spent').textContent = money(profile.spent);
    $('refcode').textContent = profile.inviteCode || '-';
    $('refcount').textContent = profile.inviteCount || 0;
    $('refearn').textContent = money(profile.inviteEarnings);
    renderVerification();
  }));
}
window.saveProfile = async () => {
  if (!me) return;
  const name = $('ename').value.trim();
  const username = $('euser').value.trim();
  if (name.length < 2 || username.length < 3) return toast('تحقق من الاسم واسم المستخدم');
  loading(true);
  try {
    if (name !== profile.name) {
      await updateDoc(doc(db, 'users', me.uid), { name, updatedAt: serverTimestamp() });
    }
    if (username.toLowerCase() !== String(profile.username || '').toLowerCase()) {
      await api('/auth/change-username', { username });
    }
    toast('تم حفظ التغييرات');
  } catch (e) { toast(errorText(e)); }
  loading(false);
};

function listenSettings() {
  unsubscribers.push(onSnapshot(doc(db, 'settings', 'general'), snap => {
    settings = snap.exists() ? snap.data() : {};
    if (settings.maintenanceMode === true) {
      $('announce').classList.remove('hide');
      $('announce').classList.add('danger');
      $('announce').innerHTML = '<b>وضع الصيانة</b><div class="subtitle">بعض الخدمات قد تكون غير متاحة حالياً.</div>';
    }
  }));
}
function listenAnnouncements() {
  unsubscribers.push(onSnapshot(collection(db, 'announcements'), snap => {
    const now = Date.now();
    const items = snap.docs.map(d => ({ id:d.id, ...d.data() })).filter(a => {
      if (a.active === false) return false;
      const start = a.startAt?.toMillis?.() ?? 0;
      const end = a.endAt?.toMillis?.() ?? Infinity;
      return start <= now && end >= now;
    }).sort((a,b) => Number(b.priority || 0) - Number(a.priority || 0));
    if (!items.length || settings.maintenanceMode) return;
    const a = items[0];
    $('announce').classList.remove('hide','danger');
    $('announce').innerHTML = '<b>' + esc(a.title || 'إعلان') + '</b><div class="subtitle">' + esc(a.body || '') + '</div>';
  }, () => {}));
}

function listenCatalog() {
  unsubscribers.push(onSnapshot(collection(db, 'categories'), snap => {
    cats = snap.docs.map(d => ({ id:d.id, ...d.data() }))
      .filter(x => x.visible !== false)
      .sort((a,b) => Number(a.seq || 0) - Number(b.seq || 0));
    renderCats();
  }));
  unsubscribers.push(onSnapshot(collection(db, 'services'), snap => {
    allServices = snap.docs.map(d => ({ id:d.id, ...d.data() }))
      .filter(x => x.visible !== false)
      .sort((a,b) => Number(a.seq || 0) - Number(b.seq || 0));
    renderPopular();
    renderCats();
  }));
}
function childCategories(parentId) { return cats.filter(c => String(c.parentId || '') === String(parentId || '')); }
function categoryServiceCount(catId) {
  const descendants = new Set([catId]);
  let changed = true;
  while (changed) {
    changed = false;
    cats.forEach(c => {
      if (c.parentId && descendants.has(c.parentId) && !descendants.has(c.id)) {
        descendants.add(c.id); changed = true;
      }
    });
  }
  return allServices.filter(s => descendants.has(s.categoryId)).length;
}
window.renderCats = () => {
  const top = cats.filter(c => !c.parentId);
  $('catCount').textContent = top.length ? top.length + ' أقسام' : '';
  $('cats').innerHTML = top.map(c => {
    const image = safeMedia(c.image);
    return '<button class="category click" data-cat="' + esc(c.id) + '">' +
      (image ? '<img src="' + esc(image) + '" alt="">' : '') +
      '<div class="cat-content"><div class="cat-icon">' +
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>' +
      '</div><b>' + esc(c.name) + '</b><div class="muted">' + categoryServiceCount(c.id) + ' خدمة</div></div></button>';
  }).join('') || '<div class="empty">لا توجد أقسام متاحة حالياً</div>';
  document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => openCategory(b.dataset.cat));
};
function serviceCard(s, compact = false) {
  const tags = [
    s.supportsRefill ? '<span class="badge success">Refill</span>' : '',
    s.supportsCancel ? '<span class="badge warning">Cancel</span>' : '',
    s.averageTime ? '<span class="badge info">' + esc(s.averageTime) + '</span>' : ''
  ].join('');
  return '<div class="card service-card click" data-service="' + esc(s.id) + '">' +
    '<div class="row"><div><b>' + esc(s.name) + '</b><div class="muted">' + esc(cats.find(c => c.id === s.categoryId)?.name || '') + '</div></div>' +
    '<b class="ok">' + money(s.price) + '<span class="tiny"> /1000</span></b></div>' +
    (!compact ? '<div class="row wrap" style="margin-top:9px"><span class="muted">' + Number(s.min || 1) + ' — ' + Number(s.max || 10000) + '</span><div class="row start wrap">' + tags + '</div></div>' : '') +
    '</div>';
}
function bindServiceCards(root = document) {
  root.querySelectorAll('[data-service]').forEach(el => el.onclick = () => {
    const s = allServices.find(x => x.id === el.dataset.service);
    if (s) prepare(s);
  });
}
function renderPopular() {
  const items = [...allServices].sort((a,b) =>
    Number(b.popular || 0) - Number(a.popular || 0) || Number(b.ordersCount || 0) - Number(a.ordersCount || 0)
  ).slice(0,5);
  $('popular').innerHTML = items.map(s => serviceCard(s, true)).join('') || '<div class="empty">ستظهر الخدمات هنا بعد إضافتها من الإدارة</div>';
  bindServiceCards($('popular'));
}
window.globalSearch = () => {
  const q = $('globalQ').value.trim().toLowerCase();
  if (!q) { $('searchResults').classList.add('hide'); $('searchResults').innerHTML = ''; return; }
  const catMatches = cats.filter(c => String(c.name || '').toLowerCase().includes(q)).slice(0,4);
  const svcMatches = allServices.filter(s => (String(s.name || '') + ' ' + String(s.providerServiceId || '')).toLowerCase().includes(q)).slice(0,8);
  $('searchResults').classList.remove('hide');
  $('searchResults').innerHTML =
    catMatches.map(c => '<button class="card click" data-search-cat="' + esc(c.id) + '"><b>' + esc(c.name) + '</b><div class="muted">قسم</div></button>').join('') +
    svcMatches.map(s => serviceCard(s, true)).join('') ||
    '<div class="empty">لا توجد نتائج</div>';
  document.querySelectorAll('[data-search-cat]').forEach(b => b.onclick = () => openCategory(b.dataset.searchCat));
  bindServiceCards($('searchResults'));
};
window.focusSearch = () => { go('home'); $('globalQ').focus(); };

function openCategory(id) {
  const cat = cats.find(c => c.id === id);
  const children = childCategories(id);
  $('stitle').textContent = cat?.name || 'الخدمات';
  if (children.length) {
    $('services').innerHTML = children.map(c =>
      '<button class="card click" data-subcat="' + esc(c.id) + '"><div class="row"><b>' + esc(c.name) + '</b><span class="badge">' + categoryServiceCount(c.id) + ' خدمة</span></div></button>'
    ).join('');
    $('services').querySelectorAll('[data-subcat]').forEach(b => b.onclick = () => openCategory(b.dataset.subcat));
  } else {
    const list = allServices.filter(s => s.categoryId === id);
    $('services').innerHTML = list.map(s => serviceCard(s)).join('') || '<div class="empty">لا توجد خدمات في هذا القسم</div>';
    bindServiceCards($('services'));
  }
  openM('servicesM');
}
function prepare(s) {
  service = s;
  $('ssum').innerHTML =
    '<div class="row"><b>' + esc(s.name) + '</b><span class="badge">' + esc(s.type || 'Default') + '</span></div>' +
    '<div class="divider"></div>' +
    '<div class="row"><span class="muted">السعر / 1000</span><b class="ok">' + money(s.price) + '</b></div>' +
    '<div class="row"><span class="muted">الحدود</span><b>' + Number(s.min || 1) + ' — ' + Number(s.max || 10000) + '</b></div>' +
    (s.averageTime ? '<div class="row"><span class="muted">متوسط البدء</span><b>' + esc(s.averageTime) + '</b></div>' : '') +
    (s.description ? '<div class="divider"></div><div class="subtitle">' + esc(s.description) + '</div>' : '');
  $('olink').value = '';
  $('oqty').value = '';
  $('total').textContent = '$0.0000';
  openM('orderM');
}
window.calc = () => {
  const q = Number($('oqty').value || 0);
  $('total').textContent = money((q / 1000) * Number(service?.price || 0));
};
window.submitOrder = async () => {
  if (!service) return;
  if (settings.maintenanceMode) return toast('التطبيق تحت الصيانة حالياً');
  if (settings.ordersEnabled === false) return toast('إنشاء الطلبات متوقف مؤقتاً');
  if (!me.emailVerified) return toast('يجب توثيق البريد قبل إنشاء الطلب');
  const link = $('olink').value.trim();
  const quantity = Number($('oqty').value);
  if (!/^https?:\/\//i.test(link)) return toast('أدخل رابطاً صحيحاً يبدأ بـ https://');
  if (!Number.isInteger(quantity) || quantity < Number(service.min || 1) || quantity > Number(service.max || 1000000)) {
    return toast('الكمية خارج حدود الخدمة');
  }

  loading(true);
  $('submit').disabled = true;
  try {
    const idempotencyKey = crypto.randomUUID?.() || (Date.now() + '-' + Math.random().toString(36).slice(2));
    const d = await api('/order/create', { serviceId:service.id, link, quantity, idempotencyKey });
    toast(d.status === 'NEEDS_REVIEW' ? 'الطلب قيد المراجعة' : 'تم إنشاء الطلب بنجاح');
    closeM('orderM');
    closeM('servicesM');
    go('orders');
  } catch (e) { toast(errorText(e)); }
  $('submit').disabled = false;
  loading(false);
};

function listenOrders() {
  const q = query(collection(db, 'orders'), where('userId','==',me.uid), orderBy('createdAt','desc'), limit(100));
  unsubscribers.push(onSnapshot(q, snap => {
    orders = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    renderOrders();
    renderLastOrder();
  }, () => {
    $('orders').innerHTML = '<div class="notice danger">تعذر تحميل الطلبات. تأكد من نشر Firestore Indexes.</div>';
  }));
}
function statusArabic(s) {
  const x = String(s || '').toUpperCase();
  return {
    CREATING:'قيد الإنشاء',PENDING:'بانتظار التنفيذ',PROCESSING:'قيد التنفيذ',IN_PROGRESS:'قيد التنفيذ',
    COMPLETED:'مكتمل',PARTIAL:'مكتمل جزئياً',CANCELED:'ملغي',FAILED:'فشل',
    REFUNDED:'مسترجع',NEEDS_REVIEW:'يحتاج مراجعة'
  }[x] || s || '-';
}
function statusClass(s) {
  const x = String(s || '').toUpperCase();
  if (x === 'COMPLETED') return 'success';
  if (['CANCELED','FAILED','REFUNDED'].includes(x)) return 'danger';
  if (['PARTIAL','NEEDS_REVIEW'].includes(x)) return 'warning';
  return 'info';
}
function orderMatchesFilter(o) {
  const s = String(o.status || '').toUpperCase();
  if (orderFilter === 'ALL') return true;
  if (orderFilter === 'ACTIVE') return ['CREATING','PENDING','PROCESSING','IN_PROGRESS'].includes(s);
  if (orderFilter === 'COMPLETED') return s === 'COMPLETED';
  if (orderFilter === 'ISSUE') return ['NEEDS_REVIEW','CANCELED','FAILED','PARTIAL','REFUNDED'].includes(s);
  return true;
}
window.setOrderFilter = (f, btn) => {
  orderFilter = f;
  document.querySelectorAll('#orderTabs .tab').forEach(x => x.classList.toggle('active', x === btn));
  renderOrders();
};
window.renderOrders = () => {
  const qv = $('oq').value.trim().toLowerCase();
  const list = orders.filter(orderMatchesFilter).filter(o =>
    !qv || (String(o.id) + ' ' + String(o.providerOrderId || '') + ' ' + String(o.service || '')).toLowerCase().includes(qv)
  );
  $('orders').innerHTML = list.map(o =>
    '<div class="card click" data-order="' + esc(o.id) + '">' +
      '<div class="row"><b>#' + esc(o.providerOrderId || o.id.slice(-9)) + '</b><span class="badge ' + statusClass(o.status) + '">' + esc(statusArabic(o.status)) + '</span></div>' +
      '<div style="margin-top:7px">' + esc(o.service) + '</div>' +
      '<div class="row muted" style="margin-top:8px"><span>' + Number(o.qty || 0).toLocaleString('en-US') + '</span><b class="ok">' + money(o.price) + '</b></div>' +
      '<div class="tiny" style="margin-top:6px">' + esc(dt(o.createdAt)) + '</div>' +
    '</div>'
  ).join('') || '<div class="empty"><div class="empty-icon">◎</div>لا توجد طلبات ضمن هذا الفلتر</div>';
  $('orders').querySelectorAll('[data-order]').forEach(el => el.onclick = () => openOrder(el.dataset.order));
};
function renderLastOrder() {
  const o = orders[0];
  if (!o) {
    $('lastOrder').innerHTML = '<div class="empty">لا توجد طلبات حتى الآن</div>';
    return;
  }
  $('lastOrder').innerHTML =
    '<div class="card click" data-last-order="' + esc(o.id) + '"><div class="row"><b>' + esc(o.service) + '</b><span class="badge ' + statusClass(o.status) + '">' + esc(statusArabic(o.status)) + '</span></div><div class="row muted" style="margin-top:8px"><span>#' + esc(o.providerOrderId || o.id.slice(-9)) + '</span><b>' + money(o.price) + '</b></div></div>';
  $('lastOrder').querySelector('[data-last-order]').onclick = () => openOrder(o.id);
}
function orderProgress(o) {
  const s = String(o.status || '').toUpperCase();
  if (s === 'COMPLETED') return 100;
  if (['PROCESSING','IN_PROGRESS','PARTIAL'].includes(s)) {
    const qty = Math.max(1, Number(o.qty || 1));
    const remains = Math.max(0, Number(o.remains ?? qty));
    return Math.max(10, Math.min(95, Math.round((1 - remains / qty) * 100)));
  }
  if (s === 'PENDING') return 12;
  return 4;
}
function openOrder(id) {
  const o = orders.find(x => x.id === id);
  if (!o) return;
  selectedOrder = o;
  const s = allServices.find(x => x.id === o.serviceId) || {};
  $('orderDetail').innerHTML =
    '<div class="card"><div class="row"><b>#' + esc(o.providerOrderId || o.id.slice(-10)) + '</b><span class="badge ' + statusClass(o.status) + '">' + esc(statusArabic(o.status)) + '</span></div>' +
      '<div class="progress" style="margin-top:13px"><span style="width:' + orderProgress(o) + '%"></span></div>' +
    '</div>' +
    '<div class="card stack">' +
      '<div class="row"><span class="muted">الخدمة</span><b>' + esc(o.service) + '</b></div>' +
      '<div class="row"><span class="muted">الكمية</span><b>' + Number(o.qty || 0).toLocaleString('en-US') + '</b></div>' +
      '<div class="row"><span class="muted">السعر</span><b class="ok">' + money(o.price) + '</b></div>' +
      '<div class="row"><span class="muted">Start count</span><b>' + Number(o.start_count || 0).toLocaleString('en-US') + '</b></div>' +
      '<div class="row"><span class="muted">Remains</span><b>' + Number(o.remains || 0).toLocaleString('en-US') + '</b></div>' +
      '<div class="row"><span class="muted">الاسترجاع</span><b>' + money(o.refundedAmount || 0) + '</b></div>' +
      '<div class="row"><span class="muted">التاريخ</span><b class="tiny">' + esc(dt(o.createdAt)) + '</b></div>' +
      '<div class="field"><label>الرابط</label><input class="input" readonly value="' + esc(o.link || '') + '"></div>' +
    '</div>' +
    (o.status === 'NEEDS_REVIEW' ? '<div class="notice warning"><b>هذا الطلب يحتاج مراجعة</b><div class="subtitle">لم يتم رد الرصيد تلقائياً لأن المزود ربما استلم الطلب. الإدارة ستراجعه لتجنب التكرار.</div></div>' : '') +
    '<div class="grid">' +
      '<button class="btn primary" id="syncOrderBtn">تحديث الحالة</button>' +
      '<button class="btn ghost" id="reorderBtn">إعادة الطلب</button>' +
      (s.supportsRefill ? '<button class="btn success" id="refillBtn">Refill</button>' : '') +
      (s.supportsCancel && ['PENDING','PROCESSING','IN_PROGRESS'].includes(String(o.status || '').toUpperCase()) ? '<button class="btn warning" id="cancelBtn">طلب إلغاء</button>' : '') +
    '</div>';
  $('syncOrderBtn').onclick = syncSelectedOrder;
  $('reorderBtn').onclick = () => { closeM('orderDetailM'); if (s.id) { prepare(s); $('olink').value = o.link || ''; $('oqty').value = o.qty || ''; calc(); } };
  if ($('refillBtn')) $('refillBtn').onclick = refillSelectedOrder;
  if ($('cancelBtn')) $('cancelBtn').onclick = cancelSelectedOrder;
  openM('orderDetailM');
}
async function syncSelectedOrder() {
  if (!selectedOrder) return;
  loading(true);
  try { await api('/order/sync', { orderId:selectedOrder.id }); toast('تم تحديث حالة الطلب'); }
  catch (e) { toast(errorText(e)); }
  loading(false);
}
async function refillSelectedOrder() {
  if (!selectedOrder || !confirm('إرسال طلب إعادة تعبئة لهذا الطلب؟')) return;
  loading(true);
  try { await api('/order/refill', { orderId:selectedOrder.id }); toast('تم إرسال طلب إعادة التعبئة'); }
  catch (e) { toast(errorText(e)); }
  loading(false);
}
async function cancelSelectedOrder() {
  if (!selectedOrder || !confirm('إرسال طلب إلغاء للمزود؟ لن يتم رد أي مبلغ قبل تأكيد الإلغاء.')) return;
  loading(true);
  try { await api('/order/cancel', { orderId:selectedOrder.id }); toast('تم إرسال طلب الإلغاء'); }
  catch (e) { toast(errorText(e)); }
  loading(false);
}

function listenWallet() {
  const q = query(collection(db,'walletTransactions'), where('userId','==',me.uid), orderBy('createdAt','desc'), limit(60));
  unsubscribers.push(onSnapshot(q, snap => {
    $('tx').innerHTML = snap.docs.map(d => ({ id:d.id, ...d.data() })).map(t =>
      '<div class="card row"><div><b>' + esc(t.description || t.type || 'عملية') + '</b><div class="tiny">' + esc(dt(t.createdAt)) + '</div></div>' +
      '<b class="' + (Number(t.amount || 0) >= 0 ? 'ok' : 'bad') + '">' + (Number(t.amount || 0) >= 0 ? '+' : '') + money(t.amount) + '</b></div>'
    ).join('') || '<div class="empty">لا توجد حركات مالية</div>';
  }));
}
window.redeem = async () => {
  if (!me?.emailVerified) return toast('يجب توثيق البريد أولاً');
  const code = $('coupon').value.trim().toUpperCase();
  if (!code) return toast('أدخل الكوبون');
  loading(true);
  try {
    const d = await api('/wallet/redeem-coupon', { code });
    $('coupon').value = '';
    toast('تمت إضافة ' + money(d.amount));
  } catch (e) { toast(errorText(e)); }
  loading(false);
};
window.transferRef = async () => {
  if (!me?.emailVerified) return toast('يجب توثيق البريد أولاً');
  loading(true);
  try { const d = await api('/wallet/transfer-referral'); toast('تم تحويل ' + money(d.amount)); }
  catch (e) { toast(errorText(e)); }
  loading(false);
};
window.copyRef = async () => {
  try { await navigator.clipboard.writeText($('refcode').textContent); toast('تم نسخ كود الإحالة'); }
  catch { toast('تعذر النسخ'); }
};

function listenPayments() {
  unsubscribers.push(onSnapshot(collection(db, 'paymentMethods'), snap => {
    paymentMethods = snap.docs.map(d => ({ id:d.id, ...d.data() }))
      .filter(x => x.enabled !== false)
      .sort((a,b) => Number(a.seq || 0) - Number(b.seq || 0));
    $('paymentMethods').innerHTML = paymentMethods.map(p =>
      '<button class="card click" data-pay="' + esc(p.id) + '"><div class="cat-icon">' +
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18"/></svg>' +
      '</div><b>' + esc(p.name) + '</b><div class="muted">' + money(p.min || 0) + ' — ' + money(p.max || 0) + '</div></button>'
    ).join('') || '<div class="empty">لا توجد طرق شحن مفعلة حالياً</div>';
    $('paymentMethods').querySelectorAll('[data-pay]').forEach(b => b.onclick = () => openRecharge(b.dataset.pay));
  }));
}
function openRecharge(id) {
  activeMethod = paymentMethods.find(x => x.id === id);
  if (!activeMethod) return;
  $('methodInfo').innerHTML =
    '<b>' + esc(activeMethod.name) + '</b>' +
    '<div class="subtitle">' + esc(activeMethod.instructions || '') + '</div>' +
    (activeMethod.accountNumber ? '<div class="divider"></div><div class="row"><span class="muted">الحساب</span><code>' + esc(activeMethod.accountNumber) + '</code></div>' : '') +
    '<div class="row"><span class="muted">الحدود</span><b>' + money(activeMethod.min || 0) + ' — ' + money(activeMethod.max || 0) + '</b></div>';
  $('rechargeAmount').value = '';
  $('rechargeRef').value = '';
  openM('rechargeM');
}
window.submitRecharge = async () => {
  if (!activeMethod) return;
  if (!me?.emailVerified) return toast('يجب توثيق البريد أولاً');
  const amount = Number($('rechargeAmount').value);
  const reference = $('rechargeRef').value.trim();
  if (!(amount > 0) || !reference) return toast('أدخل المبلغ ورقم العملية');
  loading(true);
  try {
    await api('/wallet/recharge-request', { methodId:activeMethod.id, amount, reference });
    closeM('rechargeM');
    toast('تم إرسال طلب الشحن للمراجعة');
  } catch (e) { toast(errorText(e)); }
  loading(false);
};
function listenRechargeRequests() {
  const q = query(collection(db,'rechargeRequests'), where('userId','==',me.uid), orderBy('createdAt','desc'), limit(20));
  unsubscribers.push(onSnapshot(q, snap => {
    $('recharges').innerHTML = snap.docs.map(d => ({ id:d.id, ...d.data() })).map(r =>
      '<div class="card"><div class="row"><b>' + money(r.amount) + '</b><span class="badge ' + (r.status === 'APPROVED' ? 'success' : r.status === 'REJECTED' ? 'danger' : 'warning') + '">' + esc(r.status || 'PENDING') + '</span></div><div class="tiny">' + esc(dt(r.createdAt)) + '</div></div>'
    ).join('') || '<div class="empty">لا توجد طلبات شحن</div>';
  }));
}

let notiDocs = [];
function listenNotifications() {
  const q = query(collection(db,'notifications'), where('userId','==',me.uid), orderBy('createdAt','desc'), limit(50));
  unsubscribers.push(onSnapshot(q, snap => {
    notiDocs = snap.docs;
    const unread = snap.docs.filter(d => d.data().read === false).length;
    $('notiBadge').textContent = unread > 99 ? '99+' : unread;
    $('notiBadge').classList.toggle('hide', !unread);
    $('notis').innerHTML = snap.docs.map(d => {
      const n = d.data();
      return '<div class="card"><div class="row"><b>' + esc(n.title || 'إشعار') + '</b>' + (n.read === false ? '<span class="badge info">جديد</span>' : '') + '</div><div class="subtitle">' + esc(n.message || '') + '</div><div class="tiny">' + esc(dt(n.createdAt)) + '</div></div>';
    }).join('') || '<div class="empty">لا توجد إشعارات</div>';
  }));
}
window.openNotifications = async () => {
  openM('notiM');
  const unread = notiDocs.filter(d => d.data().read === false);
  try { await Promise.all(unread.map(d => updateDoc(d.ref, { read:true }))); } catch {}
};

function listenChat() {
  const q = query(collection(db,'chats',me.uid,'messages'), orderBy('createdAt','asc'), limit(200));
  unsubscribers.push(onSnapshot(q, snap => {
    $('chat').innerHTML = snap.docs.map(d => d.data()).map(m =>
      '<div class="msg ' + (m.sender === 'user' ? 'me' : 'them') + '">' + esc(m.text || '') + '</div>'
    ).join('') || '<div class="empty">ابدأ محادثة مع فريق الدعم</div>';
    $('chat').scrollTop = $('chat').scrollHeight;
  }));
}
window.sendMsg = async () => {
  const text = $('msg').value.trim();
  if (!text) return;
  if (text.length > 700) return toast('الرسالة طويلة جداً');
  $('msg').value = '';
  try {
    const mid = doc(collection(db,'chats',me.uid,'messages'));
    await setDoc(mid, { text, sender:'user', createdAt:serverTimestamp() });
    await setDoc(doc(db,'chats',me.uid), {
      userId:me.uid, name:profile.name || '', username:profile.username || '',
      lastMessage:text, time:serverTimestamp(), hasUnread:true, status:'open'
    }, { merge:true });
  } catch (e) { toast(errorText(e)); }
};

window.go = page => {
  currentPage = page;
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  $('p-' + page)?.classList.add('active');
  document.querySelectorAll('.nav button').forEach(x => x.classList.toggle('active', x.dataset.p === page));
};
window.openM = id => $(id)?.classList.add('open');
window.closeM = id => $(id)?.classList.remove('open');
window.kaidoBack = () => {
  const m = [...document.querySelectorAll('.modal.open')].pop();
  if (m) { m.classList.remove('open'); return true; }
  if (currentPage !== 'home') { go('home'); return true; }
  return false;
};
