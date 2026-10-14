"""Use production prompt/message construction for single-decision text SFT."""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from single_call import build_decision_messages, validate_decision, PROTOCOL

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();rows=[]
    for line in args.input.read_text().splitlines():
        row=json.loads(line);inp=row['input']
        raw=json.dumps(row['output'],ensure_ascii=False,separators=(',',':'))
        _,state=validate_decision(raw,inp['state_before'])
        assert state==row['verification']['expected_state_after'],row['sample_id']
        messages,_=build_decision_messages(inp['user_text'],inp['state_before'],inp.get('history',[]))
        messages.append({'role':'assistant','content':raw})
        rows.append({'sample_id':row['sample_id'],'semantic_group_id':row['semantic_group_id'],
                     'split':row['split'],'protocol_version':PROTOCOL,'messages':messages,
                     'loss_scope':'final_assistant_output_only'})
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in rows))
    print(json.dumps({'exported_existing_rows':len(rows),'new_interactions':0,'output':str(args.output)},ensure_ascii=False))

if __name__=='__main__':main()
