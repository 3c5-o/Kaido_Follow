const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 30 });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: '256kb' }));

const OWNER_EMAIL = 'kaidofollow@gmail.com';
const ACTIVE_STATUSES = ['CREATING','PENDING','PROCESSING','IN_PROGRESS','NEEDS_REVIEW'];
const TERMINAL_STATUSES = new Set(['COMPLETED','CANCELED','FAILED','PARTIAL','REFUNDED']);

function httpError(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}
function money(v) { return Math.round(Number(v || 0) * 10000) / 10000; }
function cleanText(v, max = 200) { return String(v || '').trim().slice(0, max); }
function normalizeUsername(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_.\u0600-\u06ff]/g, '').slice(0, 24);
}
function safeUrl(s) {
  try { const u = new URL(String(s)); return u.protocol === 'https:' || u.protocol === 'http:'; }
  catch { return false; }
}
function normalizeStatus(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!s) return 'PENDING';
  if (s.includes('complete')) return 'COMPLETED';
  if (s.includes('partial')) return 'PARTIAL';
  if (s.includes('cancel')) return 'CANCELED';
  if (s.includes('fail') || s.includes('error')) return 'FAILED';
  if (s.includes('progress') || s.includes('process')) return 'PROCESSING';
  if (s.includes('pending') || s.includes('await') || s.includes('queue')) return 'PENDING';
  return 'PENDING';
}
function publicError(e) {
  const status = e.status || 400;
  console.error(e);
  return { status, body: { ok: false, error: e.message || 'UNKNOWN_ERROR' } };
}
function fail(res, e) {
  const x = publicError(e);
  res.status(x.status).json(x.body);
}
async function bearer(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw httpError('UNAUTHENTICATED', 401);
  return admin.auth().verifyIdToken(h.slice(7));
}
async function auth(req, adminOnly = false, verified = false) {
  const token = await bearer(req);
  if (adminOnly) {
    if (!token.admin || String(token.email || '').toLowerCase() !== OWNER_EMAIL) throw httpError('ADMIN_REQUIRED', 403);
  }
  if (verified && !token.email_verified) throw httpError('EMAIL_NOT_VERIFIED', 403);
  return token;
}
async function rateLimit(uid, key, max = 12, windowSeconds = 60) {
  const id = crypto.createHash('sha256').update(`${uid}:${key}`).digest('hex');
  const ref = db.doc(`rateLimits/${id}`);
  const now = Date.now();
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : {};
    const started = Number(d.startedAtMs || 0);
    if (!started || now - started >= windowSeconds * 1000) {
      tx.set(ref, { uid, key, count: 1, startedAtMs: now, expiresAt: admin.firestore.Timestamp.fromMillis(now + windowSeconds * 2000) });
      return;
    }
    const next = Number(d.count || 0) + 1;
    if (next > max) throw httpError('RATE_LIMITED', 429);
    tx.update(ref, { count: next });
  });
}
async function notify(userId, title, message, type = 'general', data = {}) {
  await db.collection('notifications').add({
    userId, title, message, type, data, read: false, createdAt: FieldValue.serverTimestamp()
  });
}
async function adminLog(adminId, action, targetId = '', reason = '', metadata = {}) {
  await db.collection('adminLogs').add({
    adminId, action, targetId, reason, metadata, createdAt: FieldValue.serverTimestamp()
  });
}
async function providerSecret(providerId) {
  if (!providerId) throw httpError('PROVIDER_NOT_CONFIGURED');
  const [meta, secret] = await Promise.all([
    db.doc(`providers/${providerId}`).get(),
    db.doc(`providerSecrets/${providerId}`).get()
  ]);
  if (!meta.exists || !secret.exists) throw httpError('PROVIDER_NOT_CONFIGURED');
  const p = { id: providerId, ...meta.data(), ...secret.data() };
  if (p.enabled === false || !p.url || !p.key) throw httpError('PROVIDER_DISABLED');
  return p;
}
async function providerCall(provider, params, timeoutMs = 18000) {
  const body = new URLSearchParams({ key: provider.key, ...params });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let r;
    try {
      r = await fetch(provider.url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal
      });
    } catch (e) {
      throw httpError('PROVIDER_NETWORK_UNKNOWN', 502, { ambiguous: true, cause: e });
    }
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw httpError('INVALID_PROVIDER_RESPONSE', 502, { ambiguous: r.ok }); }
    if (!r.ok) throw httpError(`PROVIDER_HTTP_${r.status}`, 502, { ambiguous: r.status >= 500 });
    if (data.error) throw httpError(`PROVIDER_REJECTED: ${cleanText(data.error, 160)}`, 400, { providerRejected: true });
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function getGeneralSettings() {
  const s = await db.doc('settings/general').get();
  return s.exists ? s.data() : {};
}
async function incrementStats(fields) {
  const data = {};
  for (const [k, v] of Object.entries(fields)) data[k] = FieldValue.increment(Number(v || 0));
  data.updatedAt = FieldValue.serverTimestamp();
  await db.doc('systemStats/global').set(data, { merge: true });
}

async function createProfile(token, body) {
  const name = cleanText(body?.name, 60);
  const username = normalizeUsername(body?.username);
  const referralCode = cleanText(body?.referralCode, 32).toUpperCase();
  if (name.length < 2 || username.length < 3) throw httpError('INVALID_PROFILE');

  const userRef = db.doc(`users/${token.uid}`);
  const usernameRef = db.doc(`usernames/${username}`);
  const inviteCode = 'KF-' + token.uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase();
  const ownReferralRef = db.doc(`referralCodes/${inviteCode}`);
  const referralRef = referralCode ? db.doc(`referralCodes/${referralCode}`) : null;

  let created = false;
  await db.runTransaction(async tx => {
    const refs = [userRef, usernameRef];
    if (referralRef) refs.push(referralRef);
    const snaps = await Promise.all(refs.map(r => tx.get(r)));
    const existingUser = snaps[0];
    if (existingUser.exists) return;

    const usernameSnap = snaps[1];
    if (usernameSnap.exists) throw httpError('USERNAME_TAKEN', 409);

    let invitedBy = null;
    if (referralRef) {
      const refSnap = snaps[2];
      if (!refSnap.exists) throw httpError('REFERRAL_NOT_FOUND', 404);
      invitedBy = refSnap.data().userId;
      if (!invitedBy || invitedBy === token.uid) throw httpError('SELF_REFERRAL');
    }

    tx.create(usernameRef, { userId: token.uid, username, createdAt: FieldValue.serverTimestamp() });
    tx.create(ownReferralRef, { userId: token.uid, code: inviteCode, createdAt: FieldValue.serverTimestamp() });
    tx.create(userRef, {
      name, username, email: String(token.email || '').toLowerCase(),
      balance: 0, spent: 0, banned: false,
      inviteCode, inviteCount: 0, inviteEarnings: 0,
      invitedBy: invitedBy || null,
      emailVerified: !!token.email_verified,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    if (invitedBy) tx.update(db.doc(`users/${invitedBy}`), { inviteCount: FieldValue.increment(1) });
    tx.set(db.doc('systemStats/global'), { userCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    created = true;
  });
  return { created, inviteCode };
}

async function changeUsername(uid, usernameRaw) {
  const username = normalizeUsername(usernameRaw);
  if (username.length < 3) throw httpError('INVALID_USERNAME');
  const uref = db.doc(`users/${uid}`);
  await db.runTransaction(async tx => {
    const us = await tx.get(uref);
    if (!us.exists) throw httpError('USER_NOT_FOUND', 404);
    const old = normalizeUsername(us.data().username);
    if (old === username) return;
    const nr = db.doc(`usernames/${username}`);
    const ns = await tx.get(nr);
    if (ns.exists) throw httpError('USERNAME_TAKEN', 409);
    tx.create(nr, { userId: uid, username, createdAt: FieldValue.serverTimestamp() });
    if (old) tx.delete(db.doc(`usernames/${old}`));
    tx.update(uref, { username, updatedAt: FieldValue.serverTimestamp() });
  });
  return username;
}

async function refundOrderAmount(orderRef, amount, reason, actor = 'system', finalStatus = 'REFUNDED') {
  amount = money(amount);
  if (amount <= 0) return 0;
  let userId = '';
  await db.runTransaction(async tx => {
    const os = await tx.get(orderRef);
    if (!os.exists) throw httpError('ORDER_NOT_FOUND', 404);
    const o = os.data();
    userId = o.userId;
    const already = money(o.refundedAmount || 0);
    const maximum = money(o.price || 0);
    const remainingRefundable = money(maximum - already);
    const give = money(Math.min(amount, remainingRefundable));
    if (give <= 0) return;

    tx.update(db.doc(`users/${o.userId}`), {
      balance: FieldValue.increment(give),
      spent: FieldValue.increment(-give)
    });
    tx.update(orderRef, {
      refundedAmount: FieldValue.increment(give),
      isRefunded: money(already + give) >= maximum,
      status: finalStatus,
      refundReason: reason,
      refundedAt: FieldValue.serverTimestamp(),
      refundedBy: actor,
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.set(db.collection('walletTransactions').doc(), {
      userId: o.userId, amount: give, type: 'refund', orderId: orderRef.id,
      description: reason, createdAt: FieldValue.serverTimestamp()
    });
    if (o.statsCounted) {
      tx.set(db.doc('systemStats/global'), {
        grossRevenue: FieldValue.increment(-give),
        estimatedProfit: FieldValue.increment(-give),
        refundTotal: FieldValue.increment(give),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  });
  if (userId) await notify(userId, 'تم استرجاع مبلغ', `تمت إعادة $${amount.toFixed(4)} إلى محفظتك.`, 'refund', { orderId: orderRef.id });
  return amount;
}

async function settleProviderStatus(orderRef, order, data, normalized) {
  const remains = Math.max(0, Number(data.remains ?? order.remains ?? 0));
  const startCount = Math.max(0, Number(data.start_count ?? order.start_count ?? 0));
  const patch = {
    status: normalized,
    providerStatus: cleanText(data.status || normalized, 80),
    remains, start_count: startCount,
    updatedAt: FieldValue.serverTimestamp()
  };

  if (normalized === 'COMPLETED') {
    patch.remains = 0;
    patch.completedAt = FieldValue.serverTimestamp();
    await orderRef.update(patch);
    return;
  }

  if (normalized === 'PARTIAL' || normalized === 'CANCELED' || normalized === 'FAILED') {
    await orderRef.update(patch);
    const qty = Math.max(1, Number(order.qty || 1));
    const undelivered = Math.min(qty, remains > 0 ? remains : (normalized === 'PARTIAL' ? 0 : qty));
    const proportional = money(Number(order.price || 0) * (undelivered / qty));
    if (proportional > money(order.refundedAmount || 0)) {
      const due = money(proportional - Number(order.refundedAmount || 0));
      await refundOrderAmount(orderRef, due, `Provider status: ${normalized}`, 'system', normalized);
    }
    return;
  }

  await orderRef.update(patch);
}

async function syncOrderDoc(orderDoc) {
  const o = orderDoc.data();
  if (!o.providerOrderId) return false;
  if (TERMINAL_STATUSES.has(String(o.status || '').toUpperCase())) return false;
  const provider = await providerSecret(o.providerId);
  const data = await providerCall(provider, { action: 'status', order: String(o.providerOrderId) });
  const normalized = normalizeStatus(data.status);
  await settleProviderStatus(orderDoc.ref, o, data, normalized);
  return true;
}

app.get('/health', (_, res) => res.json({
  ok: true, service: 'kaido-follow', project: 'kaido-follow-b597e', version: '2.0.0'
}));

app.post('/bootstrap-owner', async (req, res) => {
  try {
    const t = await bearer(req);
    if (String(t.email || '').toLowerCase() !== OWNER_EMAIL) throw httpError('OWNER_EMAIL_REQUIRED', 403);
    const user = await admin.auth().getUser(t.uid);
    await admin.auth().setCustomUserClaims(t.uid, { ...(user.customClaims || {}), admin: true, role: 'owner' });
    await db.doc(`admins/${t.uid}`).set({
      email: OWNER_EMAIL, role: 'owner', active: true, updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ ok: true, role: 'owner' });
  } catch (e) { fail(res, e); }
});

app.post('/auth/bootstrap-profile', async (req, res) => {
  try {
    const t = await auth(req);
    await rateLimit(t.uid, 'bootstrap-profile', 5, 120);
    const out = await createProfile(t, req.body || {});
    res.json({ ok: true, ...out });
  } catch (e) { fail(res, e); }
});

app.post('/auth/change-username', async (req, res) => {
  try {
    const t = await auth(req);
    await rateLimit(t.uid, 'username', 5, 300);
    const username = await changeUsername(t.uid, req.body?.username);
    res.json({ ok: true, username });
  } catch (e) { fail(res, e); }
});

app.post('/auth/sync-verification', async (req, res) => {
  try {
    const t = await auth(req);
    await db.doc(`users/${t.uid}`).set({
      emailVerified: !!t.email_verified, updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ ok: true, emailVerified: !!t.email_verified });
  } catch (e) { fail(res, e); }
});

app.post('/order/create', async (req, res) => {
  let orderRef, token, price = 0, service, providerAccepted = false;
  try {
    token = await auth(req, false, true);
    await rateLimit(token.uid, 'order-create', 12, 60);
    const { serviceId, link, quantity, idempotencyKey } = req.body || {};
    const qty = Number(quantity);
    if (!serviceId || !safeUrl(link) || !Number.isInteger(qty) || qty <= 0 || !idempotencyKey) throw httpError('INVALID_ORDER_DATA');

    const cleanKey = String(idempotencyKey).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
    if (!cleanKey) throw httpError('INVALID_IDEMPOTENCY_KEY');
    const orderId = `${token.uid}_${cleanKey}`;
    orderRef = db.doc(`orders/${orderId}`);
    const serviceRef = db.doc(`services/${serviceId}`);
    const userRef = db.doc(`users/${token.uid}`);

    await db.runTransaction(async tx => {
      const [existing, uSnap, sSnap] = await Promise.all([tx.get(orderRef), tx.get(userRef), tx.get(serviceRef)]);
      if (existing.exists) throw httpError('IDEMPOTENT_REPLAY', 409, { replay: existing.data() });
      if (!uSnap.exists || !sSnap.exists) throw httpError('ACCOUNT_OR_SERVICE_NOT_FOUND', 404);

      const user = uSnap.data();
      service = sSnap.data();
      if (user.banned) throw httpError('ACCOUNT_BANNED', 403);
      if (service.visible === false) throw httpError('SERVICE_DISABLED');
      const min = Number(service.min || 1), max = Number(service.max || 1000000);
      if (qty < min || qty > max) throw httpError(`QUANTITY_${min}_${max}`);

      price = money((qty / 1000) * Number(service.price || 0));
      if (price <= 0) throw httpError('INVALID_SERVICE_PRICE');
      if (Number(user.balance || 0) < price) throw httpError('INSUFFICIENT_BALANCE');

      tx.update(userRef, { balance: FieldValue.increment(-price), spent: FieldValue.increment(price) });
      tx.create(orderRef, {
        userId: token.uid, serviceId, service: service.name || 'Service', link, qty, price,
        originalCost: money((qty / 1000) * Number(service.originalCost || 0)),
        providerId: service.providerId, providerServiceId: String(service.providerServiceId || ''),
        status: 'CREATING', providerStatus: '', remains: qty, start_count: 0,
        refundedAmount: 0, isRefunded: false, statsCounted: false,
        idempotencyKey: cleanKey,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
      tx.set(db.collection('walletTransactions').doc(), {
        userId: token.uid, amount: -price, type: 'order', orderId,
        description: `Order ${service.name || ''}`, createdAt: FieldValue.serverTimestamp()
      });
    });

    const provider = await providerSecret(service.providerId);
    const data = await providerCall(provider, {
      action: 'add', service: String(service.providerServiceId), link: String(link), quantity: String(qty)
    });
    if (!data.order) throw httpError('PROVIDER_ORDER_ID_MISSING', 502, { ambiguous: true });
    providerAccepted = true;

    await db.runTransaction(async tx => {
      const os = await tx.get(orderRef);
      if (!os.exists) throw httpError('ORDER_NOT_FOUND', 404);
      if (os.data().providerOrderId) return;
      tx.update(orderRef, {
        providerOrderId: String(data.order), status: 'PENDING', providerStatus: 'Pending',
        acceptedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), statsCounted: true
      });
      tx.set(db.doc('systemStats/global'), {
        orderCount: FieldValue.increment(1),
        grossRevenue: FieldValue.increment(price),
        estimatedCost: FieldValue.increment(Number(os.data().originalCost || 0)),
        estimatedProfit: FieldValue.increment(money(price - Number(os.data().originalCost || 0))),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });

    await notify(token.uid, 'تم استلام الطلب', `تم إنشاء طلب ${service.name || ''} بنجاح.`, 'order', { orderId: orderRef.id });
    res.json({ ok: true, orderId: orderRef.id, providerOrderId: String(data.order), price, status: 'PENDING' });
  } catch (e) {
    if (e.message === 'IDEMPOTENT_REPLAY' && e.replay) return res.status(200).json({ ok: true, replay: true, order: e.replay });

    if (orderRef && token && price > 0) {
      try {
        const snap = await orderRef.get();
        const o = snap.exists ? snap.data() : null;
        if (o && !o.providerOrderId && !o.isRefunded) {
          if (e.ambiguous || providerAccepted) {
            await orderRef.update({
              status: 'NEEDS_REVIEW', providerStatus: cleanText(e.message, 120),
              reviewReason: cleanText(e.message, 160), updatedAt: FieldValue.serverTimestamp()
            });
            await notify(token.uid, 'الطلب قيد المراجعة', 'لم نحصل على تأكيد نهائي من المزود. لم يتم رد الرصيد تلقائياً لحماية الطلب من التكرار.', 'order_review', { orderId: orderRef.id });
          } else {
            await refundOrderAmount(orderRef, price, cleanText(e.message, 160), 'system', 'FAILED');
          }
        }
      } catch (refundErr) { console.error('order recovery failed', refundErr); }
    }
    fail(res, e);
  }
});

app.post('/order/sync', async (req, res) => {
  try {
    const t = await auth(req);
    await rateLimit(t.uid, 'order-sync', 30, 60);
    const orderId = cleanText(req.body?.orderId, 160);
    const ref = db.doc(`orders/${orderId}`);
    const snap = await ref.get();
    if (!snap.exists || snap.data().userId !== t.uid) throw httpError('ORDER_NOT_FOUND', 404);
    const changed = await syncOrderDoc({ ref, data: () => snap.data() });
    const fresh = await ref.get();
    res.json({ ok: true, changed, order: fresh.data() });
  } catch (e) { fail(res, e); }
});

app.post('/order/refill', async (req, res) => {
  try {
    const t = await auth(req, false, true);
    await rateLimit(t.uid, 'order-refill', 8, 300);
    const orderId = cleanText(req.body?.orderId, 180);
    const ref = db.doc(`orders/${orderId}`);
    const snap = await ref.get();
    if (!snap.exists || snap.data().userId !== t.uid) throw httpError('ORDER_NOT_FOUND', 404);
    const o = snap.data();
    const service = await db.doc(`services/${o.serviceId}`).get();
    if (!service.exists || service.data().supportsRefill !== true) throw httpError('REFILL_NOT_SUPPORTED');
    if (!o.providerOrderId) throw httpError('PROVIDER_ORDER_MISSING');
    const p = await providerSecret(o.providerId);
    const data = await providerCall(p, { action: 'refill', order: String(o.providerOrderId) });
    await ref.update({
      refillRequested: true,
      refillId: String(data.refill ?? data.order ?? ''),
      refillStatus: cleanText(data.status || 'PENDING', 80),
      refillRequestedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    await notify(t.uid, 'تم إرسال طلب إعادة التعبئة', 'سنتابع حالة إعادة التعبئة تلقائياً.', 'refill', { orderId });
    res.json({ ok: true, refill: data.refill ?? data.order ?? null });
  } catch (e) { fail(res, e); }
});

app.post('/order/cancel', async (req, res) => {
  try {
    const t = await auth(req, false, true);
    await rateLimit(t.uid, 'order-cancel', 8, 300);
    const orderId = cleanText(req.body?.orderId, 180);
    const ref = db.doc(`orders/${orderId}`);
    const snap = await ref.get();
    if (!snap.exists || snap.data().userId !== t.uid) throw httpError('ORDER_NOT_FOUND', 404);
    const o = snap.data();
    const service = await db.doc(`services/${o.serviceId}`).get();
    if (!service.exists || service.data().supportsCancel !== true) throw httpError('CANCEL_NOT_SUPPORTED');
    if (!o.providerOrderId || TERMINAL_STATUSES.has(String(o.status || '').toUpperCase())) throw httpError('ORDER_NOT_CANCELABLE');
    const p = await providerSecret(o.providerId);
    const data = await providerCall(p, { action: 'cancel', order: String(o.providerOrderId) });
    await ref.update({
      cancelRequested: true,
      cancelResponse: cleanText(JSON.stringify(data), 500),
      cancelRequestedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    await notify(t.uid, 'تم إرسال طلب الإلغاء', 'تم إرسال طلب الإلغاء إلى المزود. سيظهر أي استرجاع بعد تأكيد الإلغاء.', 'cancel', { orderId });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

app.post('/wallet/redeem-coupon', async (req, res) => {
  try {
    const t = await auth(req, false, true);
    await rateLimit(t.uid, 'coupon', 8, 120);
    const code = cleanText(req.body?.code, 40).toUpperCase();
    if (!code) throw httpError('COUPON_REQUIRED');

    const couponRef = db.doc(`coupons/${code}`);
    const userRef = db.doc(`users/${t.uid}`);
    const redemptionRef = db.doc(`couponRedemptions/${code}_${t.uid}`);
    let amount = 0;

    await db.runTransaction(async tx => {
      const settingsRef = db.doc('settings/general');
      const [cSnap, uSnap, rSnap, settingsSnap] = await Promise.all([
        tx.get(couponRef), tx.get(userRef), tx.get(redemptionRef), tx.get(settingsRef)
      ]);
      if (!cSnap.exists) throw httpError('INVALID_COUPON');
      if (rSnap.exists) throw httpError('COUPON_ALREADY_USED');
      if (!uSnap.exists) throw httpError('USER_NOT_FOUND', 404);

      const c = cSnap.data(), u = uSnap.data(), settings = settingsSnap.exists ? settingsSnap.data() : {}, now = Date.now();
      if (c.active === false) throw httpError('COUPON_DISABLED');
      if (c.startsAt && c.startsAt.toMillis() > now) throw httpError('COUPON_NOT_STARTED');
      if (c.expiresAt && c.expiresAt.toMillis() < now) throw httpError('COUPON_EXPIRED');
      if (Number(c.currentUses || 0) >= Number(c.maxUses || 1)) throw httpError('COUPON_LIMIT_REACHED');

      amount = money(c.value);
      if (amount <= 0) throw httpError('INVALID_COUPON_VALUE');

      tx.update(couponRef, { currentUses: FieldValue.increment(1) });
      tx.create(redemptionRef, { code, userId: t.uid, value: amount, createdAt: FieldValue.serverTimestamp() });
      tx.update(userRef, { balance: FieldValue.increment(amount) });
      tx.set(db.collection('walletTransactions').doc(), {
        userId: t.uid, amount, type: 'coupon', description: `Coupon ${code}`, createdAt: FieldValue.serverTimestamp()
      });

      if (u.invitedBy) {
        const pct = Math.max(0, Math.min(100, Number(c.affiliatePercent ?? settings.affiliatePercent ?? 5)));
        const commission = money(amount * pct / 100);
        if (commission > 0) {
          tx.update(db.doc(`users/${u.invitedBy}`), { inviteEarnings: FieldValue.increment(commission) });
          tx.set(db.collection('referralTransactions').doc(), {
            referrerId: u.invitedBy, referredUserId: t.uid, source: 'coupon',
            sourceId: code, amount: commission, createdAt: FieldValue.serverTimestamp()
          });
        }
      }
    });

    await notify(t.uid, 'تم شحن المحفظة', `تمت إضافة $${amount.toFixed(4)} إلى رصيدك.`, 'wallet');
    res.json({ ok: true, amount });
  } catch (e) { fail(res, e); }
});

app.post('/wallet/transfer-referral', async (req, res) => {
  try {
    const t = await auth(req, false, true);
    await rateLimit(t.uid, 'referral-transfer', 5, 300);
    const ref = db.doc(`users/${t.uid}`);
    let amount = 0;
    await db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (!s.exists) throw httpError('USER_NOT_FOUND', 404);
      amount = money(s.data().inviteEarnings || 0);
      if (amount < 5) throw httpError('MINIMUM_5_USD');
      tx.update(ref, { balance: FieldValue.increment(amount), inviteEarnings: 0 });
      tx.set(db.collection('walletTransactions').doc(), {
        userId: t.uid, amount, type: 'referral', description: 'Referral earnings transfer',
        createdAt: FieldValue.serverTimestamp()
      });
    });
    await notify(t.uid, 'تم تحويل أرباح الإحالة', `تمت إضافة $${amount.toFixed(4)} إلى المحفظة.`, 'wallet');
    res.json({ ok: true, amount });
  } catch (e) { fail(res, e); }
});

app.post('/wallet/recharge-request', async (req, res) => {
  try {
    const t = await auth(req, false, true);
    await rateLimit(t.uid, 'recharge-request', 6, 300);
    const methodId = cleanText(req.body?.methodId, 80);
    const reference = cleanText(req.body?.reference, 120);
    const amount = money(req.body?.amount);
    if (!methodId || amount <= 0 || !reference) throw httpError('INVALID_RECHARGE_REQUEST');

    const method = await db.doc(`paymentMethods/${methodId}`).get();
    if (!method.exists || method.data().enabled === false) throw httpError('PAYMENT_METHOD_UNAVAILABLE');
    const min = Number(method.data().min || 0), max = Number(method.data().max || 1000000);
    if (amount < min || amount > max) throw httpError('RECHARGE_AMOUNT_OUT_OF_RANGE');

    const r = await db.collection('rechargeRequests').add({
      userId: t.uid, methodId, amount, reference, status: 'PENDING',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    await notify(t.uid, 'تم استلام طلب الشحن', 'طلب الشحن قيد المراجعة.', 'recharge', { requestId: r.id });
    res.json({ ok: true, requestId: r.id });
  } catch (e) { fail(res, e); }
});

app.get('/admin/dashboard', async (req, res) => {
  try {
    await auth(req, true);
    const s = await db.doc('systemStats/global').get();
    const d = s.exists ? s.data() : {};
    res.json({ ok: true, stats: {
      userCount: Number(d.userCount || 0), orderCount: Number(d.orderCount || 0),
      grossRevenue: money(d.grossRevenue || 0), estimatedCost: money(d.estimatedCost || 0),
      estimatedProfit: money(d.estimatedProfit || 0), refundTotal: money(d.refundTotal || 0)
    }});
  } catch (e) { fail(res, e); }
});

app.get('/admin/providers', async (req, res) => {
  try {
    await auth(req, true);
    const s = await db.collection('providers').orderBy('priority').get();
    res.json({ ok: true, providers: s.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (e) { fail(res, e); }
});

app.post('/admin/provider/save', async (req, res) => {
  try {
    const t = await auth(req, true);
    const { id, name, url, key, currency = 'USD', enabled = true, priority = 1 } = req.body || {};
    if (!cleanText(name, 80) || !safeUrl(url)) throw httpError('INVALID_PROVIDER');
    const ref = id ? db.doc(`providers/${id}`) : db.collection('providers').doc();
    const secretRef = db.doc(`providerSecrets/${ref.id}`);
    if (!id && !cleanText(key, 300)) throw httpError('PROVIDER_KEY_REQUIRED');
    if (id && !cleanText(key, 300)) {
      const oldSecret = await secretRef.get();
      if (!oldSecret.exists) throw httpError('PROVIDER_KEY_REQUIRED');
    }

    await ref.set({
      name: cleanText(name, 80), url: cleanText(url, 300), currency: cleanText(currency, 12) || 'USD',
      enabled: !!enabled, priority: Number(priority || 1),
      updatedAt: FieldValue.serverTimestamp(), updatedBy: t.uid
    }, { merge: true });
    if (cleanText(key, 300)) await secretRef.set({ key: cleanText(key, 300), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await adminLog(t.uid, id ? 'provider_update' : 'provider_create', ref.id);
    res.json({ ok: true, id: ref.id });
  } catch (e) { fail(res, e); }
});

app.post('/admin/provider/toggle', async (req, res) => {
  try {
    const t = await auth(req, true);
    const id = cleanText(req.body?.providerId, 100);
    const enabled = !!req.body?.enabled;
    await db.doc(`providers/${id}`).update({ enabled, updatedAt: FieldValue.serverTimestamp(), updatedBy: t.uid });
    await adminLog(t.uid, enabled ? 'provider_enable' : 'provider_disable', id);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

app.post('/admin/provider/test', async (req, res) => {
  try {
    await auth(req, true);
    const p = await providerSecret(req.body?.providerId);
    const started = Date.now();
    const d = await providerCall(p, { action: 'balance' });
    res.json({ ok: true, latencyMs: Date.now() - started, balance: Number(d.balance || 0), currency: d.currency || p.currency || 'USD' });
  } catch (e) { fail(res, e); }
});

app.post('/admin/provider/services', async (req, res) => {
  try {
    await auth(req, true);
    const p = await providerSecret(req.body?.providerId);
    const d = await providerCall(p, { action: 'services' }, 30000);
    const services = Array.isArray(d) ? d : [];
    res.json({ ok: true, services: services.slice(0, 5000).map(x => ({
      service: String(x.service ?? x.id ?? ''), name: cleanText(x.name, 180),
      type: cleanText(x.type, 80), category: cleanText(x.category, 120),
      rate: Number(x.rate || 0), min: Number(x.min || 0), max: Number(x.max || 0),
      refill: !!x.refill, cancel: !!x.cancel
    })) });
  } catch (e) { fail(res, e); }
});

app.post('/admin/adjust-balance', async (req, res) => {
  try {
    const t = await auth(req, true);
    const userId = cleanText(req.body?.userId, 140);
    const delta = money(req.body?.amount);
    const reason = cleanText(req.body?.reason, 180);
    if (!userId || !delta || !reason) throw httpError('INVALID_ADJUSTMENT');

    await db.runTransaction(async tx => {
      const uref = db.doc(`users/${userId}`);
      const us = await tx.get(uref);
      if (!us.exists) throw httpError('USER_NOT_FOUND', 404);
      const before = money(us.data().balance || 0), after = money(before + delta);
      if (after < 0) throw httpError('NEGATIVE_BALANCE');
      tx.update(uref, { balance: after });
      tx.set(db.collection('walletTransactions').doc(), {
        userId, amount: delta, balanceBefore: before, balanceAfter: after,
        type: 'admin_adjustment', description: reason, adminId: t.uid,
        createdAt: FieldValue.serverTimestamp()
      });
      tx.set(db.collection('adminLogs').doc(), {
        adminId: t.uid, action: 'adjust_balance', targetId: userId,
        amount: delta, reason, createdAt: FieldValue.serverTimestamp()
      });
    });
    await notify(userId, 'تم تعديل الرصيد', reason, 'wallet');
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

app.post('/admin/user/ban', async (req, res) => {
  try {
    const t = await auth(req, true);
    const userId = cleanText(req.body?.userId, 140);
    const banned = !!req.body?.banned;
    const reason = cleanText(req.body?.reason, 180) || (banned ? 'Admin ban' : 'Admin unban');
    await db.doc(`users/${userId}`).update({
      banned, banReason: banned ? reason : FieldValue.delete(),
      bannedAt: banned ? FieldValue.serverTimestamp() : FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    });
    await adminLog(t.uid, banned ? 'user_ban' : 'user_unban', userId, reason);
    await notify(userId, banned ? 'تم إيقاف الحساب' : 'تم تفعيل الحساب', reason, 'account');
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

app.post('/admin/refund', async (req, res) => {
  try {
    const t = await auth(req, true);
    const orderId = cleanText(req.body?.orderId, 180);
    const reason = cleanText(req.body?.reason, 180) || 'Admin refund';
    if (!orderId) throw httpError('ORDER_REQUIRED');
    const ref = db.doc(`orders/${orderId}`);
    const s = await ref.get();
    if (!s.exists) throw httpError('ORDER_NOT_FOUND', 404);
    const o = s.data();
    const due = money(Number(o.price || 0) - Number(o.refundedAmount || 0));
    if (due <= 0) throw httpError('ALREADY_REFUNDED');
    await refundOrderAmount(ref, due, reason, t.uid, 'REFUNDED');
    await adminLog(t.uid, 'order_refund', orderId, reason, { amount: due });
    res.json({ ok: true, amount: due });
  } catch (e) { fail(res, e); }
});

app.post('/admin/order/reconcile', async (req, res) => {
  try {
    const t = await auth(req, true);
    const orderId = cleanText(req.body?.orderId, 180);
    const action = cleanText(req.body?.action, 30).toUpperCase();
    const ref = db.doc(`orders/${orderId}`);
    const s = await ref.get();
    if (!s.exists) throw httpError('ORDER_NOT_FOUND', 404);
    const o = s.data();

    if (action === 'ATTACH') {
      const providerOrderId = cleanText(req.body?.providerOrderId, 120);
      if (!providerOrderId) throw httpError('PROVIDER_ORDER_ID_REQUIRED');
      await ref.update({
        providerOrderId, status: 'PENDING', reviewReason: FieldValue.delete(),
        reconciledAt: FieldValue.serverTimestamp(), reconciledBy: t.uid, updatedAt: FieldValue.serverTimestamp()
      });
      await adminLog(t.uid, 'order_reconcile_attach', orderId, '', { providerOrderId });
      return res.json({ ok: true });
    }
    if (action === 'REFUND') {
      const due = money(Number(o.price || 0) - Number(o.refundedAmount || 0));
      if (due <= 0) throw httpError('ALREADY_REFUNDED');
      await refundOrderAmount(ref, due, 'Admin reconciliation refund', t.uid, 'REFUNDED');
      await adminLog(t.uid, 'order_reconcile_refund', orderId, '', { amount: due });
      return res.json({ ok: true });
    }
    throw httpError('INVALID_RECONCILE_ACTION');
  } catch (e) { fail(res, e); }
});

app.post('/admin/recharge/resolve', async (req, res) => {
  try {
    const t = await auth(req, true);
    const requestId = cleanText(req.body?.requestId, 160);
    const decision = cleanText(req.body?.decision, 20).toUpperCase();
    const reason = cleanText(req.body?.reason, 180);
    const ref = db.doc(`rechargeRequests/${requestId}`);
    let userId = '', amount = 0;

    await db.runTransaction(async tx => {
      const rs = await tx.get(ref);
      if (!rs.exists) throw httpError('RECHARGE_NOT_FOUND', 404);
      const r = rs.data();
      if (r.status !== 'PENDING') throw httpError('RECHARGE_ALREADY_RESOLVED');
      userId = r.userId; amount = money(r.amount);

      if (decision === 'APPROVE') {
        const uref = db.doc(`users/${userId}`);
        const us = await tx.get(uref);
        if (!us.exists) throw httpError('USER_NOT_FOUND', 404);
        const before = money(us.data().balance || 0), after = money(before + amount);
        tx.update(uref, { balance: after });
        tx.set(db.collection('walletTransactions').doc(), {
          userId, amount, balanceBefore: before, balanceAfter: after,
          type: 'recharge', referenceId: requestId, description: 'Recharge approved',
          adminId: t.uid, createdAt: FieldValue.serverTimestamp()
        });
        tx.update(ref, { status: 'APPROVED', resolvedAt: FieldValue.serverTimestamp(), resolvedBy: t.uid, reason });
      } else if (decision === 'REJECT') {
        tx.update(ref, { status: 'REJECTED', resolvedAt: FieldValue.serverTimestamp(), resolvedBy: t.uid, reason });
      } else throw httpError('INVALID_DECISION');
    });

    await adminLog(t.uid, `recharge_${decision.toLowerCase()}`, requestId, reason, { amount });
    await notify(userId, decision === 'APPROVE' ? 'تم قبول الشحن' : 'تم رفض الشحن',
      decision === 'APPROVE' ? `تمت إضافة $${amount.toFixed(4)} إلى رصيدك.` : (reason || 'راجع الدعم للمزيد من التفاصيل.'),
      'recharge', { requestId });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

app.post('/admin/sync-orders', async (req, res) => {
  try {
    await auth(req, true);
    const updated = await syncPending(300);
    res.json({ ok: true, updated });
  } catch (e) { fail(res, e); }
});

async function syncPending(maxTotal = 300) {
  let updated = 0;
  const snap = await db.collection('orders').where('status', 'in', ACTIVE_STATUSES.slice(0, 10)).limit(maxTotal).get();
  for (const doc of snap.docs) {
    if (!doc.data().providerOrderId) continue;
    try {
      if (await syncOrderDoc(doc)) updated++;
    } catch (e) {
      console.error('sync', doc.id, e.message);
      await doc.ref.set({ lastSyncError: cleanText(e.message, 160), lastSyncAt: FieldValue.serverTimestamp() }, { merge: true });
    }
  }
  return updated;
}

exports.api = onRequest({ timeoutSeconds: 60 }, app);
exports.syncOrdersScheduled = onSchedule({ schedule: 'every 5 minutes', timeoutSeconds: 180 }, async () => {
  await syncPending(300);
});
