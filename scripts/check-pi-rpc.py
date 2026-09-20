"""Real cell protocol regression. --live uses approved synthetic model prompts only."""
import argparse
import json
from pathlib import Path
import queue
import subprocess
import threading
import time
import uuid

parser=argparse.ArgumentParser()
parser.add_argument('--live',action='store_true')
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]

class Client:
    def __init__(self):
        self.events=queue.Queue();self.history=[]
        self.process=subprocess.Popen(['bash',str(root/'scripts/pi.sh'),'--rpc'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1)
        def read():
            for line in self.process.stdout:
                try:self.events.put(json.loads(line))
                except ValueError:pass
            self.events.put({'type':'eof'})
        threading.Thread(target=read,daemon=True).start()
        self.ready=self.wait(lambda e:e.get('type')=='ready',timeout=30)
    def wait(self,predicate,timeout=30):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            event=self.events.get(timeout=max(0.1,deadline-time.monotonic()))
            self.history.append(event)
            if event.get('type')=='approval_required':print(json.dumps(event),flush=True)
            if event.get('type')=='eof':raise RuntimeError('Unexpected EOF')
            if predicate(event):return event
        raise TimeoutError()
    def send(self,op,**params):
        command={'id':uuid.uuid4().hex,'op':op,**params}
        self.process.stdin.write(json.dumps(command)+'\n');self.process.stdin.flush()
        return command['id']
    def call(self,op,**params):
        request=self.send(op,**params)
        return self.wait(lambda e:e.get('type')=='response' and e.get('id')==request)
    def close(self):
        self.call('close');self.process.wait(timeout=10)
        assert self.process.returncode==0

client=Client()
try:
    # Pending approval must not block status/cancel, nor accept concurrent prompts.
    response=client.call('prompt',text='Protocol cancellation test only. Reply CANCEL_TEST. Do not use tools.')
    assert response['ok']
    session_id=response['result']['session_id']
    client.wait(lambda e:e.get('type')=='approval_required')
    assert client.call('status')['result']['busy']
    assert client.call('prompt',text='Must be rejected')['error']=='BUSY'
    started=time.monotonic()
    assert client.call('cancel')['result']['cancelled']
    assert time.monotonic()-started<5
    assert not client.call('status')['result']['busy']
    assert client.call('approve')['error']=='UNKNOWN_OPERATION'
    assert client.call('new')['ok']
    assert client.call('resume',session_id=session_id)['ok']
    assert 'CANCEL_TEST' in json.dumps(client.call('history'))
    client.close()
    # Restart the cell process and reopen the saved context without issuing model calls.
    client=Client()
    assert client.call('resume',session_id=session_id)['ok']
    assert 'CANCEL_TEST' in json.dumps(client.call('history'))
    assert client.call('resume',session_id='../auth.json')['error']=='INVALID_SESSION_ID'
    assert client.call('status')['result']['session_id']==session_id
    if args.live:
        assert client.call('new')['ok']
        marker='PI_RPC_MEMORY_'+uuid.uuid4().hex[:8]
        session_id=client.call('status')['result']['session_id']
        for prompt in [f'Remember this marker for our conversation: {marker}. Reply READY only. Do not use tools.',
                       'What exact marker did I ask you to remember? Reply with the marker only. Do not use tools.']:
            response=client.call('prompt',text=prompt)
            turn_id=response['result']['turn_id']
            finished=client.wait(lambda e:e.get('type')=='finished' and e.get('turn_id')==turn_id,timeout=600)
            assert finished['success'],finished
        text=[e['text'] for e in client.history if e.get('type')=='assistant' and e.get('text')][-1]
        assert marker in text,(marker,text)
        client.close();client=Client()
        assert client.call('resume',session_id=session_id)['ok']
        response=client.call('prompt',text='After reopening this session, repeat the remembered marker only. Do not use tools.')
        finished=client.wait(lambda e:e.get('type')=='finished' and e.get('turn_id')==response['result']['turn_id'],timeout=600)
        assert finished['success']
        text=[e['text'] for e in client.history if e.get('type')=='assistant' and e.get('text')][-1]
        assert marker in text
        print(json.dumps({'live_multiturn_and_restart':True,'session_id':session_id,'marker':marker}),flush=True)
    client.close()
    print(json.dumps({'rpc_cancel_busy_resume_restart':True}),flush=True)
finally:
    if client.process.poll() is None:
        client.process.stdin.close()
        try:client.process.wait(timeout=10)
        except subprocess.TimeoutExpired:client.process.terminate()
