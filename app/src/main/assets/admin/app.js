import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, getIdTokenResult } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, orderBy, limit, startAfter, onSnapshot, serverTimestamp, Timestamp
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

const ADMIN_EMAIL = 'kaidofollow@gmail.com';
const API = 'https://us-central1-kaido-follow-b597e.cloudfunctions.net/api';
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

let me = null;
let users = [];
let orders = [];
let services = [];
let cats = [];
let providers = [];
let coupons = [];
let payments = [];
let rechargeRequests = [];
let chats = [];
let announcements = [];
let currentPage = 'dashboard';
let orderFilter = 'ALL';
let activeChat = null;
let chatUnsub = null;
let lastUserDoc = null;
let lastOrderDoc = null;
let lastLogDoc = null;
let logs = [];
let importedServices = [];

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => '$' + Number(n || 0).toFixed(4);
const dt = t => {
  try {
    const d = t?.toDate ? t.toDate() : new Date(t);
    if (!d || Number.isNaN(d.getTime())) return '-';
    return new Intl.DateTimeFormat('ar-IQ', { dateStyle:'medium', timeStyle:'short' }).format(d);
  } catch { return '-'; }
};
const dateInput = t => {
  try {
    const d = t?.toDate ? t.toDate() : new Date(t);
    if (!d || Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0,10);
  } catch { return ''; }
};

function toast(text) {
  $('toast').textContent = String(text || '');
  $('toast').classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => $('toast').classList.remove('show'), 3000);
}
function loading(v) { $('loader').classList.toggle('on', !!v); }
function setOnlineState() { $('offline').classList.toggle('hide', navigator.onLine); }
window.addEventListener('online', setOnlineState);
window.addEventListener('offline', setOnlineState);
setOnlineState();

function errorText(e) {
  const s = String(e?.message || '');
  const map = {
    ADMIN_REQUIRED:'الحساب غير مخول للإدارة',
    OWNER_EMAIL_REQUIRED:'هذا البريد ليس بريد المالك',
    NEGATIVE_BALANCE:'لا يمكن جعل الرصيد سالباً',
    ALREADY_REFUNDED:'تم استرجاع الطلب مسبقاً',
    RECHARGE_ALREADY_RESOLVED:'تمت معالجة طلب الشحن مسبقاً',
    PROVIDER_KEY_REQUIRED:'أدخل مفتاح API للمزود',
    PROVIDER_DISABLED:'المزود متوقف',
    RATE_LIMITED:'محاولات كثيرة، حاول لاحقاً'
  };
  for (const [k,v] of Object.entries(map)) if (s.includes(k)) return v;
  return s.replace(/^Firebase:\s*/,'').slice(0,240) || 'حدث خطأ';
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
function form(title, html) {
  $('formTitle').textContent = title;
  $('formBody').innerHTML = html;
  openM('formM');
}
function detail(title, html) {
  $('detailTitle').textContent = title;
  $('detailBody').innerHTML = html;
  openM('detailM');
}
function statusArabic(s) {
  const x = String(s || '').toUpperCase();
  return {
    CREATING:'قيد الإنشاء',PENDING:'بانتظار التنفيذ',PROCESSING:'قيد التنفيذ',IN_PROGRESS:'قيد التنفيذ',
    COMPLETED:'مكتمل',PARTIAL:'جزئي',CANCELED:'ملغي',FAILED:'فشل',REFUNDED:'مسترجع',NEEDS_REVIEW:'يحتاج مراجعة'
  }[x] || s || '-';
}
function statusClass(s) {
  const x = String(s || '').toUpperCase();
  if (x === 'COMPLETED') return 'success';
  if (['FAILED','CANCELED','REFUNDED','REJECTED'].includes(x)) return 'danger';
  if (['NEEDS_REVIEW','PARTIAL','PENDING'].includes(x)) return 'warning';
  return 'info';
}

window.adminLogin = async () => {
  const pass = $('ap').value;
  if (!pass) return toast('أدخل كلمة المرور');
  loading(true);
  try { await signInWithEmailAndPassword(auth, ADMIN_EMAIL, pass); }
  catch { toast('البريد الإداري ثابت وكلمة المرور غير صحيحة'); }
  loading(false);
};
window.logout = () => signOut(auth);

onAuthStateChanged(auth, async user => {
  me = user;
  $('auth').classList.toggle('hide', !!user);
  $('app').classList.toggle('hide', !user);
  if (!user) return;

  loading(true);
  try {
    if (String(user.email || '').toLowerCase() !== ADMIN_EMAIL) throw new Error('OWNER_EMAIL_REQUIRED');
    let token = await getIdTokenResult(user, true);
    if (!token.claims.admin) {
      await api('/bootstrap-owner');
      token = await getIdTokenResult(user, true);
    }
    if (!token.claims.admin || token.claims.role !== 'owner') throw new Error('ADMIN_REQUIRED');
    $('identity').textContent = ADMIN_EMAIL + ' — Owner';
    await init();
  } catch (e) {
    toast(errorText(e));
    await signOut(auth);
  } finally {
    loading(false);
  }
});

async function init() {
  await Promise.all([
    loadCats(), loadProviders(), loadServices(), loadCoupons(), loadPayments(),
    loadRecharges(), loadSettings(), loadAnnouncements()
  ]);
  await Promise.all([loadUsers(true), loadOrders(true), loadLogs(true)]);
  listenChats();
  refreshDashboard();
  health();
}

window.health = async () => {
  try {
    const r = await fetch(API + '/health');
    const d = await r.json();
    $('health').className = 'badge ' + (d.ok ? 'success' : 'danger');
    $('health').textContent = d.ok ? 'Backend يعمل — 2.0.0' : 'Backend خطأ';
  } catch {
    $('health').className = 'badge danger';
    $('health').textContent = 'Backend غير منشور';
  }
};
window.refreshDashboard = async () => {
  try {
    const d = await api('/admin/dashboard', {}, 'GET');
    const s = d.stats || {};
    $('su').textContent = Number(s.userCount || 0).toLocaleString('en-US');
    $('so').textContent = Number(s.orderCount || 0).toLocaleString('en-US');
    $('ss').textContent = money(s.grossRevenue);
    $('sp').textContent = money(s.estimatedProfit);
    $('sr').textContent = money(s.refundTotal);
  } catch {
    $('su').textContent = users.length;
    $('so').textContent = orders.length;
  }
  $('reviewCount').textContent = orders.filter(o => String(o.status).toUpperCase() === 'NEEDS_REVIEW').length;
  renderDashboardOrders();
};
function renderDashboardOrders() {
  $('dashOrders').innerHTML = orders.slice(0,5).map(o =>
    '<div class="card click" data-dash-order="' + esc(o.id) + '"><div class="row"><b>' + esc(o.service) + '</b><span class="badge ' + statusClass(o.status) + '">' + esc(statusArabic(o.status)) + '</span></div><div class="row muted" style="margin-top:7px"><span>#' + esc(o.providerOrderId || o.id.slice(-8)) + '</span><b>' + money(o.price) + '</b></div></div>'
  ).join('') || '<div class="empty">لا توجد طلبات</div>';
  $('dashOrders').querySelectorAll('[data-dash-order]').forEach(x => x.onclick = () => openOrder(x.dataset.dashOrder));
}
window.syncAll = async () => {
  loading(true);
  try {
    const d = await api('/admin/sync-orders');
    toast('تم تحديث ' + Number(d.updated || 0) + ' طلب');
    await loadOrders(true);
    refreshDashboard();
  } catch (e) { toast(errorText(e)); }
  loading(false);
};

async function loadUsers(reset = false) {
  if (reset) { users = []; lastUserDoc = null; }
  let q = query(collection(db,'users'), orderBy('createdAt','desc'), limit(60));
  if (lastUserDoc) q = query(collection(db,'users'), orderBy('createdAt','desc'), startAfter(lastUserDoc), limit(60));
  const s = await getDocs(q);
  if (!s.empty) lastUserDoc = s.docs[s.docs.length - 1];
  users.push(...s.docs.map(d => ({ id:d.id, ...d.data() })));
  $('moreUsers').classList.toggle('hide', s.size < 60);
  renderUsers();
}
window.loadMoreUsers = () => loadUsers(false);
window.renderUsers = () => {
  const qv = $('us').value.trim().toLowerCase();
  const list = users.filter(u => !qv || (String(u.name || '') + ' ' + String(u.email || '') + ' ' + String(u.username || '') + ' ' + u.id).toLowerCase().includes(qv));
  $('users').innerHTML = list.map(u =>
    '<div class="card"><div class="row"><div><b>' + esc(u.name || '-') + '</b><div class="muted">' + esc(u.email || '') + '</div></div><b class="ok">' + money(u.balance) + '</b></div>' +
    '<div class="row" style="margin-top:9px"><span class="badge ' + (u.banned ? 'danger' : 'success') + '">' + (u.banned ? 'محظور' : 'نشط') + '</span><button class="btn ghost" data-user="' + esc(u.id) + '">إدارة</button></div></div>'
  ).join('') || '<div class="empty">لا توجد نتائج</div>';
  $('users').querySelectorAll('[data-user]').forEach(b => b.onclick = () => userForm(b.dataset.user));
};
function userForm(id) {
  const u = users.find(x => x.id === id);
  if (!u) return;
  form('إدارة المستخدم', '<div class="card"><b>' + esc(u.name || '-') + '</b><div class="muted">' + esc(u.email || '') + '</div><div class="tiny">' + esc(u.id) + '</div></div>' +
    '<div class="grid"><div class="metric"><span class="muted">الرصيد</span><b>' + money(u.balance) + '</b></div><div class="metric"><span class="muted">المنفق</span><b>' + money(u.spent) + '</b></div></div>' +
    '<div class="field"><label>إضافة/خصم من الرصيد</label><input id="delta" class="input" type="number" step=".0001" placeholder="مثال 5 أو -2"></div>' +
    '<div class="field"><label>السبب</label><input id="balanceReason" class="input" maxlength="180"></div>' +
    '<button id="adjustBalance" class="btn primary">تنفيذ تعديل الرصيد</button>' +
    '<div class="divider"></div><div class="field"><label>سبب الحظر/فك الحظر</label><input id="banReason" class="input" maxlength="180" value="' + esc(u.banReason || '') + '"></div>' +
    '<button id="toggleBan" class="btn ' + (u.banned ? 'success' : 'danger') + '">' + (u.banned ? 'فك الحظر' : 'حظر المستخدم') + '</button>');
  $('adjustBalance').onclick = async () => {
    const amount = Number($('delta').value), reason = $('balanceReason').value.trim();
    if (!amount || !reason) return toast('أدخل المبلغ والسبب');
    loading(true);
    try { await api('/admin/adjust-balance', { userId:id, amount, reason }); toast('تم تعديل الرصيد'); closeM('formM'); await loadUsers(true); }
    catch (e) { toast(errorText(e)); }
    loading(false);
  };
  $('toggleBan').onclick = async () => {
    const reason = $('banReason').value.trim() || (u.banned ? 'فك الحظر بواسطة الإدارة' : 'حظر بواسطة الإدارة');
    loading(true);
    try { await api('/admin/user/ban', { userId:id, banned:!u.banned, reason }); toast('تم تحديث حالة الحساب'); closeM('formM'); await loadUsers(true); }
    catch (e) { toast(errorText(e)); }
    loading(false);
  };
}

async function loadOrders(reset = false) {
  if (reset) { orders = []; lastOrderDoc = null; }
  let q = query(collection(db,'orders'), orderBy('createdAt','desc'), limit(70));
  if (lastOrderDoc) q = query(collection(db,'orders'), orderBy('createdAt','desc'), startAfter(lastOrderDoc), limit(70));
  const s = await getDocs(q);
  if (!s.empty) lastOrderDoc = s.docs[s.docs.length - 1];
  orders.push(...s.docs.map(d => ({ id:d.id, ...d.data() })));
  $('moreOrders').classList.toggle('hide', s.size < 70);
  renderOrders();
  renderDashboardOrders();
  $('reviewCount').textContent = orders.filter(o => String(o.status).toUpperCase() === 'NEEDS_REVIEW').length;
}
window.loadMoreOrders = () => loadOrders(false);
window.setAdminOrderFilter = (f, btn) => {
  orderFilter = f;
  document.querySelectorAll('#adminOrderTabs .tab').forEach(x => x.classList.toggle('active', x === btn));
  renderOrders();
};
function orderFilterMatch(o) {
  const s = String(o.status || '').toUpperCase();
  if (orderFilter === 'ALL') return true;
  if (orderFilter === 'ACTIVE') return ['CREATING','PENDING','PROCESSING','IN_PROGRESS'].includes(s);
  if (orderFilter === 'REVIEW') return s === 'NEEDS_REVIEW';
  if (orderFilter === 'DONE') return ['COMPLETED','PARTIAL','CANCELED','FAILED','REFUNDED'].includes(s);
  return true;
}
window.renderOrders = () => {
  const qv = $('os').value.trim().toLowerCase();
  const list = orders.filter(orderFilterMatch).filter(o => !qv || (o.id + ' ' + String(o.providerOrderId || '') + ' ' + String(o.service || '') + ' ' + String(o.userId || '')).toLowerCase().includes(qv));
  $('orders').innerHTML = list.map(o =>
    '<div class="card click" data-order="' + esc(o.id) + '"><div class="row"><b>#' + esc(o.providerOrderId || o.id.slice(-9)) + '</b><span class="badge ' + statusClass(o.status) + '">' + esc(statusArabic(o.status)) + '</span></div>' +
    '<div style="margin-top:6px">' + esc(o.service) + '</div><div class="row muted" style="margin-top:8px"><span>' + Number(o.qty || 0).toLocaleString('en-US') + '</span><b>' + money(o.price) + '</b></div><div class="tiny">' + esc(dt(o.createdAt)) + '</div></div>'
  ).join('') || '<div class="empty">لا توجد طلبات</div>';
  $('orders').querySelectorAll('[data-order]').forEach(b => b.onclick = () => openOrder(b.dataset.order));
};
function openOrder(id) {
  const o = orders.find(x => x.id === id);
  if (!o) return;
  const u = users.find(x => x.id === o.userId);
  detail('تفاصيل الطلب', '<div class="card"><div class="row"><b>#' + esc(o.providerOrderId || o.id.slice(-10)) + '</b><span class="badge ' + statusClass(o.status) + '">' + esc(statusArabic(o.status)) + '</span></div><div class="tiny">' + esc(o.id) + '</div></div>' +
    '<div class="card stack"><div class="row"><span class="muted">المستخدم</span><b>' + esc(u?.name || o.userId?.slice(0,10) || '-') + '</b></div><div class="row"><span class="muted">الخدمة</span><b>' + esc(o.service) + '</b></div><div class="row"><span class="muted">الكمية</span><b>' + Number(o.qty || 0).toLocaleString('en-US') + '</b></div><div class="row"><span class="muted">السعر</span><b>' + money(o.price) + '</b></div><div class="row"><span class="muted">تكلفة المزود</span><b>' + money(o.originalCost) + '</b></div><div class="row"><span class="muted">Remains</span><b>' + Number(o.remains || 0) + '</b></div><div class="row"><span class="muted">Refunded</span><b>' + money(o.refundedAmount || 0) + '</b></div><div class="field"><label>الرابط</label><input class="input" readonly value="' + esc(o.link || '') + '"></div></div>' +
    (String(o.status).toUpperCase() === 'NEEDS_REVIEW' ? '<div class="notice warning"><b>طلب غامض من المزود</b><div class="subtitle">' + esc(o.reviewReason || 'لم يصل تأكيد نهائي') + '</div><div class="field"><label>Provider Order ID إذا وجدته عند المزود</label><input id="reconcileProviderId" class="input"></div><div class="row start"><button id="attachProviderId" class="btn success">ربط رقم المزود</button><button id="reviewRefund" class="btn danger">استرجاع كامل</button></div></div>' : '') +
    '<div class="row start wrap"><button id="refundOrder" class="btn danger" ' + (Number(o.refundedAmount || 0) >= Number(o.price || 0) ? 'disabled' : '') + '>استرجاع</button><button id="syncOrdersFromDetail" class="btn ghost">مزامنة الطلبات</button></div>');
  $('refundOrder').onclick = () => refundOrder(id);
  $('syncOrdersFromDetail').onclick = async () => { await syncAll(); closeM('detailM'); };
  if ($('attachProviderId')) $('attachProviderId').onclick = async () => {
    const providerOrderId = $('reconcileProviderId').value.trim();
    if (!providerOrderId) return toast('أدخل رقم الطلب عند المزود');
    loading(true);
    try { await api('/admin/order/reconcile', { orderId:id, action:'ATTACH', providerOrderId }); toast('تم ربط الطلب'); closeM('detailM'); await loadOrders(true); }
    catch (e) { toast(errorText(e)); }
    loading(false);
  };
  if ($('reviewRefund')) $('reviewRefund').onclick = async () => {
    if (!confirm('تأكيد أن المزود لم يستلم الطلب وإرجاع الرصيد بالكامل؟')) return;
    loading(true);
    try { await api('/admin/order/reconcile', { orderId:id, action:'REFUND' }); toast('تم الاسترجاع'); closeM('detailM'); await Promise.all([loadOrders(true),loadUsers(true)]); }
    catch (e) { toast(errorText(e)); }
    loading(false);
  };
}
async function refundOrder(id) {
  const reason = prompt('سبب الاسترجاع', 'استرجاع بواسطة الإدارة');
  if (!reason) return;
  loading(true);
  try { const d = await api('/admin/refund', { orderId:id, reason }); toast('تم استرجاع ' + money(d.amount)); closeM('detailM'); await Promise.all([loadOrders(true),loadUsers(true)]); refreshDashboard(); }
  catch (e) { toast(errorText(e)); }
  loading(false);
}

async function loadCats() {
  const s = await getDocs(query(collection(db,'categories'), orderBy('seq','asc')));
  cats = s.docs.map(d => ({ id:d.id, ...d.data() }));
  renderCats();
}
function renderCats() {
  $('cats').innerHTML = cats.map(c =>
    '<div class="card"><div class="row"><div><b>' + esc(c.name) + '</b><div class="muted">' + (c.parentId ? 'فرعي' : 'رئيسي') + ' — ترتيب ' + Number(c.seq || 0) + '</div></div><span class="badge ' + (c.visible === false ? 'danger' : 'success') + '">' + (c.visible === false ? 'مخفي' : 'ظاهر') + '</span></div><div class="row start" style="margin-top:9px"><button class="btn ghost" data-cat-edit="' + esc(c.id) + '">تعديل</button><button class="btn danger" data-cat-del="' + esc(c.id) + '">حذف</button></div></div>'
  ).join('') || '<div class="empty">لا توجد أقسام</div>';
  $('cats').querySelectorAll('[data-cat-edit]').forEach(b => b.onclick = () => catForm(b.dataset.catEdit));
  $('cats').querySelectorAll('[data-cat-del]').forEach(b => b.onclick = () => deleteCategory(b.dataset.catDel));
}
window.catForm = id => {
  const c = cats.find(x => x.id === id) || {};
  form(id ? 'تعديل القسم' : 'إضافة قسم', '<div class="field"><label>الاسم</label><input id="cn" class="input" value="' + esc(c.name || '') + '"></div><div class="field"><label>رابط الصورة</label><input id="ci" class="input" value="' + esc(c.image || '') + '"></div><div class="field"><label>الترتيب</label><input id="cs" class="input" type="number" value="' + Number(c.seq || 0) + '"></div><div class="field"><label>القسم الأب</label><select id="cp" class="select"><option value="">قسم رئيسي</option>' + cats.filter(x => !x.parentId && x.id !== id).map(x => '<option value="' + esc(x.id) + '" ' + (c.parentId === x.id ? 'selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select></div><label class="row start"><input id="cvisible" type="checkbox" ' + (c.visible === false ? '' : 'checked') + '> ظاهر للمستخدمين</label><button id="saveCat" class="btn primary" style="width:100%;margin-top:12px">حفظ</button>');
  $('saveCat').onclick = async () => {
    const data = { name:$('cn').value.trim(), image:$('ci').value.trim(), seq:Number($('cs').value || 0), parentId:$('cp').value, visible:$('cvisible').checked, updatedAt:serverTimestamp() };
    if (!data.name) return toast('اسم القسم مطلوب');
    loading(true);
    try { id ? await setDoc(doc(db,'categories',id),data,{merge:true}) : await addDoc(collection(db,'categories'),{...data,createdAt:serverTimestamp()}); closeM('formM'); await loadCats(); toast('تم حفظ القسم'); }
    catch (e) { toast(errorText(e)); }
    loading(false);
  };
};
async function deleteCategory(id) {
  if (cats.some(c => c.parentId === id) || services.some(s => s.categoryId === id)) return toast('انقل الأقسام الفرعية والخدمات قبل حذف القسم');
  if (!confirm('حذف هذا القسم؟')) return;
  await deleteDoc(doc(db,'categories',id));
  await loadCats();
}

async function loadServices() {
  const s = await getDocs(collection(db,'services'));
  services = s.docs.map(d => ({ id:d.id, ...d.data() }));
  renderServices();
}
window.renderServices = () => {
  const qv = $('serviceSearch').value.trim().toLowerCase();
  const list = services.filter(s => !qv || (String(s.name || '') + ' ' + String(s.providerServiceId || '')).toLowerCase().includes(qv));
  $('services').innerHTML = list.map(s =>
    '<div class="card"><div class="row"><div><b>' + esc(s.name) + '</b><div class="muted">' + esc(cats.find(c => c.id === s.categoryId)?.name || '') + '</div></div><b class="ok">' + money(s.price) + '</b></div><div class="row wrap" style="margin-top:8px"><span class="badge ' + (s.visible === false ? 'danger' : 'success') + '">' + (s.visible === false ? 'مخفي' : 'فعال') + '</span>' + (s.supportsRefill ? '<span class="badge success">Refill</span>' : '') + (s.supportsCancel ? '<span class="badge warning">Cancel</span>' : '') + '</div><div class="row start" style="margin-top:9px"><button class="btn ghost" data-service-edit="' + esc(s.id) + '">تعديل</button><button class="btn danger" data-service-del="' + esc(s.id) + '">حذف</button></div></div>'
  ).join('') || '<div class="empty">لا توجد خدمات</div>';
  $('services').querySelectorAll('[data-service-edit]').forEach(b => b.onclick = () => serviceForm(b.dataset.serviceEdit));
  $('services').querySelectorAll('[data-service-del]').forEach(b => b.onclick = () => deleteService(b.dataset.serviceDel));
};
window.serviceForm = id => {
  const s = services.find(x => x.id === id) || {};
  form(id ? 'تعديل الخدمة' : 'إضافة خدمة', '<div class="field"><label>اسم الخدمة</label><input id="sn" class="input" value="' + esc(s.name || '') + '"></div><div class="field"><label>القسم</label><select id="sc" class="select">' + cats.map(c => '<option value="' + esc(c.id) + '" ' + (s.categoryId === c.id ? 'selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select></div><div class="field"><label>المزود</label><select id="spr" class="select">' + providers.map(p => '<option value="' + esc(p.id) + '" ' + (s.providerId === p.id ? 'selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select></div><div class="field"><label>Provider Service ID</label><input id="spi" class="input" value="' + esc(s.providerServiceId || '') + '"></div><div class="grid"><div class="field"><label>سعر البيع /1000</label><input id="svp" class="input" type="number" step=".0001" value="' + (s.price ?? '') + '"></div><div class="field"><label>تكلفة المزود /1000</label><input id="sco" class="input" type="number" step=".0001" value="' + (s.originalCost ?? '') + '"></div></div><div class="grid"><div class="field"><label>Min</label><input id="smin" class="input" type="number" value="' + Number(s.min || 10) + '"></div><div class="field"><label>Max</label><input id="smax" class="input" type="number" value="' + Number(s.max || 10000) + '"></div></div><div class="grid"><div class="field"><label>النوع</label><input id="stype" class="input" value="' + esc(s.type || 'Default') + '"></div><div class="field"><label>متوسط البدء</label><input id="stime" class="input" value="' + esc(s.averageTime || '') + '" placeholder="0-30 دقيقة"></div></div><div class="field"><label>الوصف</label><textarea id="sd" class="textarea">' + esc(s.description || '') + '</textarea></div><div class="grid"><label class="row start"><input id="srefill" type="checkbox" ' + (s.supportsRefill ? 'checked' : '') + '> Refill</label><label class="row start"><input id="scancel" type="checkbox" ' + (s.supportsCancel ? 'checked' : '') + '> Cancel</label><label class="row start"><input id="svisible" type="checkbox" ' + (s.visible === false ? '' : 'checked') + '> ظاهر</label><label class="row start"><input id="spopular" type="checkbox" ' + (s.popular ? 'checked' : '') + '> مقترح</label></div><div class="field"><label>الترتيب</label><input id="sseq" class="input" type="number" value="' + Number(s.seq || 0) + '"></div><button id="saveService" class="btn primary" style="width:100%">حفظ الخدمة</button>');
  $('saveService').onclick = async () => {
    const min = Number($('smin').value), max = Number($('smax').value), price = Number($('svp').value), cost = Number($('sco').value);
    if (!$('sn').value.trim() || !$('sc').value || !$('spr').value || !$('spi').value.trim()) return toast('أكمل بيانات الخدمة');
    if (!(price > 0) || cost < 0 || !(min > 0) || max < min) return toast('تحقق من الأسعار والحدود');
    const data = {
      name:$('sn').value.trim(), categoryId:$('sc').value, providerId:$('spr').value,
      providerServiceId:$('spi').value.trim(), price, originalCost:cost, min, max,
      type:$('stype').value.trim() || 'Default', averageTime:$('stime').value.trim(),
      description:$('sd').value.trim(), supportsRefill:$('srefill').checked,
      supportsCancel:$('scancel').checked, visible:$('svisible').checked,
      popular:$('spopular').checked, seq:Number($('sseq').value || 0), updatedAt:serverTimestamp()
    };
    loading(true);
    try { id ? await setDoc(doc(db,'services',id),data,{merge:true}) : await addDoc(collection(db,'services'),{...data,createdAt:serverTimestamp()}); closeM('formM'); await loadServices(); toast('تم حفظ الخدمة'); }
    catch (e) { toast(errorText(e)); }
    loading(false);
  };
};
async function deleteService(id) {
  if (!confirm('حذف الخدمة؟ الطلبات السابقة ستبقى محفوظة.')) return;
  await deleteDoc(doc(db,'services',id));
  await loadServices();
}

async function loadProviders() {
  try {
    const d = await api('/admin/providers', {}, 'GET');
    providers = d.providers || [];
    renderProviders();
  } catch (e) {
    $('providers').innerHTML = '<div class="notice danger">انشر Firebase Functions الجديدة أولاً: ' + esc(errorText(e)) + '</div>';
  }
}
function renderProviders() {
  $('providers').innerHTML = providers.map(p =>
    '<div class="card"><div class="row"><div><b>' + esc(p.name) + '</b><div class="muted">' + esc(p.url) + '</div></div><span class="badge ' + (p.enabled === false ? 'danger' : 'success') + '">' + (p.enabled === false ? 'معطل' : 'فعال') + '</span></div><div class="row wrap" style="margin-top:9px"><span class="badge">Priority ' + Number(p.priority || 1) + '</span><span class="badge">' + esc(p.currency || 'USD') + '</span></div><div class="row start" style="margin-top:10px"><button class="btn ghost" data-provider-edit="' + esc(p.id) + '">تعديل</button><button class="btn ghost" data-provider-test="' + esc(p.id) + '">فحص</button><button class="btn ' + (p.enabled === false ? 'success' : 'danger') + '" data-provider-toggle="' + esc(p.id) + '">' + (p.enabled === false ? 'تفعيل' : 'تعطيل') + '</button></div></div>'
  ).join('') || '<div class="empty">لا يوجد مزودون</div>';
  $('providers').querySelectorAll('[data-provider-edit]').forEach(b => b.onclick = () => providerForm(b.dataset.providerEdit));
  $('providers').querySelectorAll('[data-provider-test]').forEach(b => b.onclick = () => testProvider(b.dataset.providerTest));
  $('providers').querySelectorAll('[data-provider-toggle]').forEach(b => b.onclick = () => toggleProvider(b.dataset.providerToggle));
}
window.providerForm = id => {
  const p = providers.find(x => x.id === id) || {};
  form(id ? 'تعديل المزود' : 'إضافة مزود', '<div class="field"><label>الاسم</label><input id="pn" class="input" value="' + esc(p.name || '') + '"></div><div class="field"><label>API URL</label><input id="pu" class="input" value="' + esc(p.url || '') + '" placeholder="https://provider.com/api/v2"></div><div class="field"><label>API Key ' + (id ? '(اتركه فارغاً للاحتفاظ بالمفتاح الحالي)' : '') + '</label><input id="pk" class="input" type="password"></div><div class="grid"><div class="field"><label>Currency</label><input id="pc" class="input" value="' + esc(p.currency || 'USD') + '"></div><div class="field"><label>Priority</label><input id="pp" class="input" type="number" value="' + Number(p.priority || 1) + '"></div></div><label class="row start"><input id="penabled" type="checkbox" ' + (p.enabled === false ? '' : 'checked') + '> المزود فعال</label><button id="saveProvider" class="btn primary" style="width:100%;margin-top:12px">حفظ المزود</button>');
  $('saveProvider').onclick = async () => {
    loading(true);
    try {
      await api('/admin/provider/save', { id:id || undefined, name:$('pn').value.trim(), url:$('pu').value.trim(), key:$('pk').value.trim(), currency:$('pc').value.trim(), priority:Number($('pp').value || 1), enabled:$('penabled').checked });
      closeM('formM'); await loadProviders(); toast('تم حفظ المزود');
    } catch (e) { toast(errorText(e)); }
    loading(false);
  };
};
async function testProvider(id) {
  loading(true);
  try { const r = await api('/admin/provider/test',{providerId:id}); toast('متصل — ' + r.latencyMs + 'ms — ' + r.balance + ' ' + (r.currency || '')); }
  catch (e) { toast(errorText(e)); }
  loading(false);
}
async function toggleProvider(id) {
  const p = providers.find(x => x.id === id);
  if (!p) return;
  loading(true);
  try { await api('/admin/provider/toggle',{providerId:id,enabled:p.enabled === false}); await loadProviders(); toast('تم تحديث المزود'); }
  catch (e) { toast(errorText(e)); }
  loading(false);
}

window.openImport = () => {
  importedServices = [];
  form('استيراد خدمات المزود', '<div class="field"><label>المزود</label><select id="importProvider" class="select">' + providers.filter(p => p.enabled !== false).map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('') + '</select></div><div class="field"><label>القسم الذي ستضاف إليه الخدمات</label><select id="importCategory" class="select">' + cats.map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('') + '</select></div><div class="field"><label>هامش الربح %</label><input id="importMarkup" class="input" type="number" value="30" min="0"></div><button id="fetchProviderServices" class="btn primary" style="width:100%">جلب الخدمات</button><div id="importResults" class="list" style="margin-top:12px"></div>');
  $('fetchProviderServices').onclick = fetchProviderServices;
};
async function fetchProviderServices() {
  const providerId = $('importProvider').value;
  loading(true);
  try {
    const d = await api('/admin/provider/services',{providerId});
    importedServices = d.services || [];
    $('importResults').innerHTML = '<div class="row"><b>' + importedServices.length + ' خدمة</b><button id="importSelected" class="btn success">إضافة المحدد</button></div>' + importedServices.slice(0,250).map((s,i) =>
      '<label class="card row start"><input type="checkbox" class="importCheck" value="' + i + '"><div><b>' + esc(s.name) + '</b><div class="muted">ID ' + esc(s.service) + ' — ' + Number(s.min || 0) + ' / ' + Number(s.max || 0) + '</div><div class="ok">' + money(s.rate) + '</div></div></label>'
    ).join('');
    $('importSelected').onclick = importSelectedServices;
  } catch (e) { toast(errorText(e)); }
  loading(false);
}
async function importSelectedServices() {
  const selected = [...document.querySelectorAll('.importCheck:checked')].map(x => importedServices[Number(x.value)]).filter(Boolean);
  if (!selected.length) return toast('حدد خدمة واحدة على الأقل');
  const providerId = $('importProvider').value, categoryId = $('importCategory').value;
  const markup = Math.max(0, Number($('importMarkup').value || 0));
  loading(true);
  try {
    for (const s of selected) {
      const cost = Number(s.rate || 0);
      await addDoc(collection(db,'services'), {
        name:s.name || ('Service ' + s.service), categoryId, providerId, providerServiceId:String(s.service),
        originalCost:cost, price:Number((cost * (1 + markup / 100)).toFixed(4)),
        min:Number(s.min || 1), max:Number(s.max || 10000), type:s.type || 'Default',
        supportsRefill:!!s.refill, supportsCancel:!!s.cancel, visible:true, popular:false,
        seq:0, imported:true, createdAt:serverTimestamp(), updatedAt:serverTimestamp()
      });
    }
    toast('تم استيراد ' + selected.length + ' خدمة');
    closeM('formM');
    await loadServices();
  } catch (e) { toast(errorText(e)); }
  loading(false);
}

async function loadCoupons() {
  const s = await getDocs(collection(db,'coupons'));
  coupons = s.docs.map(d => ({ id:d.id, ...d.data() }));
  renderCoupons();
}
function renderCoupons() {
  $('coupons').innerHTML = coupons.map(c =>
    '<div class="card"><div class="row"><div><b>' + esc(c.id) + '</b><div class="muted">' + Number(c.currentUses || 0) + ' / ' + Number(c.maxUses || 1) + '</div></div><b class="ok">' + money(c.value) + '</b></div><div class="row" style="margin-top:8px"><span class="badge ' + (c.active === false ? 'danger' : 'success') + '">' + (c.active === false ? 'معطل' : 'فعال') + '</span><div class="row start"><button class="btn ghost" data-coupon-edit="' + esc(c.id) + '">تعديل</button><button class="btn danger" data-coupon-del="' + esc(c.id) + '">حذف</button></div></div></div>'
  ).join('') || '<div class="empty">لا توجد كوبونات</div>';
  $('coupons').querySelectorAll('[data-coupon-edit]').forEach(b => b.onclick = () => couponForm(b.dataset.couponEdit));
  $('coupons').querySelectorAll('[data-coupon-del]').forEach(b => b.onclick = () => deleteCoupon(b.dataset.couponDel));
}
window.couponForm = id => {
  const c = coupons.find(x => x.id === id) || {};
  form(id ? 'تعديل الكوبون' : 'إنشاء كوبون', '<div class="field"><label>الكود</label><input id="cc" class="input" ' + (id ? 'readonly' : '') + ' value="' + esc(id || '') + '"></div><div class="grid"><div class="field"><label>القيمة</label><input id="cv" class="input" type="number" step=".0001" value="' + (c.value ?? '') + '"></div><div class="field"><label>أقصى استخدام</label><input id="cm" class="input" type="number" value="' + Number(c.maxUses || 1) + '"></div></div><div class="field"><label>عمولة الإحالة %</label><input id="cap" class="input" type="number" min="0" max="100" value="' + Number(c.affiliatePercent ?? 5) + '"></div><div class="grid"><div class="field"><label>يبدأ</label><input id="cstart" class="input" type="date" value="' + dateInput(c.startsAt) + '"></div><div class="field"><label>ينتهي</label><input id="cexp" class="input" type="date" value="' + dateInput(c.expiresAt) + '"></div></div><label class="row start"><input id="cactive" type="checkbox" ' + (c.active === false ? '' : 'checked') + '> فعال</label><button id="saveCoupon" class="btn primary" style="width:100%;margin-top:12px">حفظ</button>');
  $('saveCoupon').onclick = async () => {
    const code = $('cc').value.trim().toUpperCase(), value = Number($('cv').value), maxUses = Number($('cm').value);
    if (!code || !(value > 0) || !(maxUses > 0)) return toast('تحقق من بيانات الكوبون');
    const data = { code, value, maxUses, affiliatePercent:Math.max(0,Math.min(100,Number($('cap').value || 0))), active:$('cactive').checked, updatedAt:serverTimestamp() };
    const sd = $('cstart').value, ed = $('cexp').value;
    if (sd) data.startsAt = Timestamp.fromDate(new Date(sd + 'T00:00:00'));
    if (ed) data.expiresAt = Timestamp.fromDate(new Date(ed + 'T23:59:59'));
    if (!id) { data.currentUses = 0; data.createdAt = serverTimestamp(); }
    await setDoc(doc(db,'coupons',code),data,{merge:true});
    closeM('formM'); await loadCoupons(); toast('تم حفظ الكوبون');
  };
};
async function deleteCoupon(id) {
  if (!confirm('حذف الكوبون؟')) return;
  await deleteDoc(doc(db,'coupons',id));
  await loadCoupons();
}

async function loadPayments() {
  const s = await getDocs(collection(db,'paymentMethods'));
  payments = s.docs.map(d => ({ id:d.id, ...d.data() })).sort((a,b) => Number(a.seq || 0)-Number(b.seq || 0));
  renderPayments();
}
function renderPayments() {
  $('payments').innerHTML = payments.map(p =>
    '<div class="card"><div class="row"><div><b>' + esc(p.name) + '</b><div class="muted">' + esc(p.accountNumber || '') + '</div></div><span class="badge ' + (p.enabled === false ? 'danger' : 'success') + '">' + (p.enabled === false ? 'معطلة' : 'فعالة') + '</span></div><div class="row muted" style="margin-top:8px"><span>' + money(p.min || 0) + ' — ' + money(p.max || 0) + '</span><button class="btn ghost" data-payment-edit="' + esc(p.id) + '">تعديل</button></div></div>'
  ).join('') || '<div class="empty">لا توجد طرق دفع</div>';
  $('payments').querySelectorAll('[data-payment-edit]').forEach(b => b.onclick = () => paymentForm(b.dataset.paymentEdit));
}
window.paymentForm = id => {
  const p = payments.find(x => x.id === id) || {};
  form(id ? 'تعديل طريقة الدفع' : 'إضافة طريقة دفع', '<div class="field"><label>الاسم</label><input id="payName" class="input" value="' + esc(p.name || '') + '"></div><div class="field"><label>رقم الحساب / المحفظة</label><input id="payAccount" class="input" value="' + esc(p.accountNumber || '') + '"></div><div class="field"><label>التعليمات</label><textarea id="payInstructions" class="textarea">' + esc(p.instructions || '') + '</textarea></div><div class="grid"><div class="field"><label>Min</label><input id="payMin" class="input" type="number" step=".0001" value="' + Number(p.min || 0) + '"></div><div class="field"><label>Max</label><input id="payMax" class="input" type="number" step=".0001" value="' + Number(p.max || 1000) + '"></div></div><div class="field"><label>الترتيب</label><input id="paySeq" class="input" type="number" value="' + Number(p.seq || 0) + '"></div><label class="row start"><input id="payEnabled" type="checkbox" ' + (p.enabled === false ? '' : 'checked') + '> مفعلة</label><button id="savePayment" class="btn primary" style="width:100%;margin-top:12px">حفظ</button>' + (id ? '<button id="deletePayment" class="btn danger" style="width:100%;margin-top:8px">حذف</button>' : ''));
  $('savePayment').onclick = async () => {
    const data = { name:$('payName').value.trim(), accountNumber:$('payAccount').value.trim(), instructions:$('payInstructions').value.trim(), min:Number($('payMin').value || 0), max:Number($('payMax').value || 0), seq:Number($('paySeq').value || 0), enabled:$('payEnabled').checked, updatedAt:serverTimestamp() };
    if (!data.name || data.max < data.min) return toast('تحقق من بيانات طريقة الدفع');
    id ? await setDoc(doc(db,'paymentMethods',id),data,{merge:true}) : await addDoc(collection(db,'paymentMethods'),{...data,createdAt:serverTimestamp()});
    closeM('formM'); await loadPayments(); toast('تم الحفظ');
  };
  if ($('deletePayment')) $('deletePayment').onclick = async () => { if (confirm('حذف طريقة الدفع؟')) { await deleteDoc(doc(db,'paymentMethods',id)); closeM('formM'); await loadPayments(); } };
};

async function loadRecharges() {
  const s = await getDocs(query(collection(db,'rechargeRequests'), orderBy('createdAt','desc'), limit(120)));
  rechargeRequests = s.docs.map(d => ({ id:d.id, ...d.data() }));
  renderRecharges();
}
function renderRecharges() {
  $('recharges').innerHTML = rechargeRequests.map(r => {
    const u = users.find(x => x.id === r.userId);
    return '<div class="card"><div class="row"><div><b>' + money(r.amount) + '</b><div class="muted">' + esc(u?.name || r.userId?.slice(0,10) || '-') + '</div></div><span class="badge ' + statusClass(r.status) + '">' + esc(r.status || 'PENDING') + '</span></div><div class="row muted" style="margin-top:8px"><span>Reference</span><code>' + esc(r.reference || '') + '</code></div><div class="tiny">' + esc(dt(r.createdAt)) + '</div>' + (r.status === 'PENDING' ? '<div class="row start" style="margin-top:9px"><button class="btn success" data-recharge-ok="' + esc(r.id) + '">قبول</button><button class="btn danger" data-recharge-no="' + esc(r.id) + '">رفض</button></div>' : '') + '</div>';
  }).join('') || '<div class="empty">لا توجد طلبات شحن</div>';
  $('recharges').querySelectorAll('[data-recharge-ok]').forEach(b => b.onclick = () => resolveRecharge(b.dataset.rechargeOk,'APPROVE'));
  $('recharges').querySelectorAll('[data-recharge-no]').forEach(b => b.onclick = () => resolveRecharge(b.dataset.rechargeNo,'REJECT'));
}
async function resolveRecharge(id, decision) {
  const reason = decision === 'REJECT' ? prompt('سبب الرفض','المرجع غير صحيح') : 'تم التحقق من العملية';
  if (decision === 'REJECT' && !reason) return;
  loading(true);
  try { await api('/admin/recharge/resolve',{requestId:id,decision,reason}); toast(decision === 'APPROVE' ? 'تم شحن الرصيد' : 'تم رفض الطلب'); await Promise.all([loadRecharges(),loadUsers(true)]); }
  catch (e) { toast(errorText(e)); }
  loading(false);
}

let chatsUnsub = null;
function listenChats() {
  if (chatsUnsub) chatsUnsub();
  chatsUnsub = onSnapshot(query(collection(db,'chats'), orderBy('time','desc'), limit(150)), snap => {
    chats = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    renderChats();
  });
}
window.renderChats = () => {
  const qv = $('chatSearch').value.trim().toLowerCase();
  const list = chats.filter(c => !qv || (String(c.name || '') + ' ' + String(c.username || '') + ' ' + String(c.lastMessage || '')).toLowerCase().includes(qv));
  $('chats').innerHTML = list.map(c =>
    '<button class="card click" data-chat="' + esc(c.id) + '"><div class="row"><b>' + esc(c.name || c.id.slice(0,8)) + '</b>' + (c.hasUnread ? '<span class="badge info">جديد</span>' : '') + '</div><div class="muted">' + esc(c.lastMessage || '') + '</div><div class="row"><span class="tiny">' + esc(dt(c.time)) + '</span><span class="badge ' + (c.status === 'closed' ? 'danger' : 'success') + '">' + esc(c.status || 'open') + '</span></div></button>'
  ).join('') || '<div class="empty">لا توجد محادثات</div>';
  $('chats').querySelectorAll('[data-chat]').forEach(b => b.onclick = () => openChat(b.dataset.chat));
};
function openChat(id) {
  activeChat = id;
  const c = chats.find(x => x.id === id) || {};
  $('chatbox').classList.remove('hide');
  $('chatTitle').textContent = c.name || 'المحادثة';
  $('internalNote').value = c.internalNote || '';
  setDoc(doc(db,'chats',id), { hasUnread:false }, { merge:true });
  if (chatUnsub) chatUnsub();
  chatUnsub = onSnapshot(query(collection(db,'chats',id,'messages'), orderBy('createdAt','asc'), limit(300)), snap => {
    $('chat').innerHTML = snap.docs.map(d => d.data()).map(m => '<div class="msg ' + (m.sender === 'admin' ? 'me' : 'them') + '">' + esc(m.text || '') + '</div>').join('');
    $('chat').scrollTop = $('chat').scrollHeight;
  });
}
window.sendReply = async () => {
  const text = $('reply').value.trim();
  if (!activeChat || !text) return;
  $('reply').value = '';
  await addDoc(collection(db,'chats',activeChat,'messages'), { text, sender:'admin', createdAt:serverTimestamp() });
  await setDoc(doc(db,'chats',activeChat), { lastMessage:'الإدارة: ' + text, time:serverTimestamp(), status:'open', hasUnread:false }, { merge:true });
};
window.closeTicket = async () => {
  if (!activeChat) return;
  await setDoc(doc(db,'chats',activeChat), { status:'closed', time:serverTimestamp() }, { merge:true });
  toast('تم إغلاق التذكرة');
};
window.saveInternalNote = async () => {
  if (!activeChat) return;
  await setDoc(doc(db,'chats',activeChat), { internalNote:$('internalNote').value.trim(), internalNoteUpdatedAt:serverTimestamp() }, { merge:true });
  toast('تم حفظ الملاحظة الداخلية');
};

async function loadAnnouncements() {
  const s = await getDocs(collection(db,'announcements'));
  announcements = s.docs.map(d => ({ id:d.id, ...d.data() })).sort((a,b) => Number(b.priority || 0)-Number(a.priority || 0));
  renderAnnouncements();
}
function renderAnnouncements() {
  $('announcements').innerHTML = announcements.map(a =>
    '<div class="card"><div class="row"><b>' + esc(a.title || 'إعلان') + '</b><span class="badge ' + (a.active === false ? 'danger' : 'success') + '">' + (a.active === false ? 'متوقف' : 'فعال') + '</span></div><div class="subtitle">' + esc(a.body || '') + '</div><div class="row start" style="margin-top:8px"><button class="btn ghost" data-ann-edit="' + esc(a.id) + '">تعديل</button><button class="btn danger" data-ann-del="' + esc(a.id) + '">حذف</button></div></div>'
  ).join('') || '<div class="empty">لا توجد إعلانات</div>';
  $('announcements').querySelectorAll('[data-ann-edit]').forEach(b => b.onclick = () => announcementForm(b.dataset.annEdit));
  $('announcements').querySelectorAll('[data-ann-del]').forEach(b => b.onclick = () => deleteAnnouncement(b.dataset.annDel));
}
window.announcementForm = id => {
  const a = announcements.find(x => x.id === id) || {};
  form(id ? 'تعديل الإعلان' : 'إضافة إعلان', '<div class="field"><label>العنوان</label><input id="annTitle" class="input" value="' + esc(a.title || '') + '"></div><div class="field"><label>النص</label><textarea id="annBody" class="textarea">' + esc(a.body || '') + '</textarea></div><div class="field"><label>الأولوية</label><input id="annPriority" class="input" type="number" value="' + Number(a.priority || 0) + '"></div><div class="grid"><div class="field"><label>يبدأ</label><input id="annStart" class="input" type="date" value="' + dateInput(a.startAt) + '"></div><div class="field"><label>ينتهي</label><input id="annEnd" class="input" type="date" value="' + dateInput(a.endAt) + '"></div></div><label class="row start"><input id="annActive" type="checkbox" ' + (a.active === false ? '' : 'checked') + '> فعال</label><button id="saveAnn" class="btn primary" style="width:100%;margin-top:12px">حفظ</button>');
  $('saveAnn').onclick = async () => {
    const data = { title:$('annTitle').value.trim(), body:$('annBody').value.trim(), priority:Number($('annPriority').value || 0), active:$('annActive').checked, updatedAt:serverTimestamp() };
    if (!data.title || !data.body) return toast('العنوان والنص مطلوبان');
    if ($('annStart').value) data.startAt = Timestamp.fromDate(new Date($('annStart').value + 'T00:00:00'));
    if ($('annEnd').value) data.endAt = Timestamp.fromDate(new Date($('annEnd').value + 'T23:59:59'));
    id ? await setDoc(doc(db,'announcements',id),data,{merge:true}) : await addDoc(collection(db,'announcements'),{...data,createdAt:serverTimestamp()});
    closeM('formM'); await loadAnnouncements(); toast('تم حفظ الإعلان');
  };
};
async function deleteAnnouncement(id) {
  if (!confirm('حذف الإعلان؟')) return;
  await deleteDoc(doc(db,'announcements',id));
  await loadAnnouncements();
}

async function loadSettings() {
  const s = await getDoc(doc(db,'settings','general'));
  const d = s.exists() ? s.data() : {};
  $('aff').value = Number(d.affiliatePercent ?? 5);
  $('ordersEnabled').checked = d.ordersEnabled !== false;
  $('maintenanceMode').checked = d.maintenanceMode === true;
}
window.saveSettings = async () => {
  const affiliatePercent = Math.max(0,Math.min(100,Number($('aff').value || 0)));
  await setDoc(doc(db,'settings','general'), {
    affiliatePercent, ordersEnabled:$('ordersEnabled').checked, maintenanceMode:$('maintenanceMode').checked,
    updatedAt:serverTimestamp()
  }, { merge:true });
  toast('تم حفظ إعدادات النظام');
};

async function loadLogs(reset = false) {
  if (reset) { logs = []; lastLogDoc = null; }
  let q = query(collection(db,'adminLogs'), orderBy('createdAt','desc'), limit(60));
  if (lastLogDoc) q = query(collection(db,'adminLogs'), orderBy('createdAt','desc'), startAfter(lastLogDoc), limit(60));
  const s = await getDocs(q);
  if (!s.empty) lastLogDoc = s.docs[s.docs.length - 1];
  logs.push(...s.docs.map(d => ({ id:d.id, ...d.data() })));
  $('moreLogs').classList.toggle('hide', s.size < 60);
  $('logs').innerHTML = logs.map(x => '<div class="card"><div class="row"><b>' + esc(x.action || 'action') + '</b><span class="tiny">' + esc(dt(x.createdAt)) + '</span></div><div class="muted">' + esc(x.targetId || '') + '</div>' + (x.reason ? '<div class="subtitle">' + esc(x.reason) + '</div>' : '') + '</div>').join('') || '<div class="empty">لا يوجد سجل بعد</div>';
}
window.loadMoreLogs = () => loadLogs(false);

window.go = p => {
  currentPage = p;
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  $('p-' + p)?.classList.add('active');
  document.querySelectorAll('.nav button').forEach(x => x.classList.toggle('active', x.dataset.p === p));
  if (p === 'dashboard') refreshDashboard();
  if (p === 'recharges') loadRecharges();
};
window.openM = id => $(id)?.classList.add('open');
window.closeM = id => $(id)?.classList.remove('open');
window.kaidoBack = () => {
  const m = [...document.querySelectorAll('.modal.open')].pop();
  if (m) { m.classList.remove('open'); return true; }
  if (currentPage !== 'dashboard') { go('dashboard'); return true; }
  return false;
};
