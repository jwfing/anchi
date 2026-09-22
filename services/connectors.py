"""Single source of truth for connector identities, hosts, credentials and operations."""

from dataclasses import dataclass

from common import Denied

READ, WRITE = 'read', 'write'


@dataclass(frozen=True)
class Connector:
    id: str
    user: str
    hosts: tuple
    credential: str  # 'google:<name>' uses the PKCE flow; 'token:<name>' is an imported static token
    module: str
    ops: dict
    paths: tuple  # regular expressions the trusted HTTPS helper accepts for this connector

    @property
    def socket(self):
        return f'/run/secure-{self.id}/api.sock'

    @property
    def state_directory(self):
        return f'/var/lib/secure-{self.id}'


CONNECTORS = {
    'gmail': Connector(
        id='gmail',
        user='secure-gmail',
        hosts=('gmail.googleapis.com',),
        credential='google:gmail',
        module='gmail',
        ops={'gmail.status': READ, 'gmail.list': READ, 'gmail.read': READ},
        paths=(r'/gmail/v1/users/me/messages(/[A-Za-z0-9_-]{1,128})?(\?.*)?',),
    ),
    'drive': Connector(
        id='drive',
        user='secure-drive',
        hosts=('www.googleapis.com',),
        credential='google:drive',
        module='drive',
        ops={
            'drive.status': READ,
            'drive.search': READ,
            'drive.read': READ,
            'drive.create': WRITE,
            'drive.update': WRITE,
        },
        paths=(
            r'/drive/v3/files(\?.*)?',
            r'/drive/v3/files/[A-Za-z0-9_-]{1,128}(/export)?(\?.*)?',
            r'/drive/v3/about\?.*',
            r'/upload/drive/v3/files(/[A-Za-z0-9_-]{1,128})?\?uploadType=(multipart|media)',
        ),
    ),
    'notion': Connector(
        id='notion',
        user='secure-notion',
        hosts=('api.notion.com',),
        credential='token:notion',
        module='notion',
        ops={
            'notion.status': READ,
            'notion.search': READ,
            'notion.read': READ,
            'notion.create_page': WRITE,
            'notion.append': WRITE,
        },
        paths=(
            r'/v1/search',
            r'/v1/pages(/[A-Za-z0-9-]{1,128})?',
            r'/v1/blocks/[A-Za-z0-9-]{1,128}/children(\?.*)?',
            r'/v1/users/me',
        ),
    ),
    'slack': Connector(
        id='slack',
        user='secure-slack',
        hosts=('slack.com',),
        credential='token:slack',
        module='slack',
        ops={'slack.status': READ, 'slack.channels': READ, 'slack.history': READ, 'slack.post': WRITE},
        paths=(r'/api/(conversations\.list|conversations\.history|chat\.postMessage|auth\.test|auth\.revoke)(\?.*)?',),
    ),
}
SERVICE_USERS = tuple(c.user for c in CONNECTORS.values())


def by_user(username):
    for connector in CONNECTORS.values():
        if connector.user == username:
            return connector
    return None


def by_op(operation):
    if not isinstance(operation, str) or '.' not in operation:
        raise Denied('OPERATION_DENIED')
    connector = CONNECTORS.get(operation.split('.', 1)[0])
    if connector is None or operation not in connector.ops:
        raise Denied('OPERATION_DENIED')
    return connector


def kind(operation):
    return by_op(operation).ops[operation]
