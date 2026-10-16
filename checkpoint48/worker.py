"""Authenticated GPU RPC: exact native cp48 + training template; no cabin execution."""
import base64,hashlib,io,json,os,secrets,socket,threading,time,urllib.request
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import numpy as np
import torch
from qwen_asr import Qwen3ASRModel
from audio_agent.models.native_decoder import configure_native_decoder,load_checkpoint_weights,compute_context

CHECKPOINT=Path(os.environ['VEHICLE_CHECKPOINT'])
OUTPUT=Path(os.environ['OUTPUT_ROOT']);OUTPUT.mkdir(parents=True,exist_ok=True)
PORT=int(os.environ.get('VEHICLE_RPC_PORT','18948'))
TOKEN=secrets.token_urlsafe(32);LOCK=threading.Lock()
contract=json.loads((CHECKPOINT/'prompt_contract.json').read_text())
assert contract['prompt_version']=='stage2_request_mixture_v1'
for relative,digest in contract['asset_sha256'].items():
 assert hashlib.sha256((CHECKPOINT/relative).read_bytes()).hexdigest()==digest,relative
bundle=CHECKPOINT/'prompt_assets/vehicle_tool_messages_v3'
TOOLS=json.loads((bundle/'tools.json').read_text());TEMPLATE=(bundle/'chat_template.jinja').read_text()
print('LOADING_NATIVE_CP48',flush=True)
wrapper=Qwen3ASRModel.from_pretrained(str(CHECKPOINT),dtype=torch.bfloat16,device_map='cuda:0',attn_implementation='sdpa',max_new_tokens=256,max_inference_batch_size=1)
configure_native_decoder(wrapper.model)
metadata=load_checkpoint_weights(wrapper.model,CHECKPOINT)
assert metadata['step']==48
wrapper.model.eval().requires_grad_(False)
tokenizer=wrapper.processor.tokenizer

@torch.inference_mode()
def generate(messages):
 prefix=tokenizer.apply_chat_template(messages,tools=TOOLS,chat_template=TEMPLATE,tokenize=False,add_generation_prompt=True,enable_thinking=False)
 ids=tokenizer.encode(prefix,add_special_tokens=False)
 if len(ids)>8192:raise ValueError('对话超过本次测试的上下文上限，请开启新会话')
 device=next(wrapper.model.parameters()).device
 ids=torch.tensor([ids],device=device);mask=torch.ones_like(ids);past=None;tokens=[];reason='max_tokens'
 eos={tokenizer.convert_tokens_to_ids(x) for x in ('<|im_end|>','<|endoftext|>')}
 for _ in range(384):
  position=(mask.cumsum(-1)-1)[:,-ids.shape[1]:].unsqueeze(0).expand(3,-1,-1)
  with compute_context(wrapper.model):
   out=wrapper.model.thinker.model(input_ids=ids,attention_mask=mask,position_ids=position,past_key_values=past,use_cache=True,return_dict=True)
   token=wrapper.model.thinker.lm_head(out.last_hidden_state[:,-1]).argmax(-1).item()
  if token in eos:reason='eos';break
  tokens.append(token);past=out.past_key_values
  ids=torch.tensor([[token]],device=device);mask=torch.cat([mask,torch.ones_like(ids)],dim=1)
 return {'text':tokenizer.decode(tokens,skip_special_tokens=False,clean_up_tokenization_spaces=False),'stop_reason':reason,'output_tokens':len(tokens),'input_tokens':mask.shape[1]-len(tokens),'prefix_sha256':hashlib.sha256(prefix.encode()).hexdigest()}

client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def send(self,status,value):
  body=json.dumps(value,ensure_ascii=False,allow_nan=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_GET(self):
  if not secrets.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN):return self.send(401,{'error':'unauthorized'})
  if self.path!='/health':return self.send(404,{})
  self.send(200,{'ready':True,'busy':LOCK.locked(),'checkpoint':str(CHECKPOINT),'step':48,'prompt_version':'vehicle_tool_messages_v3','gpu':torch.cuda.get_device_name(0),'native_precision':True})
 def do_POST(self):
  if not secrets.compare_digest(self.headers.get('Authorization',''),'Bearer '+TOKEN):return self.send(401,{'error':'unauthorized'})
  if not LOCK.acquire(False):return self.send(409,{'error':'model busy'})
  started=time.monotonic()
  try:
   size=int(self.headers.get('Content-Length',0))
   if not 0<size<=4000000:raise ValueError('Invalid body length')
   data=json.loads(self.rfile.read(size))
   if self.path=='/generate':result=generate(data['messages'])
   elif self.path=='/transcribe':
    pcm=base64.b64decode(data['pcm'],validate=True)
    if len(pcm)%2 or not 6400<=len(pcm)<=640000:raise ValueError('Invalid PCM length')
    wave=np.frombuffer(pcm,dtype='<i2').astype('float32')/32768
    with torch.inference_mode(),compute_context(wrapper.model):text=wrapper.transcribe(audio=[(wave,16000)])[0].text.strip()
    result={'text':text}
   elif self.path=='/synthesize':
    text=data['text']
    if not isinstance(text,str) or not 0<len(text)<=1600:raise ValueError('Invalid speech text')
    req=urllib.request.Request('http://127.0.0.1:18786/synthesize',data=json.dumps({'text':text,'language':'Chinese','speed':1.0}).encode(),headers={'Content-Type':'application/json'})
    with client.open(req,timeout=90) as response:audio=response.read()
    result={'wav':base64.b64encode(audio).decode()}
   else:raise ValueError('Unknown operation')
   result['seconds']=round(time.monotonic()-started,4);self.send(200,result)
  except Exception as e:
   import traceback;traceback.print_exc();self.send(500,{'error':str(e)})
  finally:LOCK.release()

manifest={'checkpoint':str(CHECKPOINT),'step':48,'prompt_contract':contract,'gpu':torch.cuda.get_device_name(0),'native_precision':True,'loaded_at':time.time()}
(OUTPUT/'loaded_model.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
server=ThreadingHTTPServer(('0.0.0.0',PORT),Handler)
endpoint=OUTPUT/'endpoint.json'
fd=os.open(endpoint,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump({'host':socket.gethostbyname(socket.gethostname()),'port':PORT,'token':TOKEN},f)
print('CP48_RPC_READY',flush=True)
server.serve_forever()
