import './app.js?v=label-sync-20261012';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const shell=$('.cockpit'),cockpit=window.slaiCockpit,reduced=matchMedia('(prefers-reduced-motion: reduce)');
const MIN=16,MAX=28,STEP=.5,EASE='cubic-bezier(.2,.8,.2,1)',SPRING='cubic-bezier(.34,1.4,.5,1)';
const subtitles=['氛围合成','氛围合成','氛围合成','轻钢琴','柔和拨弦','空灵琴音'];
const motion=(el,frames,options)=>reduced.matches?null:el.animate(frames,{easing:EASE,...options});

/* Temperature: per-digit roll, direction follows the change. */
const tempEl=$('#hero-value strong');let shownTemp=null;
function slot(ch){const s=document.createElement('span');s.className='dg';s.append(Object.assign(document.createElement('span'),{textContent:ch}));return s;}
function rollTemp(value){
 const text=String(value),old=shownTemp;if(text===old)return;shownTemp=text;
 tempEl.setAttribute('aria-label',text+'°');
 if(old===null||reduced.matches){tempEl.replaceChildren(...[...text].map(slot));return;}
 const dir=Number(text)>Number(old)?1:-1,current=[...tempEl.children];
 const next=[...text].map((ch,i)=>{
  const prev=current[i];if(prev&&old[i]===ch){prev.querySelectorAll('.dg-out').forEach(n=>n.remove());return prev;}
  const s=slot(ch),delay=(text.length-1-i)*45;
  if(old[i]!==undefined){const out=Object.assign(document.createElement('span'),{className:'dg-out',textContent:old[i]});out.setAttribute('aria-hidden','true');s.append(out);
   out.animate([{transform:'none',opacity:1,filter:'blur(0)'},{transform:`translateY(${-dir*42}%)`,opacity:0,filter:'blur(6px)'}],{duration:360,delay,easing:EASE,fill:'both'}).finished.then(()=>out.remove(),()=>{});}
  s.firstChild.animate([{transform:`translateY(${dir*42}%)`,opacity:0,filter:'blur(6px)'},{transform:'none',opacity:1,filter:'blur(0)'}],{duration:520,delay,easing:SPRING,fill:'backwards'});
  return s;
 });
 tempEl.replaceChildren(...next);
}

/* Ruler */
const ruler=$('#temp-ruler'),ticks=ruler.querySelector('.ruler-ticks');
for(let v=MIN;v<=MAX;v+=STEP){const t=document.createElement('i');t.dataset.v=v;if(v%2===0){t.className='major';t.dataset.label=v;}ticks.append(t);}
const ratio=v=>(v-MIN)/(MAX-MIN);
const snap=x=>{const r=ruler.getBoundingClientRect();const p=Math.min(1,Math.max(0,(x-r.left)/r.width));return Math.round((MIN+p*(MAX-MIN))/STEP)*STEP;};
function paint(temp){ruler.style.setProperty('--t',ratio(temp));ruler.setAttribute('aria-valuenow',temp);ruler.setAttribute('aria-valuetext',temp+'°C');for(const t of ticks.children)t.classList.toggle('on',Number(t.dataset.v)<=temp);}
let dragging=null;
const commit=temp=>{if(temp!==cockpit.read().temp)cockpit.executeAction({temp}).catch(()=>{});};
ruler.addEventListener('pointerdown',e=>{dragging=snap(e.clientX);ruler.setPointerCapture(e.pointerId);ruler.classList.add('dragging');paint(dragging);rollTemp(dragging);});
ruler.addEventListener('pointermove',e=>{if(dragging===null)return;const v=snap(e.clientX);if(v!==dragging){dragging=v;paint(v);rollTemp(v);}});
const release=()=>{if(dragging===null)return;const v=dragging;dragging=null;ruler.classList.remove('dragging');commit(v);};
ruler.addEventListener('pointerup',release);ruler.addEventListener('pointercancel',release);
ruler.addEventListener('keydown',e=>{const d={ArrowLeft:-STEP,ArrowDown:-STEP,ArrowRight:STEP,ArrowUp:STEP}[e.key];if(!d)return;e.preventDefault();commit(Math.min(MAX,Math.max(MIN,cockpit.read().temp+d)));});

/* Mode segmented control: one pill slides between options. */
const modes=$('.c-modes'),pill=document.createElement('i');pill.className='c-pill';pill.setAttribute('aria-hidden','true');modes.prepend(pill);
const modeOrder=['auto','cool','heat','fan'];

/* Music: covers cross-fade, titles slide in the direction of travel. */
function swapCover(el,from){
 const ghost=Object.assign(document.createElement('i'),{className:'cover cover-ghost'});ghost.dataset.cover=from;el.append(ghost);
 const a=motion(ghost,[{opacity:1},{opacity:0}],{duration:560,fill:'forwards'});
 if(a)a.finished.then(()=>ghost.remove(),()=>ghost.remove());else ghost.remove();
 motion(el,[{transform:'scale(1.1)',filter:'brightness(1.25)'},{transform:'none',filter:'none'}],{duration:760});
}
const slideText=(el,dir)=>motion(el,[{transform:`translateX(${dir*10}px)`,opacity:0,filter:'blur(3px)'},{transform:'none',opacity:1,filter:'blur(0)'}],{duration:460});

let last=null;
function sync(state){
 if(dragging===null){paint(state.temp);rollTemp(state.temp);}
 const i=modeOrder.indexOf(state.climateMode);modes.style.setProperty('--i',i);
 for(const b of $$('.zone')){const on=b.getAttribute('aria-pressed')==='true',name=b.querySelector('em').textContent;b.setAttribute('aria-label',`${name}送风，${state.ac&&on?'送风中':on?'已开启，空调关闭':'已关闭'}`);}
 if(last&&last.track!==state.track){
  const dir=(state.track-last.track+6)%6===5?-1:1;
  for(const c of $$('[data-cover-current]'))swapCover(c,last.track);
  slideText($('#mini-title'),dir);slideText($('#np-title'),dir);
 }
 if(last&&last.playing!==state.playing)motion($('#play'),[{transform:'scale(.82)'},{transform:'none'}],{duration:480,easing:SPRING});
 if(last&&last.fan!==state.fan)$('.fan-bar').style.setProperty('--dir',state.fan>last.fan?1:-1);
 for(const c of $$('[data-cover-current]'))c.dataset.cover=state.track;
 $('.now-playing small').textContent=(state.playing?'正在播放':'已暂停')+' · 本地曲库';
 $('#np-title').textContent=$('#mini-title').textContent;$('#np-sub').textContent=subtitles[state.track];
 shell.dataset.track=state.track;shell.style.setProperty('--fan-speed',state.fan);
 last={track:state.track,playing:state.playing,fan:state.fan};
}
shell.addEventListener('cockpit:render',e=>sync(e.detail));
sync(cockpit.read());

/* Dialogs grow out of the control that opened them. */
for(const [button,dialog]of [['climate-detail','climate-dialog'],['music-detail','music-dialog'],['ambient-detail','ambient-dialog'],['command-open','command-dialog']]){
 $('#'+button).addEventListener('click',()=>{const d=$('#'+dialog),b=$('#'+button).getBoundingClientRect();if(!d.open)return;d.style.transformOrigin=`${b.left+b.width/2-d.offsetLeft}px ${b.top+b.height/2-d.offsetTop}px`;});
}

/* Caption: replies replace with a soft cross-fade; streamed text just grows and stays scrolled to the end. */
const response=$('#response');let captionText='';
new MutationObserver(()=>{
 const text=response.textContent;
 if(text&&captionText&&!text.startsWith(captionText))motion(response,[{opacity:0,transform:'translateY(6px)',filter:'blur(4px)'},{opacity:1,transform:'none',filter:'blur(0)'}],{duration:420});
 captionText=text;response.scrollTop=response.scrollHeight;
}).observe(response,{childList:true,characterData:true,subtree:true});
