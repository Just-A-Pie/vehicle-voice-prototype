import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceActivity,ContinuousMic} from '../web/slai/voice-activity.mjs';
const frame=amp=>Float32Array.from({length:480},(_,i)=>amp*Math.sin(i*.25));
function feed(vad,ms,amp){const out=[];for(let i=0;i<ms;i+=10){const e=vad.push(frame(amp));if(e)out.push(e);}return out;}
test('silence remains bounded and never submitted',()=>{
 const v=new VoiceActivity(48000);assert.deepEqual(feed(v,60000,0),[]);assert.ok(v.pre.length<=36);
});
test('short click discarded; qualified speech ends after a full second of silence',()=>{
 const v=new VoiceActivity(48000);assert.deepEqual(feed(v,50,.15),[]);assert.deepEqual(feed(v,1500,0),[]);
 assert.equal(feed(v,600,.08)[0].type,'start');assert.equal(feed(v,990,0).length,0);
 const end=feed(v,10,0)[0];assert.equal(end.type,'utterance');assert.ok(end.chunks.length>160);
});
test('brief pauses preserve a single command; next utterance has fresh buffers',()=>{
 const v=new VoiceActivity(48000);feed(v,400,.08);assert.deepEqual(feed(v,500,0),[]);feed(v,400,.08);
 assert.equal(feed(v,1000,0)[0].type,'utterance');assert.equal(feed(v,400,.08)[0].type,'start');
 assert.equal(feed(v,1000,0)[0].type,'utterance');assert.equal(v.chunks.length,0);
});
test('brief sustained sound does not qualify as a full utterance',()=>{
 const v=new VoiceActivity(48000);feed(v,150,.08);assert.equal(feed(v,1000,0)[0].type,'discard');
});
test('long segment is rejected instead of submitting a truncated instruction',()=>{
 const v=new VoiceActivity(48000);assert.equal(feed(v,19000,.08).at(-1).type,'limit');
});
const tick=()=>new Promise(r=>setTimeout(r,5));
function mocks(getMedia){
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:getMedia}}});
 globalThis.AudioContext=class{sampleRate=48000;state='running';audioWorklet={addModule:async()=>{}};destination={};async resume(){}async close(){this.state='closed';}createMediaStreamSource(){return {connect(){},disconnect(){}};}createGain(){return {gain:{value:1},connect(){},disconnect(){}};}};
 globalThis.AudioWorkletNode=class{port={onmessage:null};connect(){return {connect(){}};}disconnect(){}};
}
function stream(){const track={enabled:true,stopped:false,stop(){this.stopped=true;}};return {track,getTracks:()=>[track]};}
function controller(onUtterance=()=>{}){return new ContinuousMic({onUtterance,onStatus:()=>{},onError:e=>{throw e;}});}
test('late permission result after stop releases its stream and never reopens',async()=>{
 let resolve; mocks(()=>new Promise(r=>resolve=r));const c=controller(),pending=c.start();c.stop();const s=stream();resolve(s);await pending;
 assert.equal(s.track.stopped,true);assert.equal(c.enabled,false);assert.equal(c.context,null);
});
test('pause ignores playback audio; resume supports another turn; stop cancels rearm',async()=>{
 const s=stream();mocks(async()=>s);let turns=0;const c=controller(()=>{turns++;});await c.start();await tick();
 const send=(n,amp)=>{for(let i=0;i<n;i++)c.worklet.port.onmessage({data:frame(amp)});};
 send(60,.08);send(100,0);await tick();assert.equal(turns,1);assert.equal(c.listening,false);assert.equal(s.track.enabled,false);
 send(60,.08);send(100,0);await tick();assert.equal(turns,1);
 c.resume(0);await tick();send(60,.08);send(100,0);await tick();assert.equal(turns,2);
 c.resume(1);c.stop();await tick();assert.equal(c.listening,false);assert.equal(s.track.stopped,true);
});
test('stop during worklet loading prevents resurrection',async()=>{
 const s=stream();mocks(async()=>s);let finish;
 const Base=AudioContext;globalThis.AudioContext=class extends Base{audioWorklet={addModule:()=>new Promise(r=>finish=r)};};
 const c=controller(),pending=c.start();await tick();const ctx=c.context;c.stop();finish();await pending;
 assert.equal(ctx.state,'closed');assert.equal(c.worklet,undefined);assert.equal(s.track.stopped,true);
});
test('microphone denial resets switch and reports error',async()=>{
 mocks(async()=>{throw Object.assign(Error('denied'),{name:'NotAllowedError'});});let error;
 const c=new ContinuousMic({onUtterance(){},onStatus(){},onError:e=>error=e});await c.start();
 assert.equal(c.enabled,false);assert.equal(error.name,'NotAllowedError');
});
