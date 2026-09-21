"""Text/function-only Codex requests; never hosted tools, files, URLs, or custom routes."""

import json
import re
from common import Denied, fields

TOOL_NAMES = {'read', 'bash', 'write', 'edit', 'gmail_status', 'gmail_list', 'gmail_read', 'host_files'}


def validate_parts(instructions, inputs, tools):
    if not isinstance(instructions, str) or not 1 <= len(instructions) <= 20000:
        raise Denied('BAD_INSTRUCTIONS')
    if (
        not isinstance(inputs, list)
        or not 1 <= len(inputs) <= 100
        or not isinstance(tools, list)
        or len(tools) > len(TOOL_NAMES)
    ):
        raise Denied('BAD_CODEX_INPUT')
    for tool in tools:
        if not isinstance(tool, dict):
            raise Denied('BAD_CODEX_TOOL')
        fields(tool, ('type', 'name', 'description', 'parameters', 'strict'), ('type', 'name', 'parameters'))
        if tool['type'] != 'function' or tool['name'] not in TOOL_NAMES or not isinstance(tool['parameters'], dict):
            raise Denied('BAD_CODEX_TOOL')
    if len({t['name'] for t in tools}) != len(tools):
        raise Denied('BAD_CODEX_TOOL')
    for item in inputs:
        if not isinstance(item, dict):
            raise Denied('BAD_CODEX_INPUT')
        kind = item.get('type', 'message')
        if kind == 'message':
            fields(item, ('type', 'role', 'content', 'id', 'status', 'phase'), ('role', 'content'))
            if item['role'] not in ('user', 'assistant') or not isinstance(item['content'], list):
                raise Denied('BAD_CODEX_INPUT')
            for content in item['content']:
                if not isinstance(content, dict):
                    raise Denied('TEXT_ONLY')
                fields(content, ('type', 'text', 'annotations'), ('type', 'text'))
                if (
                    content['type'] not in ('input_text', 'output_text')
                    or not isinstance(content['text'], str)
                    or content.get('annotations', []) != []
                ):
                    raise Denied('TEXT_ONLY')
        elif kind == 'function_call':
            fields(
                item, ('type', 'id', 'call_id', 'name', 'arguments', 'status'), ('type', 'call_id', 'name', 'arguments')
            )
            if item['name'] not in TOOL_NAMES or not isinstance(item['arguments'], str):
                raise Denied('BAD_CODEX_TOOL')
        elif kind == 'function_call_output':
            fields(item, ('type', 'call_id', 'output'), ('type', 'call_id', 'output'))
            if not isinstance(item['output'], str):
                raise Denied('TEXT_ONLY')
        elif kind == 'reasoning':
            fields(item, ('type', 'id', 'summary', 'encrypted_content', 'status'), ('type', 'id'))
            if not isinstance(item.get('summary', []), list) or not isinstance(item.get('encrypted_content', ''), str):
                raise Denied('BAD_REASONING')
        else:
            raise Denied('BAD_CODEX_INPUT')
    # UTF-8 bytes: the cell sends UTF-8, so CJK text is not penalized by ASCII escaping.
    if len(json.dumps([instructions, inputs, tools], ensure_ascii=False).encode()) > 44000:
        raise Denied('CODEX_CONTEXT_TOO_LARGE')


def validate_payload(payload):
    fields(
        payload,
        (
            'model',
            'store',
            'stream',
            'instructions',
            'input',
            'tools',
            'tool_choice',
            'parallel_tool_calls',
            'include',
            'reasoning',
        ),
        (
            'model',
            'store',
            'stream',
            'instructions',
            'input',
            'tools',
            'tool_choice',
            'parallel_tool_calls',
            'include',
            'reasoning',
        ),
    )
    if not isinstance(payload['model'], str) or not re.fullmatch('gpt-[a-zA-Z0-9._-]{1,80}', payload['model']):
        raise Denied('BAD_MODEL_NAME')
    if (
        payload['store'] is not False
        or payload['stream'] is not True
        or payload['parallel_tool_calls'] is not False
        or payload['tool_choice'] != 'auto'
        or payload['include'] != ['reasoning.encrypted_content']
        or payload['reasoning'] != {'effort': 'low', 'summary': 'auto'}
    ):
        raise Denied('BAD_CODEX_OPTIONS')
    validate_parts(payload['instructions'], payload['input'], payload['tools'])
