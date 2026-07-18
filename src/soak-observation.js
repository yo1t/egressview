'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function sanitizeCommit(value) {
  const commit = String(value || '').trim();
  return /^[0-9a-f]{7,64}$/i.test(commit) ? commit : 'unknown';
}

function sanitizeVersion(value) {
  const version = String(value || '').trim();
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version) ? version : 'unknown';
}

function routerCoverage(routers, now, recentWindowMs = DAY_MS, requiredKinds = ['yamaha', 'cisco']) {
  const safeRouters = (Array.isArray(routers) ? routers : [])
    .filter(router => router && router.enabled === true)
    .map(router => {
      const lastSuccessMs = Number(router.lastSuccessAt) || 0;
      return {
        id: String(router.id || '').slice(0, 80),
        kind: String(router.kind || '').slice(0, 20),
        lastSuccessAt: lastSuccessMs ? new Date(lastSuccessMs).toISOString() : null,
        recentlyCollected: lastSuccessMs > 0 && now - lastSuccessMs <= recentWindowMs,
      };
    });

  const required = [...new Set(requiredKinds.map(kind => String(kind).trim()).filter(Boolean))];
  const missingKinds = required.filter(kind => !safeRouters.some(router => router.kind === kind));
  const staleKinds = required.filter(kind =>
    safeRouters.some(router => router.kind === kind)
    && !safeRouters.some(router => router.kind === kind && router.recentlyCollected)
  );

  return { routers: safeRouters, missingKinds, staleKinds };
}

function createSoakRecord({
  consistency,
  routers,
  version,
  commit,
  durationMs,
  now = Date.now(),
  recentWindowMs = DAY_MS,
  requiredKinds = ['yamaha', 'cisco'],
  processStartedAt,
}) {
  const coverage = routerCoverage(routers, now, recentWindowMs, requiredKinds);
  const safeVersion = sanitizeVersion(version);
  const safeCommit = sanitizeCommit(commit);
  const counters = {
    missing: Number(consistency?.missingObservations) || 0,
    orphans: Number(consistency?.orphanObservations) || 0,
    underMerged: Number(consistency?.underMerged) || 0,
    kindMismatches: Number(consistency?.kindMismatches) || 0,
  };
  const failures = [];
  const validationFailures = [];
  for (const [name, count] of Object.entries(counters)) {
    if (count !== 0) {
      const failure = `${name}=${count}`;
      failures.push(failure);
      validationFailures.push(failure);
    }
  }
  if (!consistency) failures.push('consistency-check-unavailable');
  if (safeVersion === 'unknown') failures.push('version-unknown');
  if (safeCommit === 'unknown') failures.push('commit-unknown');
  const processStartedMs = Number(processStartedAt) || 0;
  if (!processStartedMs) failures.push('process-start-unknown');
  if (coverage.missingKinds.length) {
    const failure = `router-kinds-missing=${coverage.missingKinds.join(',')}`;
    failures.push(failure);
    validationFailures.push(failure);
  }
  if (coverage.staleKinds.length) {
    const failure = `router-kinds-stale=${coverage.staleKinds.join(',')}`;
    failures.push(failure);
    validationFailures.push(failure);
  }

  return {
    checkedAt: new Date(now).toISOString(),
    version: safeVersion,
    commit: safeCommit,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    processStartedAt: processStartedMs ? new Date(processStartedMs).toISOString() : null,
    ...counters,
    routers: coverage.routers,
    passed: failures.length === 0,
    failureType: failures.length === 0
      ? null
      : validationFailures.length > 0 ? 'validation' : 'operational',
    failures,
  };
}

function isOperationalFailure(record) {
  if (!record || record.passed) return false;
  if (record.failureType === 'operational') return true;
  if (record.failureType === 'validation') return false;

  // Legacy monitor errors were written without counters or a failure type.
  const failures = Array.isArray(record.failures) ? record.failures : [];
  const validationFailure = failures.some(failure =>
    /^(missing|orphans|underMerged|kindMismatches)=/.test(String(failure))
    || /^router-kinds-(missing|stale)=/.test(String(failure))
  );
  return !validationFailure;
}

function summarizeSoakHistory(records, {
  minChecks = 7,
  maxGapHours = 36,
} = {}) {
  const sorted = (Array.isArray(records) ? records : [])
    .filter(record => record && Number.isFinite(Date.parse(record.checkedAt)))
    .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
  const latest = sorted.at(-1);
  if (!latest) return { readyForV5: false, consecutiveChecks: 0, elapsedDays: 0, restartObserved: false };

  const maxGapMs = maxGapHours * 60 * 60 * 1000;
  let streak = [];
  let lastSuccess = null;
  let operationalFailures = 0;
  for (const record of sorted) {
    const sameBuild = record.version === latest.version && record.commit === latest.commit;
    if (!sameBuild) {
      streak = [];
      lastSuccess = null;
      operationalFailures = 0;
      continue;
    }
    if (record.passed) {
      const gapTooLarge = lastSuccess
        && Date.parse(record.checkedAt) - Date.parse(lastSuccess.checkedAt) > maxGapMs;
      if (gapTooLarge) {
        streak = [];
        operationalFailures = 0;
      }
      streak.push(record);
      lastSuccess = record;
      continue;
    }
    if (isOperationalFailure(record)) {
      operationalFailures += 1;
      continue;
    }
    streak = [];
    lastSuccess = null;
    operationalFailures = 0;
  }

  const dates = new Set(streak.map(record => record.checkedAt.slice(0, 10)));
  const processStarts = new Set(streak.map(record => record.processStartedAt).filter(Boolean));
  const elapsedMs = streak.length > 1
    ? Date.parse(streak.at(-1).checkedAt) - Date.parse(streak[0].checkedAt)
    : 0;
  const elapsedDays = Math.floor(elapsedMs / DAY_MS);
  const restartObserved = processStarts.size >= 2;
  const pendingOperationalFailure = !latest.passed && isOperationalFailure(latest);
  const readyForV5 = latest.passed
    && streak.length >= minChecks
    && dates.size >= minChecks
    && restartObserved;

  return {
    readyForV5,
    consecutiveChecks: streak.length,
    distinctDates: dates.size,
    elapsedDays,
    restartObserved,
    operationalFailures,
    pendingOperationalFailure,
    version: latest.version,
    commit: latest.commit,
  };
}

module.exports = {
  DAY_MS,
  createSoakRecord,
  routerCoverage,
  sanitizeCommit,
  sanitizeVersion,
  isOperationalFailure,
  summarizeSoakHistory,
};
