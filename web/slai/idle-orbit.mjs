export const ORBIT_AMPLITUDE=40*Math.PI/180;
// A 100-second sine cycle takes 50 seconds between the two end views.
export function createIdleOrbit(angle=0,center=0){
 return {center,phase:Math.asin(Math.max(-1,Math.min(1,(angle-center)/ORBIT_AMPLITUDE))),speed:0,angle};
}
export function stepIdleOrbit(orbit,enabled,dt){
 const target=enabled?Math.PI/50:0;
 orbit.speed+=(target-orbit.speed)*(1-Math.exp(-dt/1.2));
 if(!enabled&&orbit.speed<1e-6)orbit.speed=0;
 orbit.phase=(orbit.phase+orbit.speed*dt)%(2*Math.PI);
 orbit.angle=orbit.center+ORBIT_AMPLITUDE*Math.sin(orbit.phase);
 return orbit.angle;
}
