import I18N from './i18n-data.js?v=__ASSET_VERSION__';

let currentLang = 'ja';

function t(key) {
  return I18N[currentLang]?.[key] ?? I18N.ja[key] ?? key;
}

function tVars(key, vars = {}) {
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    t(key)
  );
}

function applyI18n() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
}

export function setCurrentLang(lang) {
  if (lang === 'ja' || lang === 'en') currentLang = lang;
}

export { I18N, t, tVars, currentLang, applyI18n };
