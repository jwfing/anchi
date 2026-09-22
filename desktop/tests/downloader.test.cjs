const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { install, checkUrl, entriesFor } = require('../src/main/downloader.cjs');

async function archive(t, files) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-dl-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'src');
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fs.writeFile(path.join(source, name), text, { mode: 0o644 });
  }
  const tarball = path.join(base, 'tool.tar.gz');
  await promisify(execFile)('/usr/bin/tar', ['-czf', tarball, '-C', source, '.']);
  const bytes = await fs.readFile(tarball);
  return {
    base,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    tools: path.join(base, 'tools'),
  };
}
const respond = (status, body, headers = {}) => ({
  status,
  headers: new Headers(headers),
  body: body ? Readable.from([body]) : null,
});

test('manifest lists pinned tools per platform with sha256', () => {
  const linux = entriesFor('linux-x64');
  for (const name of ['lima', 'codex']) {
    assert.match(linux[name].sha256, /^[a-f0-9]{64}$/);
    assert(linux[name].url.startsWith('https://github.com/'));
    assert.doesNotThrow(() => checkUrl(linux[name].url));
  }
  assert.deepEqual(entriesFor('darwin-arm64'), {});
  for (const bad of [
    'http://github.com/x',
    'https://evil.example/x',
    'file:///etc/passwd',
    'nonsense',
  ])
    assert.throws(() => checkUrl(bad), /DOWNLOAD_HOST_NOT_ALLOWED/);
});

test('checksum mismatch leaves no executable and no current link', async (t) => {
  const { bytes, tools } = await archive(t, { 'bin/limactl': '#!/bin/sh\n' });
  const entry = {
    version: '1.0',
    url: 'https://github.com/x/y.tar.gz',
    sha256: 'f'.repeat(64),
    layout: 'tar',
    executable: 'bin/limactl',
  };
  await assert.rejects(
    install('lima', entry, { toolsDirectory: tools, fetch: async () => respond(200, bytes) }),
    /DOWNLOAD_CHECKSUM_MISMATCH/,
  );
  assert.deepEqual(await fs.readdir(path.join(tools, 'lima')), []);
});

test('successful install follows allowed redirects, renames install_as and switches current atomically', async (t) => {
  const { bytes, sha256, tools } = await archive(t, {
    'codex-x86_64-unknown-linux-musl': '#!/bin/sh\necho codex\n',
  });
  const entry = {
    version: 'v1',
    url: 'https://github.com/openai/codex/releases/download/v1/codex.tar.gz',
    sha256,
    layout: 'tar',
    executable: 'codex-x86_64-unknown-linux-musl',
    install_as: 'codex',
  };
  let calls = 0;
  const fetch = async (url) => {
    calls++;
    if (url.startsWith('https://github.com/'))
      return respond(302, null, { location: 'https://objects.githubusercontent.com/blob/1' });
    return respond(200, bytes);
  };
  const file = await install('codex', entry, { toolsDirectory: tools, fetch });
  assert.equal(file, path.join(tools, 'codex/v1/codex'));
  assert.equal((await fs.stat(file)).mode & 0o111, 0o111);
  assert.equal(await fs.readlink(path.join(tools, 'codex/current')), 'v1');
  assert.equal(calls, 2);
  await install('codex', entry, {
    toolsDirectory: tools,
    fetch: async () => {
      throw Error('MUST_NOT_DOWNLOAD_AGAIN');
    },
  });
  assert.equal(await fs.readlink(path.join(tools, 'codex/current')), 'v1');
});

test('redirects to unknown hosts, too many hops and oversized bodies are refused', async (t) => {
  const { bytes, sha256, tools } = await archive(t, { 'bin/limactl': 'x' });
  const entry = {
    version: '2',
    url: 'https://github.com/a/b.tar.gz',
    sha256,
    layout: 'tar',
    executable: 'bin/limactl',
  };
  await assert.rejects(
    install('lima', entry, {
      toolsDirectory: tools,
      fetch: async () => respond(302, null, { location: 'https://evil.example/b' }),
    }),
    /DOWNLOAD_HOST_NOT_ALLOWED/,
  );
  await assert.rejects(
    install('lima', entry, {
      toolsDirectory: tools,
      fetch: async (url) => respond(302, null, { location: url + '/again' }),
    }),
    /DOWNLOAD_TOO_MANY_REDIRECTS/,
  );
  await assert.rejects(
    install('lima', entry, {
      toolsDirectory: tools,
      fetch: async () => respond(200, bytes),
      maxBytes: 4,
    }),
    /DOWNLOAD_TOO_LARGE/,
  );
  await assert.rejects(
    install('lima', entry, { toolsDirectory: tools, fetch: async () => respond(500, null) }),
    /DOWNLOAD_FAILED/,
  );
  assert.deepEqual(await fs.readdir(path.join(tools, 'lima')), []);
});

test('immediate stream failures finish file creation and cleanup before rejecting', async (t) => {
  const { bytes, sha256, tools } = await archive(t, { 'bin/limactl': 'x' });
  const entry = {
    version: 'cleanup',
    url: 'https://github.com/a/b',
    sha256,
    executable: 'bin/limactl',
  };
  for (let i = 0; i < 20; i++) {
    await assert.rejects(
      install('lima', entry, {
        toolsDirectory: tools,
        fetch: async () => respond(200, bytes),
        maxBytes: 1,
      }),
      /DOWNLOAD_TOO_LARGE/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await fs.readdir(path.join(tools, 'lima')), []);
  }
});
