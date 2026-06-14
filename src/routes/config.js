// Routes: general settings and data-source configuration
'use strict';
const path   = require('path');
const logger = require('../logger');

const { Router } = require('express');

// Reject paths with null bytes or '..' components; require absolute path.
function isValidLogPath(p) {
  if (typeof p !== 'string') return false;
  const s = p.trim();
  return s.length > 0 && path.isAbsolute(s) && !s.includes('\x00') && !s.split('/').includes('..');
}

const ALLOWED_COUNTRIES = new Set([
  'JP','US','CA','GB','DE','FR','IT','ES','NL','SE','CH','NO',
  'AU','NZ','CN','KR','TW','HK','SG','IN','BR','RU',
]);

/**
 * @param {{
 *   requireAdmin, asus, yamaha, enrichment, notifier, history,
 *   dnsmasqLog, inspectSyslog, dhcpdSyslog,
 *   runtime,  // for handleInspectSession
 *   appState: {
 *     homeCountry, uiLanguage, autoInvestigate, retentionDays,
 *     dnsmasqEnabled, dnsmasqLogFile,
 *     inspectEnabled, inspectLogFile,
 *     dhcpdEnabled, dhcpdLogFile
 *   },
 *   saveConfig: () => void
 * }} ctx
 */
module.exports = function configRoutes(ctx) {
  const {
    requireAdmin, asus, enrichment, notifier, history,
    dnsmasqLog, inspectSyslog, dhcpdSyslog,
    runtime, appState, saveConfig,
  } = ctx;

  const router = Router();

  // ── GET /api/status ────────────────────────────────────────────────────────
  router.get('/status', requireAdmin, (req, res) => {
    res.json({
      authenticated: asus.isAuthenticated(),
      routerIp:      asus.getRouterIp(),
      enrichment:    enrichment.getApiStats(),
    });
  });

  // ── POST /api/config/general ───────────────────────────────────────────────
  router.post('/config/general', requireAdmin, (req, res) => {
    const { homeCountry: hc, language: lang, autoInvestigate: ai, retentionDays: rd } = req.body;

    if (hc) {
      if (!ALLOWED_COUNTRIES.has(hc)) return res.status(400).json({ error: '無効な国コードです' });
      appState.homeCountry = hc;
    }
    if (lang) {
      if (!['ja', 'en'].includes(lang)) return res.status(400).json({ error: 'invalid language' });
      appState.uiLanguage = lang;
      notifier.configure({ language: lang });
    }
    if (typeof ai === 'boolean') {
      appState.autoInvestigate = ai;
      logger.info(`[auto-investigate] ${ai ? 'enabled' : 'disabled'}`);
    }
    if (rd && [7, 30, 90, 180, 365, 730].includes(Number(rd))) {
      appState.retentionDays = Number(rd);
      history.setRetentionDays(appState.retentionDays);
      logger.info(`[config] Retention set to ${appState.retentionDays} days`);
    }

    saveConfig();
    res.json({
      success: true,
      homeCountry:     appState.homeCountry,
      language:        appState.uiLanguage,
      autoInvestigate: appState.autoInvestigate,
      retentionDays:   appState.retentionDays,
    });
  });

  // ── GET /api/config/datasources ────────────────────────────────────────────
  router.get('/config/datasources', requireAdmin, (req, res) => {
    res.json({
      dnsmasq: { enabled: appState.dnsmasqEnabled, logFile: appState.dnsmasqLogFile },
      inspect: { enabled: appState.inspectEnabled, logFile: appState.inspectLogFile },
      dhcpd:   { enabled: appState.dhcpdEnabled,   logFile: appState.dhcpdLogFile   },
    });
  });

  // ── POST /api/config/datasources ───────────────────────────────────────────
  router.post('/config/datasources', requireAdmin, (req, res) => {
    const { dnsmasq, inspect, dhcpd } = req.body || {};

    if (dnsmasq) {
      if (typeof dnsmasq.enabled  === 'boolean') appState.dnsmasqEnabled = dnsmasq.enabled;
      if (isValidLogPath(dnsmasq.logFile)) appState.dnsmasqLogFile = dnsmasq.logFile.trim();
      dnsmasqLog.stop();
      dnsmasqLog.configure({
        logFile: appState.dnsmasqLogFile,
        enabled: appState.dnsmasqEnabled,
        onDnsQuery: ({ domain, resolvedIp }) => {
          if (resolvedIp) {
            enrichment.getDnsCache().set(resolvedIp, {
              host: domain, expires: Date.now() + 5 * 60 * 1000, source: 'dnsmasq',
            });
          }
        },
      });
      if (appState.dnsmasqEnabled) dnsmasqLog.start();
    }

    if (inspect) {
      if (typeof inspect.enabled === 'boolean') appState.inspectEnabled = inspect.enabled;
      if (isValidLogPath(inspect.logFile)) appState.inspectLogFile = inspect.logFile.trim();
      inspectSyslog.stop();
      inspectSyslog.configure({
        logFile:   appState.inspectLogFile,
        enabled:   appState.inspectEnabled,
        onSession: runtime.handleInspectSession,
      });
      if (appState.inspectEnabled) inspectSyslog.start();
    }

    if (dhcpd) {
      if (typeof dhcpd.enabled === 'boolean') appState.dhcpdEnabled = dhcpd.enabled;
      if (isValidLogPath(dhcpd.logFile)) appState.dhcpdLogFile = dhcpd.logFile.trim();
      dhcpdSyslog.stop();
      dhcpdSyslog.configure({ logFile: appState.dhcpdLogFile, enabled: appState.dhcpdEnabled });
      if (appState.dhcpdEnabled) dhcpdSyslog.start();
    }

    saveConfig();
    res.json({
      success: true,
      dnsmasq: { enabled: appState.dnsmasqEnabled, logFile: appState.dnsmasqLogFile },
      inspect: { enabled: appState.inspectEnabled, logFile: appState.inspectLogFile },
      dhcpd:   { enabled: appState.dhcpdEnabled,   logFile: appState.dhcpdLogFile   },
    });
  });

  return router;
};
