from common import Denied, rpc

SOCKET = '/run/secure-policy/api.sock'


def require(action):
    decision = rpc(SOCKET, {'op': 'authorize', 'action': action})
    if decision['decision'] != 'allow':
        raise Denied('APPROVAL_REQUIRED:' + decision['approval_id'])
    result = rpc(
        SOCKET, {'op': 'consume', 'action': action, 'grant_id': decision['grant_id'], 'ticket': decision['ticket']}
    )
    if result.get('allowed') is not True:
        raise Denied('POLICY_DENIED')
