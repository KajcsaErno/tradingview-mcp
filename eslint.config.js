import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'scripts/*.bat', 'scripts/*.vbs'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        fetch: 'readonly',
        WebSocket: 'readonly',
      },
    },
    rules: {
      // Leading-underscore args/vars are intentional (the `_deps` DI hook,
      // ignored callback params); don't flag them.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        // Allow the destructure-to-omit idiom: `const { drop, ...rest } = obj`.
        ignoreRestSiblings: true,
      }],
      // Empty `catch {}` is an intentional best-effort pattern throughout the
      // CDP layer (cleanup that must never throw).
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // The path-traversal sanitizer regex /[\/\\]/g is pinned by
    // tests/sanitization.test.js as an exact source string — keep the escape.
    files: ['src/core/capture.js', 'src/core/batch.js'],
    rules: {
      'no-useless-escape': 'off',
    },
  },
];
