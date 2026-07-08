// P2-22: 遅延リクエストログ — 本番負荷下でしか顕在化しない遅延
// （gzip ストリーミング問題など）を、手動計測なしで自己申告させる。
// 閾値は EGRESSVIEW_SLOW_REQUEST_MS で調整可能（デフォルト 3000ms）。
'use strict';

const logger = require('./logger');

/**
 * 遅延リクエストを WARN ログに出す Express ミドルウェアを生成する。
 * 'finish' はレスポンスが OS へ書き切られた時点で発火するため、
 * ストリーミング送信（圧縮・大きなボディ）の遅延も計測に含まれる。
 *
 * @param {{ thresholdMs?: number, log?: (msg: string) => void }} [opts]
 */
function createSlowRequestLogger({
  thresholdMs = parseInt(process.env.EGRESSVIEW_SLOW_REQUEST_MS || '3000', 10),
  log = (msg) => logger.warn(msg),
} = {}) {
  return function slowRequestLogger(req, res, next) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (ms < thresholdMs) return;
      // クエリ文字列は記録しない（ログ肥大と将来のパラメータ追加への防御）
      const path = String(req.originalUrl || req.url || '').split('?')[0];
      const size = res.getHeader && res.getHeader('content-length') || '-';
      log(`[slow-request] ${req.method} ${path} ${res.statusCode} ${ms.toFixed(0)}ms size=${size}`);
    });
    next();
  };
}

module.exports = { createSlowRequestLogger };
