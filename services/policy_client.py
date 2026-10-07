from common import Denied, rpc

SOCKET = '/run/secure-policy/api.sock'
# The agent the current request serves, set by the server for requests from the egress bridge.
AGENT = None


def require(action):
    scope = {'agent': AGENT} if AGENT else {}
    decision = rpc(SOCKET, {'op': 'authorize', 'action': action, **scope})
    if decision['decision'] != 'allow':
        raise Denied('APPROVAL_REQUIRED:' + decision['approval_id'])
    result = rpc(
        SOCKET,
        {'op': 'consume', 'action': action, 'grant_id': decision['grant_id'], 'ticket': decision['ticket'], **scope},
    )
    if result.get('allowed') is not True:
        raise Denied('POLICY_DENIED')
