let api;
async function initializeLanguage() {
  api = await import('../renderer/i18n.mjs');
}
module.exports = {
  initializeLanguage,
  t: (...args) => (api ? api.t(...args) : String(args[0])),
  text: (strings, ...values) =>
    api ? api.text(strings, ...values) : String.raw({ raw: strings }, ...values),
  getLocale: () => api?.getLocale() || 'en',
  setLocale: (locale) => api.setLocale(locale),
};
