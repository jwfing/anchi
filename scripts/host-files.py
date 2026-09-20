"""Host-only, bounded text file operations. Invoked by the trusted desktop over stdin.
No host path or authority is accepted directly from the agent. POSIX dirfds and
O_NOFOLLOW prevent symlink traversal; root identity is pinned by desktop consent.
"""
import json
import os
import stat
import sys
import uuid

LIMIT = 24000

def directory(parent, name):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)

def operate(value):
    grant, request = value['grant'], value['request']
    op = request.get('op')
    if op not in ('list', 'read', 'write', 'mkdir', 'delete'):
        raise ValueError('INVALID_FILE_OPERATION')
    if op in ('write', 'mkdir', 'delete') and grant['mode'] != 'rw':
        raise ValueError('READ_ONLY')
    relative = request.get('path', '')
    if not isinstance(relative, str) or len(relative) > 2048 or '\x00' in relative:
        raise ValueError('INVALID_PATH')
    parts = relative.split('/') if relative else []
    if any(p in ('', '.', '..') or p.startswith('.') for p in parts):
        raise ValueError('INVALID_PATH')
    fds = []
    try:
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        fds.append(fd)
        for component in grant['path'].split('/')[1:]:
            fd = directory(fd, component)
            fds.append(fd)
        root_stat = os.fstat(fd)
        if [str(root_stat.st_dev), str(root_stat.st_ino)] != grant['identity']:
            raise ValueError('DIRECTORY_CHANGED')
        for component in parts[:-1]:
            fd = directory(fd, component)
            fds.append(fd)
        if op == 'list':
            if parts:
                fd = directory(fd, parts[-1])
                fds.append(fd)
            entries = []
            with os.scandir(fd) as iterator:
                for entry in iterator:
                    if entry.name.startswith('.') or entry.is_symlink():
                        continue
                    kind = 'directory' if entry.is_dir(follow_symlinks=False) else 'file' if entry.is_file(follow_symlinks=False) else None
                    if kind:
                        entries.append({'name': entry.name, 'kind': kind})
                    if len(entries) >= 100:
                        break
            return {'entries': entries, 'limit': 100}
        if not parts:
            raise ValueError('INVALID_PATH')
        name = parts[-1]
        if op == 'mkdir':
            os.mkdir(name, mode=0o700, dir_fd=fd)
            return {'created': True}
        try:
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                raise ValueError('UNSAFE_FILE')
        except FileNotFoundError:
            if op != 'write':
                raise
        if op == 'read':
            handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            fds.append(handle)
            st = os.fstat(handle)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > LIMIT:
                raise ValueError('UNSAFE_OR_LARGE_FILE')
            data = os.read(handle, LIMIT + 1)
            if len(data) > LIMIT:
                raise ValueError('FILE_TOO_LARGE')
            return {'text': data.decode('utf-8')}
        if op == 'delete':
            os.unlink(name, dir_fd=fd)
            return {'deleted': True}
        text = request.get('text')
        if not isinstance(text, str) or len(text.encode('utf-8')) > LIMIT:
            raise ValueError('FILE_TOO_LARGE')
        temporary = '.qisuo-' + uuid.uuid4().hex
        try:
            handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            with os.fdopen(handle, 'wb') as stream:
                stream.write(text.encode('utf-8'))
                stream.flush()
                os.fsync(stream.fileno())
            os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=fd)
            except FileNotFoundError:
                pass
        return {'written': True}
    finally:
        for fd in reversed(fds):
            os.close(fd)

if __name__ == '__main__':
    try:
        data = sys.stdin.buffer.read(65537)
        if len(data) > 65536:
            raise ValueError('REQUEST_TOO_LARGE')
        result = operate(json.loads(data))
        print(json.dumps({'ok': True, 'result': result}))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error).replace('_', '').isupper() else 'FILE_OPERATION_DENIED'
        print(json.dumps({'ok': False, 'error': code}))
