"""Normalize only complete, whitelisted tool JSON; Qwen-Agent still executes/parses tools."""
import json

def normalize_tool_response(text):
 raw=text.strip()
 if raw.startswith('```json\n') and raw.endswith('\n```'):raw=raw[8:-4].strip()
 try:obj=json.loads(raw)
 except (ValueError,TypeError):return text
 if not isinstance(obj,dict) or set(obj)!={'name','arguments'}:return text
 if obj['name'] not in {'control_cabin','vehicle_control'} or not isinstance(obj['arguments'],dict):return text
 return '<tool_call>\n'+json.dumps(obj,ensure_ascii=False)+'\n</tool_call>'
