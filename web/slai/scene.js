import * as THREE from 'three';
import {MeshoptDecoder} from './vendor/meshopt_decoder.mjs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {Reflector} from 'three/addons/objects/Reflector.js';
import {palette} from './controls.mjs?v=47';
import {createMotion,stepMotion,motionSettled,damp,doorKeys,windowKeys} from './motion.mjs?v=45';
import {selectShot,nearestAngle,isWheelGroup} from './camera-shots.mjs?v=48';
import {createIdleOrbit,stepIdleOrbit,ORBIT_AMPLITUDE} from './idle-orbit.mjs?v=1';
export function mountScene(state,onReady,onMotion=()=>{},onTelemetry=()=>{}){
 const container=document.querySelector('#scene'),shell=document.querySelector('.cockpit');
 const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
 const motion=createMotion(),pending=[];let width=1,height=1,drag=0,down=false,startX=0,model,roadClock=0,lastPhase='';
 const windowPulseUntil={};let lastWindowSignature='';const doorPulseUntil={};
 // Screen tags pinned to the moving glass / door edge; the 3D car stays the primary feedback.
 const anchors={},tags={},tagLayer=document.querySelector('.tags');let carX=-1;
 for(const el of tagLayer?.querySelectorAll('[data-tag]')||[])tags[el.dataset.tag]={el,value:el.querySelector('b'),active:false,settledAt:0,shown:''};
 const doors=[],windows=[],glass=[],lamps=[],trim=[],cabinSurfaces=[],wheels=[],airLevel={value:0,velocity:0},fanVisual={value:state.fan,velocity:0},view={value:0,velocity:0};
 let renderer;
 try{
 renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.75));renderer.setClearColor(0x000000,0);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.02;
 renderer.localClippingEnabled=true;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;container.appendChild(renderer.domElement);
 const scene=new THREE.Scene();
 const camera=new THREE.PerspectiveCamera(35,1,.03,100),camPos=new THREE.Vector3(),camTarget=new THREE.Vector3(0,.7,0);
 const studio=new RoomEnvironment();
 for(const [x,y,z,w,h,tint,power,rx,ry]of [[-4,4,0,1.2,9,0xe4f2ff,1.8,-Math.PI/2,0],[4,2,-1,.5,8,0x95b8cc,1.2,0,Math.PI/2],[0,5,-4,8,.8,0xffffff,1.6,-Math.PI/2,0]]){const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({color:tint,side:THREE.DoubleSide}));m.material.color.multiplyScalar(power);m.position.set(x,y,z);m.rotation.set(rx,ry,0);studio.add(m);}
 const pmrem=new THREE.PMREMGenerator(renderer),environment=pmrem.fromScene(studio,.025).texture;scene.environment=environment;scene.environmentIntensity=.65;pmrem.dispose();studio.dispose();
 scene.add(new THREE.HemisphereLight(0xc6d9ef,0x080c13,.95));
 const key=new THREE.DirectionalLight(0xfff1e9,1.8);key.position.set(-3,7,-4);key.castShadow=true;key.shadow.mapSize.set(2048,2048);Object.assign(key.shadow.camera,{left:-6,right:6,top:6,bottom:-6,near:.1,far:25});key.shadow.bias=-.00015;key.shadow.normalBias=.018;scene.add(key);
 const rim=new THREE.DirectionalLight(0xa8c5d8,.5);rim.position.set(5,2,2);scene.add(rim);
 const fill=new THREE.DirectionalLight(0xe8eaff,.55);fill.position.set(-5,1,4);scene.add(fill);
 const overhead=new THREE.DirectionalLight(0xf1f4fb,.85);overhead.position.set(.4,10,.6);scene.add(overhead);
 const paints={silver:['#c9ced6',.62,.24],graphite:['#34383f',.7,.3],midnight:['#16233a',.65,.26],pearl:['#e6e4df',.12,.2],red:['#ac1023',.28,.31]};
 const paint=paints[new URLSearchParams(location.search).get('paint')]||paints.silver;
 // Short-range interior lights illuminate seats and door trim; no additional shadow passes.
 const cabinLights=[];
 for(const z of[-.28,.8])for(const x of[-.5,.5]){const light=new THREE.SpotLight(0x86dcff,0,2.3,1.0,.9,2);light.position.set(x,1.16,z);light.target.position.set(x*.25,.45,z);scene.add(light,light.target);cabinLights.push(light);}
 // One real planar reflection pass, softened and attenuated like dark wet asphalt.
 const ground=new Reflector(new THREE.PlaneGeometry(160,160),{textureWidth:1024,textureHeight:1024,clipBias:.003,multisample:0,color:0x25384b,shader:{
  uniforms:{color:{value:null},tDiffuse:{value:null},textureMatrix:{value:null},travel:{value:0},roadLevel:{value:1},lineTint:{value:new THREE.Color(.07,.1,.13)}},
  vertexShader:`uniform mat4 textureMatrix;varying vec4 vUv;varying vec3 world;void main(){world=(modelMatrix*vec4(position,1.)).xyz;vUv=textureMatrix*vec4(position,1.);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader:`uniform sampler2D tDiffuse;uniform float travel;uniform float roadLevel;uniform vec3 lineTint;varying vec4 vUv;varying vec3 world;
   float stripe(float p,float c,float w){return 1.-smoothstep(w,w+.025,abs(p-c));}
   void main(){vec2 uv=vUv.xy/vUv.w;vec3 refl=vec3(0.);float weight=0.;
    // Dense Gaussian taps avoid visibly displaced copies of wheels and body edges.
    for(int x=-3;x<=3;x++){for(int y=-3;y<=3;y++){
     vec2 tap=vec2(float(x),float(y));float w=exp(-dot(tap,tap)/4.5);
     refl+=texture2D(tDiffuse,uv+tap/1024.).rgb*w;weight+=w;
    }}refl/=weight;
    float fade=exp(-length(world.xz)*.095);float grain=fract(sin(dot(world.xz*130.,vec2(12.9898,78.233)))*43758.5453);
    vec3 base=vec3(.006,.007,.016)+grain*.0018;
    float dash=1.-smoothstep(2.8,3.,mod(world.z-travel+500.,6.));
    float markings=stripe(world.x,1.85,.025)+stripe(world.x,-1.85,.03)*dash+stripe(world.x,-5.55,.025);
    float trace=exp(-pow(abs(world.x)-1.85,2.)*20.)*.08;
    float shadow=1.-.64*exp(-pow(world.x/.9,6.)-pow(world.z/2.25,8.));
    float pool=1.-smoothstep(.3,1.,length(world.xz/vec2(6.5,8.5)));
    gl_FragColor=vec4(base*shadow+refl*.085*exp(-length(world.xz)*.32)*shadow+lineTint*markings*fade*roadLevel+lineTint*1.6*trace*fade*roadLevel,pool);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
   }`}});
 ground.material.transparent=true;ground.material.depthWrite=false;ground.rotation.x=-Math.PI/2;ground.position.y=-.008;scene.add(ground);
 const shadow=new THREE.Mesh(new THREE.PlaneGeometry(25,25),new THREE.ShadowMaterial({opacity:.38,depthWrite:false}));shadow.rotation.x=-Math.PI/2;shadow.position.y=-.005;shadow.receiveShadow=true;scene.add(shadow);
 const headlights=new THREE.Group();scene.add(headlights);for(const x of[-.7,.7]){const l=new THREE.SpotLight(0xd8edff,22,14,.36,.8,2);l.position.set(x,.7,-2);l.target.position.set(x,.02,-8);headlights.add(l,l.target);}
 // Flow starts at estimated dash / rear-console vent positions, not at screen labels.
 const air=new THREE.Group();scene.add(air);let airClock=0;
 const airUniforms={time:{value:0},level:{value:0},tint:{value:new THREE.Color('#25b0ef')}};
 const flowMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,depthTest:false,side:THREE.DoubleSide,blending:THREE.NormalBlending,toneMapped:false,uniforms:airUniforms,
  vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader:`varying vec2 vUv;uniform float time;uniform float level;uniform vec3 tint;
   void main(){float edge=pow(sin(vUv.y*3.14159),1.2);float ends=smoothstep(0.,.07,vUv.x)*(1.-smoothstep(.65,1.,vUv.x));
    float wave=pow(.5+.5*cos(vUv.x*14.-time*3.+vUv.y*.7),3.);float core=exp(-pow((vUv.y-.5)*7.,2.));
    float alpha=edge*ends*level*(.2+.6*wave+.1*core);gl_FragColor=vec4(tint,alpha);}`});
 const flowPaths=[],flowVeils=[],zoneLevels=[{value:1,velocity:0},{value:1,velocity:0}];
 for(const row of[0,1])for(const side of[-1,1]){
  const x=side*(row?.12:.4),z=row?.08:-.796,y=row?.60:.89;
  const path=new THREE.CatmullRomCurve3([new THREE.Vector3(x,y,z),new THREE.Vector3(x+side*.06,y+.15,z+.3),new THREE.Vector3(x+side*.13,row?1.03:1.14,z+.73),new THREE.Vector3(x+side*.2,row?1.04:1.08,z+1.08)]);flowPaths.push(path);
  const positions=[],uv=[],indices=[];
  for(let i=0;i<=48;i++){const t=i/48,point=path.getPoint(t),spread=.07+t*.24;for(const edge of[-1,1]){positions.push(point.x+edge*spread,point.y,point.z);uv.push(t,(edge+1)/2);}if(i<48){const n=i*2;indices.push(n,n+1,n+2,n+1,n+3,n+2);}}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geo.setIndex(indices);const veil=new THREE.Mesh(geo,flowMaterial.clone());veil.material.uniforms={...airUniforms,level:{value:0}};flowVeils.push({material:veil.material,row});veil.renderOrder=6;air.add(veil);
 }
 // Moving soft particles provide unmistakable direction without turning the air into pipes.
 const particlePositions=new Float32Array(4*28*3),particleAlpha=new Float32Array(4*28),particleGeometry=new THREE.BufferGeometry();
 particleGeometry.setAttribute('position',new THREE.BufferAttribute(particlePositions,3).setUsage(THREE.DynamicDrawUsage));particleGeometry.setAttribute('alpha',new THREE.BufferAttribute(particleAlpha,1).setUsage(THREE.DynamicDrawUsage));
 const particleMaterial=new THREE.ShaderMaterial({uniforms:airUniforms,transparent:true,depthTest:false,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false,
  vertexShader:'attribute float alpha;varying float strength;void main(){strength=alpha;vec4 p=modelViewMatrix*vec4(position,1.);gl_PointSize=clamp(30./-p.z,2.,5.);gl_Position=projectionMatrix*p;}',
  fragmentShader:'uniform vec3 tint;uniform float level;varying float strength;void main(){float d=length(gl_PointCoord-.5);gl_FragColor=vec4(tint,(1.-smoothstep(.08,.5,d))*strength*level*.38);}'});
 const particles=new THREE.Points(particleGeometry,particleMaterial);particles.frustumCulled=false;particles.renderOrder=7;air.add(particles);
 const lightRibbons=[];
 const ambientGroup=new THREE.Group();scene.add(ambientGroup);const ambientStrips=[];
 const ambientMat=new THREE.MeshBasicMaterial({color:0x86dcff,transparent:true,opacity:0,depthWrite:false,depthTest:true,toneMapped:false,blending:THREE.AdditiveBlending});
 const ambientHalo=ambientMat.clone();
 // Each ribbon owns its colour so a change can travel front-to-back through the cabin.
 const ribbons=[];
 function lightRibbon(points,parent=ambientGroup){
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),group=new THREE.Group(),core=ambientMat.clone(),halo=ambientHalo.clone();
  group.add(new THREE.Mesh(new THREE.TubeGeometry(curve,32,.012,6,false),core));
  group.add(new THREE.Mesh(new THREE.TubeGeometry(curve,32,.035,8,false),halo));
  ribbons.push({core,halo,z:points.reduce((s,p)=>s+p[2],0)/points.length,color:new THREE.Color(0x86dcff),level:0,flash:0,seen:''});
  parent.add(group);lightRibbons.push(group);return group;
 }
 for(const [x,side]of[[-.69,'l'],[.69,'r']])for(const [start,end,row]of[[-.72,.17,'f'],[.23,1.03,'r']]){
  const strip=lightRibbon([[x,1.025,start],[x,1.01,(start+end)/2],[x,.985,end]]);
  ambientStrips.push({node:strip,door:'door_'+side+row+'_dummy'});
 }
 lightRibbon([[-.68,1.02,-.78],[0,1.035,-.88],[.68,1.02,-.78]]);
 lightRibbon([[-.6,.96,1.12],[0,.95,1.17],[.6,.96,1.12]]);
 const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);loader.load('./assets/family-sedan.70259c87b911.glb',gltf=>{
  model=new THREE.Group();const car=gltf.scene;car.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(car),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3()),scale=4.7/size.z;
  car.position.set(-center.x,-bounds.min.y,-center.z);model.add(car);model.scale.setScalar(scale);scene.add(model);model.updateMatrixWorld(true);
  car.traverse(o=>{if(!o.isMesh)return;o.castShadow=true;o.receiveShadow=true;const original=Array.isArray(o.material)?o.material:[o.material];const copies=original.map(m=>{if(/primary|paint_black/.test((o.name+' '+m.name).toLowerCase())){const coat=new THREE.MeshPhysicalMaterial();THREE.MeshStandardMaterial.prototype.copy.call(coat,m);coat.clearcoat=1;coat.clearcoatRoughness=.08;return coat;}return m.clone();});o.material=Array.isArray(o.material)?copies:copies[0];
   copies.forEach(m=>{const name=(o.name+' '+m.name).toLowerCase();m.envMap=environment;m.envMapIntensity=.6;for(const k of['map','normalMap','roughnessMap','metalnessMap'])if(m[k])m[k].anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
    if(/primary|paint_black/.test(name)){m.color.set(paint[0]);m.metalness=paint[1];m.roughness=paint[2];m.vertexColors=false;m.transparent=false;m.depthWrite=true;m.needsUpdate=true;}
    if(/glass/.test(name)){m.color.set('#355262');m.transparent=true;m.opacity=.4;m.depthWrite=false;m.metalness=.05;m.roughness=.25;m.envMapIntensity=.25;glass.push(m);}
    if(/seat.*leather|leather_white/.test(name)){m.color.set('#c6d0d5');m.roughness=.8;m.metalness=.03;m.envMapIntensity=.85;m.emissive.set('#172a36');m.emissiveIntensity=.12;}
    if(/right_front_light|left_front_light|foglight/.test(name)){m.emissive.set('#bde8ff');lamps.push({m,front:true});}
    if(/right_rear_light|left_rear_light|breaklight/.test(name)){m.emissive.set('#e62424');lamps.push({m,front:false});}
    if(/seat|leather|carpet|plastic|putih|interiorlights/.test(name)&&!/primary|glass|light_pantulan/.test(name)){if(m.emissive)cabinSurfaces.push({m,base:m.emissive.clone(),intensity:m.emissiveIntensity});}
    if(/interiorlights/.test(name)){m.emissive.set('#86dcff');trim.push(m);}
    if(/platnomor/.test(name))o.visible=false;
    // The source asset contains emissive imitation-reflection decals. They are not lamps.
    if(/pantulans|light_pantulan/.test(name))o.visible=false;
   });
  });
  const normalized=name=>{let found;car.traverse(o=>{if(o.name.replace(/[^a-z0-9_-]/gi,'').toLowerCase()===name.toLowerCase())found=o;});return found;};
  for(const [name,key,sign]of [['door_lf_dummy','leftDoor',-1],['door_lr_dummy','rearLeftDoor',-1],['door_rf_dummy','rightDoor',1],['door_rr_dummy','rearRightDoor',1]]){const n=normalized(name);if(n){const materials=[];n.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])if(/primary/.test(m.name))materials.push(m);});doors.push({node:n,key,base:n.quaternion.clone(),sign,materials});const box=new THREE.Box3().setFromObject(n),c=box.getCenter(new THREE.Vector3());anchors[key]={node:n,local:n.worldToLocal(new THREE.Vector3(box.max.x>0?box.max.x:box.min.x,box.max.y,c.z))};}}
  for(const strip of ambientStrips){const parent=normalized(strip.door);if(parent)parent.attach(strip.node);}
  for(const [name,key] of [['door_lf_glass0_0','leftWindow'],['door_lr_glass0_0','rearLeftWindow'],['door_rf_glass0_0','rightWindow'],['door_rr_glass0_0','rearRightWindow']]){const n=normalized(name);if(!n)continue;const base=n.position.clone(),world=n.getWorldPosition(new THREE.Vector3()),localStart=n.parent.worldToLocal(world.clone()),localEnd=n.parent.worldToLocal(world.clone().add(new THREE.Vector3(0,-.46,0)));
   // Clip below each window's original lower edge, never toggle visibility at the end.
   const box=new THREE.Box3().setFromObject(n),plane=new THREE.Plane(new THREE.Vector3(0,1,0),-box.min.y),c=box.getCenter(new THREE.Vector3());
   anchors[key]={node:n,local:n.worldToLocal(new THREE.Vector3(c.x,box.max.y,c.z))};
   for(const m of Array.isArray(n.material)?n.material:[n.material]){m.clippingPlanes=[plane];m.needsUpdate=true;}
   const highlightMaterial=new THREE.MeshBasicMaterial({color:0xcfdcec,transparent:true,opacity:0,depthWrite:false,depthTest:false,side:THREE.DoubleSide,clippingPlanes:[plane],toneMapped:false});
   const highlight=new THREE.Mesh(n.geometry,highlightMaterial);highlight.renderOrder=8;n.add(highlight);
   const edgeMaterial=new THREE.LineBasicMaterial({color:0xf2f6ff,transparent:true,opacity:0,depthWrite:false,depthTest:false,clippingPlanes:[plane],toneMapped:false});
   const edge=new THREE.LineSegments(new THREE.EdgesGeometry(n.geometry,40),edgeMaterial);edge.renderOrder=9;n.add(edge);
   windows.push({node:n,key,base,travel:localEnd.sub(localStart),highlightMaterial,edgeMaterial,highlight,edge});
  }
  // Each wheel mesh group is rotated about its own measured world-space axle.
  const wheelNodes=[];car.traverse(o=>{if(!o.isMesh&&isWheelGroup(o.name))wheelNodes.push(o);});wheelNodes.forEach(o=>{const box=new THREE.Box3().setFromObject(o);if(box.isEmpty())return;const pivot=new THREE.Group();pivot.position.copy(box.getCenter(new THREE.Vector3()));scene.add(pivot);pivot.attach(o);pivot.name=o.name;wheels.push(pivot);});
  container.dataset.model='ready';container.dataset.readyMs=String(Math.round(performance.now()));container.dataset.seating='left-hand-drive-front-and-rear';document.querySelector('.loading')?.remove();onReady();
 },e=>{const l=document.querySelector('.loading');if(e.total&&l)l.firstChild.textContent=`正在载入座舱 ${Math.round(e.loaded/e.total*100)}%`;},e=>{console.error(e);document.querySelector('.loading').innerHTML='车辆暂未载入，控制仍可使用<button id="retry-model">重新加载</button>';document.querySelector('#retry-model').onclick=()=>location.reload();});
 // The mirror pass shows physical surfaces, not explanatory overlays or cabin glow.
 // Restore every value immediately: the main view retains all feedback and lighting.
 const reflectScene=ground.onBeforeRender;
 ground.onBeforeRender=function(...args){
  const hidden=[air,...lightRibbons,...cabinLights,...windows.flatMap(w=>[w.highlight,w.edge])];
  const visibility=hidden.map(node=>[node,node.visible]);
  const materials=new Set([...trim,...cabinSurfaces.map(x=>x.m),...doors.flatMap(d=>d.materials)]);
  const emissions=[...materials].map(m=>[m,m.emissiveIntensity]);
  try{
   for(const node of hidden)node.visible=false;
   for(const m of materials)m.emissiveIntensity=0;
   reflectScene.apply(this,args);
  }finally{
   for(const [node,visible]of visibility)node.visible=visible;
   for(const [material,intensity]of emissions)material.emissiveIntensity=intensity;
  }
 };
 const dest=new THREE.Vector3(),zAxis=new THREE.Vector3(0,0,1),q=new THREE.Quaternion(),tint=new THREE.Color(),cabinTint=new THREE.Color(),cold=new THREE.Color('#25b0ef'),warm=new THREE.Color('#f2bd86'),neutral=new THREE.Color('#c9e1e4'),tagPoint=new THREE.Vector3(),tagFixed=new THREE.Vector3();
 let ambientSeen=`${state.ambient}${state.ambientColor}${state.ambientBrightness}`,ambientChangedAt=-1e9;
 for(const r of ribbons){r.seen=ambientSeen;r.color.set(palette[state.ambientColor].hex);r.level=state.ambient?state.ambientBrightness/100:0;}
 let firstFrame=true,shot=null,shotUntil=0,shotStarted=0,shotDirection=1,wasShotActive=false,idleResumeAt=performance.now()+12000;let orbit=createIdleOrbit(Math.PI*.13);const lookDest=new THREE.Vector3(0,.7,0);const shotMix={value:0,velocity:0};
 const resize=()=>{width=container.clientWidth;height=shell.clientHeight;renderer.setSize(width,height);camera.aspect=width/height;camera.setViewOffset(width,height,-width*(width<560?0:width<900?.075:.18),height*(width<560?-.10:width<900?.055:.015),width,height);camera.updateProjectionMatrix();};new ResizeObserver(resize).observe(shell);resize();
 const pauseIdle=(delay=12000)=>{idleResumeAt=performance.now()+delay;};
 addEventListener('pointerdown',()=>pauseIdle());addEventListener('keydown',()=>pauseIdle());
 document.addEventListener('visibilitychange',()=>pauseIdle());
 container.addEventListener('pointerdown',e=>{down=true;shotUntil=0;shot=null;drag=view.value;orbit=createIdleOrbit(Math.PI*.13+drag,Math.PI*.13+drag);pauseIdle(20000);startX=e.clientX;container.setPointerCapture(e.pointerId);});container.addEventListener('pointermove',e=>{if(down){drag+=(e.clientX-startX)*.004;startX=e.clientX;orbit=createIdleOrbit(Math.PI*.13+drag,Math.PI*.13+drag);}});const endDrag=()=>{down=false;const angle=nearestAngle(0,Math.PI*.13+view.value);orbit=createIdleOrbit(Math.max(-ORBIT_AMPLITUDE,Math.min(ORBIT_AMPLITUDE,angle)),0);pauseIdle(20000);};container.addEventListener('pointerup',endDrag);container.addEventListener('pointercancel',endDrag);
 let then=performance.now(),frameCount=0,frameTime=0;
 function frame(now){requestAnimationFrame(frame);const dt=Math.max(0,Math.min((now-then)/1000,.05));then=now;if(document.hidden)return;const smooth=1-Math.exp(-dt*3),mobile=width<900;
  frameCount++;frameTime+=dt;if(frameTime>1){container.dataset.fps=(frameCount/frameTime).toFixed(0);frameCount=0;frameTime=0;}
  stepMotion(motion,state,dt);state.motionPhase=motion.phase;state.motionSpeed=motion.speed.value;
  if(motion.phase!==lastPhase){lastPhase=motion.phase;onMotion(motion.phase);}
  // Approach a nearby useful view, gently track the subject, then continue from there.
  const active=shot&&!reduced&&now<shotUntil;
  if(wasShotActive&&!active){const angle=Math.PI*.13+view.value;orbit=createIdleOrbit(Math.max(-ORBIT_AMPLITUDE,Math.min(ORBIT_AMPLITUDE,nearestAngle(0,angle))),0);idleResumeAt=now+1800;}
  wasShotActive=!!active;
  damp(shotMix,active?1:0,dt,active?.95:1.8);
  const voiceBusy=['listening','processing','speaking'].includes(state.voicePhase);
  const blocked=voiceBusy||down||active||!motionSettled(motion,state)||!!document.querySelector('dialog[open],#remote-panel:not([hidden])');
  if(blocked)idleResumeAt=Math.max(idleResumeAt,now+1800);
  const idleEnabled=!reduced&&!blocked&&now>=idleResumeAt;
  const baseAngle=down?Math.PI*.13+drag:stepIdleOrbit(orbit,idleEnabled,dt);
  container.dataset.idleOrbit=idleEnabled?'moving':'paused';
  container.dataset.orbitAngle=(orbit.angle*180/Math.PI).toFixed(2);
  const progress=active?Math.min(1,(now-shotStarted)/(shotUntil-shotStarted)):0;
  const tracking=shotDirection*.12*(progress*progress*(3-2*progress));
  const goal=active?nearestAngle(Math.PI*.13+view.value,shot.angle+tracking)-Math.PI*.13:nearestAngle(Math.PI*.13+view.value,baseAngle)-Math.PI*.13;
  damp(view,goal,dt,down?.35:active?1.15:3.2);
  const blend=shotMix.value,angle=Math.PI*.13+view.value;
  const dist=(width<560?18:mobile?11.8:9)+(shot?shot.distance-9-(active?.18*progress:0):0)*blend;
  const elevation=(mobile?5.2:4.1)+(shot?shot.height-4.1:0)*blend;
  dest.set(Math.sin(angle)*dist,elevation,Math.cos(angle)*dist);
  lookDest.set(0,.7+(shot?shot.targetY-.7:0)*blend,(shot?.targetZ||0)*blend);
  if(firstFrame){camPos.copy(dest);camTarget.copy(lookDest);firstFrame=false;}else{camPos.lerp(dest,smooth);camTarget.lerp(lookDest,smooth);}
  camera.position.copy(camPos);camera.lookAt(camTarget);
  // lookAt changes the quaternion AFTER updating matrixWorld. Project labels
  // with the new inverse now, matching the camera used by renderer this frame.
  camera.updateMatrixWorld(true);
  container.dataset.shot=active?shot.name:'overview';
  container.dataset.shotSettled=String(!!active&&Math.abs(view.value-goal)<.025&&Math.abs(shotMix.value-1)<.025);
  for(const d of doors){d.node.quaternion.copy(d.base).multiply(q.setFromAxisAngle(zAxis,motion.doors[d.key].value*d.sign*1.05));const glow=now<(doorPulseUntil[d.key]||0)?.12:0;for(const m of d.materials){m.emissive.set('#45caff');m.emissiveIntensity=THREE.MathUtils.lerp(m.emissiveIntensity,glow,smooth);}}
  for(const w of windows){w.node.position.copy(w.base).addScaledVector(w.travel,motion.windows[w.key].value);const active=now<(windowPulseUntil[w.key]||0);w.highlightMaterial.opacity=THREE.MathUtils.lerp(w.highlightMaterial.opacity,active?.12:0,smooth);w.edgeMaterial.opacity=THREE.MathUtils.lerp(w.edgeMaterial.opacity,active?.7:0,smooth);}
  for(const [key,t]of Object.entries(tags)){
   const a=anchors[key];if(!t.active||!a){if(t.shown!=='off'){t.el.classList.remove('on');t.shown='off';}continue;}
   const channel=key in motion.windows?motion.windows[key]:motion.doors[key],settled=Math.abs(channel.value-state[key]/100)<.004;
   if(settled&&!t.settledAt)t.settledAt=now;else if(!settled)t.settledAt=0;
   if(t.settledAt&&now>t.settledAt+2600){t.active=false;continue;}
   // The label stays at the closed glass edge; only the dot rides down with the moving glass.
   a.node.localToWorld(tagPoint.copy(a.local));tagFixed.copy(tagPoint);if(key in motion.windows)tagFixed.y+=.46*channel.value;
   const facing=Math.sign(tagPoint.x)*(camera.position.x-tagPoint.x)/camera.position.distanceTo(tagPoint);
   tagPoint.project(camera);tagFixed.project(camera);
   const x=(tagFixed.x+1)/2*width,y=(1-tagFixed.y)/2*height,drop=Math.max(0,(tagFixed.y-tagPoint.y)/2*height),visible=THREE.MathUtils.smoothstep(facing,.12,.4);
   t.el.style.transform=`translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;t.el.style.opacity=visible.toFixed(3);t.el.style.setProperty('--drop',drop.toFixed(1)+'px');
   const text=Math.round(channel.value*100)+'%';if(t.value.textContent!==text)t.value.textContent=text;
   const mode=settled?'done':'moving';if(t.shown!==mode){t.el.classList.add('on');t.el.classList.toggle('done',settled);t.shown=mode;}
  }
  if(model){tagPoint.set(0,.7,0).project(camera);const x=Math.round((tagPoint.x+1)/2*width);if(Math.abs(x-carX)>2){carX=x;shell.style.setProperty('--car-x',x+'px');}}
  glass.forEach(m=>m.opacity=THREE.MathUtils.lerp(m.opacity,.4-airLevel.value*.2,smooth));
  const positions=Object.fromEntries(windowKeys.map(k=>[k,Math.round(motion.windows[k].value*100)])),doorPositions=Object.fromEntries(doorKeys.map(k=>[k,Math.round(motion.doors[k].value*100)])),signature=[...Object.values(positions),...Object.values(doorPositions)].join(',');if(signature!==lastWindowSignature){lastWindowSignature=signature;onTelemetry({windowPositions:positions,doorPositions});}state.windowPositions=positions;state.doorPositions=doorPositions;
  if(!reduced)roadClock+=motion.speed.value*8*dt;ground.material.uniforms.travel.value=roadClock;ground.material.uniforms.roadLevel.value=THREE.MathUtils.lerp(ground.material.uniforms.roadLevel.value,motion.phase==='parked'?0:1,smooth);
  // Negative X rotation rolls this -Z-facing vehicle forward.
  for(const wheel of wheels)wheel.rotation.x=-roadClock/.34;
  container.dataset.wheelRotations=wheels.map(w=>w.name+':'+w.rotation.x.toFixed(3)).join(',');
  for(const {m,front}of lamps)m.emissiveIntensity=THREE.MathUtils.lerp(m.emissiveIntensity,state.lights?(front?1.8:motion.phase==='braking'?2.7:1.1):0,smooth);
  headlights.children.forEach(l=>{if(l.isSpotLight)l.intensity=THREE.MathUtils.lerp(l.intensity,state.lights?22:0,smooth);});
  tint.set(palette[state.ambientColor].hex);ambientMat.color.lerp(tint,smooth);
  ambientMat.opacity=THREE.MathUtils.lerp(ambientMat.opacity,state.ambient?state.ambientBrightness/100:0,smooth);
  const lightLevel=ambientMat.opacity;
  const ambientKey=`${state.ambient}${state.ambientColor}${state.ambientBrightness}`,ambientTarget=state.ambient?state.ambientBrightness/100:0,quick=1-Math.exp(-dt*5);
  if(ambientKey!==ambientSeen){ambientSeen=ambientKey;ambientChangedAt=now;}
  for(const r of ribbons){
   const reached=reduced||now-ambientChangedAt>=(r.z+.95)*380;
   if(reached&&r.seen!==ambientKey){r.seen=ambientKey;r.flash=ambientTarget>0?1:0;}
   if(reached){r.color.lerp(tint,quick);r.level=THREE.MathUtils.lerp(r.level,ambientTarget,quick);}
   r.flash*=Math.exp(-dt*2.6);
   r.core.color.copy(r.color).multiplyScalar(1+r.flash*1.2);r.core.opacity=Math.min(1,r.level+r.flash*.25);
   r.halo.color.copy(r.color);r.halo.opacity=r.level*.11*(1+r.flash*2.5);
  }
  ground.material.uniforms.lineTint.value.copy(ambientMat.color).lerp(neutral,.65).multiplyScalar(.035+lightLevel*.025);
  for(const light of cabinLights){light.color.copy(ambientMat.color);light.intensity=lightLevel*4.5;}
  cabinTint.copy(ambientMat.color).multiplyScalar(lightLevel*.22);for(const {m,base,intensity} of cabinSurfaces){m.emissive.copy(base).multiplyScalar(intensity).add(cabinTint);m.emissiveIntensity=1;}
  trim.forEach(m=>{m.emissive.copy(ambientMat.color);m.emissiveIntensity=lightLevel*1.5;});
  damp(fanVisual,state.fan,dt,.35);damp(airLevel,state.ac&&(state.frontAir||state.rearAir)?1:0,dt,.5);zoneLevels.forEach((z,i)=>damp(z,state[i?"rearAir":"frontAir"]?1:0,dt,.5));for(const f of flowVeils)f.material.uniforms.level.value=airLevel.value*zoneLevels[f.row].value*(.45+.55*fanVisual.value/5);if(!reduced)airClock+=dt*(.55+fanVisual.value*.2);airUniforms.time.value=airClock;airUniforms.level.value=airLevel.value;airUniforms.tint.value.lerp(state.climateMode==='heat'?warm:state.climateMode==='cool'?cold:neutral,smooth);air.visible=airLevel.value>.001;
  for(let row=0;row<4;row++)for(let j=0;j<28;j++){const t=(j/28+airClock*.19)%1,p=flowPaths[row].getPoint(t),i=row*28+j,spread=(.035+t*.15)*Math.sin(j*7.13);particlePositions[i*3]=p.x+spread;particlePositions[i*3+1]=p.y+.018*Math.cos(j*3.7);particlePositions[i*3+2]=p.z;particleAlpha[i]=Math.sin(t*Math.PI)*zoneLevels[Math.floor(row/2)].value;}
  particleGeometry.attributes.position.needsUpdate=true;particleGeometry.attributes.alpha.needsUpdate=true;

  for(let i=pending.length-1;i>=0;i--){const p=pending[i];if(Object.entries(p.patch).some(([k,v])=>state[k]!==v)||motionSettled(motion,p.patch)){p.resolve();pending.splice(i,1);}}
  container.dataset.climateMode=state.climateMode;container.dataset.fanVisual=fanVisual.value.toFixed(3);container.dataset.airTint=airUniforms.tint.value.getHexString();container.dataset.air=airLevel.value.toFixed(2);container.dataset.airFront=(airLevel.value*zoneLevels[0].value).toFixed(2);container.dataset.airRear=(airLevel.value*zoneLevels[1].value).toFixed(2);container.dataset.ambientIntensity=ambientMat.opacity.toFixed(3);container.dataset.doors=doors.map(d=>`${d.key}:${(motion.doors[d.key].value*1.05).toFixed(3)}`).join(',');container.dataset.windows=windowKeys.map(k=>k+':'+motion.windows[k].value.toFixed(4)).join(',');container.dataset.speed=motion.speed.value.toFixed(4);container.dataset.phase=motion.phase;container.dataset.camera=camPos.toArray().map(x=>x.toFixed(4)).join(',');container.dataset.road=roadClock.toFixed(3);container.dataset.reflection='physical-surfaces-only';
  renderer.render(scene,camera);
 }requestAnimationFrame(frame);
 return {whenSettled:patch=>new Promise(resolve=>pending.push({patch,resolve})),pulse:patch=>{if(Object.keys(patch).length)pauseIdle();const angle=Math.PI*.13+view.value,planned=selectShot(patch,angle);if(planned&&!down&&!reduced){const delta=nearestAngle(angle,planned.angle)-angle;shotDirection=Math.abs(delta)>.05?Math.sign(delta):1;shot=planned;shotStarted=performance.now();shotUntil=shotStarted+6500+Math.min(2000,Math.abs(delta)*900);}const until=performance.now()+4300;for(const k of windowKeys)if(k in patch)windowPulseUntil[k]=until;for(const k of doorKeys)if(k in patch||patch.locked===true)doorPulseUntil[k]=until;
  if(Object.keys(patch).length<=8)for(const k of [...windowKeys,...doorKeys])if(tags[k]&&(k in patch||patch.locked===true&&motion.doors[k]?.value>.01)){tags[k].active=true;tags[k].settledAt=0;tags[k].shown='';}}};
 }catch(e){console.error(e);document.querySelector('.loading').textContent='此设备暂不支持三维显示，座舱控制仍可使用。';return {whenSettled:()=>Promise.resolve(),pulse:()=>{}};}
}
