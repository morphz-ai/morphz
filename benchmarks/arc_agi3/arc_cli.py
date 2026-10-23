"""Public game observations only. Does not import the game engine or game source."""
import json
import pathlib
import sys
import urllib.error
import urllib.request

def build_request(port, args):
    command = args[0] if args else 'status'
    if command in ('status', 'observe'):
        if len(args) > 1:
            raise ValueError('status/observe do not accept arguments')
        return urllib.request.Request(f'http://127.0.0.1:{port}/{command}')
    if command == 'batch' and len(args) == 2:
        body = {'actions': json.loads(args[1])}
    elif command in ('action', 'step') and len(args) in (2, 4):
        body = {'action': args[1]}
        if len(args) == 4:
            body['data'] = {'x': int(args[2]), 'y': int(args[3])}
        if command == 'step':
            body['with_observation'] = True
    else:
        raise ValueError('Commands: status | observe | action/step ACTIONn [x y] | batch JSON')
    return urllib.request.Request(f'http://127.0.0.1:{port}/action',
        data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})


def main():
    root = pathlib.Path(__file__).resolve().parent
    port = json.loads((root/'connection.json').read_text())['port']
    try:
        request = build_request(port, sys.argv[1:])
        with urllib.request.urlopen(request, timeout=60) as result:
            print(result.read().decode())
    except urllib.error.HTTPError as exc:
        print(exc.read().decode())
        raise SystemExit(1)
    except (ValueError, IndexError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == '__main__':
    main()
