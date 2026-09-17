const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 20 });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '256kb' }));

const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'Kaido@gmail.com').toLowerCase();
const TERMINAL = ['completed','canceled','cancelled','failed','fail','partial','refunded'];

async function bearer(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw Object.assign(new Error('UNAUTHENTICATED'), { status: 401 });
  return admin.auth().verifyIdToken(h.slice(7));
}
async function auth(req, adminOnly = false) {
  const token = await bearer(req);
  if (adminOnly && !token.admin) throw Object.assign(new Error('ADMIN_REQUIRED'), { status: 403 });
  return token;
}
function fail(res, e) {
  const status = e.status || 400;
  console.error(e);
  res.status(status).json({ ok:false, error:e.message || 'UNKNOWN_ERROR' });
}
function money(v){ return Math.round(Number(v || 0) * 10000) / 10000; }
function safeUrl(s){ try { const u = new URL(s); return ['http:','https:'].includes(u.protocol); } catch { return false; } }
async function providerSecret(providerId) {
  const [meta, secret] = await Promise.all([
    db.doc(`providers/${providerId}`).get(),
    db.doc(`providerSecrets/${providerId}`).get()
  ]);
  if (!meta.exists || !secret.exists) throw new Error('PROVIDER_NOT_CONFIGURED');
  const p = { id: providerId, ...meta.data(), ...secret.data() };
  if (p.enabled === false || !p.url || !p.key) throw new Error('PROVIDER_DISABLED');
  return p;
}
async function providerCall(provider, params) {
  const body = new URLSearchParams({ key: provider.key, ...params });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(provider.url, { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body, signal:controller.signal });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { throw new Error('INVALID_PROVIDER_RESPONSE'); }
    if (!r.ok || data.error) throw new Error(data.error || `PROVIDER_HTTP_${r.status}`);
    return data;
  } finally { clearTimeout(t); }
}

app.get('/health', (_,res)=>res.json({ok:true, service:'kaido-follow', version:'1.0.0'}));

app.post('/bootstrap-owner', async (req,res)=>{
  try {
    const t = await bearer(req);
    if ((t.email || '').toLowerCase() !== OWNER_EMAIL) throw Object.assign(new Error('OWNER_EMAIL_REQUIRED'), {status:403});
    const user = await admin.auth().getUser(t.uid);
    await admin.auth().setCustomUserClaims(t.uid, { ...(user.customClaims||{}), admin:true, role:'owner' });
    await db.doc(`admins/${t.uid}`).set({ email:t.email, role:'owner', active:true, updatedAt:FieldValue.serverTimestamp() }, {merge:true});
    res.json({ok:true, role:'owner'});
  } catch(e){ fail(res,e); }
});

app.post('/referral/attach', async(req,res)=>{
  try{
    const t=await auth(req); const code=String(req.body?.code||'').trim().toUpperCase(); if(!code) return res.json({ok:true,attached:false});
    const q=await db.collection('users').where('inviteCode','==',code).limit(1).get();
    if(q.empty) throw new Error('REFERRAL_NOT_FOUND'); const referrer=q.docs[0]; if(referrer.id===t.uid) throw new Error('SELF_REFERRAL');
    const uref=db.doc(`users/${t.uid}`);
    await db.runTransaction(async tx=>{ const us=await tx.get(uref); if(!us.exists) throw new Error('USER_NOT_FOUND'); if(us.data().invitedBy) return; tx.update(uref,{invitedBy:referrer.id}); tx.update(referrer.ref,{inviteCount:FieldValue.increment(1)}); });
    res.json({ok:true,attached:true});
  }catch(e){fail(res,e);}
});

app.post('/order/create', async (req,res)=>{
  let orderRef, token, price = 0;
  try {
    token = await auth(req);
    const { serviceId, link, quantity, idempotencyKey } = req.body || {};
    const qty = Number(quantity);
    if (!serviceId || !safeUrl(link) || !Number.isInteger(qty) || qty <= 0 || !idempotencyKey) throw new Error('INVALID_ORDER_DATA');
    const orderId = `${token.uid}_${String(idempotencyKey).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,48)}`;
    orderRef = db.doc(`orders/${orderId}`);
    const serviceRef = db.doc(`services/${serviceId}`);
    const userRef = db.doc(`users/${token.uid}`);

    let service;
    await db.runTransaction(async tx => {
      const existing = await tx.get(orderRef);
      if (existing.exists) {
        const d = existing.data();
        throw Object.assign(new Error('IDEMPOTENT_REPLAY'), { status:409, replay:d });
      }
      const [uSnap,sSnap] = await Promise.all([tx.get(userRef), tx.get(serviceRef)]);
      if (!uSnap.exists || !sSnap.exists) throw new Error('ACCOUNT_OR_SERVICE_NOT_FOUND');
      const user = uSnap.data(); service = sSnap.data();
      if (user.banned) throw Object.assign(new Error('ACCOUNT_BANNED'), {status:403});
      if (service.visible === false) throw new Error('SERVICE_DISABLED');
      const min = Number(service.min || 1), max = Number(service.max || 1000000);
      if (qty < min || qty > max) throw new Error(`QUANTITY_${min}_${max}`);
      price = money((qty/1000) * Number(service.price || 0));
      if (price <= 0 || Number(user.balance || 0) < price) throw new Error('INSUFFICIENT_BALANCE');
      tx.update(userRef, { balance:FieldValue.increment(-price), spent:FieldValue.increment(price) });
      tx.set(orderRef, {
        userId:token.uid, serviceId, service:service.name || 'Service', link, qty, price,
        originalCost: money((qty/1000) * Number(service.originalCost || 0)), providerId:service.providerId,
        providerServiceId:String(service.providerServiceId), status:'Creating', remains:qty, start_count:0,
        isRefunded:false, idempotencyKey, createdAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp()
      });
      tx.set(db.collection('walletTransactions').doc(), { userId:token.uid, amount:-price, type:'order', orderId, description:`Order ${service.name||''}`, createdAt:FieldValue.serverTimestamp() });
    });

    const provider = await providerSecret(service.providerId);
    const data = await providerCall(provider, { action:'add', service:String(service.providerServiceId), link, quantity:String(qty) });
    if (!data.order) throw new Error('PROVIDER_ORDER_ID_MISSING');
    await orderRef.update({ providerOrderId:String(data.order), status:'Pending', updatedAt:FieldValue.serverTimestamp() });
    await db.collection('notifications').add({ userId:token.uid, title:'تم استلام الطلب', message:`تم إنشاء طلب ${service.name} بنجاح.`, type:'order', read:false, createdAt:FieldValue.serverTimestamp() });
    res.json({ok:true, orderId:orderRef.id, providerOrderId:String(data.order), price});
  } catch(e) {
    if (e.message === 'IDEMPOTENT_REPLAY' && e.replay) return res.status(200).json({ok:true,replay:true,order:e.replay});
    if (orderRef && token && price > 0) {
      try {
        await db.runTransaction(async tx => {
          const snap = await tx.get(orderRef); if (!snap.exists) return;
          const d = snap.data(); if (d.providerOrderId || d.isRefunded) return;
          tx.update(db.doc(`users/${token.uid}`), { balance:FieldValue.increment(price), spent:FieldValue.increment(-price) });
          tx.update(orderRef, { status:'Failed', isRefunded:true, refundReason:e.message, updatedAt:FieldValue.serverTimestamp() });
          tx.set(db.collection('walletTransactions').doc(), { userId:token.uid, amount:price, type:'refund', orderId:orderRef.id, description:'Automatic order refund', createdAt:FieldValue.serverTimestamp() });
        });
      } catch(refundErr){ console.error('refund failed', refundErr); }
    }
    fail(res,e);
  }
});

app.post('/order/sync', async (req,res)=>{
  try {
    const t = await auth(req);
    const { orderId } = req.body || {};
    const ref = db.doc(`orders/${orderId}`), snap = await ref.get();
    if (!snap.exists || snap.data().userId !== t.uid) throw Object.assign(new Error('ORDER_NOT_FOUND'),{status:404});
    const o = snap.data(); if (!o.providerOrderId || TERMINAL.some(x=>String(o.status||'').toLowerCase().includes(x))) return res.json({ok:true, order:o});
    const provider = await providerSecret(o.providerId);
    const data = await providerCall(provider, {action:'status', order:String(o.providerOrderId)});
    await ref.update({ status:data.status||o.status, remains:data.remains ?? o.remains, start_count:data.start_count ?? o.start_count, updatedAt:FieldValue.serverTimestamp() });
    res.json({ok:true, status:data.status, remains:data.remains, start_count:data.start_count});
  } catch(e){ fail(res,e); }
});

app.post('/wallet/redeem-coupon', async (req,res)=>{
  try {
    const t = await auth(req); const code = String(req.body?.code||'').trim().toUpperCase(); if (!code) throw new Error('COUPON_REQUIRED');
    const couponRef = db.doc(`coupons/${code}`), userRef = db.doc(`users/${t.uid}`), redemptionRef = db.doc(`couponRedemptions/${code}_${t.uid}`);
    let amount=0;
    await db.runTransaction(async tx=>{
      const [cSnap,uSnap,rSnap] = await Promise.all([tx.get(couponRef),tx.get(userRef),tx.get(redemptionRef)]);
      if (!cSnap.exists) throw new Error('INVALID_COUPON'); if (rSnap.exists) throw new Error('COUPON_ALREADY_USED');
      const c=cSnap.data(), u=uSnap.data(); if (c.active===false) throw new Error('COUPON_DISABLED');
      if (c.expiresAt && c.expiresAt.toMillis() < Date.now()) throw new Error('COUPON_EXPIRED');
      if (Number(c.currentUses||0) >= Number(c.maxUses||1)) throw new Error('COUPON_LIMIT_REACHED');
      amount=money(c.value); if(amount<=0) throw new Error('INVALID_COUPON_VALUE');
      tx.update(couponRef,{currentUses:FieldValue.increment(1)}); tx.set(redemptionRef,{code,userId:t.uid,value:amount,createdAt:FieldValue.serverTimestamp()});
      tx.update(userRef,{balance:FieldValue.increment(amount)});
      tx.set(db.collection('walletTransactions').doc(),{userId:t.uid,amount,type:'coupon',description:`Coupon ${code}`,createdAt:FieldValue.serverTimestamp()});
      if(u.invitedBy){
        const pct=Math.max(0,Math.min(100,Number(c.affiliatePercent ?? 5))), commission=money(amount*pct/100);
        if(commission>0) tx.update(db.doc(`users/${u.invitedBy}`),{inviteEarnings:FieldValue.increment(commission)});
      }
    });
    await db.collection('notifications').add({userId:t.uid,title:'تم شحن المحفظة',message:`تمت إضافة $${amount.toFixed(2)} إلى رصيدك.`,type:'wallet',read:false,createdAt:FieldValue.serverTimestamp()});
    res.json({ok:true,amount});
  }catch(e){fail(res,e);}
});

app.post('/wallet/transfer-referral', async(req,res)=>{
  try{
    const t=await auth(req), ref=db.doc(`users/${t.uid}`); let amount=0;
    await db.runTransaction(async tx=>{ const s=await tx.get(ref); amount=money(s.data()?.inviteEarnings||0); if(amount<5) throw new Error('MINIMUM_5_USD'); tx.update(ref,{balance:FieldValue.increment(amount),inviteEarnings:0}); tx.set(db.collection('walletTransactions').doc(),{userId:t.uid,amount,type:'referral',description:'Referral earnings transfer',createdAt:FieldValue.serverTimestamp()}); });
    res.json({ok:true,amount});
  }catch(e){fail(res,e);}
});

app.post('/admin/provider/save', async(req,res)=>{
  try{
    const t=await auth(req,true); const {id,name,url,key,currency='USD',enabled=true,priority=1}=req.body||{}; if(!name||!url||!key||!safeUrl(url)) throw new Error('INVALID_PROVIDER');
    const ref=id?db.doc(`providers/${id}`):db.collection('providers').doc();
    await Promise.all([
      ref.set({name,url,currency,enabled,priority:Number(priority||1),updatedAt:FieldValue.serverTimestamp(),updatedBy:t.uid},{merge:true}),
      db.doc(`providerSecrets/${ref.id}`).set({key,updatedAt:FieldValue.serverTimestamp()},{merge:true})
    ]);
    res.json({ok:true,id:ref.id});
  }catch(e){fail(res,e);}
});

app.get('/admin/providers', async(req,res)=>{
  try{ await auth(req,true); const s=await db.collection('providers').orderBy('priority').get(); res.json({ok:true,providers:s.docs.map(d=>({id:d.id,...d.data()}))}); }catch(e){fail(res,e);}
});
app.post('/admin/provider/balance', async(req,res)=>{
  try{ await auth(req,true); const p=await providerSecret(req.body?.providerId); const d=await providerCall(p,{action:'balance'}); res.json({ok:true,balance:Number(d.balance||0),currency:d.currency||p.currency||'USD'}); }catch(e){fail(res,e);}
});
app.post('/admin/provider/test', async(req,res)=>{
  try{ await auth(req,true); const p=await providerSecret(req.body?.providerId); const started=Date.now(); const d=await providerCall(p,{action:'balance'}); res.json({ok:true,latencyMs:Date.now()-started,balance:d.balance,currency:d.currency}); }catch(e){fail(res,e);}
});

app.post('/admin/adjust-balance', async(req,res)=>{
  try{
    const t=await auth(req,true), {userId,amount,reason}=req.body||{}; const delta=money(amount); if(!userId||!delta||!reason) throw new Error('INVALID_ADJUSTMENT');
    await db.runTransaction(async tx=>{ const uref=db.doc(`users/${userId}`), us=await tx.get(uref); if(!us.exists) throw new Error('USER_NOT_FOUND'); const next=money(Number(us.data().balance||0)+delta); if(next<0) throw new Error('NEGATIVE_BALANCE'); tx.update(uref,{balance:next}); tx.set(db.collection('walletTransactions').doc(),{userId,amount:delta,type:'admin_adjustment',description:reason,adminId:t.uid,createdAt:FieldValue.serverTimestamp()}); tx.set(db.collection('adminLogs').doc(),{adminId:t.uid,action:'adjust_balance',targetId:userId,amount:delta,reason,createdAt:FieldValue.serverTimestamp()}); });
    res.json({ok:true});
  }catch(e){fail(res,e);}
});

app.post('/admin/refund', async(req,res)=>{
  try{
    const t=await auth(req,true), {orderId,reason='Admin refund'}=req.body||{}; if(!orderId) throw new Error('ORDER_REQUIRED'); const oref=db.doc(`orders/${orderId}`);
    await db.runTransaction(async tx=>{ const os=await tx.get(oref); if(!os.exists) throw new Error('ORDER_NOT_FOUND'); const o=os.data(); if(o.isRefunded) throw new Error('ALREADY_REFUNDED'); tx.update(db.doc(`users/${o.userId}`),{balance:FieldValue.increment(Number(o.price||0)),spent:FieldValue.increment(-Number(o.price||0))}); tx.update(oref,{isRefunded:true,status:'Refunded',refundReason:reason,refundedAt:FieldValue.serverTimestamp(),refundedBy:t.uid}); tx.set(db.collection('walletTransactions').doc(),{userId:o.userId,amount:Number(o.price||0),type:'refund',orderId,description:reason,createdAt:FieldValue.serverTimestamp()}); tx.set(db.collection('adminLogs').doc(),{adminId:t.uid,action:'refund',targetId:orderId,reason,createdAt:FieldValue.serverTimestamp()}); });
    res.json({ok:true});
  }catch(e){fail(res,e);}
});

async function syncPending(limitCount=80){
  const snap=await db.collection('orders').where('status','in',['Creating','Pending','Processing','In progress','In Progress']).limit(limitCount).get();
  let updated=0;
  for(const doc of snap.docs){
    const o=doc.data(); if(!o.providerOrderId) continue;
    try{ const p=await providerSecret(o.providerId); const d=await providerCall(p,{action:'status',order:String(o.providerOrderId)}); await doc.ref.update({status:d.status||o.status,remains:d.remains??o.remains,start_count:d.start_count??o.start_count,updatedAt:FieldValue.serverTimestamp()}); updated++; }catch(e){ console.error('sync',doc.id,e.message); }
  }
  return updated;
}
app.post('/admin/sync-orders',async(req,res)=>{try{await auth(req,true);res.json({ok:true,updated:await syncPending(100)});}catch(e){fail(res,e);}});

exports.api = onRequest({ timeoutSeconds:60 }, app);
exports.syncOrdersScheduled = onSchedule({ schedule:'every 5 minutes', timeoutSeconds:120 }, async()=>{ await syncPending(100); });
