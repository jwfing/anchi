const fs = require('node:fs/promises');
const path = require('node:path');
class Preferences {
  constructor(file) {
    this.file = file;
    this.locale = 'en';
    this.pending = Promise.resolve();
  }
  async load() {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (['en', 'zh-CN'].includes(value.locale)) this.locale = value.locale;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  setLocale(locale) {
    if (!['en', 'zh-CN'].includes(locale)) return Promise.reject(Error('INVALID_LOCALE'));
    const save = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file + '.tmp', JSON.stringify({ locale }) + '\n', { mode: 0o600 });
      await fs.rename(this.file + '.tmp', this.file);
      this.locale = locale;
      return { locale };
    };
    const operation = this.pending.then(save);
    this.pending = operation.catch(() => {});
    return operation;
  }
}
module.exports = { Preferences };
