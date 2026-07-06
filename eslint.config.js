// ESLint flat config — CommonJS backend + ES Modules frontend の混成構成
'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'dev-conntrack/**',
      'docs/**',
    ],
  },

  // ── バックエンド（CommonJS / Node）─────────────────────────────────────────
  {
    files: ['server.js', 'src/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js', 'playwright.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // 意図的な空 catch（ベストエフォート処理）を許容
      'no-empty': ['error', { allowEmptyCatch: true }],
      // _ プレフィックスは「意図的に未使用」の規約
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // SSH 出力の ANSI エスケープ除去・機器名の制御文字判定で正当に使用
      'no-control-regex': 'off',
    },
  },

  // ── スモークテスト（page.evaluate 内でブラウザ globals を参照）──────────────
  {
    files: ['test/smoke/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // ── フロントエンド（ES Modules / ブラウザ）──────────────────────────────────
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        io: 'readonly',         // socket.io client（script タグで読み込み）
        d3: 'readonly',         // D3.js（script タグで読み込み）
        Chart: 'readonly',      // Chart.js（script タグで読み込み）
        topojson: 'readonly',   // topojson-client（script タグで読み込み）
        _DEMO_MODE: 'readonly', // サーバーがテンプレート置換で注入
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
    },
  },
];
