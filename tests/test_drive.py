import json
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import drive
from common import Denied
from connector_harness import ConnectorHarness

DOC = 'application/vnd.google-apps.document'


class DriveTests(ConnectorHarness):
    def test_validation_bounds(self):
        drive.validate('drive.search', {'query': 'q', 'limit': 10})
        for op, params in (
            ('drive.search', {'query': 'q', 'limit': 11}),
            ('drive.search', {'query': 'a\nb', 'limit': 1}),
            ('drive.read', {'file_id': '../x'}),
            ('drive.create', {'parent_id': 'root', 'name': 'n', 'mime_type': 'image/png', 'text': 'x'}),
            ('drive.create', {'parent_id': 'root', 'name': 'n', 'mime_type': 'text/plain', 'text': '中' * 17000}),
            ('drive.update', {'file_id': 'f', 'text': 'x'}),
        ):
            with self.subTest(op=op), self.assertRaises(Denied):
                drive.validate(op, params)
        with self.assertRaises(Denied):
            drive.validate('drive.delete', {})

    def test_search_and_read_export(self):
        listing = {'files': [{'id': 'f1', 'name': 'Plan', 'mimeType': DOC, 'modifiedTime': 't', 'secret': 'x'}]}
        self.responses = [(200, json.dumps(listing).encode())]
        result = drive.handle({'op': 'search', 'query': 'plan', 'limit': 5})
        self.assertEqual(result['files'], [{'id': 'f1', 'name': 'Plan', 'mimeType': DOC, 'modifiedTime': 't'}])
        self.assertIn('fullText+contains', self.calls[0][1])
        meta = {'id': 'f1', 'name': 'Plan', 'mimeType': DOC, 'headRevisionId': 'r9'}
        self.responses = [(200, json.dumps(meta).encode()), (200, ('正文' * 30000).encode())]
        result = drive.handle({'op': 'read', 'file_id': 'f1'})
        self.assertTrue(result['truncated'] and result['untrusted_content'])
        self.assertLessEqual(len(result['text'].encode()), 40000)
        self.assertIn('/export?mimeType=text%2Fplain', self.calls[2][1])
        self.responses = [(200, json.dumps({'id': 'f2', 'mimeType': 'image/png', 'name': 'x'}).encode())]
        with self.assertRaisesRegex(Denied, 'UNSUPPORTED_MIME_TYPE'):
            drive.handle({'op': 'read', 'file_id': 'f2'})

    def test_create_is_multipart_and_approved_with_full_text(self):
        self.responses = [(200, json.dumps({'id': 'new1', 'name': 'a.txt'}).encode())]
        result = drive.handle(
            {
                'op': 'create',
                'request_id': 'a' * 32,
                'parent_id': 'root',
                'name': 'a.txt',
                'mime_type': 'text/plain',
                'text': 'hello',
            }
        )
        self.assertEqual(result['id'], 'new1')
        method, path, headers, body = self.calls[0]
        self.assertEqual((method, path), ('POST', '/upload/drive/v3/files?uploadType=multipart'))
        self.assertIn('multipart/related', headers['Content-Type'])
        self.assertIn(b'hello', body)
        action = self.approved_action(drive)
        self.assertEqual(action['operation'], 'drive.create')
        self.assertEqual(action['params']['text'], 'hello')

    def test_update_binds_revision(self):
        meta = {'id': 'f1', 'name': 'Plan', 'mimeType': 'text/plain', 'headRevisionId': 'r1'}
        self.responses = [
            (200, json.dumps(meta).encode()),
            (200, json.dumps(meta).encode()),
            (200, json.dumps({'id': 'f1', 'headRevisionId': 'r2'}).encode()),
        ]
        drive.handle({'op': 'update', 'request_id': 'b' * 32, 'file_id': 'f1', 'text': 'v2'})
        action = self.approved_action(drive)
        self.assertEqual(action['params']['expected_revision'], 'r1')
        self.assertEqual(action['params']['name'], 'Plan')
        self.assertEqual(self.calls[2][:2], ('PATCH', '/upload/drive/v3/files/f1?uploadType=media'))
        changed = {**meta, 'headRevisionId': 'r2'}
        self.responses = [(200, json.dumps(meta).encode()), (200, json.dumps(changed).encode())]
        with self.assertRaisesRegex(Denied, 'TARGET_CHANGED'):
            drive.handle({'op': 'update', 'request_id': 'c' * 32, 'file_id': 'f1', 'text': 'v3'})
        self.assertEqual(len(self.calls), 5)

    def test_probe_returns_email_only(self):
        self.responses = [(200, json.dumps({'user': {'emailAddress': 'me@example.com', 'permissionId': 'x'}}).encode())]
        self.assertEqual(drive.probe('T'), 'me@example.com')


if __name__ == '__main__':
    unittest.main()
