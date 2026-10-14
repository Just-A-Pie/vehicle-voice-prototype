export const windowKeys=['leftWindow','rightWindow','rearLeftWindow','rearRightWindow'];
export const doorKeys=['leftDoor','rightDoor','rearLeftDoor','rearRightDoor'];
export const windowNames={leftWindow:'主驾车窗',rightWindow:'副驾车窗',rearLeftWindow:'左后车窗',rearRightWindow:'右后车窗'};
export const doorNames={leftDoor:'主驾车门',rightDoor:'副驾车门',rearLeftDoor:'左后车门',rearRightDoor:'右后车门'};
export const palette={blue:{name:'冰川蓝',hex:'#86dcff'},violet:{name:'暮光紫',hex:'#bca2ff'},amber:{name:'暖琥珀',hex:'#efbe84'}};
export const trackNames=['Nightfall','Blue Horizon','Weightless','晨光','河畔','星夜'];
const toggle=(label,value)=>({type:'boolean',label,default:value});
const number=(label,min,max,step,value,unit='')=>({type:'number',label,min,max,step,default:value,unit});
// One parameter contract drives validation, defaults, tool schema and numeric UI bounds.
export const parameters={
 ac:toggle('空调系统',false),climateMode:{type:'string',label:'空调模式：auto自动、cool制冷、heat制热、fan通风',enum:['auto','cool','heat','fan'],default:'auto'},temp:number('设定温度',16,28,.5,22,'°C'),fan:number('风量',1,5,1,2,'档'),frontAir:toggle('前排送风',true),rearAir:toggle('后排送风',true),
 playing:toggle('音乐',false),volume:number('音量',0,1,.01,.35,'%'),muted:toggle('静音',false),track:number('曲目',0,trackNames.length-1,1,0),
 ambient:toggle('氛围灯',true),ambientColor:{type:'string',label:'氛围灯颜色',enum:Object.keys(palette),default:'blue'},ambientBrightness:number('氛围灯亮度',0,100,1,70,'%'),
 lights:toggle('迎宾灯',true),locked:toggle('车锁',true),
 ...Object.fromEntries(doorKeys.map(k=>[k,number(doorNames[k]+'开度',0,100,1,0,'%')])),
 ...Object.fromEntries(windowKeys.map(k=>[k,number(windowNames[k]+'开度',0,100,1,0,'%')]))
};
const actuators=[...doorKeys,...windowKeys];
export const defaultPatch=()=>Object.fromEntries(Object.entries(parameters).map(([k,d])=>[k,d.default]));
export const initialState=()=>({...defaultPatch(),windows:false,focus:'climate',camera:'exterior',modelReady:false});
function check(key,value){const d=parameters[key];if(!d)throw Error('暂不支持的操作：'+key);
 if(d.type==='boolean'){if(typeof value!=='boolean')throw Error(d.label+'需要开关值');}
 else if(d.type==='string'){if(!d.enum.includes(value))throw Error('暂不支持这个'+d.label);}
 else if(!Number.isFinite(value)||value<d.min||value>d.max||Math.abs(value/d.step-Math.round(value/d.step))>1e-7)throw Error(d.label+'支持 '+d.min+'–'+d.max+(d.unit||'')+'，步长 '+d.step+(d.unit||''));
}
export function validatePatch(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||!Object.keys(p).length)throw Error('请提供一个操作');
 const out={...p};
 for(const [alias,keys] of [['windows',windowKeys],['doors',doorKeys]])if(alias in out){let value=out[alias];if(typeof value==='boolean')value=value?100:0;check(keys[0],value);for(const key of keys)if(!(key in out))out[key]=value;delete out[alias];}
 for(const key of Object.keys(out)){if(actuators.includes(key)&&typeof out[key]==='boolean')out[key]=out[key]?100:0;check(key,out[key]);}
 // Locking closes every door; the returned patch is the effective command, also used by feedback.
 if(out.locked===true)for(const key of doorKeys)out[key]=0;
 return out;
}
export function applyPatch(state,patch){
 const p=validatePatch(patch),n={...state,...p};
 if(doorKeys.some(k=>p[k]>0))n.locked=false;
 if((p.climateMode!==undefined||p.temp!==undefined||p.fan!==undefined||p.frontAir===true||p.rearAir===true)&&p.ac!==false)n.ac=true;
 if((p.ambientColor!==undefined||p.ambientBrightness>0)&&p.ambient!==false)n.ambient=true;
 if(p.track!==undefined&&p.playing!==false)n.playing=true;
 if(p.volume!==undefined&&p.muted!==true)n.muted=false;
 if(['ac','climateMode','temp','fan','frontAir','rearAir'].some(k=>k in p))n.focus='climate';
 else if(['playing','track','volume','muted'].some(k=>k in p))n.focus='music';
 else if(['ambient','ambientColor','ambientBrightness'].some(k=>k in p))n.focus='ambient';else n.focus='vehicle';
 n.camera=state.camera;n.windows=windowKeys.every(k=>n[k]===100);return n;
}
export const controlSchema={type:'object',properties:Object.fromEntries([
 ...Object.entries(parameters).map(([k,d])=>[k,{type:d.type,description:d.label+(actuators.includes(k)?'，0=关闭，100=全开':k==='volume'?'，0–1 对应 0–100%':''),...(d.type==='number'?{minimum:d.min,maximum:d.max,multipleOf:d.step}:{}),...(d.enum?{enum:d.enum}:{})}]),
 ...['windows','doors'].map(k=>[k,{type:'number',minimum:0,maximum:100,multipleOf:1,description:'全部'+(k==='windows'?'车窗':'车门')+'开度，0–100；单独字段优先'}])
]),additionalProperties:false};
const clamp=(x,min,max)=>Math.max(min,Math.min(max,x));
function numericChinese(s){const digits={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};let sum=0,current=0;for(const c of s){if(c==='百'){sum+=(current||1)*100;current=0;}else if(c==='十'){sum+=(current||1)*10;current=0;}else current=digits[c];}return sum+current;}
function normalize(text){return text.trim().replace(/百分之([零〇一二两三四五六七八九十百\d.]+)/g,(_,n)=>(/^\d/.test(n)?n:numericChinese(n))+'%').replace(/[零〇一二两三四五六七八九十百]+(?:点[零〇一二三四五六七八九]+)?(?=\s*(?:度|档|%|％|成))/g,n=>n.includes('点')?numericChinese(n.split('点')[0])+'.'+[...n.split('点')[1]].map(c=>numericChinese(c)).join(''):numericChinese(n)).replace(/[。！!？?]/g,'');}
function targets(c,keys){const specs=[[/左后|后左|后排左/,2],[/右后|后右|后排右/,3],[/左前|前左|主驾/,0],[/右前|前右|副驾/,1]],found=specs.filter(([r])=>r.test(c)).map(([,i])=>keys[i]);if(found.length)return found;
 if(/后排|后面|后边/.test(c))return keys.slice(2);if(/前排|前面|前边/.test(c))return keys.slice(0,2);if(/左侧|左边/.test(c))return [keys[0],keys[2]];if(/右侧|右边/.test(c))return [keys[1],keys[3]];return keys;
}
const percent=c=>{const m=c.match(/(-?\d+(?:\.\d+)?)\s*[%％]/);return m?Number(m[1]):null;};
function opening(c,current){const v=percent(c),relative=/再|增加|减少|多开|多关|开大|关小/.test(c),closing=/关|升起|升高/.test(c);
 if(v!==null&&(v<0||v>100))throw Error('开度支持 0–100%');
 if(v!==null)return relative?clamp(current+(closing||/减少/.test(c)?-v:v),0,100):v;
 if(/一半|半开|半关/.test(c))return 50;if(/四分之一/.test(c))return 25;if(/留缝|透气/.test(c))return 10;
 const part=c.match(/(\d+(?:\.\d+)?)成/);if(part)return Number(part[1])*10;
 if(/一点|一些|开大|关小/.test(c))return clamp(current+(closing?-10:10),0,100);
 if(/\d/.test(c))throw Error('请用百分比指定开度，例如 30%');
 if(/关闭|关掉|关上|关了|全关|升起/.test(c))return 0;if(/打开|开启|全开|降下/.test(c))return 100;
 throw Error('请指定开度，例如“主驾车窗开到 30%”');
}
export function parseCommand(text,state){
 const t=normalize(text);if(!t)throw Error('请输入指令');
 const clauses=t.split(/[，,；;]|然后|并且|同时|顺便|以及|并(?=把|打开|关闭|播放|暂停)/).map(x=>x.trim()).filter(Boolean);
 let patch={},working={...state};
 for(const c of clauses){let p={};const off=/关闭|关掉|关上|关了|停止|暂停|别放|不要放/.test(c),on=/打开|开启|启动|开一下|开空调|播放|放点|放一/.test(c);
  if(/车窗/.test(c)){p=Object.fromEntries(targets(c,windowKeys).map(k=>[k,opening(c,working[k])]));}
  else if(/车门/.test(c)){p=Object.fromEntries(targets(c,doorKeys).map(k=>[k,opening(c,working[k])]));}
  else if(/氛围灯|座舱灯光|冰川蓝|暮光紫|暖琥珀/.test(c)){
   if(/亮度|调亮|调暗|亮一点|暗一点/.test(c)){const v=percent(c);if(v!==null){if(v<0||v>100)throw Error('亮度支持 0–100%');p.ambientBrightness=/再|增加|减少/.test(c)?clamp(working.ambientBrightness+(/暗|降低|减少/.test(c)?-v:v),0,100):v;}else if(/调亮|调暗|亮一点|暗一点|降低|提高/.test(c)&&!/[0-9]/.test(c))p.ambientBrightness=clamp(working.ambientBrightness+(/暗|降低/.test(c)?-10:10),0,100);else throw Error('请指定亮度百分比，例如 30%');}
   if(/紫/.test(c))p.ambientColor='violet';else if(/蓝/.test(c))p.ambientColor='blue';else if(/琥珀|暖色/.test(c))p.ambientColor='amber';
   if(off||on)p.ambient=!off;if(!Object.keys(p).length)throw Error('支持冰川蓝、暮光紫、暖琥珀和 0–100% 亮度');
  }
  else if(/取消静音|解除静音|恢复声音/.test(c))p.muted=false;
  else if(/静音/.test(c))p.muted=true;
  else if(/音量|声音.*(大|小)/.test(c)||/音乐.*(小一点|大一点|调小|调大)/.test(c)){
   const v=percent(c);if(v===null&&/[0-9]/.test(c))throw Error('请用百分比指定音量');if(v!==null){if(v<0||v>100)throw Error('音量支持 0–100%');p.volume=/再|增加|减少/.test(c)?Math.round(clamp(working.volume+(/小|低|减少/.test(c)?-v:v)/100,0,1)*100)/100:v/100;}else if(/小|低/.test(c))p.volume=Math.round(clamp(working.volume-.1,0,1)*100)/100;else if(/大|高/.test(c))p.volume=Math.round(clamp(working.volume+.1,0,1)*100)/100;else throw Error('可试试“音量调到 30%”');
  }
  else if(/音乐|歌曲|下一首|上一首|安静/.test(c)||trackNames.some(n=>c.toLowerCase().includes(n.toLowerCase()))){
   const index=trackNames.findIndex(n=>c.toLowerCase().includes(n.toLowerCase()));
   if(index>=0)p.track=index;else if(/上一/.test(c))p.track=(working.track+trackNames.length-1)%trackNames.length;else if(/换|下一/.test(c))p.track=(working.track+1)%trackNames.length;
   else if(off||/安静/.test(c))p.playing=false;else if(on||/来点音乐|轻音乐/.test(c))p.playing=true;else throw Error('请指定播放、暂停或曲目');
  }
  else if(/制冷|制热|通风|只吹风|自动空调|自动模式/.test(c)){p.climateMode=/制冷/.test(c)?'cool':/制热/.test(c)?'heat':/通风|只吹风/.test(c)?'fan':'auto';if(off)p.ac=false;}
  else if(/前排|后排/.test(c)&&/送风|空调/.test(c)&&!/(度|档)/.test(c)){
   if(!off&&!on)throw Error('请指定打开或关闭送风');if(/前排/.test(c))p.frontAir=!off;if(/后排/.test(c))p.rearAir=!off;
  }
  else if(/风量|风速/.test(c)){const m=c.match(/(-?\d+(?:\.\d+)?)\s*档/);if(!m&&/[0-9]/.test(c))throw Error('请指定风量档位，例如 3 档');if(m){const v=Number(m[1]);p.fan=/再|增加|减少|加|减/.test(c)&&v>0?clamp(working.fan+(/小|低|减/.test(c)?-v:v),1,5):v;}else if(/小|低|大|高/.test(c))p.fan=clamp(working.fan+(/小|低/.test(c)?-1:1),1,5);else throw Error('风量支持 1–5 档');}
  else if(/空调|温度|太冷|太热|凉一点|暖一点/.test(c)){
   const m=c.match(/(-?\d+(?:\.\d+)?)\s*(?:度|℃|°C?)/i);
   if(!m&&/[0-9]/.test(c))throw Error('请指定温度单位，例如 22.5 度');if(m){const v=Number(m[1]);p.temp=/调高|升高|提高|增加|调低|降低|减少/.test(c)&&v>0?clamp(working.temp+(/低|减少/.test(c)?-v:v),16,28):v;}else if(/调高|升高|太冷|暖一点/.test(c))p.temp=clamp(working.temp+.5,16,28);else if(/调低|降低|太热|凉一点/.test(c))p.temp=clamp(working.temp-.5,16,28);else if(off||on)p.ac=!off;else throw Error('温度支持 16–28°C，步长 0.5°C');
  }
  else if(/解锁/.test(c))p.locked=false;else if(/锁车|锁定/.test(c))p.locked=true;
  else if(/迎宾灯|车灯|大灯/.test(c)&&(off||on))p.lights=!off;
  else throw Error('这条指令尚未接入。可尝试空调、音乐、氛围灯、车门或车窗。');
  p=validatePatch(p);working=applyPatch(working,p);Object.assign(patch,p);
 }
 // Preserve implied power/unlock changes in compound-command order.
 for(const key of ['ac','ambient','playing','muted','locked'])if(working[key]!==state[key]||key in patch)patch[key]=working[key];
 return validatePatch(patch);
}
export function suggestions(s){return [
 {category:'climate',text:s.ac?(s.temp===24?'把温度调到 22 度':'把温度调到 24 度'):'打开空调'},
 {category:'music',text:s.playing?(s.muted?'解除静音':'音量调到 30%'):'播放音乐'},
 {category:'ambient',text:s.ambientBrightness===30?'氛围灯换成紫色':'氛围灯亮度调到 30%'},
 {category:'windows',text:s.rearRightWindow===50?'关闭右后车窗':'右后车窗打开一半'},
 {category:'doors',text:s.rearRightDoor>0?'关闭右后车门':'打开右后车门'},
 {category:'combo',text:s.ac&&s.playing?'关闭空调，暂停音乐':'打开空调，播放音乐'}
 ];}
export function chooseSuggestion(s,recent=[],lastCategory=''){const pool=suggestions(s),fresh=pool.filter(x=>x.category!==lastCategory);return fresh.sort((a,b)=>recent.lastIndexOf(a.text)-recent.lastIndexOf(b.text))[0]||pool[0];}
