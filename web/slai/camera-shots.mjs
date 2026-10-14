// Only commands with a visible 3D effect earn a camera move.
export function selectShot(patch,currentAngle=.85){
 const closest=angles=>angles.reduce((best,a)=>Math.abs(nearestAngle(currentAngle,a)-currentAngle)<Math.abs(nearestAngle(currentAngle,best)-currentAngle)?a:best);
 const keys=Object.keys(patch);
 if(!keys.length||keys.length>8)return null; // initial sync / reset
 const mechanical=keys.filter(k=>/Window$|Door$/.test(k));
 if(mechanical.length){
  const left=mechanical.some(k=>/left|Left/.test(k)),right=mechanical.some(k=>/right|Right/.test(k));
  const rear=mechanical.every(k=>/^rear/.test(k));
  return {name:'doors-windows',angle:left===right?closest([1.35,-1.35]):(left?-1:1)*(rear?1.12:1.95),distance:8.1,height:3.3,targetY:.85,targetZ:rear?.45:-.2};
 }
 if(keys.some(k=>['ambient','ambientColor','ambientBrightness','ac','climateMode','fan','frontAir','rearAir'].includes(k)))
  return {name:'cabin',angle:closest([.92,-.92]),distance:8,height:5.7,targetY:.65,targetZ:0};
 if(keys.includes('lights'))return {name:'lights',angle:closest([2.5,-2.5]),distance:9,height:3.1,targetY:.65,targetZ:-.3};
 return null;
}
export const nearestAngle=(from,to)=>from+Math.atan2(Math.sin(to-from),Math.cos(to-from));
export const isWheelGroup=name=>/^wheels(?:[_.]?\d+)?$/.test(name);
