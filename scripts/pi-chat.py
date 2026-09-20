"""Host-side terminal client. Only text/protocol commands cross into the cell."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import threading
import uuid


def safe(text):
    return ''.join(c for c in str(text) if c in '\n\t' or (ord(c)>=32 and not 127<=ord(c)<=159))


def main():
    parser=argparse.ArgumentParser(description='Chat with secure pi; approval stays in a separate terminal.')
    parser.add_argument('--resume',help='Resume a saved session UUID')
    args=parser.parse_args()
    if args.resume and not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',args.resume):
        parser.error('--resume must be a session UUID')
    root=Path(__file__).resolve().parents[1]
    process=subprocess.Popen(['bash',str(root/'scripts/pi.sh'),'--rpc'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                             text=True,bufsize=1,cwd=root,start_new_session=True)
    ready=threading.Event()
    write_lock=threading.Lock()
    resume_id=None
    def send(op,**params):
        command={'id':uuid.uuid4().hex,'op':op,**params}
        with write_lock:
            process.stdin.write(json.dumps(command,ensure_ascii=True)+'\n')
            process.stdin.flush()
        return command['id']
    def output():
        nonlocal resume_id
        try:
            for line in process.stdout:
                try: event=json.loads(line)
                except ValueError:
                    print('\n[pi] '+safe(line.rstrip()),flush=True)
                    continue
                kind=event.get('type')
                if kind=='ready':
                    print('\n会话：'+safe(event.get('session_id')),flush=True)
                    if args.resume: resume_id=send('resume',session_id=args.resume)
                    else: ready.set()
                elif kind=='assistant' and event.get('text'):
                    print('\npi> '+safe(event['text']),flush=True)
                elif kind=='approval_required':
                    approval=event.get('approval_id','')
                    print('\n待审批：'+safe(approval)+'\n请在另一个终端运行：bash scripts/policy.sh show '+safe(approval),flush=True)
                elif kind=='tool_start':print('\n[工具] '+safe(event.get('tool')),flush=True)
                elif kind=='finished':print('\n[已取消]' if event.get('cancelled') else '\n[完成]' if event.get('success') else '\n[执行失败]',flush=True)
                elif kind=='assistant' and event.get('error'):print('\n[错误] '+safe(event['error']),flush=True)
                elif kind=='response':
                    if not event.get('ok'):print('\n[错误] '+safe(event.get('error')),flush=True)
                    elif event.get('op')!='prompt':print('\n'+safe(json.dumps(event.get('result'),ensure_ascii=False,indent=2)),flush=True)
                    if event.get('id')==resume_id:
                        if not event.get('ok'):
                            send('close')
                            process.wait(timeout=10)
                        ready.set()
                elif kind in ('protocol_error','turn_error'):print('\n[错误] '+safe(event.get('error')),flush=True)
        finally:ready.set()
    reader=threading.Thread(target=output,daemon=True)
    reader.start()
    print('输入需求开始对话。/status /sessions /history /new /resume UUID /cancel /quit\n每轮模型请求在独立终端审批；执行中发新需求会返回 BUSY。',flush=True)
    try:
        ready.wait()
        while process.poll() is None:
            try: text=input('你> ').strip()
            except KeyboardInterrupt:
                send('cancel'); continue
            except EOFError:break
            if not text:continue
            if text=='/quit':break
            if text.startswith('/resume '):send('resume',session_id=text.split(maxsplit=1)[1])
            elif text in ('/status','/sessions','/history','/new','/cancel'):send(text[1:])
            elif text.startswith('/'):print('未知命令；输入 /quit 退出。')
            else:send('prompt',text=text)
    except (BrokenPipeError,OSError):
        print('pi 通信已关闭。')
    finally:
        if process.poll() is None:
            try:send('close')
            except (BrokenPipeError,OSError):pass
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.terminate(); process.wait(timeout=5)
        reader.join(timeout=1)

if __name__=='__main__':main()
