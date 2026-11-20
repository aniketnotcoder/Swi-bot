import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openStorelexScratch } from '../storelex-mini-db.js';
import { createStorelexMiniService, verifyTelegramInitData } from '../storelex-mini-service.js';

const sign = (token, userId) => {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now()/1000)), user: JSON.stringify({id:userId}) });
  const data = [...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256','WebAppData').update(token).digest();
  params.set('hash',crypto.createHmac('sha256',secret).update(data).digest('hex'));
  return params.toString();
};

test('frontend is black-only and never embeds an access key or disabled operations', async () => {
  const css = await fs.readFile(new URL('../storelex-mini.css', import.meta.url), 'utf8');
  const ui = await fs.readFile(new URL('../storelex-mini.js', import.meta.url), 'utf8');
  assert.match(css, /--bg:#000000/);
  assert.doesNotMatch(css, /light mode|gradient/i);
  assert.doesNotMatch(ui, /SWG-[A-Z0-9]+|mark_used|mark_fresh|orders_recent|send_otp/);
});

test('Telegram initData signature is verified, tampering rejected', () => {
  const valid=sign('token:ABC',12345);
  assert.equal(verifyTelegramInitData(valid,'token:ABC'),'12345');
  assert.equal(verifyTelegramInitData(valid.replace('12345','99999'),'token:ABC'),null);
  assert.equal(verifyTelegramInitData(valid,'wrong'),null);
});

test('SQLite retains per-user mobile/cart/address and one-attempt placement across reopen', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storelex-mini-'));const file=path.join(dir,'scratch.sqlite');
  try {
    let db=await openStorelexScratch(file);
    await db.select('1','9876543210');await db.address('1','a1',26,80);await db.cart('1','c1');
    assert.equal(await db.lock('1','c1'),true);
    assert.equal(await db.lock('1','c1'),false);
    db.close();db=await openStorelexScratch(file);
    assert.equal(db.get('1').address_id,'a1');
    assert.equal(db.get('1').cart_id,'c1');
    assert.equal(db.attempt('1','c1').state,'ATTEMPTED');
    assert.equal(db.get('2').mobile,undefined);
    db.close();
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('cart checkout uses selected account, single placement and paid-only confirmation', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storelex-checkout-'));
  const scratch=await openStorelexScratch(path.join(dir,'s.sqlite'));
  let placements=0, paid=false;
  const client={
    me:async()=>({success:true,balance:20,fee:1,is_owner:true}),maintenance:async()=>({maintenance:false}),profile:async()=>({success:true}),
    addresses:async()=>({success:true,addresses:[{id:'a1',lat:26,lng:80}]}),
    repriceCart:async body=>({success:true,cart_id:'cart-1',cart_value:25000,bill:{},bill_lines:[{label:'To Pay',value:'300'}]}),
    placeOrder:async body=>{placements++;assert.equal(body.mobile,'9876543210');assert.equal(body.amount,300);return {success:true,order_id:'order-1',txn_id:'txn-1',method:'upi'};},
    paymentStatus:async()=>({success:true,paid}),confirmPayment:async()=>({success:true,confirmed:true}),orderStatus:async()=>({success:true,status:'Order received'})
  };
  try{
    await scratch.select('1','9876543210');await scratch.address('1','a1',26,80);
    const service=createStorelexMiniService({client,scratch,token:'token:ABC',bossIds:'1'});
    const restaurant={id:'r1'};
    await service.action('1','repriceCart',{restaurant,items:[{id:'item-1',quantity:1}]});
    await assert.rejects(service.action('1','placeOrder',{amount:301,method:'upi'}),/Bill changed/);
    await service.action('1','placeOrder',{amount:300,method:'upi'});
    await assert.rejects(service.action('1','placeOrder',{amount:300,method:'upi'}),/already attempted/);
    assert.equal(placements,1);
    await assert.rejects(service.action('1','confirmPayment'),/Payment not verified/);
    await assert.rejects(service.action('1','orderStatus'),/Payment not confirmed/);
    paid=true;
    await service.action('1','confirmPayment');
    assert.equal((await service.action('1','orderStatus')).status,'Order received');
  } finally { scratch.close();await fs.rm(dir,{recursive:true,force:true}); }
});

test('unconfirmed placement retries once using same cart and txn; no new cart', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storelex-unconfirmed-'));
  const scratch=await openStorelexScratch(path.join(dir,'s.sqlite'));
  const attempts=[];
  const client={
    me:async()=>({success:true,balance:20,fee:1,is_owner:false}),maintenance:async()=>({maintenance:false}),profile:async()=>({success:true}),
    addresses:async()=>({success:true,addresses:[{id:'a1',lat:26,lng:80}]}),
    repriceCart:async()=>({success:true,cart_id:'c1',cart_value:10000,bill:{},bill_lines:[{label:'To Pay',value:'150'}]}),
    placeOrder:async body=>{attempts.push(body);return attempts.length===1?{success:false,unconfirmed:true,txn_id:'t1'}:{success:true,order_id:'o1',txn_id:'t1'};}
  };
  try {
    await scratch.select('1','9876543210');await scratch.address('1','a1',26,80);
    const service=createStorelexMiniService({client,scratch,token:'token:ABC',bossIds:'1'});
    await service.action('1','repriceCart',{restaurant:{id:'r1'},items:[{id:'i1',quantity:1}]});
    const result=await service.action('1','placeOrder',{method:'upi',amount:150});
    assert.equal(result.order_id,'o1');assert.equal(attempts.length,2);
    assert.equal(attempts[0].cart_id,attempts[1].cart_id);
    assert.equal(attempts[1].txn_id,'t1');
  }finally{scratch.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('owner gate, disabled routes, profile/wallet/maintenance guards, mobile scoping', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storelex-mini-'));
  const scratch=await openStorelexScratch(path.join(dir,'s.sqlite'));
  const calls=[];
  let balance=5,maintenance=false,expired=false;
  const client={
    sessions:async()=>({success:true,sessions:[{mobile:'9876543210'},{mobile:'9123456789'}]}),
    me:async()=>{calls.push('me');return {success:true,balance,fee:1,is_owner:false};},
    maintenance:async()=>{calls.push('maintenance');return {maintenance};},
    profile:async mobile=>{calls.push(`profile:${mobile}`);return {success:!expired,expired};},
    addresses:async()=>({success:true,addresses:[{id:'a1',lat:26,lng:80,is_global:false},{id:'global',is_global:true}]}),
    addAddress:async body=>{calls.push(`add:${body.mobile}`);return {success:true};},
    orders:async mobile=>({success:true,mobile})
  };
  const service=createStorelexMiniService({client,scratch,token:'token:ABC',bossIds:'12345'});
  async function request(user,action,body={}){
    const raw=JSON.stringify({action,body});const chunks=[];
    const req={url:'/storelex/api',method:'POST',headers:{'x-telegram-init-data':sign('token:ABC',user)},async *[Symbol.asyncIterator](){yield Buffer.from(raw);}};
    const res={writeHead(code){this.status=code;},end(data){this.body=JSON.parse(data);}};
    await service.handle(req,res);return res;
  }
  try{
    assert.equal((await request(999,'sessions')).status,403);
    assert.equal((await request(12345,'sendOtp')).status,403);
    assert.equal((await request(12345,'ordersRecent')).status,403);
    assert.equal((await request(12345,'selectAccount',{mobile:'9876543210'})).status,200);
    const addresses=await request(12345,'addresses');
    assert.equal(addresses.body.addresses.length,1);
    assert.equal((await request(12345,'orders',{mobile:'9123456789'})).body.mobile,'9876543210');
    balance=0;
    assert.equal((await request(12345,'addAddress',{house:'abc'})).status,409);
    balance=5;maintenance=true;
    assert.equal((await request(12345,'addAddress',{house:'abc'})).status,503);
    maintenance=false;expired=true;
    assert.equal((await request(12345,'addAddress',{house:'abc'})).status,409);
    expired=false;
    assert.equal((await request(12345,'addAddress',{mobile:'9123456789'})).status,200);
    assert.ok(calls.includes('add:9876543210'));
  }finally{scratch.close();await fs.rm(dir,{recursive:true,force:true});}
});
