'use strict';

const CATALOG = require('./data/i18n.json');

let _lang = 'ja';

function t(key, vars) {
  const tmpl = CATALOG[_lang]?.[key] ?? CATALOG.ja[key] ?? key;
  if (!vars) return tmpl;
  return tmpl.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

function setLanguage(lang) {
  if (lang === 'ja' || lang === 'en') _lang = lang;
}

function getLang() { return _lang; }

module.exports = { t, setLanguage, getLang };
