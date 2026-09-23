const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Preferences } = require('../src/main/preferences.cjs');
const { Controller, validateHostCommand } = require('../src/main/controller.cjs');
const { CONNECTORS } = require('../src/shared/connectors.cjs');

test('English is the default; every page switches both ways without translating user content', async () => {
  const { getLocale, setLocale } = await import('../src/renderer/i18n.mjs');
  const { renderPage, approvalSummary } = await import('../src/renderer/views.mjs');
  assert.equal(getLocale(), 'en');
  const content = '任务已完成 <script>不要翻译我</script>';
  const props = {
    state: {
      connected: true,
      busy: true,
      sessionId: 'session-1',
      directories: [],
      events: [],
      connectorCatalog: CONNECTORS,
      setup: {
        health: { supported: true, platform: 'linux-x64', manualSteps: [], configured: true },
      },
    },
    messages: [{ role: 'user', text: content }],
    draft: content,
    env: 'secure-vm · Running',
    approvals: [],
    detail: {
      id: 'abc',
      state: 'PENDING',
      digest: 'digest',
      action: {
        operation: 'notion.append',
        params: { text: content, page_id: 'page', expected_last_edited: 'date' },
      },
    },
  };
  for (const locale of ['en', 'zh-CN', 'en']) {
    setLocale(locale);
    const chat = renderPage({ ...props, page: 'agent' });
    assert(chat.includes(locale === 'en' ? 'New session' : '新会话'));
    assert(chat.includes('任务已完成 &lt;script&gt;不要翻译我&lt;/script&gt;'));
    assert(!chat.includes('<script>'));
    assert.equal(
      Object.fromEntries(approvalSummary(props.detail.action))[locale === 'en' ? 'Body' : '正文'],
      content,
    );
    for (const page of ['setup', 'permissions', 'activity']) {
      const result = renderPage({ ...props, page });
      assert(result.includes('<h1>'));
      if (locale === 'en') assert(!/\p{Script=Han}/u.test(result), page);
    }
  }
});

test('template localization only translates static segments and escapes catalog markup', async () => {
  const { html, text, setLocale, t, translateEvent } = await import('../src/renderer/i18n.mjs');
  setLocale('en');
  assert.equal(html`<p>任务已完成 ${'任务已完成'}</p>`, '<p>Task completed 任务已完成</p>');
  assert.equal(text`频道 ${'频道中文'}`, 'Channel 频道中文');
  assert.equal(t('操作'), 'Operation');
  assert.equal(translateEvent('Slack 令牌已导入。'), 'Slack token imported.');
  setLocale('zh-CN');
  assert.equal(translateEvent('Slack token imported.'), 'Slack 令牌已导入。');
  assert.throws(() => setLocale('fr'), /INVALID_LOCALE/);
  setLocale('en');
});

test('preferences default to English, persist across restart, and reject unsupported locales', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-language-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'preferences.json');
  const preferences = new Preferences(file);
  await preferences.load();
  assert.equal(preferences.locale, 'en');
  await preferences.setLocale('zh-CN');
  const restored = new Preferences(file);
  await restored.load();
  assert.equal(restored.locale, 'zh-CN');
  await assert.rejects(() => restored.setLocale('../bad'), /INVALID_LOCALE/);
  await Promise.all([restored.setLocale('zh-CN'), restored.setLocale('en')]);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).locale, 'en');
  await fs.writeFile(file, '{"locale":"fr"}');
  const invalid = new Preferences(file);
  await invalid.load();
  assert.equal(invalid.locale, 'en');
});

test('language IPC is allowlisted, works during setup and changes no runtime task', async () => {
  assert.throws(
    () => validateHostCommand('set-language', { locale: 'en', path: '/tmp' }),
    /INVALID_ARGUMENTS/,
  );
  assert.throws(() => validateHostCommand('set-language', { locale: 'fr' }), /INVALID_LOCALE/);
  let changed;
  const controller = new Controller({
    setup: { busy: true },
    onLanguageChange: (value) => {
      changed = value;
    },
    preferences: {
      async setLocale(locale) {
        return { locale };
      },
    },
    notify() {},
  });
  assert.deepEqual(await controller.dispatch('set-language', { locale: 'zh-CN' }), {
    locale: 'zh-CN',
  });
  assert.equal(changed, 'zh-CN');
});

test('native dialogs use the same catalog and locale as the renderer', async () => {
  const language = require('../src/main/language.cjs');
  await language.initializeLanguage();
  language.setLocale('en');
  assert.equal(language.t('取消'), 'Cancel');
  language.setLocale('zh-CN');
  assert.equal(language.t('取消'), '取消');
  language.setLocale('en');
});
