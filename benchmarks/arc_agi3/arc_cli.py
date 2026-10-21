"""Public game observations only. Does not import the game engine or game source."""
import json
import pathlib
import sys
import urllib.error
import urllib.request

root=pathlib.Path(__file__).resolve().parent
port=json.loads((root/'connection.json').read_text())['port']
if len(sys.argv)==1 or sys.argv[1]=='status':
    request=urllib.request.Request(f'http://127.0.0.1:{port}/status')
else:
    # action ACTION1; action ACTION6 20 30; batch '[{"action":"ACTION1"}, ...]'
    if sys.argv[1]=='batch': body={'actions':json.loads(sys.argv[2])}
    elif sys.argv[1]=='action':
        body={'action':sys.argv[2]}
        if len(sys.argv)>=5: body['data']={'x':int(sys.argv[3]),'y':int(sys.argv[4])}
    else: raise SystemExit('Commands: status | action ACTIONn [x y] | batch JSON')
    request=urllib.request.Request(f'http://127.0.0.1:{port}/action',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
try:
    with urllib.request.urlopen(request,timeout=60) as result: print(result.read().decode())
except urllib.error.HTTPError as exc: print(exc.read().decode()); raise SystemExit(1)
