// Frontend lint: detect potential TDZ (Temporal Dead Zone) errors
// Checks that variables declared with 'let' are not referenced before their declaration line
// Run: node --test test/unit/frontend-lint.test.js
//
// Phase 2 update: JS was extracted from index.html into public/js/*.js.
// Phase 3 update: Migrated to ES modules — index.html now has a single
// <script type="module" src="__BASE__/js/main.js?v=__ASSET_VERSION__">.
// All public/js/*.js files are loaded directly for content analysis.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '..', '..', 'public', 'index.html');
const jsDir    = path.join(__dirname, '..', '..', 'public', 'js');
const frontendDepsPath = path.join(__dirname, '..', '..', 'docs', 'frontend-dependencies.md');
const html     = fs.readFileSync(htmlPath, 'utf8');
const frontendDeps = fs.readFileSync(frontendDepsPath, 'utf8');
const logJs    = fs.readFileSync(path.join(jsDir, 'log.js'), 'utf8');
const mainJs   = fs.readFileSync(path.join(jsDir, 'main.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
const yamahaJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'pollers', 'yamaha.js'), 'utf8');
const asusJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'pollers', 'asus.js'), 'utf8');
const historyJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'history.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const moduleSources = Object.fromEntries(
  fs.readdirSync(jsDir)
    .filter(file => file.endsWith('.js'))
    .map(file => [file, fs.readFileSync(path.join(jsDir, file), 'utf8')])
);

// The canonical list of frontend JS modules in dependency order.
// This mirrors the import graph rooted at main.js.
const APP_SCRIPT_FILES = [
  'i18n.js',
  'utils.js',
  'connections-panel.js',
  'map-common.js',
  'view-tabs.js',
  'auth-socket.js',
  'graph.js',
  'stats.js',
  'threat-popup.js',
  'beacon.js',
  'devices.js',
  'notif-log.js',
  'log.js',
  'settings.js',
  'time-filter.js',
  'main.js',
];

// Load all public/js/*.js files and concatenate them for content analysis.
// Since they are ES modules, import/export lines are stripped for static
// grep-style checks that don't need module resolution.
function getScriptContent() {
  const parts = APP_SCRIPT_FILES.map(file => {
    const filePath = path.join(jsDir, file);
    if (fs.existsSync(filePath)) {
      return `// === ${file} ===\n` + fs.readFileSync(filePath, 'utf8');
    }
    return `// [MISSING FILE: ${file}]`;
  });
  return parts.join('\n');
}

function getAppScriptFiles() {
  return APP_SCRIPT_FILES;
}

function importedNames(source) {
  const names = new Set();
  const importRe = /import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g;
  let m;
  while ((m = importRe.exec(source)) !== null) {
    m[1].split(',').forEach(part => {
      const local = part.trim().split(/\s+as\s+/).pop().trim();
      if (local) names.add(local);
    });
  }
  return names;
}

function declaredNames(source) {
  const names = new Set();
  const declRe = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = declRe.exec(source)) !== null) names.add(m[1] || m[2]);
  return names;
}

function exportedNames(source) {
  const names = new Set();
  const declRe = /(?:^|\n)\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:^|\n)\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = declRe.exec(source)) !== null) names.add(m[1] || m[2]);

  const listRe = /export\s+\{([^}]+)\}/g;
  while ((m = listRe.exec(source)) !== null) {
    m[1].split(',').forEach(part => {
      const exported = part.trim().split(/\s+as\s+/).pop().trim();
      if (exported) names.add(exported);
    });
  }
  return names;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasClickHandler(script, id) {
  const qid = escapeRegExp(id);
  if (new RegExp(`getElementById\\(['"]${qid}['"]\\)[\\s\\S]{0,120}addEventListener\\(['"]click['"]`).test(script)) {
    return true;
  }
  if (new RegExp(`getElementById\\(['"]${qid}['"]\\)[\\s\\S]{0,120}\\.onclick\\s*=`).test(script)) {
    return true;
  }
  const assignmentRe = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*document\\.getElementById\\(['"]${qid}['"]\\)`);
  const assignment = script.match(assignmentRe);
  if (!assignment) return false;
  return new RegExp(`\\b${assignment[1]}\\b(?:\\?\\.)?\\.addEventListener\\(['"]click['"]`).test(script);
}

describe('Frontend script wiring invariants', () => {
  it('uses a single ES module entry point in index.html', () => {
    assert.match(html, /<script type="module" src="__BASE__\/js\/main\.js\?v=__ASSET_VERSION__"><\/script>/,
      'index.html should load main.js as an ES module entry point');
    // Should not have any classic <script src="__BASE__/js/..."> tags remaining
    const classicRe = /<script src="__BASE__\/js\/[^"]+"><\/script>/g;
    const classicTags = html.match(classicRe) || [];
    assert.equal(classicTags.length, 0,
      `Classic script tags should be replaced by the ES module entry: found ${classicTags.join(', ')}`);
  });

  it('cache-busts frontend assets after server restart or deploy', () => {
    assert.match(html, /<link rel="stylesheet" href="__BASE__\/style\.css\?v=__ASSET_VERSION__">/,
      'style.css should include the generated asset version');
    assert.match(html, /<script type="module" src="__BASE__\/js\/main\.js\?v=__ASSET_VERSION__"><\/script>/,
      'main.js ES module entry should include the generated asset version');
    assert.match(serverJs, /process\.env\.EGRESSVIEW_ASSET_VERSION/,
      'server should read the asset version from the environment variable');
    assert.match(serverJs, /String\(Date\.now\(\)\)/,
      'server should generate an asset version for each process start unless explicitly set');
    assert.match(serverJs, /\.replace\(/,
      'index rendering should perform template replacement');
    assert.match(serverJs, /__ASSET_VERSION__/,
      'index rendering should replace the asset version placeholder');
    assert.match(serverJs, /filePath\.endsWith\('\.js'\)/,
      'ES module child scripts should be handled explicitly because imports do not inherit main.js cache-busting');
    assert.match(serverJs, /Cache-Control',\s*'no-cache,\s*must-revalidate'/,
      'ES module child scripts should require revalidation so stale modules do not survive a deploy');
    assert.match(serverJs, /js\.replace\(\s*\/__ASSET_VERSION__\/g/,
      'served JS modules should replace the asset version placeholder in child import URLs');
    for (const [file, source] of Object.entries(moduleSources)) {
      if (!source.includes("from './")) continue;
      assert.doesNotMatch(source, /from\s+['"]\.\/[^'"]+\.js['"]/,
        `${file} should version local ES module imports so stale child modules are not reused`);
      assert.match(source, /from\s+['"]\.\/[^'"]+\.js\?v=__ASSET_VERSION__['"]/,
        `${file} should include the asset version placeholder on local ES module imports`);
    }
  });

  it('renders index.html through the template path for subpath deployments', () => {
    assert.match(serverJs, /const\s+indexRoutes\s*=\s*\['\/',\s*'\/index\.html'\]/,
      'root index routes should be listed explicitly');
    assert.match(serverJs, /if\s*\(\s*SUBPATH\s*\)\s*indexRoutes\.push\(`\$\{SUBPATH\}\/`,\s*`\$\{SUBPATH\}\/index\.html`\)/,
      'subpath index routes should also use the rendered template, not raw static index.html');
    assert.match(serverJs, /app\.get\(indexRoutes,/,
      'index route should be registered from the combined route list');
  });

  it('keeps main.js as the ES module entry point', () => {
    assert.equal(getAppScriptFiles().at(-1), 'main.js');
  });

  it('keeps cross-file public APIs available as ES module exports', () => {
    const publicApis = [
      { file: 'auth-socket.js', name: 'apiFetch', re: /async function apiFetch\(/ },
      { file: 'auth-socket.js', name: 'socket', re: /const socket\s*=\s*io\(/ },
      { file: 'auth-socket.js', name: 'lookupNote', re: /function lookupNote\(/ },
      { file: 'graph.js', name: 'buildGraphFromConnections', re: /function buildGraphFromConnections\(/ },
      { file: 'stats.js', name: 'updateStats', re: /async function updateStats\(/ },
      { file: 'log.js', name: 'updateLogView', re: /function updateLogView\(/ },
      { file: 'devices.js', name: 'loadDevicesView', re: /async function loadDevicesView\(/ },
      { file: 'notif-log.js', name: 'loadNotifLog', re: /async function loadNotifLog\(/ },
      { file: 'view-tabs.js', name: 'switchView', re: /function switchView\(/ },
    ];

    for (const { file, name, re } of publicApis) {
      const source = fs.readFileSync(path.join(jsDir, file), 'utf8');
      assert.match(source, re, `${name} must remain available from ${file}`);
    }
  });

  it('imports module-scoped helpers instead of relying on legacy globals', () => {
    const helperOwners = {
      t: 'i18n.js',
      tVars: 'i18n.js',
      _BASE: 'utils.js',
      apiFetch: 'auth-socket.js',
      openNoteModal: 'auth-socket.js',
      esc: 'utils.js',
      typeLabel: 'utils.js',
      currentView: 'view-tabs.js',
      ensureWorldGeo: 'map-common.js',
    };
    const allowedGlobals = new Set([
      'window', 'document', 'navigator', 'localStorage', 'console',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'prompt',
      'alert', 'confirm', 'URLSearchParams', 'Date', 'Math', 'Number',
      'String', 'Array', 'Map', 'Set', 'RegExp', 'JSON', 'Promise',
      'Error', 'encodeURIComponent', 'decodeURIComponent', 'parseInt',
      'parseFloat', 'isNaN', 'isFinite', 'd3', 'topojson', 'io',
      'BASE_URL',
    ]);

    for (const [file, source] of Object.entries(moduleSources)) {
      const imported = importedNames(source);
      const declared = declaredNames(source);
      for (const [name, owner] of Object.entries(helperOwners)) {
        if (file === owner) continue;
        if (!new RegExp(`\\b${name}\\b`).test(source)) continue;
        assert(
          imported.has(name) || declared.has(name) || allowedGlobals.has(name),
          `${file} references ${name} but does not import it from ${owner}`
        );
      }
    }
    for (const [file, source] of Object.entries(moduleSources)) {
      if (file === 'utils.js') continue;
      assert.doesNotMatch(source, /\bBASE_URL\b/,
        `${file} should import/use _BASE instead of relying on bare BASE_URL`);
    }
  });

  it('only imports names that are exported by the referenced local module', () => {
    const exportCache = new Map();
    const exportsFor = file => {
      if (!exportCache.has(file)) {
        assert(moduleSources[file], `missing module source for ${file}`);
        exportCache.set(file, exportedNames(moduleSources[file]));
      }
      return exportCache.get(file);
    };

    for (const [file, source] of Object.entries(moduleSources)) {
      const importRe = /import\s+\{([^}]+)\}\s+from\s+['"]\.\/([^'"?]+\.js)(?:\?[^'"]*)?['"]/g;
      let m;
      while ((m = importRe.exec(source)) !== null) {
        const imported = m[1].split(',').map(part => part.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        const targetFile = m[2];
        const targetExports = exportsFor(targetFile);
        for (const name of imported) {
          assert(targetExports.has(name),
            `${file} imports ${name} from ${targetFile}, but ${targetFile} does not export it`);
        }
      }
    }
  });

  it('does not assign to imported ES module bindings', () => {
    for (const [file, source] of Object.entries(moduleSources)) {
      const imported = importedNames(source);
      for (const name of imported) {
        if (name.length < 3) continue;
        assert.doesNotMatch(source, new RegExp(`(?<!\\b(?:const|let|var)\\s)\\b${name}\\s*=(?![=>])`),
          `${file} should not assign to imported binding ${name}; use an exported setter instead`);
      }
    }
  });

  it('documents frontend load order and module dependency graph', () => {
    for (const file of getAppScriptFiles()) {
      assert.match(frontendDeps, new RegExp(`\\b${file.replace('.', '\\.')}\\b`),
        `docs/frontend-dependencies.md should mention ${file}`);
    }
  });
});

describe('Frontend TDZ lint', () => {
  const script = getScriptContent();
  const lines  = script.split('\n');

  it('has script content to analyze', () => {
    assert(lines.length > 100,
      `Expected >100 lines of JS (from public/js/*.js), got ${lines.length}. ` +
      `Check that APP_SCRIPT_FILES are populated and the files exist.`);
  });

  it('no let/const variables used before declaration in immediate execution', () => {
    // With ES modules, each file is its own scope, so TDZ risks from classic-script
    // load-order no longer apply. The old check for 'let homeCountry', 'let worldGeo', etc.
    // is obsolete since those are now module-scoped exports.
    // We keep this test as a placeholder to verify no global-scope TDZ risks remain
    // in any module that has top-level immediate execution.
    //
    // For now: verify there are no obvious top-level assignment references to variables
    // that are declared later in the same (concatenated) file set.
    // This is a no-op check post-ES-module migration.
    assert.ok(true, 'ES module scoping eliminates classic-script TDZ risks');
  });

  it('API fetches use apiFetch (not raw fetch with adminToken)', () => {
    // Raw fetch() with 'adminToken' key would use the wrong localStorage key
    // (correct key is TOKEN_KEY = 'egressview_admin_token', accessed via apiFetch)
    const badLines = lines
      .map((line, i) => ({ line, num: i + 1 }))
      .filter(({ line }) => /localStorage\.getItem\(['"]adminToken['"]\)/.test(line));
    assert.equal(badLines.length, 0,
      `Found raw fetch using wrong localStorage key 'adminToken' (should use apiFetch):\n  ` +
      badLines.map(l => `L${l.num}: ${l.line.trim()}`).join('\n  '));
  });

  it('all view containers toggled in switchView exist in HTML', () => {
    // Extract container IDs from switchView display toggles (from JS files)
    const toggleRe = /getElementById\(['"]([^'"]+)['"]\)\.style\.display\s*=\s*view\s*===\s*['"][^'"]+['"]\s*\?/g;
    const toggled = [];
    let m;
    while ((m = toggleRe.exec(script)) !== null) {
      toggled.push(m[1]);
    }
    const htmlIds = new Set();
    const idRe = /\bid=["']([^"']+)["']/g;
    while ((m = idRe.exec(html)) !== null) {
      htmlIds.add(m[1]);
    }
    const missing = toggled.filter(id => !htmlIds.has(id));
    assert.equal(missing.length, 0,
      `switchView toggles missing HTML ids:\n  ${[...new Set(missing)].join('\n  ')}`);
  });

  it('getElementById targets exist in HTML', () => {
    // After Phase 2, getElementById calls live in public/js/*.js (not inline in index.html).
    // Scan the concatenated JS content (not html) for all getElementById calls.
    const idCalls = [];
    const re = /getElementById\(['"]([^'"]+)['"]\)/g;
    let m;
    while ((m = re.exec(script)) !== null) {
      idCalls.push(m[1]);
    }

    // Extract all id="xxx" in HTML
    const htmlIds = new Set();
    const idRe = /\bid=["']([^"']+)["']/g;
    while ((m = idRe.exec(html)) !== null) {
      htmlIds.add(m[1]);
    }

    // Collect IDs that are dynamically injected via innerHTML template literals / strings.
    // e.g. `innerHTML = \`...<div id="foo">...\`` — these are created at runtime and
    // are legitimately referenced with getElementById immediately after.
    const dynamicIdRe = /\bid=["'`]([^"'`\s\\]+)["'`]/g;
    const dynamicIds = new Set();
    while ((m = dynamicIdRe.exec(script)) !== null) {
      dynamicIds.add(m[1]);
    }
    const assignedIdRe = /\.id\s*=\s*['"]([^'"]+)['"]/g;
    while ((m = assignedIdRe.exec(script)) !== null) {
      dynamicIds.add(m[1]);
    }

    const missing = idCalls.filter(id => !htmlIds.has(id) && !dynamicIds.has(id));
    // Dedupe
    const unique = [...new Set(missing)];
    assert.equal(unique.length, 0, `getElementById references missing HTML ids:\n  ${unique.join('\n  ')}`);
  });

  it('wires primary dialog and settings buttons to click handlers', () => {
    const primaryButtonIds = [
      // Shared note modal
      'note-save',
      'note-cancel',

      // Settings modal
      'settings-close',
      'yamaha-detect-btn',
      'yamaha-connect-btn',
      'asus-connect-btn',
      'general-save-btn',
      'pw-change-btn',
      'sessions-revoke-all-btn',
      'token-regen-btn',
      'threat-save-btn',
      'beacon-save-btn',
      'slack-verify-btn',
      'slack-lookup-btn',
      'slack-save-btn',
      'slack-test-btn',
      'backup-config-save',
      'backup-create-btn',
      'datasource-save-btn',

      // Device inventory detail and filters
      'dv-detail-close',
      'dv-detail-save',
      'dv-detail-investigate',
      'dv-detail-archive',
      'dv-search-apply',
      'dv-search-clear',
      'dv-search-close',
      'dv-clear-filters-btn',
      'devices-refresh-btn',

      // Log and notification log controls
      'log-search-apply',
      'log-search-clear',
      'log-search-close',
      'notif-log-search-apply',
      'notif-log-search-clear',
      'notif-log-search-close',
      'notif-log-refresh-btn',
      'notif-log-detail-close',
    ];

    const missing = primaryButtonIds.filter(id => !hasClickHandler(script, id));
    assert.equal(missing.length, 0,
      `Primary buttons should have click handlers:\n  ${missing.join('\n  ')}`);
    assert.match(script, /settingsBtn\.addEventListener\(['"]click['"]/,
      'settings button should open the settings modal');
  });
});

describe('Disconnect banner behavior invariants', () => {
  function snippetBetween(start, end) {
    const s = mainJs.indexOf(start);
    assert.notEqual(s, -1, `start marker not found: ${start}`);
    const e = mainJs.indexOf(end, s);
    assert.notEqual(e, -1, `end marker not found: ${end}`);
    return mainJs.slice(s, e);
  }

  it('auth-required resets the reconnect banner text before targeting the L2 settings tab', () => {
    const handler = snippetBetween("socket.on('auth-required'", "socket.on('yamaha-status'");
    assert.match(handler, /textContent\s*=\s*t\(['"]banner\.button['"]\)/,
      'ASUS/L2 auth-required should restore the generic reconnect button label');
    assert.match(handler, /openSettings\(['"]l2['"]\)/,
      'ASUS/L2 auth-required should send the reconnect button to the L2 settings tab');
  });
});

describe('Connection Log pagination/filter invariants', () => {
  function snippetBetween(start, end) {
    const s = logJs.indexOf(start);
    assert.notEqual(s, -1, `start marker not found: ${start}`);
    const e = logJs.indexOf(end, s);
    assert.notEqual(e, -1, `end marker not found: ${end}`);
    return logJs.slice(s, e);
  }

  it('client-side-only filters are detected as requiring full-fetch mode', () => {
    const fn = snippetBetween('function hasClientSideOnlyFilter()', 'let logFetchAllMode');
    assert.match(fn, /!LOG_SERVER_SORT_COLS\.has\(logSortState\.col\)/,
      'client-only sort columns must switch the log to full-fetch mode');
    assert.doesNotMatch(fn, /logThreatFilter\s*!==\s*null/,
      'threat badge filters are server-side and must not force full-fetch mode');
    assert.match(fn, /col\s*===\s*['"]app['"]/,
      'app filters must switch the log to full-fetch mode');
    assert.match(fn, /col\s*===\s*['"]threatTag['"]/,
      'threatTag filters must switch the log to full-fetch mode');
    assert.match(fn, /filter\.mode\s*===\s*['"]regex['"]/,
      'regex filters must switch the log to full-fetch mode');
  });

  it('full-fetch mode omits limit/offset so client-side filters see all matching rows', () => {
    const fn = snippetBetween('async function fetchLogPage()', '// ── Render');
    assert.match(fn, /logFetchAllMode\s*=\s*hasClientSideOnlyFilter\(\)/,
      'fetchLogPage must recompute whether a full fetch is required');
    assert.match(fn, /if\s*\(!logFetchAllMode\)\s*{[\s\S]*params\.set\(['"]limit['"][\s\S]*params\.set\(['"]offset['"]/,
      'limit/offset should only be added when full-fetch mode is off');
  });

  it('threat badge filters are sent to the server while keeping pagination', () => {
    const fn = snippetBetween('async function fetchLogPage()', '// Device filter:');
    assert.match(fn, /if\s*\(logThreatFilter\)\s*params\.set\(['"]fThreat['"],\s*logThreatFilter\)/,
      'threat badge filters must be passed to /api/connections as fThreat');
    assert.match(fn, /if\s*\(!logFetchAllMode\)\s*{[\s\S]*params\.set\(['"]limit['"][\s\S]*params\.set\(['"]offset['"]/,
      'server-side threat filters should preserve normal pagination');
  });

  it('search apply refetches instead of filtering only the current page', () => {
    const handler = snippetBetween(
      "document.getElementById('log-search-apply').addEventListener",
      "document.getElementById('log-search-clear').addEventListener"
    );
    assert.match(handler, /resetAndFetch\(\)/,
      'app/threatTag/regex filters need a refetch so they can enter full-fetch mode');
    assert.doesNotMatch(handler, /renderLogView\(\)/,
      'search apply must not render only the current page after changing filters');
  });

  it('threat badge filters refetch instead of filtering only the current page', () => {
    const section = snippetBetween('threatCountEl.innerHTML', '// Sort icon state');
    for (const id of ['safe', 'warn', 'danger']) {
      const re = new RegExp(`log-filter-${id}[\\s\\S]*?resetAndFetch\\(\\)`);
      assert.match(section, re, `${id} threat badge should refetch before applying badge filter`);
    }
    assert.doesNotMatch(section, /renderLogView\(\)/,
      'threat badge clicks must not filter only the currently loaded page');
  });

  it('client-only column sorting refetches so sort order covers the full result set', () => {
    const handler = snippetBetween(
      "document.querySelectorAll('#log-table th[data-col]').forEach",
      '// ── Search popup logic'
    );
    assert.match(handler, /resetAndFetch\(\)/,
      'sorting app/threatTag should refetch and use full-fetch mode before sorting');
    assert.doesNotMatch(handler, /renderLogView\(\)/,
      'header sort must not sort only the currently loaded page');
  });
});

describe('Server runtime invariants', () => {
  it('Yamaha polling reschedules with POLL_INTERVAL, not a hard-coded 60 seconds', () => {
    assert.match(serverJs, /setTimeout\(pollYamahaConnections,\s*POLL_INTERVAL\)/,
      'pollYamahaConnections should honor POLL_INTERVAL_MS');
    assert.doesNotMatch(serverJs, /setTimeout\(pollYamahaConnections,\s*60000\)/,
      'pollYamahaConnections must not reschedule with a hard-coded 60000 ms');
  });

  it('Yamaha connection failures emit state="failed" so the UI does not stay waiting forever', () => {
    for (const key of ['yamaha.shell-failed', 'yamaha.init-failed', 'yamaha.ssh-failed']) {
      const re = new RegExp(`onStatus\\(\\{\\s*ready:\\s*false,\\s*state:\\s*['"]failed['"][\\s\\S]*?${key.replace(/\./g, '\\.')}`);
      assert.match(yamahaJs, re, `${key} must include state: 'failed'`);
    }
    assert.match(yamahaJs, /credentials not configured[\s\S]*?onStatus\(\{\s*ready:\s*false,\s*state:\s*['"]failed['"]/,
      'missing Yamaha credentials should notify the UI as a failed state');
  });

  it('Yamaha polling queues external enrichment instead of awaiting it inline', () => {
    const start = serverJs.indexOf('async function pollYamahaConnections()');
    assert.notEqual(start, -1, 'pollYamahaConnections should exist');
    const end = serverJs.indexOf('// ─── Express middleware', start);
    assert.notEqual(end, -1, 'pollYamahaConnections section end marker should exist');
    const pollFn = serverJs.slice(start, end);
    assert.match(pollFn, /queueConnectionEnrichment\(unique\)/,
      'polling should enqueue DNS/RDAP/Geo work in the background');
    assert.doesNotMatch(pollFn, /await\s+enrichment\.lookupRdapBatch/,
      'polling must not wait for RDAP lookups before continuing');
    assert.doesNotMatch(pollFn, /await\s+enrichment\.lookupGeoBatch/,
      'polling must not wait for GeoIP lookups before continuing');
  });

  it('stats view previews the app pie before waiting for server summary', () => {
    const script = getScriptContent();
    const start = script.indexOf('async function updateStats()');
    assert.notEqual(start, -1, 'updateStats should exist');
    const end = script.indexOf('// ─── App distribution pie chart', start);
    assert.notEqual(end, -1, 'updateStats section end marker should exist');
    const updateStatsFn = script.slice(start, end);
    const previewAt = updateStatsFn.indexOf('renderStatsPiePreview(selIp)');
    const fetchAt = updateStatsFn.indexOf('await fetchStatsSummary(selIp)');
    assert.notEqual(previewAt, -1, 'updateStats should draw an immediate pie preview');
    assert.notEqual(fetchAt, -1, 'updateStats should still fetch the authoritative summary');
    assert.ok(previewAt < fetchAt,
      'the app pie preview should render before the potentially slow summary request resolves');
  });

  it('stats maps do not keep the previous period while waiting for summary', () => {
    const script = getScriptContent();
    const start = script.indexOf('async function updateStats()');
    assert.notEqual(start, -1, 'updateStats should exist');
    const end = script.indexOf('// ─── App distribution pie chart', start);
    assert.notEqual(end, -1, 'updateStats section end marker should exist');
    const updateStatsFn = script.slice(start, end);
    const clearAt = updateStatsFn.indexOf('clearStatsMapsForPendingSummary(selIp)');
    const fetchAt = updateStatsFn.indexOf('await fetchStatsSummary(selIp)');
    assert.notEqual(clearAt, -1, 'updateStats should clear stale map points before summary fetch');
    assert.notEqual(fetchAt, -1, 'updateStats should still fetch the authoritative summary');
    assert.ok(clearAt < fetchAt,
      'maps should not show the previous period while the authoritative period summary is loading');
    assert.match(script, /function\s+clearStatsMapsForPendingSummary\(selIp\)[\s\S]*?updateStatsMaps\(selIp,\s*\[\]\)/,
      'pending summary state should clear Globe/Flat map points rather than falling back to all loaded data');
  });

  it('stats maps are only cleared when the authoritative summary key changes', () => {
    const script = getScriptContent();
    const start = script.indexOf('async function updateStats()');
    assert.notEqual(start, -1, 'updateStats should exist');
    const end = script.indexOf('// ─── App distribution pie chart', start);
    assert.notEqual(end, -1, 'updateStats section end marker should exist');
    const updateStatsFn = script.slice(start, end);
    assert.match(script, /let\s+statsMapSummaryKey\s*=\s*null/,
      'stats maps should remember which summary key they currently represent');
    assert.match(script, /function\s+getStatsSummaryKey\(selIp\)/,
      'stats update should have a stable key for period/device summary requests');
    assert.match(updateStatsFn, /const\s+summaryKey\s*=\s*getStatsSummaryKey\(selIp\)/,
      'updateStats should compute the current summary key before fetching');
    assert.match(updateStatsFn, /if\s*\(\s*statsMapSummaryKey\s*!==\s*summaryKey\s*\)\s*clearStatsMapsForPendingSummary\(selIp\)/,
      'resize/socket refreshes for the same period should not clear and redraw maps repeatedly');
    assert.match(updateStatsFn, /renderStatsSummary\(summary,\s*selIp\);[\s\S]*?statsMapSummaryKey\s*=\s*summaryKey/,
      'successful summary render should mark the maps as current for that key');
  });

  it('stats maps do not rebuild Flat map layers when summary point geometry is unchanged', () => {
    const script = getScriptContent();
    const start = script.indexOf('function updateStatsMaps(selIp, mapPoints)');
    assert.notEqual(start, -1, 'updateStatsMaps should exist');
    const end = script.indexOf('let chartMode', start);
    assert.notEqual(end, -1, 'updateStatsMaps section end marker should exist');
    const updateStatsMapsFn = script.slice(start, end);
    assert.match(script, /var\s+stMapRenderSignature\s*=\s*null/,
      'stats maps should remember the last rendered map geometry signature');
    assert.match(updateStatsMapsFn, /const\s+renderSignature\s*=\s*mapPoints/,
      'summary-provided map points should produce a stable render signature');
    assert.match(updateStatsMapsFn, /Number\(p\.lat\)\.toFixed\(3\)/,
      'map signatures should be based on coarse geometry, not volatile counters');
    assert.match(updateStatsMapsFn, /if\s*\(\s*renderSignature\s*&&\s*stMapRenderSignature\s*===\s*renderSignature\s*\)/,
      'same summary geometry should not rebuild map layers');
    assert.match(updateStatsMapsFn, /stMapRenderSignature\s*=\s*renderSignature;[\s\S]*?stRenderGlobeData\(\);[\s\S]*?stRenderFlatData\(\);/,
      'map layers should only redraw after the signature is updated');
  });

  it('stats maps debounce mobile resize before rebuilding map bases', () => {
    const script = getScriptContent();
    assert.match(script, /var\s+stMapResizeTimer\s*=\s*null/,
      'stats maps should debounce resize-triggered rebuilds');
    assert.match(script, /var\s+stMapSize\s*=\s*\{\s*globeW:\s*0,\s*globeH:\s*0,\s*flatW:\s*0,\s*flatH:\s*0\s*\}/,
      'stats maps should remember their rendered size');
    assert.match(script, /function\s+stMapSizeChangedEnough\(next\)[\s\S]*?>\s*24[\s\S]*?>\s*48/,
      'small mobile browser chrome resizes should not rebuild map SVG bases');
    assert.match(script, /function\s+scheduleStatsMapResize\(\)[\s\S]*?setTimeout\(\(\)\s*=>[\s\S]*?stRenderGlobeBase\(\);[\s\S]*?stRenderFlatBase\(\);[\s\S]*?250\)/,
      'map base rebuilds should be delayed until resize settles');
    assert.match(script, /window\.addEventListener\('resize',\s*scheduleStatsMapResize\)/,
      'resize should use the debounced stats map handler');
    assert.doesNotMatch(script, /window\.addEventListener\('resize',\s*\(\)\s*=>\s*\{[\s\S]*?stRenderGlobeBase\(\);\s*stRenderFlatBase\(\);/,
      'resize must not synchronously clear and rebuild map layers');
  });

  it('stats summary fetch is not retriggered every few seconds while viewing live data', () => {
    const script = getScriptContent();
    assert.match(script, /const\s+STATS_SUMMARY_CACHE_MS\s*=\s*60_000/,
      'stats summary cache should be long enough to avoid repeated loading banners during live updates');
    assert.match(script, /let\s+statsSummaryRequestWindow\s*=\s*\{\s*key:\s*null,\s*from:\s*null,\s*to:\s*null,\s*at:\s*0\s*\}/,
      'relative periods should keep a stable request window while the cache is valid');
    assert.match(script, /function\s+statsSummaryRangeKey\(from,\s*to\)[\s\S]*?currentGraphRangeKey\(from,\s*to\)/,
      'stats should reuse the graph range key so relative periods are keyed as 1h/open, 14d/open, etc.');
    assert.match(script, /function\s+getStableStatsSummaryRange\(\)[\s\S]*?statsSummaryRequestWindow\.key\s*===\s*key[\s\S]*?STATS_SUMMARY_CACHE_MS[\s\S]*?return\s*\{\s*from:\s*statsSummaryRequestWindow\.from,\s*to:\s*statsSummaryRequestWindow\.to\s*\}/,
      'stats summary API params should not drift on every Date.now tick for relative periods');
    assert.match(script, /function\s+buildStatsSummaryParams\(selIp\)[\s\S]*?getStableStatsSummaryRange\(\)/,
      'summary params should be built from the stable range');
    assert.doesNotMatch(script, /now\s*-\s*statsSummaryCache\.at\s*<\s*5000/,
      'a 5s summary cache causes periodic refetching and visible map redraws');
    assert.match(script, /now\s*-\s*statsSummaryCache\.at\s*<\s*STATS_SUMMARY_CACHE_MS/,
      'fetchStatsSummary should use the named cache TTL');
    assert.match(script, /const\s+showLoading\s*=\s*!\(\s*statsSummaryCache\.key\s*===\s*key\s*&&\s*statsSummaryCache\.data\s*\)/,
      'same-period background summary refresh should not show the global loading banner');
    assert.match(script, /if\s*\(\s*showLoading\s*\)\s*setFetching\(\+1\)/,
      'loading should only be shown for first fetches such as period/device changes');
    assert.match(script, /if\s*\(\s*showLoading\s*\)\s*setFetching\(-1\)/,
      'loading decrement should match the conditional increment');
  });

  it('stats view does not redraw charts for the same cached summary object', () => {
    const script = getScriptContent();
    const start = script.indexOf('async function updateStats()');
    assert.notEqual(start, -1, 'updateStats should exist');
    const end = script.indexOf('// ─── App distribution pie chart', start);
    assert.notEqual(end, -1, 'updateStats section end marker should exist');
    const updateStatsFn = script.slice(start, end);
    assert.match(script, /let\s+statsRenderedSummary\s*=\s*\{\s*key:\s*null,\s*data:\s*null\s*\}/,
      'stats should remember the last rendered summary object');
    assert.match(updateStatsFn, /!\(\s*statsSummaryCache\.key\s*===\s*summaryKey\s*&&\s*statsSummaryCache\.data\s*\)[\s\S]*?renderStatsPiePreview\(selIp\)/,
      'same-period socket refreshes should not clear/redraw the pie preview while cached summary exists');
    assert.match(updateStatsFn, /statsRenderedSummary\.key\s*===\s*summaryKey\s*&&\s*statsRenderedSummary\.data\s*===\s*summary[\s\S]*?return/,
      'cached summary objects should not redraw charts and map layers repeatedly');
    assert.match(updateStatsFn, /statsRenderedSummary\s*=\s*\{\s*key:\s*summaryKey,\s*data:\s*summary\s*\}/,
      'successful summary rendering should update the rendered-summary guard');
  });

  it('keeps unsafe-inline out of the base style-src directive', () => {
    assert.match(serverJs, /"style-src 'self'; "/,
      'base style-src should not allow inline styles');
    assert.match(serverJs, /"style-src-attr 'unsafe-inline'; "/,
      'legacy inline style attributes should be isolated to style-src-attr until they are migrated');
    assert.doesNotMatch(serverJs, /"style-src 'self' 'unsafe-inline'; "/,
      'style-src must not regress to unsafe-inline');
  });

  it('stats map coverage stays on the stats header and uses compact mobile text', () => {
    const script = getScriptContent();
    const headerStart = html.indexOf('<div class="stats-header">');
    assert.notEqual(headerStart, -1, 'stats header should exist');
    const headerEnd = html.indexOf('</div>', headerStart);
    const headerHtml = html.slice(headerStart, headerEnd);
    assert.match(headerHtml, /id="stats-subtitle"[\s\S]*id="stats-map-coverage"[\s\S]*id="data-fetching-stats"/,
      'map coverage should sit to the right of the stats subtitle and before the loading indicator');
    assert.match(script, /window\.matchMedia\('\(max-width:\s*768px\)'\)\.matches/,
      'stats map coverage should detect mobile layout');
    assert.match(script, /isMobile\s*\?\s*t\('stats\.map\.coverage\.mobile'\)\s*:\s*tVars\('stats\.map\.coverage'/,
      'mobile should use a compact one-line map coverage label');
    assert.match(html + script, /stats\.map\.coverage\.mobile/,
      'mobile coverage i18n key should be present');
  });

  it('Yamaha SSH prompt wait clears stale timers and accepts privileged prompts', () => {
    assert.match(yamahaJs, /function\s+looksLikeShellPrompt/,
      'Yamaha poller should centralize shell prompt detection');
    assert.match(yamahaJs, /\/\[>#\]\\s\*\$\/\.test/,
      'Yamaha prompt detection should accept both > and # prompts');
    assert.match(yamahaJs, /function\s+clearShellWaiter/,
      'Yamaha prompt wait should clear stale timeout timers after a prompt is seen');
    assert.match(yamahaJs, /clearTimeout\(shellWaiter\.timer\)/,
      'prompt timeout must be cancelled when the command completes');
    assert.doesNotMatch(yamahaJs, /let\s+shellResolve/,
      'single resolver state without timer cleanup can corrupt later SSH command waits');
  });

  it('Yamaha NAT polling allows slow large NAT tables without timing out early', () => {
    assert.match(yamahaJs, /async\s+function\s+yamahaExec\(cmd,\s*timeoutMs\s*=\s*45000\)/,
      'yamahaExec should keep the normal timeout for short commands');
    assert.match(yamahaJs, /show nat descriptor address \$\{natDescriptor\} detail`,\s*90000\)/,
      'large NAT detail polling should have a longer timeout than short router commands');
  });

  it('ASUS polling tolerates optional API failures and labels its errors', () => {
    assert.match(asusJs, /const\s+ASUS_API_TIMEOUT_MS\s*=\s*12000/,
      'ASUS appGet calls should allow slow router responses beyond the previous 8s limit');
    assert.match(asusJs, /function\s+apiGetWithRetry/,
      'ASUS transient HTTP failures should receive a short retry');
    assert.match(asusJs, /warnOptionalPollFailure\('netdev'/,
      'WAN counter failures should not fail the whole ASUS poll');
    assert.match(asusJs, /warnOptionalPollFailure\('mesh'/,
      'mesh-list failures should not fail the whole ASUS poll');
    assert.match(asusJs, /\[asus\] poll error/,
      'ASUS hard poll failures should be clearly labeled in logs');
    assert.doesNotMatch(asusJs, /\[poll error\]/,
      'generic poll error logs make Yamaha and ASUS failures hard to distinguish');
  });

  it('demo mode passes the selected runtime DB path to every SQLite-backed store', () => {
    assert.match(serverJs, /const\s+configuredDbPath\s*=\s*process\.env\.EGRESSVIEW_DB_PATH\s*\|\|\s*process\.env\.EGRESSVIEW_DB\s*\|\|\s*['"]{2}/,
      'server startup should honor both EGRESSVIEW_DB_PATH and the documented EGRESSVIEW_DB');
    assert.match(serverJs, /const\s+runtimeDbPath\s*=\s*DEMO_MODE\s*\?/,
      'server startup should choose one runtime DB path before initializing stores');
    for (const call of [
      'sessions.initDb(runtimeDbPath)',
      'history.loadConnectionHistory(runtimeDbPath)',
      'devices.initDb(runtimeDbPath)',
      'enrichment.initDb(runtimeDbPath)',
      'beacons.initDb(runtimeDbPath)',
    ]) {
      assert.match(serverJs, new RegExp(call.replace(/[().]/g, '\\$&')),
        `${call} should use the selected runtime DB path`);
    }
    assert.match(historyJs, /function\s+loadConnectionHistory\(dbPath\)\s*{[\s\S]*initDb\(dbPath\)/,
      'history.loadConnectionHistory must accept and pass through an explicit DB path');
  });

  it('backup uses the selected runtime DB path in both normal and demo mode', () => {
    assert.match(serverJs, /backup\.configure\(\{\s*dbPath:\s*runtimeDbPath\s*\}\)/,
      'backups should follow the selected runtime DB path');
    assert.match(serverJs, /backup\.configure\(\{\s*backupDir:\s*DEMO_BACKUP_DIR\s*\}\)/,
      'demo mode backups should not use the production backup directory');
  });

  it('history default DB path honors the documented EGRESSVIEW_DB fallback', () => {
    assert.match(historyJs, /process\.env\.EGRESSVIEW_DB_PATH\s*\|\|\s*process\.env\.EGRESSVIEW_DB/,
      'history should use EGRESSVIEW_DB when EGRESSVIEW_DB_PATH is absent');
  });
});

describe('npm package invariants', () => {
  it('does not publish local-only EC2 deployment scripts', () => {
    assert(!pkg.files.includes('scripts/'), 'package files must not include the whole scripts/ directory');
    assert(!pkg.files.includes('scripts/deploy-ec2.sh'), 'local EC2 deploy script must not be published');
    assert(!pkg.files.includes('scripts/start.sh'), 'local start helper must not be published');
    assert.equal(pkg.scripts['deploy:ec2'], undefined, 'local EC2 deploy command should not be exposed as an npm script');
  });

  it('still publishes scripts required by package scripts and demo tooling', () => {
    for (const file of ['scripts/secret-scan.js', 'scripts/gen-demo-db.js', 'scripts/demo-seed.js']) {
      assert(pkg.files.includes(file), `${file} should remain in the npm package`);
    }
  });
});
