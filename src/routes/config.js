// Routes: general settings and data-source configuration
'use strict';
const logger = require('../logger');

const { Router } = require('express');
const { z } = require('zod');
const { t, setLanguage } = require('../i18n-server');
const { parseRequest } = require('../http-validation');
// Log path validation restricted to an allowlist of prefixes (tail runs via
// sudo, so arbitrary paths must not be permitted)
const { isAllowedLogPath: isValidLogPath } = require('../utils');

const ALLOWED_COUNTRIES = new Set([
  'JP','US','CA','GB','DE','FR','IT','ES','NL','SE','CH','NO',
  'AU','NZ','CN','KR','TW','HK','SG','IN','BR','RU',
]);
const generalConfigSchema = z.object({
  homeCountry: z.string().optional(),
  language: z.enum(['ja', 'en']).optional(),
  autoInvestigate: z.boolean().optional(),
  retentionDays: z.coerce.number().int().refine(value => [7, 30, 90, 180, 365, 730].includes(value)).optional(),
}).strict();
const dataSourceSchema = z.object({ enabled: z.boolean().optional(), logFile: z.string().max(4096).optional() }).strict();
const dataSourcesSchema = z.object({
  dnsmasq: dataSourceSchema.optional(),
  inspect: dataSourceSchema.optional(),
  dhcpd: dataSourceSchema.optional(),
}).strict();

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
    requireAdmin, asus, enrichment, notifier, history, threatIntel,
    dnsmasqLog, inspectSyslog, dhcpdSyslog,
    runtime, appState, saveConfig,
  } = ctx;

  const router = Router();

  function restartDataSources() {
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

    inspectSyslog.stop();
    inspectSyslog.configure({
      logFile: appState.inspectLogFile,
      enabled: appState.inspectEnabled,
      onSession: runtime.handleInspectSession,
    });
    if (appState.inspectEnabled) inspectSyslog.start();

    dhcpdSyslog.stop();
    dhcpdSyslog.configure({ logFile: appState.dhcpdLogFile, enabled: appState.dhcpdEnabled });
    if (appState.dhcpdEnabled) dhcpdSyslog.start();
  }

  // ── GET /api/status ────────────────────────────────────────────────────────
  router.get('/status', requireAdmin, (req, res) => {
    res.json({
      authenticated: asus.isAuthenticated(),
      routerIp:      asus.getRouterIp(),
      enrichment:    enrichment.getApiStats(),
      // Per feed, not just a total (P3-54). On 2026-08-29 the Hub matched
      // with Feodo's C2 list entirely absent -- abuse.ch was returning 503 --
      // while every count on screen looked healthy, because the other feeds
      // are large. A screen that cannot say which feed is missing cannot tell
      // "nothing was found" from "nobody looked".
      threatIntel:   threatIntel && typeof threatIntel.getStats === 'function'
        ? threatIntel.getStats()
        : null,
      // Lets the UI say a feature is off because of offline mode rather than
      // leaving an unexplained empty panel.
      ...(appState.offlinePolicy ? appState.offlinePolicy.describe() : {}),
    });
  });

  // ── POST /api/config/general ───────────────────────────────────────────────
  router.post('/config/general', requireAdmin, (req, res) => {
    const parsed = parseRequest(generalConfigSchema, req.body, res);
    if (!parsed.ok) return;
    const { homeCountry: hc, language: lang, autoInvestigate: ai, retentionDays: rd } = parsed.data;
    const previous = {
      homeCountry: appState.homeCountry,
      uiLanguage: appState.uiLanguage,
      autoInvestigate: appState.autoInvestigate,
      retentionDays: appState.retentionDays,
    };

    if (hc) {
      if (!ALLOWED_COUNTRIES.has(hc)) return res.status(400).json({ error: t('config.invalid-country') });
      appState.homeCountry = hc;
    }
    if (lang) {
      if (!['ja', 'en'].includes(lang)) return res.status(400).json({ error: 'invalid language' });
      appState.uiLanguage = lang;
      notifier.configure({ language: lang });
      setLanguage(lang);
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

    try {
      saveConfig();
    } catch (err) {
      Object.assign(appState, previous);
      notifier.configure({ language: previous.uiLanguage });
      setLanguage(previous.uiLanguage);
      history.setRetentionDays(previous.retentionDays);
      logger.error('[config] General settings save failed:', err.message);
      return res.status(500).json({ error: 'Settings were not saved. Check server logs.' });
    }
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
    const parsed = parseRequest(dataSourcesSchema, req.body, res);
    if (!parsed.ok) return;
    const { dnsmasq, inspect, dhcpd } = parsed.data;
    const previous = {
      dnsmasqEnabled: appState.dnsmasqEnabled,
      dnsmasqLogFile: appState.dnsmasqLogFile,
      inspectEnabled: appState.inspectEnabled,
      inspectLogFile: appState.inspectLogFile,
      dhcpdEnabled: appState.dhcpdEnabled,
      dhcpdLogFile: appState.dhcpdLogFile,
    };

    if (dnsmasq) {
      if (typeof dnsmasq.enabled  === 'boolean') appState.dnsmasqEnabled = dnsmasq.enabled;
      if (isValidLogPath(dnsmasq.logFile)) appState.dnsmasqLogFile = dnsmasq.logFile.trim();
      else if (dnsmasq.logFile !== undefined) logger.warn(`[config] dnsmasq logFile rejected (not under an allowed log directory): ${dnsmasq.logFile}`);
    }

    if (inspect) {
      if (typeof inspect.enabled === 'boolean') appState.inspectEnabled = inspect.enabled;
      if (isValidLogPath(inspect.logFile)) appState.inspectLogFile = inspect.logFile.trim();
      else if (inspect.logFile !== undefined) logger.warn(`[config] inspect logFile rejected (not under an allowed log directory): ${inspect.logFile}`);
    }

    if (dhcpd) {
      if (typeof dhcpd.enabled === 'boolean') appState.dhcpdEnabled = dhcpd.enabled;
      if (isValidLogPath(dhcpd.logFile)) appState.dhcpdLogFile = dhcpd.logFile.trim();
      else if (dhcpd.logFile !== undefined) logger.warn(`[config] dhcpd logFile rejected (not under an allowed log directory): ${dhcpd.logFile}`);
    }

    try {
      restartDataSources();
      saveConfig();
    } catch (err) {
      Object.assign(appState, previous);
      try { restartDataSources(); } catch (rollbackErr) {
        logger.error('[config] Data source rollback failed:', rollbackErr.message);
      }
      logger.error('[config] Data source settings save failed:', err.message);
      return res.status(500).json({ error: 'Settings were not saved. Check server logs.' });
    }
    res.json({
      success: true,
      dnsmasq: { enabled: appState.dnsmasqEnabled, logFile: appState.dnsmasqLogFile },
      inspect: { enabled: appState.inspectEnabled, logFile: appState.inspectLogFile },
      dhcpd:   { enabled: appState.dhcpdEnabled,   logFile: appState.dhcpdLogFile   },
    });
  });

  return router;
};
