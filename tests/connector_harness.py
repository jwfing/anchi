"""Shared fixture for connector handler tests: fake transport, temp ledger, stubbed policy and credential."""

import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))


class ConnectorHarness(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls, self.responses = [], []

        def transport(host, method, path, headers, body):
            self.calls.append((method, path, headers, body))
            return self.responses.pop(0)

        for p in (
            patch('common.TRANSPORT', transport),
            patch('connector_base.LEDGER_ROOT', Path(self.temp.name)),
            patch('connector_base.policy_client.require'),
            patch('connector_base.credential', return_value={'token': 'T', 'generation': 'g1'}),
        ):
            p.start()
            self.addCleanup(p.stop)

    def approved_action(self, module):
        return module.connector_base.policy_client.require.call_args.args[0]
