(function(){
if(window.__mangprangInjected)return; window.__mangprangInjected=true;
let lastPayload=null;
const hit=url=>/api\/(v2|v4)\/item\/get|api\/v4\/pdp\/get_pc|api\/v4\/pdp\/get_rw|api\/v4\/pdp\//.test(String(url));
const post=(payload,sourceEndpoint='')=>{lastPayload={payload,source_endpoint:sourceEndpoint}; window.postMessage({source:'MANGPRANG_SCRAPER',type:'SHOPEE_API_PAYLOAD',payload,pageUrl:location.href,source_endpoint:sourceEndpoint},'*')};
const tryJson=res=>res.clone().json().then(post).catch(()=>{});
const ofetch=window.fetch;
window.fetch=async function(...args){const res=await ofetch.apply(this,args); const url=args[0] instanceof Request?args[0].url:args[0]; if(hit(url))res.clone().json().then(j=>post(j,String(url))).catch(()=>{}); return res};
const open=XMLHttpRequest.prototype.open, send=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,u,...r){this.__mprUrl=u; return open.call(this,m,u,...r)};
XMLHttpRequest.prototype.send=function(...a){this.addEventListener('load',function(){if(hit(this.__mprUrl)){try{post(JSON.parse(this.responseText),String(this.__mprUrl||''))}catch(e){}}}); return send.apply(this,a)};
window.addEventListener('message',e=>{
  if(e.source!==window || e.data?.source!=='MANGPRANG_SCRAPER_CONTENT')return;
  if(e.data?.type==='MPR_REQUEST_LAST_PAYLOAD'){
    if(lastPayload) window.postMessage({source:'MANGPRANG_SCRAPER',type:'SHOPEE_API_PAYLOAD',payload:lastPayload.payload,source_endpoint:lastPayload.source_endpoint,pageUrl:location.href,requestId:e.data.requestId||''},'*');
    else { window.scrollBy(0,100); setTimeout(()=>window.scrollBy(0,-100),700); }
  }
});
})();
