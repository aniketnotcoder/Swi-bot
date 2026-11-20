const tg = window.Telegram?.WebApp;
tg?.ready(); tg?.expand();
const main = document.querySelector('#main');
const notice = document.querySelector('#notice');
const nav = document.querySelector('#nav');
const chip = document.querySelector('#accountChip');
const state = { tab:'accounts', scratch:null, sessions:[], addresses:[], restaurant:null, items:[], cart:null, bill:null, result:null, polling:false };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const price = paise => Number.isFinite(Number(paise)) ? `₹${(Number(paise)/100).toFixed(2)}` : '—';
const label = (name, input) => `<label>${esc(name)}</label>${input}`;
const field = (name, id, type='text', placeholder='') => label(name, `<input id="${id}" type="${type}" placeholder="${esc(placeholder)}">`);
const value = id => document.getElementById(id)?.value?.trim() || '';
const card = (title, content) => `<section class="card"><h2>${esc(title)}</h2>${content}</section>`;
const button = (label, action, extra='') => `<button data-action="${action}" ${extra}>${esc(label)}</button>`;
const flash = (message, bad=false) => { notice.textContent = message; notice.className = bad?'error':''; setTimeout(()=>{ if(notice.textContent===message) notice.textContent=''; },6500); };
async function api(action, body={}) {
  if (!tg?.initData) throw new Error('Open this Mini App inside Telegram.');
  const response = await fetch('/storelex/api',{method:'POST',headers:{'Content-Type':'application/json','x-telegram-init-data':tg.initData},body:JSON.stringify({action,body})});
  const data = await response.json();
  if(!response.ok || data?.error) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}
async function run(job){ try { await job(); }catch(e){flash(e.message,true);} }
function setTab(tab){ state.tab=tab; for(const node of nav.querySelectorAll('button'))node.classList.toggle('active',node.dataset.tab===tab); render(); }
async function refreshState(){ const result=await api('state'); state.scratch=result.state; chip.textContent=state.scratch.mobile?`ID ••••${state.scratch.mobile.slice(-4)}`:'No account'; }
const requireAccount=()=>state.scratch?.mobile ? '' : card('Select an account','Go to Accounts and pick a saved session first.');
function render(){
  if (!state.scratch) return;
  if (state.tab==='accounts') return renderAccounts();
  if (!state.scratch.mobile) {main.innerHTML=requireAccount();return;}
  if (state.tab==='addresses') return renderAddresses();
  if (state.tab==='explore') return renderExplore();
  if (state.tab==='cart') return renderCart();
  if (state.tab==='checkout') return renderCheckout();
  if (state.tab==='orders') return renderOrders();
}
function renderAccounts(){
  main.innerHTML=card('Saved accounts',button('Refresh sessions','sessions')+`<div class="list">${state.sessions.map(s=>`<div class="item ${state.scratch.mobile===s.mobile?'selected':''}"><strong>${esc(s.name||'Swiggy ID')}</strong><p class="muted">••••${esc(String(s.mobile||'').slice(-4))} · ${esc(s.is_expired?'Expired':s.status||'Active')} · ${esc(s.orders_count??0)} orders</p>${button('Select','select',`data-mobile="${esc(s.mobile)}"`)} ${button('Free cash','freecash',`class="secondary" data-mobile="${esc(s.mobile)}"`)} ${button('Export','export',`class="secondary" data-mobile="${esc(s.mobile)}"`)} ${s.key_login?button('Login key','loginkey',`class="secondary" data-mobile="${esc(s.mobile)}"`):''}</div>`).join('')}</div>`)+card('Account controls',`<p class="muted">Removing all saved accounts affects your Storelex key. Swiggy accounts themselves are not deleted.</p>${button('Remove all accounts','removeall','class="danger"')}`);
}
function renderAddresses(){
  main.innerHTML=card('Selected account addresses',button('Refresh addresses','addresses')+`<div class="list">${state.addresses.map(a=>`<div class="item ${String(state.scratch.address_id)===String(a.id)?'selected':''}"><strong>${esc(a.annotation||a.name||'Address')}</strong><p>${esc(a.formatted_address||a.house||a.area||'')}</p><small>${esc(a.receiver_mobile||'')}</small><div class="row">${button('Deliver here','addressSelect',`data-id="${esc(a.id)}"`)}${button('Sync to account','addressSync',`class="secondary" data-id="${esc(a.id)}"`)}${button('Delete','addressDelete',`class="danger" data-id="${esc(a.id)}" data-global="${a.is_global===true}"`)}</div></div>`).join('')}</div>`)+card('Add by Swiggy link',field('Address share link','addressLink','url','https://swiggy.onelink.me/...')+button('Add link','addressLinkAdd'))+card('Add manual address',field('House / flat','house')+field('Area','area')+field('Name','receiver')+field('Receiver mobile','receiverMobile','tel')+`<div class="grid">${field('Latitude','lat','number')}${field('Longitude','lng','number')}</div>`+field('Formatted address','formatted')+button('Save address','addressAdd'))+card('Location tools',field('Search place','placeSearch')+button('Search','locationSearch')+field('Place ID','placeId')+button('Details','locationDetails','class="secondary"')+button('Reverse selected coordinates','locationReverse','class="secondary"'));
}
function renderExplore(){
  main.innerHTML=card('Find restaurants',field('Restaurant','restaurantQuery','search','Search food or restaurants')+button('Search restaurants','restaurants'))+`<div id="results"></div>`+(state.restaurant?card(state.restaurant.name||'Menu',`<p class="muted">${esc(state.restaurant.area||'')}</p>${field('Search this menu','menuQuery','search')}${button('Search items','menuSearch','class="secondary"')}${button('Other outlets','outlets','class="secondary"')}<div id="menuItems"></div>`):'');
  if(state.restaurant && state.menuItems) paintItems(state.menuItems);
}
function paintItems(items){ const target=document.querySelector('#menuItems'); if(!target)return; target.innerHTML=`<div class="list">${items.slice(0,100).map((item,i)=>`<div class="item"><strong>${esc(item.name)}</strong> <span class="accent">${price(item.final_price??item.price)}</span><p class="muted">${item.in_stock===false?'Out of stock':`${(item.variant_groups||[]).length} variant groups · ${(item.addon_groups||[]).length} addon groups`}</p>${field('Quantity',`qty${i}`,'number','1')}${(item.variant_groups||[]).length||(item.addon_groups||[]).length?label('Selected variants / addons JSON (from menu)',`<textarea id="choices${i}" placeholder='{"variants":[],"addons":[]}'></textarea>`):''}${button('Add to cart','addItem',`data-index="${i}" ${item.in_stock===false?'disabled':''}`)}</div>`).join('')}</div>`; }
function renderCart(){
  main.innerHTML=card('Current cart',`<p class="muted">${state.restaurant?esc(state.restaurant.name):'Pick a restaurant in Explore.'} · ${state.scratch.address_id?'Address selected':'Select an address first'}</p><div class="list">${state.items.map((item,i)=>`<div class="item">${esc(item.name)} × ${esc(item.quantity)} · ${price(item.price)} ${button('Remove','removeItem',`class="secondary" data-index="${i}"`)}</div>`).join('')}</div>${button('Refresh live bill','reprice')}${button('Save cart backup','saveCart','class="secondary"')}${button('Load cart backup','loadCart','class="secondary"')}`)+card('Import group cart',field('Swiggy group cart link','groupLink','url')+button('Import & reprice','importGroup'))+(state.cart?card('Storelex bill',`<div class="list">${(state.cart.bill_lines||[]).map(l=>`<div class="item">${esc(l.label)}: ${esc(l.value)}</div>`).join('')}</div><p class="big accent">${esc(state.bill??'Reprice to verify total')}</p>${button('Checkout','goCheckout')}`):'');
}
function renderCheckout(){
  main.innerHTML=card('Checkout',`<p class="muted">${state.scratch.address_id?'Address selected':'Select address first'} · Cart ${esc(state.scratch.cart_id||'not repriced')}</p><p class="big accent">${esc(state.bill??'Confirm your fresh bill')}</p>${button('Coupons','coupons','class="secondary"')}${button('Best coupon','bestCoupon','class="secondary"')}${field('Coupon code','couponCode')}${button('Apply','applyCoupon')}${button('Remove','removeCoupon','class="secondary"')}${button('Payment options','paymentOptions','class="secondary"')}${button('Swiggy One status','oneStatus','class="secondary"')}<div id="couponResults"></div><hr><label>Payment method</label><select id="method"><option value="upi">UPI</option><option value="cod">Cash on delivery</option><option value="card">Card</option></select><div id="cardFields"></div><label><input type="checkbox" id="confirmAmount" style="width:auto"> I checked the fresh bill and confirm the amount</label>${button('Place with confirmed amount','place')}`)+(state.result?card('Payment & tracking',`<pre class="muted" style="white-space:pre-wrap">${esc(JSON.stringify(state.result,null,2))}</pre>${button('Open UPI app','openUpi','class="secondary"')}${button('Check payment','paymentStatus')}${button('Check tracking','orderStatus','class="secondary"')}${button('Send payment log','paylog','class="secondary"')}`):'');
  document.querySelector('#method')?.addEventListener('change',showCardFields);showCardFields();
}
function showCardFields(){const target=document.querySelector('#cardFields');if(!target)return;target.innerHTML=value('method')==='card'?`${field('Card number','cardNumber')}${field('Name','cardName')}${field('Expiry','cardExpiry')}${field('CVV','cardCvv','password')}`:'';}
function renderOrders(){main.innerHTML=card('Orders for selected account',button('Load orders','orders')+`<div id="orderList"></div>`);}
function showResult(id,content){const node=document.querySelector(id);if(node)node.innerHTML=content;}
async function loadSessions(){ const result=await api('sessions');state.sessions=result.sessions||[];render(); }
async function loadAddresses(){const result=await api('addresses');state.addresses=result.addresses||[];render();}
async function reprice(){
  if(!state.restaurant||!state.items.length)throw new Error('Add items first');
  const result=await api('repriceCart',{restaurant:state.restaurant,items:state.items});
  if(result.amount_changed){state.bill=null;flash(`Amount changed: ${result.new_amount}. Review and re-confirm.`,true);}
  state.cart=result;state.bill=finalTotal(result.bill_lines);await refreshState();render();
}
function finalTotal(lines){ const matching=(lines||[]).filter(l=>/^(to pay|grand total|total payable)$/i.test(String(l.label||'').trim()));return matching.length===1?`₹${String(matching[0].value||'').replace(/^₹\s*/,'')}`:null;}
async function payPoll(){
  if(state.polling)return;state.polling=true;
  const started=Date.now();let check=0;
  while(state.polling&&Date.now()-started<20*60*1000){
    const wait=check<36?5000:check<60?10000:20000;
    await new Promise(resolve=>setTimeout(resolve,wait));
    if(!state.polling)break;
    try{
      const status=await api('paymentStatus',{method:state.result?.method||'upi',deep:++check%4===0});
      if(status.paid===true&&!status.failed&&!status.unknown&&!status.inconclusive){
        const confirmed=await api('confirmPayment',{method:state.result?.method||'upi'});
        if(confirmed.confirmed===true){state.polling=false;state.result={...state.result,paid:true,confirmed:true,tracking:await api('orderStatus')};render();flash('Payment and order confirmed by Storelex.');break;}
      }
      if(status.failed||status.order_failed){state.polling=false;flash('Storelex reports payment/order failure.',true);break;}
    }catch(e){flash(e.message,true);}
  }
  state.polling=false;
}
nav.addEventListener('click',e=>{const tab=e.target.closest('[data-tab]')?.dataset.tab;if(tab)setTab(tab);});
main.addEventListener('click',event=>run(async()=>{
  const button=event.target.closest('[data-action]');if(!button)return;
  const action=button.dataset.action;
  if(action==='sessions')return loadSessions();
  if(action==='select'){await api('selectAccount',{mobile:button.dataset.mobile});await refreshState();state.items=[];state.cart=null;state.restaurant=null;setTab('addresses');return loadAddresses();}
  if(action==='freecash'||action==='export'||action==='loginkey'){
    if(state.scratch.mobile!==button.dataset.mobile)throw new Error('Select this account first');
    const result=await api({freecash:'checkFreeCash',export:'exportAccount',loginkey:'accountLoginKey'}[action]);
    if(action==='export'){const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='storelex-account.json';link.click();URL.revokeObjectURL(link.href);}
    else flash(action==='loginkey'?`Login key: ${result.login_key||'unavailable'}`:`Free cash: ${JSON.stringify(result.fc||result)}`);
    return;
  }
  if(action==='removeall'){if(!window.confirm('Remove ALL saved accounts from Storelex?'))return;await api('removeAllAccounts',{confirm:'REMOVE ALL'});await refreshState();return loadSessions();}
  if(action==='addresses')return loadAddresses();
  if(action==='addressSelect'){await api('selectAddress',{address_id:button.dataset.id});await refreshState();return render();}
  if(action==='addressSync'){const selected=state.addresses.find(a=>String(a.id)===button.dataset.id);if(!selected)throw new Error('Address not selected');await api('addAddressToAccount',{address:selected});return loadAddresses();}
  if(action==='addressDelete'){if(!window.confirm('Delete this address?'))return;await api('deleteAddress',{address_id:button.dataset.id,is_global:button.dataset.global==='true'});return loadAddresses();}
  if(action==='addressLinkAdd'){await api('addAddressByLink',{link:value('addressLink')});return loadAddresses();}
  if(action==='addressAdd'){await api('addAddress',{house:value('house'),area:value('area'),name:value('receiver'),receiver_mobile:value('receiverMobile'),lat:Number(value('lat')),lng:Number(value('lng')),formatted_address:value('formatted')});return loadAddresses();}
  if(action==='locationSearch'){const result=await api('locationSearch',{query:value('placeSearch')});flash(JSON.stringify(result).slice(0,300));return;}
  if(action==='locationDetails'){const result=await api('locationDetails',{place_id:value('placeId')});flash(JSON.stringify(result).slice(0,300));return;}
  if(action==='locationReverse'){const result=await api('locationReverse',{lat:state.scratch.lat,lng:state.scratch.lng});flash(JSON.stringify(result).slice(0,300));return;}
  if(action==='restaurants'){const result=await api('searchRestaurants',{q:value('restaurantQuery')});showResult('#results',`<div class="list">${(result.restaurants||[]).map((r,i)=>`<div class="item"><strong>${esc(r.name)}</strong><p class="muted">${esc(r.area)} · ${esc(r.rating||'')}</p>${button('Open menu','openMenu',`data-index="${i}"`)}</div>`).join('')}</div>`);state.restaurants=result.restaurants||[];return;}
  if(action==='openMenu'){state.restaurant=state.restaurants[Number(button.dataset.index)];const result=await api('searchMenu',{restaurant_id:state.restaurant.id,metadata:state.restaurant.metadata});state.menuItems=(result.categories||[]).flatMap(c=>c.items||[]);return render();}
  if(action==='menuSearch'){const result=await api('searchMenuItems',{restaurant_id:state.restaurant.id,query:value('menuQuery')});state.menuItems=result.items||(result.categories||[]).flatMap(c=>c.items||[]);return paintItems(state.menuItems);}
  if(action==='outlets'){const result=await api('searchOutlets',{restaurant_id:state.restaurant.id});return flash(`${(result.outlets||[]).length} outlets returned`);}
  if(action==='addItem'){
    const i=Number(button.dataset.index),item=state.menuItems[i],qty=Number(value(`qty${i}`)||1);if(!Number.isSafeInteger(qty)||qty<1)throw new Error('Invalid quantity');
    let choices={variants:[],addons:[]};if(value(`choices${i}`))choices=JSON.parse(value(`choices${i}`));
    state.items.push({id:item.id,name:item.name,image_id:item.image_id,price:item.price,base_price:item.price,quantity:qty,addons:choices.addons||[],variants:choices.variants||[],cart_context:item.cart_context,offer_ids:item.offer_ids||[],nudge_type:item.nudge_type});
    await reprice();return setTab('cart');
  }
  if(action==='removeItem'){state.items.splice(Number(button.dataset.index),1);if(state.items.length)await reprice();else{try{await api('repriceCart',{restaurant:state.restaurant,items:[]});}catch{}state.cart=null;state.bill=null;render();}return;}
  if(action==='reprice')return reprice();
  if(action==='saveCart'){await api('setCartState',{cart:{restaurant:state.restaurant,lines:state.items,loc:{lat:state.scratch.lat,lng:state.scratch.lng}},loc:{lat:state.scratch.lat,lng:state.scratch.lng}});flash('Cart backup saved');return;}
  if(action==='loadCart'){const saved=await api('getCartState');if(!saved.cart?.restaurant||!Array.isArray(saved.cart.lines))throw new Error('No selected-account cart backup');state.restaurant=saved.cart.restaurant;state.items=saved.cart.lines;await reprice();return;}
  if(action==='importGroup'){const result=await api('importGroupCart',{link:value('groupLink')});if(!result.success)throw new Error(result.message||'Import failed');state.restaurant=result.restaurant;state.items=result.items||[];await reprice();return;}
  if(action==='goCheckout')return setTab('checkout');
  if(['coupons','bestCoupon','applyCoupon','removeCoupon','paymentOptions','oneStatus'].includes(action)){
    const result=await api(action,{code:value('couponCode')});
    if(['bestCoupon','applyCoupon','removeCoupon'].includes(action))await reprice();
    if(action==='coupons')showResult('#couponResults',`<div class="list">${(result.coupons||[]).map(c=>`<div class="item">${esc(c.code)} · ${esc(c.title||'')} · ${c.applicable?'Applicable':'Not applicable'}</div>`).join('')}</div>`);
    else if(action!=='bestCoupon'&&action!=='applyCoupon'&&action!=='removeCoupon')flash(JSON.stringify(result).slice(0,250));
    return;
  }
  if(action==='place'){
    if(!document.querySelector('#confirmAmount')?.checked)throw new Error('Confirm the fresh amount first');
    if(!state.bill)throw new Error('Reprice before payment');
    const method=value('method');let cardData;
    if(method==='card')cardData={number:value('cardNumber'),name:value('cardName'),expiry:value('cardExpiry'),cvv:value('cardCvv')};
    const result=await api('placeOrder',{amount:Number(state.bill.replace('₹','')),method,card:cardData,address:state.addresses.find(a=>String(a.id)===String(state.scratch.address_id))});
    if(result.requires_reconfirm){state.bill=null;flash(`Amount changed: ${result.new_amount}. Refresh bill and reconfirm.`,true);return setTab('cart');}
    if(result.requires_reconcile)throw new Error('Placement unconfirmed. Check Storelex orders; do not retry blindly.');
    state.result=result;render();
    if(result.upi_url)flash('UPI payment request ready; order is NOT confirmed.');
    if(method==='upi'||method==='card')void payPoll();
    if(method==='cod')run(async()=>{const status=await api('orderStatus');state.result={...state.result,tracking:status};render();});
    return;
  }
  if(action==='paylog'){await api('paylog',{events:[{ev:'miniapp_payment_view',at:new Date().toISOString(),order_id:state.result?.order_id,method:state.result?.method,amount:Number((state.bill||'').replace('₹',''))}]});flash('Payment telemetry sent');return;}
  if(action==='openUpi'){const url=state.result?.upi_url;if(!url?.startsWith('upi://pay?'))throw new Error('No provider UPI link');window.location.href=url;return;}
  if(action==='paymentStatus'){const status=await api('paymentStatus',{method:state.result?.method||'upi'});flash(status.paid?'Provider says paid; confirming…':JSON.stringify(status).slice(0,180));return;}
  if(action==='orderStatus'){const status=await api('orderStatus');state.result={...state.result,tracking:status};render();return;}
  if(action==='orders'){const result=await api('orders');showResult('#orderList',`<div class="list">${(result.orders||[]).map(o=>`<div class="item"><strong>${esc(o.restaurant_name||o.order_id)}</strong><p class="muted">${esc(o.order_status||'')} · ${esc(o.order_total||'')}</p>${button('Details','orderDetail',`data-id="${esc(o.order_id)}"`)} ${button('Rate 5 stars','rateOrder',`class="secondary" data-id="${esc(o.order_id)}"`)}</div>`).join('')}</div>`);return;}
  if(action==='orderDetail'){const result=await api('orderDetail',{order_id:button.dataset.id});showResult('#orderList',card('Order detail',`<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(result,null,2))}</pre>`));return;}
  if(action==='rateOrder'){if(!window.confirm('Rate restaurant and delivery partner 5 stars?'))return;await api('rateOrder',{order_id:button.dataset.id});flash('Rating sent');return;}
}));
run(async()=>{await refreshState();await loadSessions();});
