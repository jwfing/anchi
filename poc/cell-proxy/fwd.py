"""Byte forwarder between TCP and a Unix socket (PoC).

  fwd.py unix-to-tcp SOCK HOST PORT   # VM side: socket the cell sees -> mitmdump
  fwd.py tcp-to-unix PORT SOCK        # cell side: 127.0.0.1:PORT -> socket
"""

import asyncio
import os
import sys


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        writer.close()


async def bridge(reader, writer, connect):
    try:
        up_reader, up_writer = await connect()
    except OSError:
        writer.close()
        return
    await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))


async def main(argv):
    mode = argv[1]
    if mode == "unix-to-tcp":
        sock, host, port = argv[2], argv[3], int(argv[4])
        if os.path.exists(sock):
            os.unlink(sock)
        server = await asyncio.start_unix_server(
            lambda r, w: bridge(r, w, lambda: asyncio.open_connection(host, port)), path=sock)
        os.chmod(sock, 0o666)  # PoC only; the real design restricts this by group.
    elif mode == "tcp-to-unix":
        port, sock = int(argv[2]), argv[3]
        server = await asyncio.start_server(
            lambda r, w: bridge(r, w, lambda: asyncio.open_unix_connection(sock)), "127.0.0.1", port)
    else:
        raise SystemExit(__doc__)
    print(f"fwd {mode} ready", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main(sys.argv))
