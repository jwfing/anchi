import json
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import notion
from common import Denied
from connector_harness import ConnectorHarness


class NotionTests(ConnectorHarness):
    def test_headers_and_search(self):
        results = {
            'results': [
                {
                    'id': 'p1',
                    'object': 'page',
                    'last_edited_time': 't',
                    'properties': {'title': {'type': 'title', 'title': [{'plain_text': 'Roadmap'}]}},
                },
                {'id': 'd1', 'object': 'database', 'last_edited_time': 't', 'title': [{'plain_text': 'Tasks'}]},
            ]
        }
        self.responses = [(200, json.dumps(results).encode())]
        result = notion.handle({'op': 'search', 'query': 'road', 'limit': 5})
        self.assertEqual(
            result['results'][0], {'id': 'p1', 'object': 'page', 'title': 'Roadmap', 'last_edited_time': 't'}
        )
        self.assertEqual(result['results'][1]['title'], 'Tasks')
        method, path, headers, body = self.calls[0]
        self.assertEqual((method, path, headers['Notion-Version']), ('POST', '/v1/search', '2022-06-28'))
        self.assertEqual(json.loads(body)['page_size'], 5)

    def test_read_flattens_blocks_and_paginates(self):
        page = {
            'id': 'p1',
            'last_edited_time': 'e1',
            'properties': {'title': {'type': 'title', 'title': [{'plain_text': 'Roadmap'}]}},
        }
        blocks1 = {
            'results': [
                {'type': 'heading_2', 'heading_2': {'rich_text': [{'plain_text': 'Goals'}]}},
                {'type': 'paragraph', 'paragraph': {'rich_text': [{'plain_text': 'Ship '}, {'plain_text': 'it'}]}},
                {'type': 'image', 'image': {}},
            ],
            'has_more': True,
            'next_cursor': 'c2',
        }
        blocks2 = {
            'results': [{'type': 'bulleted_list_item', 'bulleted_list_item': {'rich_text': [{'plain_text': 'a'}]}}],
            'has_more': False,
        }
        self.responses = [
            (200, json.dumps(page).encode()),
            (200, json.dumps(blocks1).encode()),
            (200, json.dumps(blocks2).encode()),
        ]
        result = notion.handle({'op': 'read', 'page_id': 'p1'})
        self.assertEqual(result['text'], 'Goals\nShip it\n- a')
        self.assertEqual(result['last_edited_time'], 'e1')
        self.assertIn('start_cursor=c2', self.calls[2][1])

    def test_create_and_append_bind_edit_time(self):
        self.responses = [(200, json.dumps({'id': 'new'}).encode())]
        notion.handle(
            {
                'op': 'create_page',
                'request_id': 'a' * 32,
                'parent_page_id': 'p1',
                'title': 'Notes',
                'paragraphs': ['one', 'two'],
            }
        )
        body = json.loads(self.calls[0][3])
        self.assertEqual(body['parent'], {'page_id': 'p1'})
        self.assertEqual(len(body['children']), 2)
        self.assertEqual(body['children'][0]['paragraph']['rich_text'][0]['text']['content'], 'one')
        page = {'id': 'p1', 'last_edited_time': 'e1', 'properties': {}}
        self.responses = [
            (200, json.dumps(page).encode()),
            (200, json.dumps(page).encode()),
            (200, json.dumps({'results': []}).encode()),
        ]
        notion.handle({'op': 'append', 'request_id': 'b' * 32, 'page_id': 'p1', 'paragraphs': ['x']})
        action = self.approved_action(notion)
        self.assertEqual(action['params']['expected_last_edited'], 'e1')
        self.assertEqual(self.calls[3][:2], ('PATCH', '/v1/blocks/p1/children'))
        self.responses = [
            (200, json.dumps(page).encode()),
            (200, json.dumps({**page, 'last_edited_time': 'e2'}).encode()),
        ]
        with self.assertRaisesRegex(Denied, 'TARGET_CHANGED'):
            notion.handle({'op': 'append', 'request_id': 'c' * 32, 'page_id': 'p1', 'paragraphs': ['x']})

    def test_validation(self):
        with self.assertRaises(Denied):
            notion.validate('notion.create_page', {'parent_page_id': 'p', 'title': 't', 'paragraphs': ['x' * 2001]})
        with self.assertRaises(Denied):
            notion.validate('notion.create_page', {'parent_page_id': 'p', 'title': 't', 'paragraphs': ['x'] * 101})
        with self.assertRaises(Denied):
            notion.validate('notion.read', {'page_id': 'p/1'})

    def test_probe(self):
        self.responses = [
            (200, json.dumps({'type': 'bot', 'name': 'Anchi', 'bot': {'workspace_name': 'Acme'}}).encode())
        ]
        self.assertEqual(notion.probe('ntn_x'), 'Acme')


if __name__ == '__main__':
    unittest.main()
