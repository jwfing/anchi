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
from dataclasses import dataclass, field
from urllib.parse import parse_qs
from xml.sax.saxutils import escape

PLACEHOLDER_MARK = 'anchi-placeholder'
PLACEHOLDER_AWS_KEY = 'AKIAANCHIPLACEHOLDER'
CONNECTORS = ('github', 'aws', 'linear')
# Runtime credentials an agent of that runtime gets; injected replace-only.
RUNTIMES = ('codex', 'claude')
PLACEHOLDER_CLAUDE_OAUTH = 'sk-ant-oat01-anchi-placeholder-' + '0' * 40
PLACEHOLDER_CLAUDE_KEY = 'sk-ant-api03-anchi-placeholder-' + '0' * 40


@dataclass(frozen=True)
class Rule:
    name: str
    hosts: tuple[str, ...]
    # bearer | basic | raw | aws_sigv4 | anthropic | none (deny-only)
    kind: str
    # Connector or runtime that grants this rule; None applies to every agent.
    grant: str | None
    deny: tuple[str, ...] = field(default=())
    # When set, only matching paths are injected; others pass through untouched.
    path: str | None = None
    # Inject only when the client sent a placeholder, never into an unauthenticated request.
    replace_only: bool = False


RULES: tuple[Rule, ...] = (
    Rule(name='codex', hosts=('chatgpt.com',), kind='bearer', grant='codex', replace_only=True),
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


def find_rule(host):
    for rule in RULES:
        if any(host_matches(p, host) for p in rule.hosts):
            return rule
    return None


def classify_credential(headers):
    """What kind of credential the client sent, without revealing it."""
    auth = headers.get('authorization', '') or headers.get('x-api-key', '')
    if not auth:
        return 'none'
    if PLACEHOLDER_MARK in auth or PLACEHOLDER_AWS_KEY in auth:
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


def decide(method, host, path, headers, body, grants):
    """`headers` has lowercase keys. `grants` holds the agent's connectors and runtime."""
    rule = find_rule(host)
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
        if not ip.is_global or ip.is_multicast:
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
    'github': ('GET', 'https://api.github.com/user', b''),
    'linear': ('POST', 'https://api.linear.app/graphql', b'{"query":"{ viewer { email name } }"}'),
    'aws': ('POST', 'https://sts.{region}.amazonaws.com/', b'Action=GetCallerIdentity&Version=2011-06-15'),
}


def verify_request(connector, credential):
    """(method, url, headers, body) of the identity call for `connector`."""
    method, url, body = VERIFY_ENDPOINTS[connector]
    headers = {'user-agent': 'anchi-egress-verify', 'accept': 'application/json'}
    if connector == 'github':
        headers['authorization'] = f'Bearer {credential["token"]}'
    elif connector == 'linear':
        headers['authorization'] = credential['token']
        headers['content-type'] = 'application/json'
    else:
        url = url.format(region=credential['region'])
        headers = {'content-type': 'application/x-www-form-urlencoded'}
        headers = aws_resign(method, url, headers, body, credential['region'], 'sts', credential)
    return method, url, headers, body


def verify_account(connector, status, body):
    """Account label from the identity call's response; ValueError when the credential is refused."""
    if status in (401, 403):
        raise ValueError('CREDENTIAL_REJECTED')
    if status != 200:
        raise ValueError(f'VERIFY_HTTP_{status}')
    text = body.decode('utf-8', 'replace')
    try:
        if connector == 'github':
            return str(json.loads(text)['login'])[:100]
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
GRAPHQL_MUTATION = re.compile(r'^\s*mutation\b')


def graphql_mutation(body):
    try:
        query = json.loads(body or b'{}').get('query', '')
    except (ValueError, AttributeError):
        return True  # unreadable: treat as a write
    return isinstance(query, str) and bool(GRAPHQL_MUTATION.match(query))


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
    try:
        query = json.loads(body or b'{}').get('query', '')
    except (ValueError, AttributeError):
        return ''
    if not isinstance(query, str) or not GRAPHQL_MUTATION.match(query):
        return ''
    return ','.join(dict.fromkeys(re.findall(r'\b([a-z][A-Za-z]+)\s*[({]', query)))


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
        subjects = [f'graphql-mutation:{graphql_mutation_names(body)}']
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
    'codex': ('chatgpt.com', '*.chatgpt.com'),
    'claude': ('api.anthropic.com',),
    'github': ('github.com', 'api.github.com', 'codeload.github.com', '*.githubusercontent.com'),
    'aws': ('*.amazonaws.com',),
    'linear': ('api.linear.app',),
}


def egress_allowlist(patterns, grants):
    """The cell's allowed host patterns, or None for open egress."""
    if patterns is None:
        return None
    allowed = {p.lower() for p in patterns}
    for grant in grants:
        allowed.update(BASE_EGRESS.get(grant, ()))
    return frozenset(allowed)


def egress_allowed(allowlist, host):
    if allowlist is None:
        return True
    return any(host_matches(p, host) for p in allowlist)
