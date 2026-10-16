import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const source=(await fs.readFile(new URL('../web/slai/voice-bridge.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const flush=()=>new Promise(r=>setImmediate(r));
async function setup(){
 const nodes=new Map(),events={};let mic,transport,resolveFinish,calls=0,fail=false,profile='api',switchFail=false;const selections=[],sessions=[],clears=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{setAttribute(k,v){this[k]=v;},replaceChildren(){}});return nodes.get(id);};
 const cockpit={setVoicePhase(){},applyServerState(){},notify(){},notifyAction(){},notifyTranscript(){},beginFeedback(){},unlockMedia:async()=>{},setCommandTransport:t=>transport=t};
 class Mic {constructor(o){Object.assign(this,o);mic=this;this.enabled=false;this.resumes=0;} async start(){this.enabled=true;this.worklet={};this.onStatus('listening');}pause(){this.paused=true;}resume(){this.resumes++;this.paused=false;}stop(){this.enabled=false;this.onStatus('off');}}
 class Player {metrics={};reset(){}unlock(){return Promise.resolve(true);}stop(){}wav(){return null;}finish(){return new Promise(r=>resolveFinish=r);}}
 const ctx={window:{slaiCockpit:cockpit},document:{getElementById:node,createTextNode:x=>x,createElement:()=>({}),hidden:false},sessionStorage:{getItem(){return '';},setItem(){},removeItem(){}},Audio:class{pause(){}},PCMStreamPlayer:Player,ContinuousMic:Mic,wavBase64:()=> 'synthetic-wav',performance,AbortController,TextDecoder,Uint8Array,URL,console,setTimeout,clearTimeout,setInterval(){},addEventListener:(k,fn)=>events[k]=fn,
 fetch:async(url,opts)=>{
  if(url.endsWith('connection-settings')){if(opts.method==='POST'){const body=JSON.parse(opts.body);selections.push(body);if(switchFail)return {ok:false,status:503,json:async()=>({detail:'目标不可达'})};profile=body.profile;}return {ok:true,json:async()=>({profile})};}
  if(url.endsWith('health'))return {ok:true,json:async()=>({ready:true,streaming_audio:true,profiles:['slai']})};
  if(url.endsWith('clear-history')){clears.push(JSON.parse(opts.body));return {ok:true,json:async()=>({session_id:'test-'+profile,state:{leftWindow:100},history_cleared:true})};}
  if(url.endsWith('session')){sessions.push(JSON.parse(opts.body));return {ok:true,json:async()=>({session_id:'test-'+profile})};}
  calls++;if(fail)throw Error('test disconnect');let sent=false;
  return {ok:true,body:{getReader:()=>({read:async()=>sent?{done:true}:(sent=true,{done:false,value:new TextEncoder().encode(JSON.stringify({type:'done',data:{session_id:'test',reply:'完成'}})+'\n')}),cancel:async()=>{},releaseLock(){}})}};
 }};
 vm.runInNewContext(source,ctx);await flush();await node('voice-continuous').onclick();
 return {mic,nodes,node,events,ctx,transport,selections,sessions,clears,setSwitchFail:()=>switchFail=true,get calls(){return calls;},finish:()=>resolveFinish(),setFail:()=>fail=true};
}
test('automatic utterance waits for playback before rearming; next utterance uses same route',async()=>{
 const x=await setup();const pending=x.mic.onUtterance([],48000);await flush();
 assert.equal(x.calls,1);assert.equal(x.mic.paused,true);assert.equal(x.mic.resumes,0);
 x.finish();await pending;assert.equal(x.mic.resumes,1);
 const next=x.mic.onUtterance([],48000);await flush();x.finish();await next;assert.equal(x.calls,2);
});
test('switch off during reply prevents automatic microphone reopening',async()=>{
 const x=await setup();const pending=x.mic.onUtterance([],48000);await flush();await x.node('voice-continuous').onclick();x.finish();await pending;
 assert.equal(x.mic.enabled,false);assert.equal(x.mic.resumes,0);
});
test('network failure stops continuous mode without retrying command',async()=>{
 const x=await setup();x.setFail();await x.mic.onUtterance([],48000);
 assert.equal(x.calls,1);assert.equal(x.mic.enabled,false);assert.equal(x.mic.resumes,0);
});
test('backgrounding stops continuous recording',async()=>{
 const x=await setup();x.ctx.document.hidden=true;x.events.visibilitychange();assert.equal(x.mic.enabled,false);
});

test('model switch uses saved API settings and creates a fresh session',async()=>{
 const x=await setup();x.mic.stop();x.node('remote-model-select').value='checkpoint48';await x.node('remote-model-switch').onclick();
 assert.equal(x.selections[0].profile,'checkpoint48');assert.equal(x.sessions.at(-1).session_id,'');
 x.node('remote-model-select').value='api';await x.node('remote-model-switch').onclick();
 assert.equal(x.selections.at(-1).settings,undefined);assert.equal(x.sessions.at(-1).session_id,'');
});
test('failed switch keeps current model and session',async()=>{
 const x=await setup();x.mic.stop();x.setSwitchFail();x.node('remote-model-select').value='checkpoint48';await x.node('remote-model-switch').onclick();
 assert.equal(x.node('remote-model-select').value,'api');assert.equal(x.sessions.length,1);assert.match(x.node('remote-model-status').textContent,/切换失败/);
});
test('continuous listening blocks model switching',async()=>{
 const x=await setup();x.node('remote-model-select').value='checkpoint48';await x.node('remote-model-switch').onclick();assert.equal(x.selections.length,0);
});

test('choosing a model applies it immediately without a second button click',async()=>{
 const x=await setup();x.mic.stop();x.node('remote-model-select').value='checkpoint48';await x.node('remote-model-select').onchange();assert.equal(x.selections.at(-1).profile,'checkpoint48');
});
test('clear conversation reaches backend, preserves session and stops continuous listening',async()=>{
 const x=await setup();await x.node('voice-clear-history').onclick();assert.equal(x.clears.length,1);assert.equal(x.clears[0].session_id,'test-api');assert.equal(x.mic.enabled,false);assert.equal(x.sessions.length,1);
});
