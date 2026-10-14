import {windowKeys,doorKeys} from './controls.mjs?v=45';
export {windowKeys,doorKeys};
const channel=value=>({value,velocity:0});
// Exact critically damped response: interruption preserves both position and velocity.
export function damp(c,target,dt,time=.32){
 const w=2/time,x=c.value-target,e=Math.exp(-w*dt),a=c.velocity+w*x;
 c.value=target+(x+a*dt)*e;c.velocity=(c.velocity-w*a*dt)*e;
 if(Math.abs(c.value-target)<.0001&&Math.abs(c.velocity)<.0003){c.value=target;c.velocity=0;}
 return c.value;
}
export function createMotion(){return {speed:channel(1),windows:Object.fromEntries(windowKeys.map(k=>[k,channel(0)])),doors:Object.fromEntries(doorKeys.map(k=>[k,channel(0)])),distance:0,phase:'cruising'};}
export function stepMotion(m,s,dt){
 const requestedStop=doorKeys.some(k=>s[k]>0);
 const doorsClosed=doorKeys.every(k=>m.doors[k].value<.001);
 damp(m.speed,requestedStop||!doorsClosed?0:1,dt,requestedStop?.48:.95);
 if(m.speed.value<.003&&requestedStop){m.speed.value=0;m.speed.velocity=0;}
 for(const k of doorKeys)damp(m.doors[k],m.speed.value===0?s[k]/100:0,dt,.42);
 for(const key of windowKeys)damp(m.windows[key],s[key]/100,dt,.48);
 m.distance+=m.speed.value*8*dt;
 m.phase=m.speed.value>.01?(requestedStop?'braking':m.speed.value<.97?'accelerating':'cruising'):
   !doorsClosed||doorKeys.some(k=>s[k]>0)?'parked':requestedStop?'parking':'accelerating';
 return m;
}
const target=v=>typeof v==='boolean'?Number(v):v/100;
export function motionSettled(m,p){
 return windowKeys.every(k=>!(k in p)&&!('windows'in p)||Math.abs(m.windows[k].value-target(p[k]??p.windows))<.001)&&
 doorKeys.every(k=>!(k in p)||Math.abs(m.doors[k].value-target(p[k]))<.001);
}
