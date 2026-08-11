'use strict';

const MAX_ROUTER_HOST_NAME_LENGTH = 80;

function normalizeRouterHostName(value) {
  return Array.from(String(value ?? ''), character => {
    const code = character.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ROUTER_HOST_NAME_LENGTH);
}

function promptLines(value) {
  return String(value || '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .reverse();
}

function extractCiscoHostName(value) {
  const [line = ''] = promptLines(value);
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,62})[>#]$/.exec(line);
  return match ? normalizeRouterHostName(match[1]) : '';
}

function extractYamahaConsolePrompt(value) {
  const [line = ''] = promptLines(value);
  const match = /^([^>#]{1,80})[>#]$/.exec(line);
  if (!match || /[()]/.test(match[1])) return '';
  const name = normalizeRouterHostName(match[1]);
  return name && !/^password\s*:?$/i.test(name) ? name : '';
}

module.exports = {
  MAX_ROUTER_HOST_NAME_LENGTH,
  normalizeRouterHostName,
  extractCiscoHostName,
  extractYamahaConsolePrompt,
};
