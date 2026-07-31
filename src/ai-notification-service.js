'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { buildAiFacts } = require('./ai-facts');
const { buildAiContext } = require('./ai-context');
const logger = require('./logger');

const CLOUD_PROVIDERS = new Set(['anthropic', 'openai', 'bedrock']);
const DEFAULT_CONFIG = Object.freeze({
  frequency: 'off',
  weekday: 1,
  time: '09:00',
  timezone: 'Asia/Tokyo',
  rangeHours: 168,
  destinations: { ui: true, slack: false },
  rules: {
    scheduled: false,
    danger: false,
    newDestination: false,
    increase: false,
  },
  threat: {
    enabled: false,
    dangerThreshold: 1,
    newDestinationsThreshold: 1,
    increaseThreshold: 3,
  },
  dailyLimit: 3,
  cooldownMinutes: 60,
  automationConsent: false,
  automationProvider: '',
});

function normalizeConfig(input = {}) {
  const destinations = { ...DEFAULT_CONFIG.destinations, ...(input.destinations || {}) };
  const legacyThreatEnabled = input.threat?.enabled ?? DEFAULT_CONFIG.threat.enabled;
  const rules = {
    scheduled: input.rules?.scheduled ?? ((input.frequency ?? DEFAULT_CONFIG.frequency) !== 'off'),
    danger: input.rules?.danger ?? legacyThreatEnabled,
    newDestination: input.rules?.newDestination ?? legacyThreatEnabled,
    increase: input.rules?.increase ?? legacyThreatEnabled,
  };
  const threat = {
    ...DEFAULT_CONFIG.threat,
    ...(input.threat || {}),
    enabled: rules.danger || rules.newDestination || rules.increase,
  };
  const normalized = {
    frequency: input.frequency ?? DEFAULT_CONFIG.frequency,
    weekday: input.weekday ?? DEFAULT_CONFIG.weekday,
    time: input.time ?? DEFAULT_CONFIG.time,
    timezone: input.timezone ?? DEFAULT_CONFIG.timezone,
    rangeHours: input.rangeHours ?? DEFAULT_CONFIG.rangeHours,
    destinations,
    rules,
    threat,
    dailyLimit: input.dailyLimit ?? DEFAULT_CONFIG.dailyLimit,
    cooldownMinutes: input.cooldownMinutes ?? DEFAULT_CONFIG.cooldownMinutes,
    automationConsent: input.automationConsent ?? DEFAULT_CONFIG.automationConsent,
    automationProvider: input.automationProvider ?? DEFAULT_CONFIG.automationProvider,
  };
  if (!['off', 'daily', 'weekly'].includes(normalized.frequency)) throw new Error('Invalid notification frequency');
  if (rules.scheduled && normalized.frequency === 'off') {
    throw new Error('Scheduled notification frequency is required');
  }
  if (Object.values(rules).some(value => typeof value !== 'boolean')) {
    throw new Error('Invalid notification rule');
  }
  if (!Number.isInteger(normalized.weekday) || normalized.weekday < 0 || normalized.weekday > 6) {
    throw new Error('Invalid notification weekday');
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized.time)) throw new Error('Invalid notification time');
  if (!Number.isInteger(normalized.rangeHours) || normalized.rangeHours < 1 || normalized.rangeHours > 336) {
    throw new Error('Invalid notification range');
  }
  if (!destinations.ui && !destinations.slack) throw new Error('At least one notification destination is required');
  for (const [name, value] of Object.entries({
    dangerThreshold: threat.dangerThreshold,
    newDestinationsThreshold: threat.newDestinationsThreshold,
    increaseThreshold: threat.increaseThreshold,
  })) {
    if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Error(`Invalid ${name}`);
  }
  if (!Number.isInteger(normalized.dailyLimit) || normalized.dailyLimit < 1 || normalized.dailyLimit > 6) {
    throw new Error('Invalid notification daily limit');
  }
  if (!Number.isInteger(normalized.cooldownMinutes)
    || normalized.cooldownMinutes < 15 || normalized.cooldownMinutes > 1440) {
    throw new Error('Invalid notification cooldown');
  }
  return normalized;
}

function localParts(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function localMidnightTimestamp({ year, month, day }, timezone) {
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day));
  let timestamp = target;
  for (let i = 0; i < 4; i++) {
    const observed = localParts(timestamp, timezone);
    const observedAsUtc = Date.UTC(
      Number(observed.year),
      Number(observed.month) - 1,
      Number(observed.day),
      Number(observed.hour),
      Number(observed.minute)
    );
    const correction = target - observedAsUtc;
    timestamp += correction;
    if (correction === 0) break;
  }
  return timestamp;
}

function dayBounds(timestamp, timezone) {
  const current = localParts(timestamp, timezone);
  const from = localMidnightTimestamp(current, timezone);
  const nextDate = new Date(Date.UTC(
    Number(current.year),
    Number(current.month) - 1,
    Number(current.day) + 1
  ));
  const to = localMidnightTimestamp({
    year: nextDate.getUTCFullYear(),
    month: nextDate.getUTCMonth() + 1,
    day: nextDate.getUTCDate(),
  }, timezone);
  return { from, to };
}

function scheduleKey(config, now) {
  if (config.frequency === 'off') return null;
  const parts = localParts(now, config.timezone);
  const [hour, minute] = config.time.split(':').map(Number);
  if (Number(parts.hour) * 60 + Number(parts.minute) < hour * 60 + minute) return null;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  if (config.frequency === 'weekly' && weekdays[parts.weekday] !== config.weekday) return null;
  return `scheduled:${config.frequency}:${parts.year}-${parts.month}-${parts.day}:${config.time}`;
}

function threatCauses(facts, currentThreatDestinations, previousThreatDestinations, config) {
  const causes = [];
  if (config.rules?.danger !== false
    && facts.current.danger >= config.threat.dangerThreshold) causes.push('danger');
  const previous = new Set(previousThreatDestinations);
  const newCount = currentThreatDestinations.filter(dst => !previous.has(dst)).length;
  if (config.rules?.newDestination !== false
    && newCount >= config.threat.newDestinationsThreshold) causes.push('new-destination');
  const currentTotal = facts.current.warn + facts.current.danger;
  const previousTotal = facts.previous.warn + facts.previous.danger;
  if (config.rules?.increase !== false
    && currentTotal - previousTotal >= config.threat.increaseThreshold) causes.push('increase');
  return causes;
}

function createAiNotificationService(deps) {
  const {
    aiProvider, history, threatIntel, devices, asus, notifier,
    getRouters, getLanguage = () => 'ja', emit = () => {},
    now = () => Date.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  } = deps;
  let config = normalizeConfig();
  let timer = null;
  let running = false;
  let threatCheckQueued = false;

  function configure(next = {}) {
    const mergedInput = { ...config, ...next };
    // A persisted pre-P2-62 config has no rules object. Let normalizeConfig
    // deterministically expand frequency/threat.enabled instead of inheriting defaults.
    if (!Object.hasOwn(next, 'rules')
      && (Object.hasOwn(next, 'frequency') || Object.hasOwn(next, 'threat'))) {
      delete mergedInput.rules;
    }
    const merged = normalizeConfig(mergedInput);
    // Throws for invalid IANA timezone names.
    localParts(now(), merged.timezone);
    config = merged;
    return exportConfig();
  }

  function exportConfig() {
    return JSON.parse(JSON.stringify(config));
  }

  function automationAllowed() {
    const provider = aiProvider.getPublicConfig().provider;
    return !CLOUD_PROVIDERS.has(provider)
      || (config.automationConsent && config.automationProvider === provider);
  }

  function publicStatus() {
    const slack = notifier?.getConfig?.() || {};
    return {
      running,
      provider: aiProvider.getPublicConfig().provider,
      automationReady: automationAllowed(),
      slackReady: !!(slack.enabled && slack.tokenSet && slack.userId),
    };
  }

  function persistUsage(result, requestId) {
    if (typeof history.appendAiUsage !== 'function') return;
    const usage = result.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const pricing = result.pricing || {};
    try {
      history.appendAiUsage({
        usageId: randomUUID(),
        requestId,
        conversationId: null,
        kind: 'analysis',
        createdAt: result.generatedAt || now(),
        provider: result.provider,
        model: result.model || '',
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        totalTokens: usage.totalTokens || 0,
        estimatedCostUsd: Number.isFinite(result.estimatedCostUsd) ? result.estimatedCostUsd : null,
        pricingVersion: pricing.pricingVersion || null,
        inputUsdPerMillion: pricing.inputUsdPerMillion ?? null,
        outputUsdPerMillion: pricing.outputUsdPerMillion ?? null,
      });
    } catch (error) {
      logger.warn('[ai-notification] Usage persistence failed:', error.message);
    }
  }

  function threatDestinations(from, to) {
    return history.groupDstByTimeRange(from, to)
      .filter(row => threatIntel?.matchThreatIntel(row.dst, row.dstHost || row.dst))
      .map(row => row.dst)
      .sort();
  }

  async function run({ triggerType, triggerKey = null, cause = '', consentConfirmed = false } = {}) {
    if (running) {
      const error = new Error('AI notification analysis is already running');
      error.code = 'AI_BUSY';
      throw error;
    }
    const provider = aiProvider.getPublicConfig().provider;
    if (provider === 'disabled') throw new Error('AI provider is disabled');
    const cloud = CLOUD_PROVIDERS.has(provider);
    const durableConsent = config.automationConsent && config.automationProvider === provider;
    if (cloud && !(consentConfirmed || durableConsent)) {
      const error = new Error('Cloud AI automation consent is required');
      error.code = 'AI_CONSENT_REQUIRED';
      throw error;
    }
    if (triggerKey && history.hasAiNotificationTriggerKey(triggerKey)) {
      return { skipped: true, reason: 'already-run' };
    }

    running = true;
    const to = now();
    const from = to - config.rangeHours * 60 * 60_000;
    const requestId = randomUUID();
    try {
      const routers = getRouters();
      const facts = buildAiFacts({ history, threatIntel, routers, from, to, serverTime: to });
      const context = buildAiContext({ facts, history, routers, from, to, threatIntel, devices, asus });
      const result = await aiProvider.generateInsight(context, {
        cloudConsentConfirmed: cloud,
        language: getLanguage(),
      });
      persistUsage(result, requestId);
      const slackSent = config.destinations.slack
        ? await notifier.sendAiNotification({
          triggerType,
          text: result.text,
          generatedAt: result.generatedAt || to,
          language: getLanguage(),
        })
        : false;
      if (config.destinations.slack && !slackSent && !config.destinations.ui) {
        const error = new Error('Slack delivery failed');
        error.code = 'AI_NOTIFICATION_DELIVERY_FAILED';
        throw error;
      }
      const usage = result.usage || {};
      const event = {
        eventId: randomUUID(),
        triggerType,
        triggerKey,
        cause,
        createdAt: result.generatedAt || to,
        rangeFrom: from,
        rangeTo: to,
        status: 'complete',
        provider: result.provider || provider,
        model: result.model || '',
        body: config.destinations.ui ? result.text : null,
        slackSent: slackSent ? 1 : 0,
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        totalTokens: usage.totalTokens || 0,
        estimatedCostUsd: Number.isFinite(result.estimatedCostUsd) ? result.estimatedCostUsd : null,
        errorCode: null,
      };
      history.appendAiNotification(event);
      emit('ai-notification', { ...event, body: undefined });
      return event;
    } catch (error) {
      history.appendAiNotification({
        eventId: randomUUID(),
        triggerType,
        // Failed scheduled work must be retryable on the next scheduler tick.
        triggerKey: null,
        cause,
        createdAt: now(),
        rangeFrom: from,
        rangeTo: to,
        status: 'failed',
        provider,
        model: aiProvider.getPublicConfig().models?.[provider] || '',
        errorCode: error.code || 'AI_NOTIFICATION_FAILED',
      });
      throw error;
    } finally {
      running = false;
    }
  }

  async function runThreatCheck() {
    threatCheckQueued = false;
    if (!config.threat.enabled || !automationAllowed()) return;
    const currentTime = now();
    const bounds = dayBounds(currentTime, config.timezone);
    if (history.countAiNotifications(bounds.from, bounds.to, 'threat') >= config.dailyLimit) return;
    const to = currentTime;
    const from = to - config.rangeHours * 60 * 60_000;
    const routers = getRouters();
    const facts = buildAiFacts({ history, threatIntel, routers, from, to, serverTime: to });
    const currentDsts = threatDestinations(from, to);
    const previousDsts = threatDestinations(from - (to - from), from);
    const causes = threatCauses(facts, currentDsts, previousDsts, config);
    if (!causes.length) return;
    const cause = causes.sort().join('+');
    const latest = history.latestAiNotification(cause, 'threat');
    if (latest && currentTime - latest.createdAt < config.cooldownMinutes * 60_000) return;
    const digest = createHash('sha256').update(`${cause}|${currentDsts.join(',')}`).digest('hex').slice(0, 16);
    await run({ triggerType: 'threat', triggerKey: `threat:${digest}:${Math.floor(currentTime / 60_000)}`, cause });
  }

  function observeThreat() {
    if (!config.threat.enabled || threatCheckQueued) return;
    threatCheckQueued = true;
    setImmediate(() => runThreatCheck().catch(error => {
      if (error.code !== 'AI_BUSY') logger.warn('[ai-notification] Threat analysis failed:', error.message);
    }));
  }

  async function tick() {
    if (!config.rules.scheduled) return;
    const key = scheduleKey(config, now());
    if (!key || running || !automationAllowed() || history.hasAiNotificationTriggerKey(key)) return;
    await run({ triggerType: 'scheduled', triggerKey: key, cause: config.frequency });
  }

  async function testDelivery() {
    const createdAt = now();
    const slackSent = config.destinations.slack
      ? await notifier.sendAiNotification({
        triggerType: 'test',
        text: getLanguage() === 'en' ? 'AI event notifications are configured.' : 'AIイベント通知の設定が完了しました。',
        generatedAt: createdAt,
        language: getLanguage(),
      })
      : false;
    const deliveryFailed = config.destinations.slack && !slackSent;
    const event = {
      eventId: randomUUID(),
      triggerType: 'test',
      triggerKey: null,
      cause: 'delivery-test',
      createdAt,
      rangeFrom: createdAt,
      rangeTo: createdAt,
      status: deliveryFailed ? 'failed' : 'complete',
      provider: '',
      model: '',
      body: config.destinations.ui
        ? (getLanguage() === 'en' ? 'AI event notification test' : 'AIイベント通知テスト')
        : null,
      slackSent: slackSent ? 1 : 0,
      errorCode: deliveryFailed ? 'AI_NOTIFICATION_DELIVERY_FAILED' : null,
    };
    history.appendAiNotification(event);
    emit('ai-notification', { ...event, body: undefined });
    if (deliveryFailed) {
      const error = new Error('Slack delivery failed');
      error.code = event.errorCode;
      throw error;
    }
    return event;
  }

  function start() {
    if (timer) return;
    timer = setIntervalFn(() => tick().catch(error => {
      if (error.code !== 'AI_BUSY') logger.warn('[ai-notification] Scheduled analysis failed:', error.message);
    }), 30_000);
    timer.unref?.();
    tick().catch(error => logger.warn('[ai-notification] Initial schedule check failed:', error.message));
  }

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
  }

  return {
    configure,
    exportConfig,
    observeThreat,
    publicStatus,
    run,
    start,
    stop,
    testDelivery,
    tick,
  };
}

module.exports = {
  CLOUD_PROVIDERS,
  DEFAULT_CONFIG,
  createAiNotificationService,
  dayBounds,
  normalizeConfig,
  scheduleKey,
  threatCauses,
};
