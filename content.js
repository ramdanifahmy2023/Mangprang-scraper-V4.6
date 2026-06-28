(function(){
  const script=document.createElement('script');
  script.src=chrome.runtime.getURL('injected.js');
  script.onload=()=>script.remove();
  (document.head||document.documentElement).appendChild(script);

  const selectedLinks=new Set();
  let cachedApiPayload=null;
  let apiSaveInFlight=false;
  let lastLocationHref=location.href;
  let lastBatch=null;

  function isDetail(){return /-i\.\d+\.\d+|\/product\/\d+\/\d+/.test(location.href)&&!location.href.includes('/search')}
  function isBackgroundScrape(){return new URLSearchParams(location.search).get('mangprang_bg')==='1'}
  function idsFromUrl(url=location.href){const s=String(url); const m=s.match(/-i\.(\d+)\.(\d+)/)||s.match(/\/product\/(\d+)\/(\d+)/)||s.match(/[?&]shopid=(\d+).*?[?&]itemid=(\d+)/); return {shopId:m?.[1]||'',itemId:m?.[2]||''}}
  function productHost(url=location.href){try{const h=new URL(url, location.href).hostname; return /shopee\.com\.my$/i.test(h)?'shopee.com.my':'shopee.co.id'}catch(_){return 'shopee.co.id'}}
  function canonicalProductUrl(ids,url=location.href){return ids.shopId&&ids.itemId?`https://${productHost(url)}/product/${ids.shopId}/${ids.itemId}`:String(url).split('?')[0]}
  function normalizeProductUrl(url){const ids=idsFromUrl(url); return canonicalProductUrl(ids,url)}
  function isProductUrl(url){return /-i\.\d+\.\d+|\/product\/\d+\/\d+/.test(String(url||''))}
  function productAnchors(){
    const seen=new Set();
    return Array.from(document.querySelectorAll('a[href]')).map(a=>{
      const href=a.href||'';
      if(!isProductUrl(href))return null;
      const url=normalizeProductUrl(href);
      if(!url||seen.has(url))return null;
      seen.add(url);
      return {a,url};
    }).filter(Boolean).slice(0,120);
  }
  function productLinks(){return productAnchors().map(x=>x.url).slice(0,80)}
  function balancedJsonFrom(text,start){
    const open=text.indexOf('{',start); if(open<0)return'';
    let depth=0, str='', esc=false;
    for(let i=open;i<text.length;i++){
      const ch=text[i];
      if(str){ if(esc)esc=false; else if(ch==='\\')esc=true; else if(ch===str)str=''; continue; }
      if(ch==='"'||ch==="'"){str=ch; continue;}
      if(ch==='{')depth++;
      else if(ch==='}'&&--depth===0)return text.slice(open,i+1);
    }
    return'';
  }
  function parseInitialStatePayload(){
    const scripts=Array.from(document.scripts).map(x=>x.textContent||'').filter(Boolean);
    for(const text of scripts){
      const idx=text.indexOf('window.__INITIAL_STATE__');
      if(idx>=0){try{return {payload:JSON.parse(balancedJsonFrom(text,idx)),source:'initial_state'};}catch(_){}}
    }
    for(const script of document.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__')){
      try{const json=JSON.parse(script.textContent||'{}'); const raw=JSON.stringify(json).toLowerCase(); if(/shopid|shop_id/.test(raw)&&/itemid|item_id/.test(raw)&&/weight|berat/.test(raw))return {payload:json,source:'script_json'};}catch(_){}
    }
    for(const text of scripts){
      if(!/shopid|shop_id|itemid|item_id|weight|berat/i.test(text))continue;
      const json=balancedJsonFrom(text,0); if(!json)continue;
      try{return {payload:JSON.parse(json),source:'script_json_loose'};}catch(_){}
    }
    return null;
  }
  function domFallback(){
    const ids=idsFromUrl();
    const text=document.body?.innerText?.slice(0,4000)||'';
    const title=document.querySelector('h1, [data-testid="pdp-product-title"]')?.textContent||document.title;
    const isCaptcha=/captcha|verification|verify|robot|unusual traffic|security check|challenge|akses ditolak|aktivitas mencurigakan|verifikasi/i.test(`${title} ${text}`);
    return {shopId:ids.shopId,itemId:ids.itemId,productUrl:canonicalProductUrl(ids),title,description:text,isCaptcha,initialStatePayload:parseInitialStatePayload(),images:Array.from(document.images).map(i=>i.src).filter(s=>/susercontent|shopee/.test(s)).slice(0,9)}
  }
  function toast(t,ok=true){
    if(!document.body)return;
    let el=document.getElementById('mangprang-toast');
    if(!el){
      el=document.createElement('div');
      el.id='mangprang-toast';
      Object.assign(el.style,{position:'fixed',left:'50%',bottom:'60px',transform:'translateX(-50%)',zIndex:2147483647,background:'#0b1220',color:'#e5e7eb',border:'1px solid #22c55e',borderRadius:'12px',padding:'8px 10px',font:'12px ui-monospace,monospace',boxShadow:'0 12px 30px rgba(0,0,0,.25)'});
      document.body.appendChild(el);
    }
    el.textContent=t;
    el.style.borderColor=ok?'#22c55e':'#ef4444';
    clearTimeout(el.__mprTimer);
    el.__mprTimer=setTimeout(()=>el.remove(),3000);
  }
  function saveApiPayload(data,mode='background'){
    if(apiSaveInFlight)return;
    apiSaveInFlight=true;
    chrome.runtime.sendMessage({type:'SHOPEE_API_PAYLOAD',data},r=>{
      apiSaveInFlight=false;
      if(mode!=='background')toast(r?.ok?'Produk masuk antrean ✓':`Gagal simpan: ${r?.error||'unknown'}`,!!r?.ok);
    });
  }
  function uniqueLinks(links){return Array.from(new Set((links||[]).map(normalizeProductUrl).filter(Boolean))).filter(isProductUrl)}
  function startBatch(links,label='Batch'){
    const clean=uniqueLinks(links);
    if(!clean.length){toast('Tidak ada produk dipilih/terdeteksi',false);return;}
    chrome.runtime.sendMessage({type:'GET_STATE'},state=>{
      const cfg=state?.cfg||{};
      if(!cfg.groupId){toast('Pilih Target Group dulu di popup extension.',false);return;}
      chrome.runtime.sendMessage({type:'START_BATCH',links:clean},r=>toast(r?.ok?`${label}: ${r?.count||clean.length} produk dimulai · Group: ${cfg.groupName||cfg.groupId}`:`Gagal mulai: ${r?.error||'cek extension'}`,!!r?.ok));
    });
  }
  function selectVisible(limit=0){
    const links=productLinks().slice(0,limit||80);
    links.forEach(l=>selectedLinks.add(l));
    decorateProductCards(); updateToolbar();
    toast(`${links.length} produk dipilih`);
  }
  function clearSelection(silent=false){selectedLinks.clear(); decorateProductCards(); updateToolbar(); if(!silent)toast('Pilihan dibersihkan')}
  function button(txt,fn,variant='green'){
    const b=document.createElement('button');
    b.textContent=txt;
    Object.assign(b.style,{border:0,borderRadius:'10px',padding:'8px 10px',font:'800 12px system-ui',cursor:'pointer',background:variant==='gray'?'#334155':'#22c55e',color:variant==='gray'?'#e5e7eb':'#052e16',whiteSpace:'nowrap'});
    b.onclick=e=>{e.preventDefault();e.stopPropagation();fn();};
    return b;
  }
  function ensureToolbar(){
    if(!document.body)return null;
    let box=document.getElementById('mangprang-float');
    if(!box){
      box=document.createElement('div');
      box.id='mangprang-float';
      Object.assign(box.style,{position:'fixed',left:'50%',bottom:'10px',transform:'translateX(-50%)',zIndex:2147483647,display:'flex',gap:'6px',alignItems:'center',justifyContent:'center',flexWrap:'nowrap',maxWidth:'calc(100vw - 24px)',background:'rgba(11,18,32,.94)',border:'1px solid rgba(34,197,94,.55)',borderRadius:'14px',padding:'7px 9px',boxShadow:'0 14px 34px rgba(0,0,0,.28)',backdropFilter:'blur(10px)',overflowX:'auto',whiteSpace:'nowrap'});
      document.body.appendChild(box);
    }
    return box;
  }
  function updateToolbar(){
    const box=ensureToolbar(); if(!box)return;
    box.innerHTML='';
    if(isDetail()){
      const label=document.createElement('span');
      label.textContent='Mangprang · detail produk';
      Object.assign(label.style,{color:'#facc15',font:'800 12px ui-monospace,monospace',padding:'0 4px'});
      const note=document.createElement('span');
      note.textContent='Scrape produk langsung dinonaktifkan. Gunakan halaman search/list.';
      Object.assign(note.style,{color:'#e5e7eb',font:'700 12px system-ui',padding:'0 4px'});
      box.append(label,note,button('Dashboard',()=>chrome.runtime.sendMessage({type:'OPEN_DASHBOARD'},r=>toast(r?.ok?'Dashboard dibuka':'Gagal buka dashboard',!!r?.ok)),'gray'));
      return;
    }
    const visible=productLinks().length;
    const count=selectedLinks.size;
    const label=document.createElement('span');
    const batchText=lastBatch?.total?` · ${lastBatch.running?'jalan':'selesai'} ${lastBatch.current}/${lastBatch.total} · OK ${lastBatch.success||0} · gagal ${lastBatch.failed||0}${lastBatch.captcha?` · captcha ${lastBatch.captcha}`:''}`:'';
    label.textContent=`${count} dipilih · ${visible} terlihat${batchText}`;
    Object.assign(label.style,{color:'#bbf7d0',font:'800 12px ui-monospace,monospace',padding:'0 4px'});
    box.append(
      label,
      button('Select visible',()=>selectVisible(0),'gray'),
      button('Clear',clearSelection,'gray'),
      button('Scrape selected',()=>startBatch(Array.from(selectedLinks),'Selected')),
      button('Scrape 20',()=>startBatch(productLinks().slice(0,20),'Batch 20')),
      button('Scrape 50',()=>startBatch(productLinks().slice(0,50),'Batch 50'))
    );
  }
  function decorateProductCards(){
    if(!document.body||isDetail())return;
    const anchors=productAnchors();
    anchors.forEach(({a,url})=>{
      a.dataset.mprProductUrl=url;
      if(getComputedStyle(a).position==='static')a.style.position='relative';
      let badge=a.querySelector(':scope > .mangprang-select-badge');
      if(!badge){
        badge=document.createElement('label');
        badge.className='mangprang-select-badge';
        Object.assign(badge.style,{position:'absolute',top:'8px',left:'8px',zIndex:2147483647,display:'flex',alignItems:'center',gap:'5px',padding:'5px 8px',borderRadius:'999px',background:'rgba(2,6,23,.86)',color:'#e5e7eb',border:'1px solid rgba(34,197,94,.8)',font:'800 11px system-ui',boxShadow:'0 8px 20px rgba(0,0,0,.25)',cursor:'pointer'});
        badge.innerHTML='<input type="checkbox" style="margin:0;accent-color:#22c55e;pointer-events:none"><span>Pilih</span>';
        ['mousedown','mouseup'].forEach(ev=>badge.addEventListener(ev,e=>{e.preventDefault();e.stopPropagation();}));
        badge.addEventListener('click',e=>{
          e.preventDefault(); e.stopPropagation();
          const input=badge.querySelector('input');
          const checked=!selectedLinks.has(url);
          input.checked=checked;
          if(checked)selectedLinks.add(url); else selectedLinks.delete(url);
          updateCardBadge(badge,url); updateToolbar();
        });
        a.appendChild(badge);
      }
      updateCardBadge(badge,url);
    });
  }
  function updateCardBadge(badge,url){
    const input=badge.querySelector('input');
    const span=badge.querySelector('span');
    const checked=selectedLinks.has(url);
    input.checked=checked;
    span.textContent=checked?'Dipilih':'Pilih';
    badge.style.background=checked?'rgba(22,101,52,.94)':'rgba(2,6,23,.86)';
    badge.style.borderColor=checked?'#86efac':'rgba(34,197,94,.8)';
  }
  function syncSelectionWithPage(){
    const valid=new Set(productLinks());
    for(const url of Array.from(selectedLinks)) if(!valid.has(url)) selectedLinks.delete(url);
  }
  function handleLocationChange(){
    if(location.href===lastLocationHref)return;
    lastLocationHref=location.href;
    clearSelection(true);
    cachedApiPayload=null;
  }
  function refreshBatch(){chrome.runtime.sendMessage({type:'GET_STATE'},r=>{lastBatch=r?.batch||null; updateToolbar();});}
  function tick(){
    if(!document.body)return;
    handleLocationChange();
    syncSelectionWithPage();
    decorateProductCards();
    updateToolbar();
  }

  window.addEventListener('message',e=>{
    if(e.source!==window)return;
    if(e.data?.source==='MANGPRANG_SCRAPER'&&e.data?.type==='SHOPEE_API_PAYLOAD'){
      cachedApiPayload=e.data;
      if(isBackgroundScrape()){saveApiPayload(e.data,'background');return;}
      // Search/list-only mode: foreground product-detail saves are disabled.
    }
  });
  chrome.runtime.onMessage.addListener((m,s,send)=>{if(m.type==='PAGE_INFO')send({isDetail:isDetail(),links:productLinks().length,selected:selectedLinks.size,url:location.href,backgroundScrape:isBackgroundScrape()}); if(m.type==='DOM_FALLBACK')send(domFallback()); if(m.type==='MPR_DETAIL_SCRAPE_DISABLED')toast('Scrape detail produk dimatikan. Pakai halaman search/list.',false); return true});
  document.addEventListener('DOMContentLoaded',tick);
  setInterval(tick,1500);
  setInterval(refreshBatch,2000);
  refreshBatch();
  tick();
})();
