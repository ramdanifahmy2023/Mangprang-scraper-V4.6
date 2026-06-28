(function(root){
const s=v=>(v==null?'':String(v)).trim();
const hasNum=v=>v!==undefined&&v!==null&&v!==''&&Number.isFinite(Number(v));
const n=v=>hasNum(v)?Math.round(Number(v)):0;
const kgFromGrams=v=>Math.max(0,Number((Math.max(0,n(v)||2000)/1000).toFixed(3)));
const price=v=>{const x=n(v); return x>999999 ? Math.round(x/100000) : x};
const uniq=a=>Array.from(new Set((a||[]).map(s).filter(Boolean)));
function cleanText(t){return s(t).replace(/shopee/gi,'').replace(/tokopedia|lazada|bukalapak|blibli/gi,'').replace(/gratis\s*ongkir|free\s*ongkir|cashback|voucher|cod/gi,'').replace(/wa\s*[:\-]?\s*\d+|whatsapp\s*[:\-]?\s*\d+/gi,'').replace(/https?:\/\/\S+/g,'').replace(/\s{2,}/g,' ').trim()}
function titleClean(t){return cleanText(t).replace(/[\[\]{}]/g,'').replace(/\s{2,}/g,' ').trim().slice(0,180)}
function imageUrl(v){v=s(v); if(!v)return''; if(/^https?:\/\//.test(v))return v; return `https://down-id.img.susercontent.com/file/${v}`}
function payloadRoot(msg){return msg?.payload||msg||{}}
function productLikeDeep(root){
  const seen=new Set(), queue=[root]; let scanned=0;
  while(queue.length&&scanned<1200){
    const v=queue.shift(); scanned++;
    if(!v||typeof v!=='object'||seen.has(v))continue; seen.add(v);
    const hasIds=v.itemid||v.item_id||v.itemId||v.shopid||v.shop_id||v.shopId;
    const hasProductShape=Array.isArray(v.models)||Array.isArray(v.tier_variations)||Array.isArray(v.tierVariations)||v.title||v.name;
    if(hasIds&&hasProductShape)return v;
    if(Array.isArray(v)){for(let i=0;i<Math.min(v.length,80);i++)queue.push(v[i]);}
    else for(const k of Object.keys(v)) if(v[k]&&typeof v[k]==='object')queue.push(v[k]);
  }
  return null;
}
function dataOf(msg){const p=payloadRoot(msg); return p.data?.item||p.data?.item_info||p.item||p.data?.item_basic||productLikeDeep(p)||p.data||p}
function imagesBlock(msg,data){const p=payloadRoot(msg); return p.data?.product_images||p.product_images||data?.product_images||{}}
function attrsBlock(msg){const p=payloadRoot(msg); return p.data?.product_attributes?.attrs||p.product_attributes?.attrs||p.data?.item?.attributes||p.data?.attributes||dataOf(msg)?.attributes||[]}
function idsOf(data,url){
  const u=s(url); let m=u.match(/-i\.(\d+)\.(\d+)/)||u.match(/\/product\/(\d+)\/(\d+)/)||u.match(/[?&]shopid=(\d+).*?[?&]itemid=(\d+)/);
  return {shop_id:s(data.shopid||data.shop_id||data.shopId||data.shop?.shopid||data.item?.shopid||data.shop_id_str||(m&&m[1])), item_id:s(data.itemid||data.item_id||data.itemId||data.item?.itemid||data.item_id_str||(m&&m[2]))}
}
function productHost(url){try{const h=new URL(s(url)||'https://shopee.co.id').hostname; return /shopee\.com\.my$/i.test(h)?'shopee.com.my':'shopee.co.id'}catch(_){return 'shopee.co.id'}}
function canonicalProductUrl(ids,url){const shop=s(ids?.shop_id), item=s(ids?.item_id); return shop&&item?`https://${productHost(url)}/product/${shop}/${item}`:s(url).split('?')[0]}
function axisName(name){const low=s(name).toLowerCase(); if(/warna|color|colour/.test(low))return'Warna'; if(/size|ukuran|nomor/.test(low))return'Ukuran'; if(/kapasitas|storage|gb|tb|memori/.test(low))return'Kapasitas'; if(/model|tipe|type/.test(low))return'Model'; return s(name)||'Varian'}
function optName(o){return s(typeof o==='string'?o:o?.name||o?.option||o?.value||o?.display_name)}
function parseWeightValue(v,source){
  if(v===undefined||v===null||v==='')return null;
  if(typeof v==='object'){
    const nested=parseWeightValue(v.weight??v.value??v.text??v.name??v.display_value,source);
    if(nested)return nested;
    return null;
  }
  const raw=s(v).toLowerCase();
  const m=raw.match(/[\d.,]+/);
  if(!m)return null;
  const num=parseFloat(m[0].replace(',','.'));
  if(!Number.isFinite(num)||num<=0)return null;
  let grams;
  if(/\bkg\b|kilogram/.test(raw)) grams=Math.round(num*1000);
  else if(/\bgr?\b|gram/.test(raw)) grams=Math.round(num);
  else grams=num<20?Math.round(num*1000):Math.round(num);
  return grams>0?{value:grams,source,confidence:/\bkg\b|kilogram|\bgr?\b|gram/.test(raw)?'unit_explicit':'unit_inferred'}:null;
}
function attrDims(attrs){let weight=0,weight_source='',weight_confidence='',length=0,width=0,height=0,stock=null; (attrs||[]).forEach(a=>{const name=s(a.name||a.attr_name).toLowerCase(); const val=s(a.value||a.value_name||a.text); if(!val)return; if(name.includes('berat')||name.includes('weight')){const parsed=parseWeightValue(val,`product_attributes.${name||'weight'}`); if(parsed){weight=parsed.value; weight_source=parsed.source; weight_confidence=parsed.confidence}} if(name.includes('dimensi')){const nums=val.match(/[\d.,]+/g)||[]; if(nums.length>=3){length=n(nums[0].replace(',','.')); width=n(nums[1].replace(',','.')); height=n(nums[2].replace(',','.'))}} if(name.includes('stok')){const x=parseInt(val.replace(/\D/g,''),10); if(Number.isFinite(x))stock=x;}}); return {weight,weight_source,weight_confidence,length,width,height,stock}}
function getPath(obj,path){let cur=obj; for(const part of path.split('.')){if(cur==null)return undefined; cur=cur[part]} return cur}
function parseBackendWeightValue(v,source){const parsed=parseWeightValue(v,source); return parsed?{...parsed,confidence:typeof v==='number'?'backend_exact':parsed.confidence,unknown:false}:null}
function findWeightDeep(root,sourcePrefix='payload'){
  const seen=new Set(); const queue=[{v:root,path:sourcePrefix,depth:0}]; let scanned=0;
  const goodName=k=>/^(weight|actual_weight|package_weight|item_weight|parcel_weight)$/i.test(k)||/berat/i.test(k);
  while(queue.length&&scanned<1500){
    const {v,path,depth}=queue.shift(); scanned++;
    if(v==null||depth>7)continue;
    if(typeof v==='string'&&/\d/.test(v)&&/\bkg\b|kilogram|\bgr?\b|gram|berat/i.test(v)){const parsed=parseBackendWeightValue(v,path); if(parsed)return parsed;}
    if(typeof v!=='object')continue;
    if(seen.has(v))continue; seen.add(v);
    if(Array.isArray(v)){for(let i=0;i<Math.min(v.length,60);i++)queue.push({v:v[i],path:`${path}[${i}]`,depth:depth+1}); continue;}
    for(const k of Object.keys(v)){
      const val=v[k]; const childPath=`${path}.${k}`;
      if(goodName(k)){const parsed=parseBackendWeightValue(val,childPath); if(parsed)return parsed;}
      if(val&&typeof val==='object')queue.push({v:val,path:childPath,depth:depth+1});
      else if(typeof val==='string'&&/berat|weight/i.test(`${k} ${val}`)){const parsed=parseBackendWeightValue(val,childPath); if(parsed)return parsed;}
    }
  }
  return null;
}
function extractWeightGrams(msg,data,attrs,logi){
  const p=payloadRoot(msg);
  const candidates=[
    ['data.weight',p],['data.item.weight',p],['data.item_info.weight',p],['data.item_basic.weight',p],
    ['item.weight',p],['item_info.weight',p],['item_basic.weight',p],
    ['weight',data],['item.weight',data],['item_info.weight',data],['item_basic.weight',data],
    ['logistics.weight',data],['logistic.weight',data],['shipping.weight',data],
    ['data.logistics.weight',p],['data.logistic.weight',p],['data.shipping.weight',p],
    ['data.item.logistics.weight',p],['data.item.logistic.weight',p],['data.item.shipping.weight',p],
    ['data.item_info.logistics.weight',p],['data.item_info.logistic.weight',p],['data.item_info.shipping.weight',p]
  ];
  for(const [path,obj] of candidates){const val=getPath(obj,path); const parsed=parseBackendWeightValue(val,path); if(parsed)return parsed;}
  const deep=findWeightDeep(p,msg?.source_endpoint||'api_payload');
  if(deep)return deep;
  if(logi?.weight>0)return {value:n(logi.weight),source:logi.weight_source||'product_attributes.Berat',confidence:logi.weight_confidence||'unit_inferred',unknown:false};
  return {value:0,source:'unknown',confidence:'missing',unknown:true};
}
function sourceCategoriesDetailed(data){const all=[...(data.categories||[]),...(data.fe_categories||[])]; const out=[]; const seen=new Set(); all.forEach((c,idx)=>{const id=s(c.catid||c.category_id||c.id); const name=s(c.display_name||c.name||c.category_name); if(!id&&!name)return; const key=`${id}|${name}`; if(seen.has(key))return; seen.add(key); out.push({id,name,level:n(c.level||idx+1),parent_id:s(c.parent_catid||c.parent_id||'')});}); return out}
function categoryNamesArray(data){return sourceCategoriesDetailed(data).map(c=>c.name).filter(Boolean)}
function sourceCategoryPath(data){return sourceCategoriesDetailed(data).map(c=>c.name).filter(Boolean).join(' > ')}
function collectImages(msg,data){const ib=imagesBlock(msg,data); const firstTier=(ib.first_tier_variations||[]).map(x=>x?.image); const tier0=data.tier_variations?.[0]||{}; const tierImgs=[...(tier0.images||[]),...(tier0.options||[]).map(o=>o?.image||o?.image_id)]; const arr=[...(ib.images||[]), data.image, data.image_url, ...(data.images||[]), ...firstTier, ...tierImgs]; return uniq(arr.map(imageUrl)).slice(0,9)}
function normalizeAxes(data){const tierVars=data.tier_variations||data.tierVariations||[]; return tierVars.slice(0,2).map((tv,i)=>({raw:tv,name:axisName(tv.name||tv.title||(i?'Opsi':'Varian')),options:(tv.options||[]).map(optName).filter(Boolean)})).filter(a=>a.options.length)}
function buildVariantImageMap(msg,data,axes){
  const ib=imagesBlock(msg,data); const byName={}, byIndex={}, sources={};
  const put=(key,img,source)=>{img=imageUrl(img); key=s(key); if(!key||!img)return; if(!byName[key]){byName[key]=img; sources['name:'+key]=source}};
  (ib.first_tier_variations||[]).forEach((tv,i)=>{const nm=s(tv?.name); const img=tv?.image; if(img){if(nm)put(nm,img,`product_images.first_tier_variations[${i}]`); byIndex[i]=imageUrl(img); sources['idx:'+i]=`product_images.first_tier_variations[${i}]`;}});
  const tv0=(data.tier_variations||data.tierVariations||[])[0]||{};
  (tv0.images||[]).forEach((img,i)=>{if(img&&!byIndex[i]){byIndex[i]=imageUrl(img); sources['idx:'+i]=`tier_variations[0].images[${i}]`;}});
  (tv0.options||[]).forEach((o,i)=>{const nm=optName(o); const img=o?.image||o?.image_id; if(img){if(nm)put(nm,img,`tier_variations[0].options[${i}].image`); if(!byIndex[i]){byIndex[i]=imageUrl(img); sources['idx:'+i]=`tier_variations[0].options[${i}].image`;}}});
  return {byName,byIndex,sources};
}
function exactNumber(obj,keys){for(const k of keys){const parts=k.split('.'); let cur=obj; for(const p of parts){cur=cur?.[p]} if(hasNum(cur))return {value:n(cur),source:k}} return null}
function stockOf(model,data,logi,hasVariants){
  return {value:90,source:'boss_policy_stock_locked_90',confidence:'locked'};
}
function modelWeightInfo(model,productWeight){
  const paths=['weight','actual_weight','package_weight','item_weight','logistics.weight','logistic.weight','shipping.weight','extinfo.weight','price_stocks.0.weight'];
  for(const path of paths){const parsed=parseBackendWeightValue(getPath(model,path),`models.${path}`); if(parsed)return parsed;}
  const deep=findWeightDeep(model,'models');
  return deep||productWeight;
}
function imageForModel(model,props,idx,imgMap,main){
  const firstVal=props[0]?.valueName||s(model.name); const firstIdx=Array.isArray(idx)&&idx.length?Number(idx[0]):null;
  if(firstIdx!==null&&imgMap.byIndex[firstIdx]) return {image:imgMap.byIndex[firstIdx],source:imgMap.sources['idx:'+firstIdx]||'first_tier_index',exact:true,key:`idx:${firstIdx}`};
  if(firstVal&&imgMap.byName[firstVal]) return {image:imgMap.byName[firstVal],source:imgMap.sources['name:'+firstVal]||'first_tier_name',exact:true,key:`name:${firstVal}`};
  const modelImg=imageUrl(model.image||model.image_id||model.extinfo?.image||model.extinfo?.image_id||'');
  if(modelImg) return {image:modelImg,source:'model.image',exact:true,key:'model'};
  return {image:main,source:'fallback_main',exact:false,key:'fallback_main'};
}
function normalizeModels(data,ids,msg,logi,images,weightInfo){
  const axes=normalizeAxes(data); const models=data.models||[]; const skus=[]; const main=images[0]||imageUrl(data.image||''); const imgMap=buildVariantImageMap(msg,data,axes); const hasVariants=Array.isArray(models)&&models.length>0;
  if(hasVariants){models.forEach((m,i)=>{
    const idx=m.extinfo?.tier_index||m.tier_index||[]; const props=[];
    if(axes[0])props.push({propName:axes[0].name,valueName:axes[0].options[idx[0]??0]||''});
    if(axes[1])props.push({propName:axes[1].name,valueName:axes[1].options[idx[1]??0]||''});
    if(!props.length && m.name && s(m.name).includes(',')){const parts=s(m.name).split(','); if(parts.length===2){props.push({propName:'Tipe',valueName:s(parts[0])}); props.push({propName:'Ukuran',valueName:s(parts[1])});}}
    if(!props.length && m.name) props.push({propName:'Varian',valueName:s(m.name)});
    if(!props.length) props.push({propName:'Varian',valueName:'Default'});
    const mid=s(m.modelid||m.model_id||m.id||i+1); const st=stockOf(m,data,logi,true); const img=imageForModel(m,props,idx,imgMap,main); const originalPrice=price(m.price||m.price_stocks?.[0]?.current_price||m.price_before_discount||data.price||data.price_min); const wInfo=modelWeightInfo(m,weightInfo); const variantName=s(m.name||props.map(p=>p.valueName).filter(Boolean).join(', ')||`Varian ${i+1}`);
    const meta={_meta:{model_id:mid,tier_index:Array.isArray(idx)?idx:[],variant_name:variantName,stock_source:st.source,stock_confidence:st.confidence,image_source:img.source,variant_image_exact:!!img.exact,variant_image_key:img.key,weight_source:wInfo.source,weight_confidence:wInfo.confidence,weight_unknown:!!wInfo.unknown}};
    skus.push({sku_code:s(m.sku||m.seller_sku||m.model_sku)||`SHP-${ids.shop_id}-${ids.item_id}-${mid}`,model_id:mid,tier_index:Array.isArray(idx)?idx:[],name:variantName,original_price:originalPrice,sell_price:originalPrice,stock:Math.max(0,st.value),stock_source:st.source,stock_confidence:st.confidence,image:img.image||main,image_source:img.source,variant_image_exact:!!img.exact,weight:n(wInfo.value),weight_source:wInfo.source,weight_confidence:wInfo.confidence,weight_unknown:!!wInfo.unknown,length:n(logi.length)||n(data.dimension?.length)||20,width:n(logi.width)||n(data.dimension?.width)||10,height:n(logi.height)||n(data.dimension?.height)||10,goodsInfos:[{goodsNo:null}],properties:[...props,meta],originalPrice:originalPrice});
  })}
  return {axes,skus,imgMap}
}
function toSessionMagicPayload(message){
  const data=dataOf(message); const ids=idsOf(data,message?.pageUrl); const attrs=attrsBlock(message); const logi=attrDims(attrs); const weightInfo=extractWeightGrams(message,data,attrs,logi); const images=collectImages(message,data); const {axes,skus,imgMap}=normalizeModels(data,ids,message,logi,images,weightInfo); const hasVariants=skus.length>0;
  const min=price(data.price_min||data.price||skus.find(x=>x.original_price)?.original_price||0); const max=price(data.price_max||data.price||0)||min; const sourceCategories=sourceCategoriesDetailed(data); const categories=categoryNamesArray(data); const sourceCategoryPathText=sourceCategoryPath(data); const main=images[0]||imageUrl(data.image||'');
  const productStock=stockOf({},data,logi,false); const fallbackStock=hasVariants?skus.reduce((a,b)=>a+Math.max(0,b.stock||0),0):Math.max(0,productStock.value);
  const skuList=hasVariants?skus:[{sku_code:`SHP-${ids.shop_id}-${ids.item_id}-1`,model_id:'default',tier_index:[],name:'Default',original_price:min,sell_price:min,originalPrice:min,stock:fallbackStock,stock_source:productStock.source,stock_confidence:productStock.confidence,image:main,image_source:main?'main_image':'unknown',variant_image_exact:false,weight:Math.max(0,n(weightInfo.value)||2),weight_source:weightInfo.source,weight_confidence:weightInfo.confidence,weight_unknown:!!weightInfo.unknown,length:n(logi.length)||20,width:n(logi.width)||10,height:n(logi.height)||10,goodsInfos:[{goodsNo:null}],properties:[{propName:'Varian',valueName:'Default'},{_meta:{model_id:'default',tier_index:[],stock_source:productStock.source,stock_confidence:productStock.confidence,image_source:main?'main_image':'unknown',variant_image_exact:false,weight_source:weightInfo.source,weight_confidence:weightInfo.confidence,weight_unknown:!!weightInfo.unknown}}]}];
  return {platform:'shopee',platform_product_id:ids.item_id||null,platform_shop_id:ids.shop_id||null,platform_product_attributes:attrs,platform_product_categories:categories.join(', '),source_category_id:sourceCategories[sourceCategories.length-1]?.id||'',source_category_name:sourceCategories[sourceCategories.length-1]?.name||'',source_category_path:sourceCategoryPathText,source_category_nodes:sourceCategories,name:titleClean(data.title||data.name||''),spuDesc:cleanText(data.description||data.desc||''),indexImage:main,whiteImage:main,jsonBannerImages:images.slice(0,9),brandId:data.brand_id||data.brand?.brand_id||null,secondHandGoodsLabel:data.condition===2?1:0,skuList:skuList.map(x=>({originalPrice:x.original_price??x.originalPrice,stock:x.stock,image:x.image,weight:kgFromGrams(x.weight),weight_gram:Math.max(0,n(x.weight)||2000),weight_source:x.weight_source||weightInfo.source,weight_confidence:x.weight_confidence||weightInfo.confidence,weight_unknown:!!(x.weight_unknown||weightInfo.unknown),length:x.length||20,width:x.width||10,height:x.height||10,goodsInfos:x.goodsInfos||[{goodsNo:null}],properties:x.properties||[],stock_source:x.stock_source,stock_confidence:x.stock_confidence,image_source:x.image_source,variant_image_exact:x.variant_image_exact,model_id:x.model_id,tier_index:x.tier_index})),baseProps:[],saleProps:axes.map(a=>({propName:a.name,values:a.options})),shop_id:ids.shop_id,item_id:ids.item_id,product_url:canonicalProductUrl(ids,message?.pageUrl||(typeof location!=='undefined'?location.href:'')),title:titleClean(data.title||data.name||''),description:cleanText(data.description||data.desc||''),price_min:min,price_max:max,stock_total:fallbackStock,stock_accuracy:hasVariants?'model_sum':productStock.confidence,variant_image_accuracy:skus.some(x=>x.variant_image_exact)?'first_tier_or_model_exact':(main?'fallback_main':'unknown'),variant_image_map:imgMap.byName,images,white_image:main,category:categories,tier_variations:axes,models:skuList.map(x=>({...x,weight_gram:Math.max(0,n(x.weight)||2000),weight:kgFromGrams(x.weight)})),weight:kgFromGrams(weightInfo.value),weight_gram:Math.max(0,n(weightInfo.value)||2000),weight_source:weightInfo.source,weight_confidence:weightInfo.confidence,weight_unknown:!!weightInfo.unknown,length:n(logi.length)||20,width:n(logi.width)||10,height:n(logi.height)||10,raw:data,captured_at:new Date().toISOString(),source:'api_payload'};
}
function normalizeShopeePayload(message){return toSessionMagicPayload(message)}
function normalizeDomFallback(d){const imgs=uniq(d.images||[]).slice(0,9); const title=titleClean(d.title); const desc=cleanText(d.description); const ids={shop_id:s(d.shopId),item_id:s(d.itemId)}; return {platform:'shopee',source:'dom_fallback',stock_accuracy:'missing',variant_image_accuracy:'unknown',shop_id:ids.shop_id,item_id:ids.item_id,platform_shop_id:ids.shop_id,platform_product_id:ids.item_id,source_category_id:'',source_category_name:'',source_category_path:'',source_category_nodes:[],product_url:canonicalProductUrl(ids,d.productUrl||(typeof location!=='undefined'?location.href:'')),title,name:title,description:desc,spuDesc:desc,price_min:0,price_max:0,stock_total:90,weight:2,weight_gram:2000,weight_source:'default_unknown',weight_confidence:'default',weight_unknown:true,length:20,width:10,height:10,images:imgs,indexImage:imgs[0]||'',white_image:imgs[0]||'',whiteImage:imgs[0]||'',jsonBannerImages:imgs,tier_variations:[],models:[],skuList:[],baseProps:[],saleProps:[],raw:d,captured_at:new Date().toISOString()}}
root.MangprangNormalizer={normalizeShopeePayload,normalizeDomFallback,toSessionMagicPayload};
})(typeof self!=='undefined'?self:window);
