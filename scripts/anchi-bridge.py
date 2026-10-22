#!/usr/bin/python3 -I
"""The server end of `anchi --server`: joins this process's stdio, an SSH session's, to the Anchi
daemon's socket, or with `tcp <port>` to 127.0.0.1:<port> for a sign-in callback. SSH carries the
bytes and authenticates the user; the daemon socket stays 0600 and nothing listens on the network.
Installed as /usr/local/bin/anchi-bridge by scripts/remote.sh."""

import os
import socket
import sys
import threading


def target():
    if sys.argv[1:2] == ['tcp'] and len(sys.argv) == 3 and sys.argv[2].isdigit() and 1024 <= int(sys.argv[2]) <= 65535:
        return socket.AF_INET, ('127.0.0.1', int(sys.argv[2])), f'nothing listens on 127.0.0.1:{sys.argv[2]}'
    if len(sys.argv) != 1:
        raise SystemExit('usage: anchi-bridge [tcp <port 1024-65535>]')
    home = os.environ.get('ANCHI_HOME') or os.path.expanduser('~/.anchi')
    path = os.path.join(home, 'run', 'daemon.sock')
    return (
        socket.AF_UNIX,
        path,
        f'the Anchi daemon is not running here ({path}); start it: systemctl --user start anchi-daemon',
    )


def main():
    family, address, missing = target()
    conn = socket.socket(family, socket.SOCK_STREAM)
    try:
        conn.connect(address)
    except OSError:
        raise SystemExit(f'anchi-bridge: {missing}') from None

    def upstream():
        while chunk := os.read(0, 65536):
            conn.sendall(chunk)
        conn.shutdown(socket.SHUT_WR)

    threading.Thread(target=upstream, daemon=True).start()
    while chunk := conn.recv(65536):
        os.write(1, chunk)


if __name__ == '__main__':
    main()
