'use strict';

const { REPOSITORY_FILE_REDIRECTS } = require('./site-repository-links');

// CloudFront JS 2.0: this function is serialized into the deployed edge code.
function viewerRequest(event, canonicalHost, redirects) {
  const request = event.request;
  const host = request.headers.host && request.headers.host.value;
  const target = redirects[request.uri];
  if (target || (host && host.toLowerCase() !== canonicalHost)) {
    const parts = [];
    for (const key in request.querystring) {
      const item = request.querystring[key];
      const values = item.multiValue || [item];
      for (let i = 0; i < values.length; i++) {
        parts.push(key + (values[i].value === '' ? '' : '=' + values[i].value));
      }
    }
    const query = parts.length ? '?' + parts.join('&') : '';
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: (target || 'https://' + canonicalHost + request.uri) + query },
      },
    };
  }
  const uri = request.uri;
  if (uri.endsWith('/')) request.uri = uri + 'index.html';
  else if (!uri.split('/').pop().includes('.')) request.uri = uri + '/index.html';
  return request;
}

function buildSiteViewerRequestCode(canonicalHost) {
  const redirects = {
    ...REPOSITORY_FILE_REDIRECTS,
    '/dl': 'https://dl.egressview.com/',
    '/dl/': 'https://dl.egressview.com/',
    '/dl/index.html': 'https://dl.egressview.com/',
  };
  return `${viewerRequest.toString()}\nfunction handler(event) {\n` +
    `  return viewerRequest(event, ${JSON.stringify(canonicalHost)}, ${JSON.stringify(redirects)});\n}`;
}

module.exports = { buildSiteViewerRequestCode };
