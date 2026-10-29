"""Egress proxy decisions for agent-team cells, independent of mitmproxy.

A cell holds placeholders. For each request the proxy asks `decide()` what to do given the
agent's connectors, then `apply()` builds the outgoing headers from the real credential.
Nothing here logs or returns credential values.
"""

import base64
import hashlib
import hmac
import ipaddress
import json
import re
import unicodedata
from dataclasses import dataclass, field
from urllib.parse import parse_qs
from xml.sax.saxutils import escape

PLACEHOLDER_MARK = 'anchi-placeholder'
# The mark without its dash, for placeholders that must match a token alphabet (Linear, Discord).
PLACEHOLDER_COMPACT = 'anchiplaceholder'
PLACEHOLDER_AWS_KEY = 'AKIAANCHIPLACEHOLDER'
CONNECTORS = ('github', 'aws', 'linear', 'posthog', 'sentry', 'firecrawl', 'figma', 'discord')
# Runtime credentials an agent of that runtime gets; injected replace-only.
RUNTIMES = ('codex', 'claude', 'hermes')
# Hermes sends `Authorization: Bearer <key>` to the user's OpenAI-compatible endpoint.
PLACEHOLDER_HERMES = 'sk-anchi-placeholder-' + '0' * 40
PLACEHOLDER_CLAUDE_OAUTH = 'sk-ant-oat01-anchi-placeholder-' + '0' * 40
PLACEHOLDER_CLAUDE_KEY = 'sk-ant-api03-anchi-placeholder-' + '0' * 40


@dataclass(frozen=True)
class Rule:
    name: str
    hosts: tuple[str, ...]
    # bearer | basic | raw | bot (Discord) | figma | aws_sigv4 | anthropic | none (deny-only)
    kind: str
    # Connector or runtime that grants this rule; None applies to every agent.
    grant: str | None
    deny: tuple[str, ...] = field(default=())
    # When set, only matching paths are injected; others pass through untouched.
    path: str | None = None
    # Inject only when the client sent a placeholder, never into an unauthenticated request.
    replace_only: bool = False


RULES: tuple[Rule, ...] = (
    # ChatGPT Apps (Codex's codex_apps MCP server) and plugins act on the accounts the user
    # linked in ChatGPT, outside the agent's connectors, approvals and audit.
    Rule(
        name='codex',
        hosts=('chatgpt.com',),
        kind='bearer',
        grant='codex',
        replace_only=True,
        deny=(r'^\S+ /backend-api/(ps|plugins|aip|connectors)(/|$)',),
    ),
    # Token refresh happens on the trusted side; a refresh from a cell would return a new
    # credential in the response body.
    Rule(name='openai-auth', hosts=('auth.openai.com',), kind='none', grant=None, deny=(r'.*',)),
    # Claude Code: a subscription token (Authorization: Bearer) or an API key (x-api-key),
    # whichever the vault holds; organization administration (API key management) is denied.
    Rule(
        name='anthropic',
        hosts=('api.anthropic.com',),
        kind='anthropic',
        grant='claude',
        replace_only=True,
        deny=(r'^\S+ /v1/organizations(/|$)',),
    ),
    # OAuth token exchange would return a new credential to the cell.
    Rule(
        name='anthropic-auth',
        hosts=('console.anthropic.com', 'platform.claude.com', 'claude.ai'),
        kind='none',
        grant=None,
        deny=(r'(?i)/oauth/token',),
    ),
    Rule(
        name='github-api',
        hosts=('api.github.com',),
        kind='bearer',
        grant='github',
        deny=(
            r'^POST /user/keys$',
            r'^POST /user/gpg_keys$',
            r'^POST /user/ssh_signing_keys$',
            r'^POST /repos/[^/]+/[^/]+/keys$',
            r'^POST /app/installations/[^/]+/access_tokens$',
            r'^POST /applications/[^/]+/token',
            r'^POST /authorizations',
            r'^(GET|PUT|DELETE|POST) /repos/[^/]+/[^/]+/(actions|codespaces|dependabot)/secrets',
            r'^(GET|PUT|DELETE|POST) /orgs/[^/]+/(actions|codespaces|dependabot)/secrets',
            r'^(GET|PUT|DELETE|POST) /repos/[^/]+/[^/]+/environments/[^/]+/secrets',
            r'^(GET|PUT|DELETE|POST) /user/codespaces/secrets',
        ),
    ),
    Rule(
        name='github-git',
        hosts=('github.com',),
        kind='basic',
        grant='github',
        # Git smart HTTP only; release downloads and web pages pass through.
        path=r'^/[^/]+/[^/]+?(\.git)?/(info/refs|git-upload-pack|git-receive-pack)$',
    ),
    Rule(
        name='aws',
        hosts=('*.amazonaws.com',),
        kind='aws_sigv4',
        grant='aws',
        deny=(
            r'^iam:(?!Get|List|Simulate).*',
            r'^sts:(?!GetCallerIdentity$).*',
            r'^sso:.*',
            r'^sso-oauth:.*',
            r'^signin:.*',
        ),
    ),
    Rule(
        name='linear',
        hosts=('api.linear.app',),
        kind='raw',
        grant='linear',
        deny=(r'\b(apiKeyCreate|apiKeyDelete|oauthClient\w*|oauthToken\w*)\b',),
    ),
    # US and EU Cloud; ingestion (`*.i.posthog.com`) takes the public project key, not this one.
    Rule(
        name='posthog',
        hosts=('us.posthog.com', 'eu.posthog.com'),
        kind='bearer',
        grant='posthog',
        path=r'^/api/',
        deny=(
            r'^\S+ /api/personal_api_keys(/|$)',
            # Resetting or rotating a project's keys returns the new key.
            r'^\S+ /api/.*/(reset_token|rotate_secret_token)/?$',
        ),
    ),
    # The API only; event ingestion (`/api/<project>/envelope/`) authenticates with the DSN.
    Rule(
        name='sentry',
        hosts=('sentry.io', 'us.sentry.io', 'de.sentry.io'),
        kind='bearer',
        grant='sentry',
        path=r'^/api/0/',
        deny=(
            r'^\S+ /api/0/api-tokens(/|$)',
            r'^\S+ /api/0/organizations/[^/]+/org-auth-tokens(/|$)',
            r'^\S+ /api/0/sentry-apps/[^/]+/(api-tokens|rotate-secret)(/|$)',
            r'^\S+ /api/0/sentry-app-installations/[^/]+/authorizations(/|$)',
        ),
    ),
    Rule(name='firecrawl', hosts=('api.firecrawl.dev',), kind='bearer', grant='firecrawl'),
    Rule(name='figma', hosts=('api.figma.com',), kind='figma', grant='figma'),
    # REST only; the gateway (a WebSocket that carries the token in a message) is not supported.
    Rule(
        name='discord',
        hosts=('discord.com', 'discordapp.com'),
        kind='bot',
        grant='discord',
        path=r'^/api/',
        deny=(
            # Webhook objects carry the webhook's own token: listing, creating or reading one by
            # id returns it. Executing a webhook (`/webhooks/<id>/<token>`) stays possible.
            r'^\S+ /api(/v\d+)?/(channels|guilds)/\d+/webhooks/?$',
            r'^\S+ /api(/v\d+)?/webhooks/\d+/?$',
            r'^\S+ /api(/v\d+)?/oauth2/token(/|$)',
        ),
    ),
)


@dataclass(frozen=True)
class Decision:
    # pass | inject | deny
    action: str
    rule: Rule | None = None
    op: str | None = None
    reason: str | None = None


def host_matches(pattern, host):
    host = host.lower().rstrip('.')
    if pattern.startswith('*.'):
        return host.endswith(pattern[1:])
    return host == pattern


def find_rule(host, extra=()):
    for rule in (*RULES, *extra):
        if any(host_matches(p, host) for p in rule.hosts):
            return rule
    return None


def hermes_rule(host, base_path=''):
    """The rule for the user's OpenAI-compatible endpoint, which only the vault knows. Its host
    never has a built-in rule (hermes_admin refuses those), so it cannot shadow one. The key is
    injected under the base URL's path only; anything else on that host is left as the cell sent
    it, placeholder and all."""
    prefix = base_path.rstrip('/')
    return Rule(
        name='hermes',
        hosts=(host,),
        kind='bearer',
        grant='hermes',
        replace_only=True,
        path=f'^{re.escape(prefix)}(/|$)' if prefix else None,
        # OpenAI-style administration (organization, projects, API keys) is not an agent's business.
        deny=(r'(?i)^\S+ (/[^ ]*)?/(organization|organizations|dashboard)(/|$)',),
    )


def classify_credential(headers):
    """What kind of credential the client sent, without revealing it."""
    auth = headers.get('authorization', '') or headers.get('x-api-key', '') or headers.get('x-figma-token', '')
    if not auth:
        return 'none'
    if PLACEHOLDER_MARK in auth or PLACEHOLDER_COMPACT in auth or PLACEHOLDER_AWS_KEY in auth:
        return 'placeholder'
    if auth.lower().startswith('basic '):
        try:
            if PLACEHOLDER_MARK in base64.b64decode(auth[6:]).decode('utf-8', 'replace'):
                return 'placeholder'
        except ValueError:
            pass
    return 'other'


AWS_SCOPE = re.compile(r'Credential=[^/]+/\d{8}/([^/]+)/([^/]+)/aws4_request')


def aws_scope(headers):
    match = AWS_SCOPE.search(headers.get('authorization', ''))
    return (match.group(1), match.group(2)) if match else None


def aws_operation(service, headers, body, method, path):
    target = headers.get('x-amz-target')
    if target:
        return f'{service}:{target.rsplit(".", 1)[-1]}'
    if 'x-www-form-urlencoded' in headers.get('content-type', ''):
        action = parse_qs(body.decode('utf-8', 'replace')).get('Action')
        if action:
            return f'{service}:{action[0]}'
    if '?' in path:
        action = parse_qs(path.split('?', 1)[1]).get('Action')
        if action:
            return f'{service}:{action[0]}'
    clean = path.split('?', 1)[0]
    if service == 's3' and '?' in path:
        # Subresources decide what an S3 call does: `POST /b?delete` deletes objects.
        keys = parse_qs(path.split('?', 1)[1], keep_blank_values=True)
        sub = next((k for k in S3_SUBRESOURCES if k in keys), None)
        if sub:
            return f'{service}:{method} {clean}?{sub}'
    return f'{service}:{method} {clean}'


S3_SUBRESOURCES = (
    'delete',
    'policy',
    'acl',
    'publicAccessBlock',
    'ownershipControls',
    'lifecycle',
    'replication',
    'encryption',
    'versioning',
    'cors',
    'website',
    'notification',
    'object-lock',
    'retention',
    'legal-hold',
)


def operation(rule, method, path, headers, body):
    if rule.kind == 'aws_sigv4':
        scope = aws_scope(headers)
        return aws_operation(scope[1] if scope else 'unknown', headers, body, method, path)
    if rule.name == 'linear':
        # GraphQL: the operation is in the body. Bounded so the audit log stays small.
        try:
            query = json.loads(body or b'{}').get('query', '')
        except (ValueError, AttributeError):
            query = ''
        names = re.findall(r'\b([a-z][A-Za-z]+)\s*[({]', query if isinstance(query, str) else '')
        return 'graphql:' + ','.join(dict.fromkeys(names))[:300]
    return f'{method} {path.split("?", 1)[0]}'


def decide(method, host, path, headers, body, grants, extra=()):
    """`headers` has lowercase keys. `grants` holds the agent's connectors and runtime; `extra`
    holds the cell's rules that depend on stored settings (the Hermes endpoint)."""
    rule = find_rule(host, extra)
    if rule is None:
        return Decision('pass')
    clean_path = path.split('?', 1)[0]
    if rule.path and not re.search(rule.path, clean_path):
        return Decision('pass')
    if rule.grant is not None and rule.grant not in grants:
        # No connector, no injection. The request leaves with whatever the client sent.
        return Decision('pass', rule, reason='not-granted')
    # AWS: only SigV4-signed calls are re-signed; unsigned public downloads pass through.
    if rule.kind == 'aws_sigv4' and aws_scope(headers) is None:
        return Decision('pass', rule, reason='unsigned')
    op = operation(rule, method, path, headers, body)
    if any(re.search(p, op) for p in rule.deny):
        return Decision('deny', rule, op)
    if rule.kind == 'none':
        return Decision('pass', rule, op)
    if rule.replace_only and classify_credential(headers) != 'placeholder':
        return Decision('pass', rule, op, reason='no-placeholder')
    return Decision('inject', rule, op)


def deny_response(decision, headers):
    """(status, body, headers) for a denial, in the service's own error shape for AWS so SDKs
    surface it cleanly and do not treat it as a retryable parse failure."""
    message = f'anchi: {decision.op} denied'
    if decision.rule is not None and decision.rule.kind == 'aws_sigv4':
        if headers.get('x-amz-target'):
            body = json.dumps({'__type': 'AccessDeniedException', 'message': message}).encode()
            return 403, body, {'content-type': 'application/x-amz-json-1.1'}
        body = (
            '<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code>'
            f'<Message>{escape(message)}</Message></Error><RequestId>anchi</RequestId></ErrorResponse>'
        ).encode()
        return 403, body, {'content-type': 'text/xml'}
    return 403, (message + '\n').encode(), {'content-type': 'text/plain'}


# Signed with the placeholder and recomputed, or proxy/hop-by-hop headers that must not be signed.
AWS_STRIP = {'authorization', 'x-amz-date', 'x-amz-security-token', 'proxy-connection', 'connection'}


def aws_resign(method, url, headers, body, region, service, credential):
    """New header set signed with the real credential."""
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.credentials import Credentials

    payload = headers.get('x-amz-content-sha256', '')
    if payload.startswith('STREAMING-') and payload not in AWS_STREAMING:
        raise ValueError(f'{payload[:60]} payloads are not re-signed')
    creds = Credentials(
        credential['access_key_id'], credential['secret_access_key'], credential.get('session_token') or None
    )
    kept = {k: v for k, v in headers.items() if k.lower() not in AWS_STRIP}
    request = AWSRequest(method=method, url=url, data=body, headers=kept)
    SigV4Auth(creds, service, region).add_auth(request)
    return {k.lower(): v for k, v in request.headers.items()}


# ── aws-chunked uploads ─────────────────────────────────────
# botocore signs the headers with x-amz-content-sha256 as given, so the seed is re-signed like any
# request. Unsigned-chunk uploads (the AWS CLI's) need nothing more. Signed chunks chain from the
# seed signature: each is recomputed with the real key as the body passes, keeping its length.

AWS_STREAMING = {
    'STREAMING-UNSIGNED-PAYLOAD-TRAILER': None,
    'STREAMING-AWS4-HMAC-SHA256-PAYLOAD': 'chunks',
    'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER': 'trailer',
}
AWS_SIGNATURE = re.compile(r'Credential=[^/]+/(\d{8}/[^/]+/[^/]+/aws4_request),.*Signature=([0-9a-f]{64})$')
CHUNK_LINE = re.compile(rb'([0-9a-fA-F]{1,8});chunk-signature=[0-9a-f]{64}')
TRAILER = re.compile(rb'((?:[A-Za-z0-9-]{1,64}:[^\r\n]{0,256}\r\n){1,8})x-amz-trailer-signature:[0-9a-f]{64}\r\n\r\n')
EMPTY_SHA256 = hashlib.sha256(b'').hexdigest()


class ChunkResigner:
    """Re-signs an aws-chunked body fed in arbitrary slices; `feed(b'')` ends it. Malformed or
    truncated input raises ValueError. Holds at most one chunk (16 MiB, S3's limit)."""

    MAX_CHUNK = 16 << 20
    MAX_LINE = 100
    MAX_TRAILER = 4096

    def __init__(self, key, timestamp, scope, seed, trailer):
        self.key, self.prefix, self.previous = key, f'{timestamp}\n{scope}\n', seed
        self.trailer = trailer
        self.buf = bytearray()
        self.state, self.size, self.size_text = 'head', 0, b''

    def sign(self, algorithm, *hashes):
        text = f'{algorithm}\n{self.prefix}{self.previous}\n' + '\n'.join(hashes)
        self.previous = hmac.new(self.key, text.encode(), hashlib.sha256).hexdigest()
        return self.previous

    def feed(self, data):
        if not data:
            if self.state != 'end' or self.buf:
                raise ValueError('truncated aws-chunked body')
            return b''
        if self.state == 'end':
            raise ValueError('data after the final aws-chunked chunk')
        self.buf += data
        out = bytearray()
        while True:
            if self.state == 'head':
                end = self.buf.find(b'\r\n')
                if end < 0:
                    if len(self.buf) > self.MAX_LINE:
                        raise ValueError('malformed aws-chunked chunk header')
                    break
                match = CHUNK_LINE.fullmatch(bytes(self.buf[:end]))
                if match is None:
                    raise ValueError('malformed aws-chunked chunk header')
                self.size_text, self.size = match.group(1), int(match.group(1), 16)
                if self.size > self.MAX_CHUNK:
                    raise ValueError('aws-chunked chunk larger than 16 MiB')
                del self.buf[: end + 2]
                if self.size == 0 and self.trailer:
                    out += self.size_text + b';chunk-signature=' + self.sign_chunk(b'').encode() + b'\r\n'
                    self.state = 'trailer'
                else:
                    self.state = 'data'
            elif self.state == 'data':
                if len(self.buf) < self.size + 2:
                    break
                chunk = bytes(self.buf[: self.size])
                if self.buf[self.size : self.size + 2] != b'\r\n':
                    raise ValueError('malformed aws-chunked chunk')
                del self.buf[: self.size + 2]
                out += self.size_text + b';chunk-signature=' + self.sign_chunk(chunk).encode() + b'\r\n'
                out += chunk + b'\r\n'
                self.state = 'head' if self.size else 'end'
            elif self.state == 'trailer':
                match = TRAILER.fullmatch(bytes(self.buf))
                if match is None:
                    if len(self.buf) > self.MAX_TRAILER:
                        raise ValueError('malformed aws-chunked trailer')
                    break
                lines = match.group(1)
                signature = self.sign(
                    'AWS4-HMAC-SHA256-TRAILER', hashlib.sha256(lines.replace(b'\r\n', b'\n')).hexdigest()
                )
                out += lines + b'x-amz-trailer-signature:' + signature.encode() + b'\r\n\r\n'
                self.buf.clear()
                self.state = 'end'
            else:
                if self.buf:
                    raise ValueError('data after the final aws-chunked chunk')
                break
        return bytes(out)

    def sign_chunk(self, chunk):
        return self.sign('AWS4-HMAC-SHA256-PAYLOAD', EMPTY_SHA256, hashlib.sha256(chunk).hexdigest())


def aws_chunk_resigner(headers, credential):
    """A ChunkResigner for re-signed `headers` whose chunks are signed, else None."""
    kind = AWS_STREAMING.get(headers.get('x-amz-content-sha256', ''))
    if kind is None:
        return None
    match = AWS_SIGNATURE.search(headers['authorization'])
    if match is None:
        raise ValueError('re-signed request has no signature')
    scope, seed = match.groups()
    date, region, service, _ = scope.split('/')
    key = ('AWS4' + credential['secret_access_key']).encode()
    for part in (date, region, service, 'aws4_request'):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    return ChunkResigner(key, headers['x-amz-date'], scope, seed, kind == 'trailer')


def apply(decision, method, url, headers, body, credential):
    """Outgoing headers (lowercase keys) for an `inject` decision."""
    rule = decision.rule
    if rule.kind == 'aws_sigv4':
        region, service = aws_scope(headers)
        return aws_resign(method, url, headers, body, region, service, credential)
    out = {k: v for k, v in headers.items() if k not in ('authorization', 'proxy-authorization')}
    if rule.kind == 'bearer':
        out['authorization'] = f'Bearer {credential["token"]}'
    elif rule.kind == 'basic':
        out['authorization'] = 'Basic ' + base64.b64encode(f'x-access-token:{credential["token"]}'.encode()).decode()
    elif rule.kind == 'raw':
        out['authorization'] = credential['token']
    elif rule.kind == 'bot':
        out['authorization'] = f'Bot {credential["token"]}'
    elif rule.kind == 'figma':
        out['x-figma-token'] = credential['token']
    elif rule.kind == 'anthropic':
        out.pop('x-api-key', None)
        if credential['kind'] == 'api_key':
            out['x-api-key'] = credential['token']
        else:
            out['authorization'] = f'Bearer {credential["token"]}'
    else:
        raise ValueError(f'rule {rule.name} does not inject')
    if rule.name == 'codex':
        out['chatgpt-account-id'] = credential['account_id']
    return out


# Destinations the proxy never connects to, as the nftables backstop for its UID lists them
# (`network_rules.egress_proxy_rules`): the two must agree, so the proxy fails closed on its
# own. IPv4-mapped and NAT64 addresses would reach a private IPv4 host through IPv6.
PRIVATE_V4 = (
    '0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, '
    '192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/3'
)
PRIVATE_V6 = '::/127, ::ffff:0:0/96, 64:ff9b::/96, 100::/64, 2001:db8::/32, fc00::/7, fe80::/10, ff00::/8'
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(n.strip()) for n in (PRIVATE_V4 + ', ' + PRIVATE_V6).split(','))


def private_destination(ip):
    """Whether the proxy must not connect to `ip`: not global, multicast, reserved, link-local,
    or inside a range the kernel backstop rejects."""
    return (
        not ip.is_global
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_link_local
        or any(ip in network for network in PRIVATE_NETWORKS if network.version == ip.version)
    )


def public_address(infos):
    """First address from getaddrinfo results if every one is public, else (None, reason).

    The proxy connects to the returned address itself, so a second resolution (DNS
    rebinding) cannot change the destination after the check.
    """
    chosen = None
    for info in infos:
        try:
            ip = ipaddress.ip_address(str(info[4][0]).split('%', 1)[0])
        except ValueError:
            return None, 'unparsable address'
        if private_destination(ip):
            return None, f'non-public destination {ip}'
        if chosen is None or (chosen.version == 6 and ip.version == 4):
            chosen = ip
    if chosen is None:
        return None, 'no address'
    return str(chosen), None


# ── connector verification ──────────────────────────────────
# The proxy itself calls one fixed, read-only identity endpoint per connector after an import,
# so a bad credential is reported at setup instead of as a 401 in the middle of a task.

VERIFY_ENDPOINTS = {
    'github': ('GET', ('https://api.github.com/user',), b''),
    'linear': ('POST', ('https://api.linear.app/graphql',), b'{"query":"{ viewer { email name } }"}'),
    'aws': ('POST', ('https://sts.{region}.amazonaws.com/',), b'Action=GetCallerIdentity&Version=2011-06-15'),
    # A key belongs to one region's cloud; the other refuses it.
    'posthog': ('GET', ('https://us.posthog.com/api/users/@me/', 'https://eu.posthog.com/api/users/@me/'), b''),
    'sentry': ('GET', ('https://sentry.io/api/0/organizations/',), b''),
    'firecrawl': ('GET', ('https://api.firecrawl.dev/v2/team/credit-usage',), b''),
    'figma': ('GET', ('https://api.figma.com/v1/me',), b''),
    'discord': ('GET', ('https://discord.com/api/v10/users/@me',), b''),
}


def verify_requests(connector, credential):
    """(method, url, headers, body) of the identity calls for `connector`, to try in order until
    one is not refused."""
    method, urls, body = VERIFY_ENDPOINTS[connector]
    out = []
    for url in urls:
        headers = {'user-agent': 'anchi-egress-verify', 'accept': 'application/json'}
        if connector == 'aws':
            url = url.format(region=credential['region'])
            headers = {'content-type': 'application/x-www-form-urlencoded'}
            headers = aws_resign(method, url, headers, body, credential['region'], 'sts', credential)
        else:
            rule = next(r for r in RULES if r.grant == connector and r.kind != 'basic')
            headers = apply(Decision('inject', rule), method, url, headers, body, credential)
            if connector == 'linear':
                headers['content-type'] = 'application/json'
        out.append((method, url, headers, body))
    return out


# A GitHub login: letters, digits and inner hyphens, at most 39 characters.
GITHUB_LOGIN = re.compile(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?')
# Characters git, systemd-run's environment expansion and its specifiers would read.
NAME_SPECIAL = frozenset('$%\\<>"\'`')


def github_identity(status, body):
    """Who the GitHub token belongs to, from `GET /user`, for commit authorship; None when the
    response is not a usable identity. The values become arguments of the guest's cell command,
    so each is bounded: the login by its pattern, the id as an integer, the name to printable
    characters git and systemd-run read literally."""
    if status != 200:
        return None
    try:
        data = json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    login, uid, name = data.get('login'), data.get('id'), data.get('name')
    if not isinstance(login, str) or not GITHUB_LOGIN.fullmatch(login):
        return None
    if type(uid) is not int or not 0 < uid < 2**53:
        return None
    clean = ''
    if isinstance(name, str):
        kept = (' ' if c in NAME_SPECIAL or unicodedata.category(c)[0] == 'C' else c for c in name[:1000])
        clean = ' '.join(''.join(kept).split())[:100].strip()
    return {'github_login': login, 'github_id': uid, 'github_name': clean or login}


def verify_account(connector, status, body, url=''):
    """Account label from the identity call's response; ValueError when the credential is refused."""
    if status in (401, 403):
        raise ValueError('CREDENTIAL_REJECTED')
    if status != 200:
        raise ValueError(f'VERIFY_HTTP_{status}')
    text = body.decode('utf-8', 'replace')
    try:
        if connector == 'github':
            return str(json.loads(text)['login'])[:100]
        if connector == 'posthog':
            region = 'EU' if url.startswith('https://eu.') else 'US'
            return f'{str(json.loads(text)["email"])[:90]} ({region})'
        if connector == 'sentry':
            slugs = [str(o['slug'])[:40] for o in json.loads(text)[:3]]
            if not slugs:
                raise ValueError('CREDENTIAL_REJECTED')
            return ', '.join(slugs)[:100]
        if connector == 'firecrawl':
            credits = json.loads(text)['data']['remainingCredits']
            if not isinstance(credits, int):
                raise TypeError
            return f'team with {credits} credits left'
        if connector == 'figma':
            data = json.loads(text)
            return str(data.get('email') or data['handle'])[:100]
        if connector == 'discord':
            return str(json.loads(text)['username'])[:100]
        if connector == 'linear':
            data = json.loads(text)
            if data.get('errors'):
                raise ValueError('CREDENTIAL_REJECTED')
            viewer = data['data']['viewer']
            return str(viewer.get('email') or viewer.get('name'))[:100]
        arn = re.search(r'<Arn>([^<]{1,300})</Arn>', text)
        if arn:
            return arn.group(1)
    except (ValueError, KeyError, TypeError) as exc:
        if str(exc) == 'CREDENTIAL_REJECTED':
            raise
    raise ValueError('VERIFY_UNEXPECTED_RESPONSE')


# ── writes held for approval ────────────────────────────────
# With `approvals: {<connector>: ask}`, an injected request that changes something waits for
# the user. Reads are never held: they would make `ask` unusable, and the boundary (no
# credential in the cell) does not depend on them.

AWS_READ = re.compile(
    r'^[a-z0-9-]+:(Get|List|Describe|Filter|Search|Lookup|Head|Query|Scan|BatchGet|Select|'
    r'Check|Validate|Estimate|Preview|Simulate|Test|View|Download|StartQuery|StopQuery)'
)
REST_CONNECTORS = ('posthog', 'sentry', 'firecrawl', 'figma', 'discord')
# PostHog runs HogQL and insight queries as POST; they read.
POSTHOG_QUERY = re.compile(r'^/api/(projects|environments)/[^/]+/query/?$')
GRAPHQL_MAX_DOCUMENT = 1_000_000


def graphql_strip(document):
    """The document with its comments and string literals blanked, so a `mutation` keyword is
    found only where GraphQL reads one, and one inside a string or comment is not."""
    out, i, n = [], 0, len(document)
    while i < n:
        c = document[i]
        if c == '#':
            while i < n and document[i] not in '\r\n':
                i += 1
            continue
        if document.startswith('"""', i):
            j = document.find('"""', i + 3)
            while j != -1 and document[j - 1] == '\\':
                j = document.find('"""', j + 1)
            i = n if j == -1 else j + 3
            out.append(' ')
            continue
        if c == '"':
            i += 1
            while i < n and document[i] not in '"\n':
                i += 2 if document[i] == '\\' else 1
            i += 1
            out.append(' ')
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def graphql_document(body):
    """The GraphQL document of a request body, stripped (see graphql_strip), or None when the
    body is not a readable GraphQL request: the proxy then treats it as a write."""
    try:
        request = json.loads(body or b'{}')
    except ValueError:
        return None
    query = request.get('query') if isinstance(request, dict) else None
    if not isinstance(query, str) or not query.strip() or len(query) > GRAPHQL_MAX_DOCUMENT:
        return None
    return graphql_strip(query.lstrip('﻿'))


def graphql_mutation(body):
    """Whether a GraphQL request carries a mutation. GraphQL lets comments, a byte-order mark,
    commas and other operations precede it (`operationName` picks one of several), so the
    keyword counts anywhere at the top level of the document, not only as its first token; a
    document that holds a mutation beside a query is a write whichever operation is named.
    Unreadable requests count as writes too."""
    document = graphql_document(body)
    if document is None:
        return True
    depth = 0
    for match in re.finditer(r'[(){}]|\b(query|mutation|subscription|fragment)\b', document):
        token = match.group(0)
        if token in '({':
            depth += 1
        elif token in ')}':
            depth = max(0, depth - 1)
        elif depth == 0 and token == 'mutation':
            return True
    return False


def is_write(decision, method, path, body):
    """Whether an injected request changes state upstream (git push, API writes, mutations)."""
    rule = decision.rule
    clean = path.split('?', 1)[0]
    if rule is None:
        return False
    if rule.name == 'github-git':
        return clean.endswith('/git-receive-pack')
    if rule.name == 'github-api':
        if clean == '/graphql':
            return graphql_mutation(body)
        return method not in ('GET', 'HEAD', 'OPTIONS')
    if rule.name == 'linear':
        return graphql_mutation(body)
    if rule.kind == 'aws_sigv4':
        op = decision.op or ''
        if ':' in op and ' ' in op.split(':', 1)[1]:  # REST, such as S3: by method
            return not op.split(':', 1)[1].startswith(('GET ', 'HEAD '))
        return not AWS_READ.match(op)
    if rule.name in REST_CONNECTORS:
        if rule.name == 'posthog' and method == 'POST' and POSTHOG_QUERY.match(clean):
            return False
        # Firecrawl's scrapes, crawls and searches spend credits, so they count as writes too.
        return method not in ('GET', 'HEAD', 'OPTIONS')
    return False


# ── trigger polling ─────────────────────────────────────────
# The daemon's polling triggers run one fixed, read-only query per type in this service, with
# the vault's credential; cells are not involved. New item ids go back to the daemon.

POLL_LIMIT = 20
LINEAR_POLL_QUERY = (
    'query($filter: IssueFilter) { issues(filter: $filter, first: 20, orderBy: createdAt) '
    '{ nodes { id identifier title url } } }'
)


def poll_request(kind, params, credential):
    """(method, url, headers, body, connector) of the query for a polling trigger."""
    if kind == 'linear-issues':
        filters = {}
        if params.get('team'):
            filters['team'] = {'key': {'eq': str(params['team'])[:40]}}
        if params.get('label'):
            filters['labels'] = {'name': {'eq': str(params['label'])[:80]}}
        if params.get('state'):
            filters['state'] = {'name': {'eq': str(params['state'])[:80]}}
        body = json.dumps({'query': LINEAR_POLL_QUERY, 'variables': {'filter': filters}}).encode()
        headers = {'authorization': credential['token'], 'content-type': 'application/json'}
        return 'POST', 'https://api.linear.app/graphql', headers, body
    if kind == 'github-issues':
        from urllib.parse import urlencode

        q = str(params.get('query', ''))[:300]
        if not q:
            raise ValueError('BAD_POLL')
        url = 'https://api.github.com/search/issues?' + urlencode(
            {'q': q, 'sort': 'created', 'order': 'desc', 'per_page': POLL_LIMIT}
        )
        headers = {'authorization': f'Bearer {credential["token"]}', 'accept': 'application/vnd.github+json'}
        return 'GET', url, headers, b''
    raise ValueError('BAD_POLL')


POLL_CONNECTOR = {'linear-issues': 'linear', 'github-issues': 'github'}


def poll_items(kind, status, body):
    """Items found by a poll: [{id, title, url}], bounded."""
    if status in (401, 403):
        raise ValueError('CREDENTIAL_REJECTED')
    if status != 200:
        raise ValueError(f'POLL_HTTP_{status}')
    data = json.loads(body.decode('utf-8', 'replace'))
    if kind == 'linear-issues':
        nodes = ((data.get('data') or {}).get('issues') or {}).get('nodes') or []
        rows = [(n.get('id'), f'{n.get("identifier", "")} {n.get("title", "")}'.strip(), n.get('url')) for n in nodes]
    else:
        rows = [(i.get('node_id') or i.get('id'), i.get('title'), i.get('html_url')) for i in data.get('items') or []]
    return [
        {'id': str(i)[:100], 'title': str(t or '')[:300], 'url': str(u or '')[:500]}
        for i, t, u in rows[:POLL_LIMIT]
        if i
    ]


# ── high-risk operations ────────────────────────────────────
# Held for the user's approval for every agent and every task origin, whatever the agent's
# `approvals` setting (phase 3, F1). Each entry: id, rule, pattern on the operation (or on git
# ref updates), and what the dialog says. The user can disable entries by id.

HIGH_RISK = (
    ('github-merge', 'github-api', r'^PUT /repos/[^/]+/[^/]+/pulls/\d+/merge$', 'merge a pull request'),
    ('github-repo-delete', 'github-api', r'^DELETE /repos/[^/]+/[^/]+$', 'delete a repository'),
    ('github-repo-settings', 'github-api', r'^PATCH /repos/[^/]+/[^/]+$', 'change repository settings'),
    ('github-repo-transfer', 'github-api', r'^POST /repos/[^/]+/[^/]+/transfer$', 'transfer a repository'),
    (
        'github-protection',
        'github-api',
        r'^(PUT|POST|PATCH|DELETE) /repos/[^/]+/[^/]+/(branches/[^/]+/protection|rulesets)',
        'change branch protection',
    ),
    (
        'github-access',
        'github-api',
        r'^(PUT|POST|PATCH|DELETE) /repos/[^/]+/[^/]+/(collaborators|hooks|keys|deployments)',
        'change repository access or hooks',
    ),
    ('github-ref-delete', 'github-api', r'^DELETE /repos/[^/]+/[^/]+/git/refs/', 'delete a branch or tag'),
    (
        'github-graphql',
        'github-api',
        r'graphql-mutation:.*\b(mergePullRequest|deleteRepository|updateRepository|'
        r'(create|update|delete)BranchProtectionRule|(create|update|delete)Ruleset|deleteRef)\b',
        'a high-risk GitHub mutation',
    ),
    ('git-default-branch', 'github-git', r'refs/heads/(main|master)$', 'push to main or master'),
    ('git-ref-delete', 'github-git', r'^delete ', 'delete a branch or tag on push'),
    (
        'aws-destroy',
        'aws',
        r'^[a-z0-9-]+:(Delete|Terminate|Remove|Revoke|Detach|Disable|ScheduleKeyDeletion|Put\w*Policy)',
        'delete, terminate or change access to an AWS resource',
    ),
    (
        'aws-s3-delete',
        'aws',
        r'^s3:(DELETE |POST \S*\?delete$|PUT \S*\?lifecycle$)',
        'delete S3 objects or buckets, or set expiry rules',
    ),
    (
        'aws-s3-access',
        'aws',
        r'^s3:PUT \S*\?(policy|acl|publicAccessBlock|ownershipControls)$',
        'change who can access an S3 bucket or object',
    ),
    ('linear-delete', 'linear', r'graphql:.*\b\w+(Delete|Archive)\b', 'delete or archive in Linear'),
    (
        'posthog-delete',
        'posthog',
        r'^DELETE /api/(organizations|projects|environments)/[^/]+/?$',
        'delete a PostHog organization or project',
    ),
    (
        'posthog-access',
        'posthog',
        r'^(POST|PUT|PATCH|DELETE) /api/organizations/[^/]+/(members|invites)(/|$)',
        'change who can access a PostHog organization',
    ),
    (
        'sentry-delete',
        'sentry',
        r'^DELETE /api/0/(organizations/[^/]+|projects/[^/]+/[^/]+|teams/[^/]+/[^/]+)/?$',
        'delete a Sentry organization, project or team',
    ),
    (
        'sentry-access',
        'sentry',
        r'^(POST|PUT|PATCH|DELETE) /api/0/organizations/[^/]+/(members|invite-requests)(/|$)',
        'change who can access a Sentry organization',
    ),
    (
        'figma-webhook',
        'figma',
        r'^(POST|PUT) /v2/(webhooks|teams/[^/]+/webhooks)(/|$)',
        'create or change a Figma webhook, which sends future events to a URL',
    ),
    (
        'discord-delete',
        'discord',
        r'^DELETE /api(/v\d+)?/(channels|guilds)/\d+/?$',
        'delete a Discord channel or server',
    ),
    (
        'discord-members',
        'discord',
        r'^(PUT|PATCH|DELETE) /api(/v\d+)?/guilds/\d+/(bans|members)/\d+',
        'ban, kick, time out or change roles of Discord members',
    ),
    (
        'discord-access',
        'discord',
        r'^((POST|PATCH|PUT|DELETE) /api(/v\d+)?/(guilds/\d+/roles|channels/\d+/permissions)'
        r'|PATCH /api(/v\d+)?/(guilds/\d+|applications/@me)/?$)',
        'change Discord roles, channel permissions, server or bot settings',
    ),
)
GIT_OID = rb'(?:[0-9a-f]{40}|[0-9a-f]{64})'
GIT_UPDATE = re.compile(rb'(' + GIT_OID + rb') (' + GIT_OID + rb') (refs/[^\x00\s]{1,200})')
GIT_SHALLOW = re.compile(rb'shallow ' + GIT_OID + rb'\n?')
GIT_PKT_LEN = re.compile(rb'[0-9a-fA-F]{4}')
# The ref updates of a push precede its pack; longer lists are not read, and the push is high-risk.
GIT_COMMANDS_MAX = 65536


def git_push_commands(body):
    """The ref updates at the start of a git-receive-pack body, as (updates, capabilities), or None
    while the list has not ended. Updates are (old, new, ref) bytes. Raises ValueError if the
    list is malformed or longer than GIT_COMMANDS_MAX bytes."""
    pos, updates, caps = 0, [], frozenset()
    while True:
        if pos + 4 > len(body):
            if pos + 4 > GIT_COMMANDS_MAX:
                raise ValueError('the ref updates are too long to read')
            return None
        head = body[pos : pos + 4]
        if not GIT_PKT_LEN.fullmatch(head):
            raise ValueError('not a git push')
        size = int(head, 16)
        if size == 0:
            return updates, caps
        if size < 5 or pos + size > GIT_COMMANDS_MAX:
            raise ValueError('the ref updates are too long to read')
        if pos + size > len(body):
            return None
        line, pos = body[pos + 4 : pos + size], pos + size
        if GIT_SHALLOW.fullmatch(line):
            continue
        command, _, capabilities = line.partition(b'\0')
        match = GIT_UPDATE.fullmatch(command.rstrip(b'\n'))
        if match is None:
            raise ValueError('not a ref update')
        if not updates:
            caps = frozenset(capabilities.split())
        updates.append(match.groups())


def git_update_subject(old, new, ref):
    return ('delete ' if set(new) == {ord('0')} else 'update ') + ref.decode()


def graphql_mutation_names(body):
    """Field names of a request that carries a mutation (every selection in the document, so a
    high-risk operation is found wherever it sits), or '' for a request without one."""
    if not graphql_mutation(body):
        return ''
    document = graphql_document(body)
    if document is None:
        return 'unreadable'
    return ','.join(dict.fromkeys(re.findall(r'\b([a-z][A-Za-z]+)\s*[({]', document)))


def high_risk(decision, method, path, body, disabled=()):
    """(id, description) of the first high-risk entry this injected request matches, or None."""
    rule = decision.rule
    if rule is None:
        return None
    if rule.name == 'github-git':
        if not path.split('?', 1)[0].endswith('/git-receive-pack'):
            return None
        try:
            parsed = git_push_commands(body)
        except ValueError:
            parsed = None
        if parsed is None:
            # A push whose ref updates cannot be read could update anything.
            return 'github-push-unreadable', 'a push whose ref updates cannot be read'
        subjects = [git_update_subject(*u) for u in parsed[0]]
    elif rule.name == 'github-api' and path.split('?', 1)[0] == '/graphql':
        names = graphql_mutation_names(body)
        if names == 'unreadable':
            # A document that cannot be read could hold any mutation, like an unreadable push.
            return 'github-graphql-unreadable', 'a GraphQL request whose document cannot be read'
        subjects = [f'graphql-mutation:{names}']
    else:
        subjects = [decision.op or '']
    for entry_id, rule_name, pattern, text in HIGH_RISK:
        if rule_name != rule.name or entry_id in disabled:
            continue
        if any(re.search(pattern, s) for s in subjects):
            return entry_id, text
    return None


# ── per-agent egress ────────────────────────────────────────
# An agent with `egress: [...]` reaches only those hosts, plus what its runtime and connectors
# need. Without the field, egress stays open (phase 3, F2).

EGRESS_PATTERN = re.compile(r'^(\*\.)?[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$')
BASE_EGRESS = {
    # Codex fetches files it lists (plugin files, attachments) from OpenAI's content CDN, at
    # links chatgpt.com hands out; chatgpt.com is reachable anyway.
    'codex': ('chatgpt.com', '*.chatgpt.com', '*.oaiusercontent.com'),
    'claude': ('api.anthropic.com',),
    # Model metadata (context lengths); the endpoint's own host comes from the cell's Hermes rule.
    'hermes': ('models.dev',),
    'github': ('github.com', 'api.github.com', 'codeload.github.com', '*.githubusercontent.com'),
    'aws': ('*.amazonaws.com',),
    'linear': ('api.linear.app',),
    'posthog': ('us.posthog.com', 'eu.posthog.com'),
    'sentry': ('sentry.io', 'us.sentry.io', 'de.sentry.io'),
    'firecrawl': ('api.firecrawl.dev',),
    # Rendered images are links to Figma's S3 bucket.
    'figma': ('api.figma.com', 'figma-alpha-api.s3.us-west-2.amazonaws.com'),
    'discord': ('discord.com', 'cdn.discordapp.com', 'media.discordapp.net'),
}


def egress_allowlist(patterns, grants, extra=()):
    """The cell's allowed host patterns, or None for open egress. `extra` holds the hosts of
    the cell's stored-settings rules, which its runtime needs."""
    if patterns is None:
        return None
    allowed = {p.lower() for p in patterns}
    for grant in grants:
        allowed.update(BASE_EGRESS.get(grant, ()))
    for rule in extra:
        allowed.update(rule.hosts)
    return frozenset(allowed)


def egress_allowed(allowlist, host):
    if allowlist is None:
        return True
    return any(host_matches(p, host) for p in allowlist)
