import js from '@eslint/js';
import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';

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
      // Stricter quality rules on the source tree (parity with SonarLint/IDE
      // inspections): complexity caps, no nested ternaries/templates, modern
      // idioms. Tests and scripts are deliberately exempt.
      files: ['src/**/*.js'],
      plugins: {sonarjs, unicorn},
      rules: {
          'sonarjs/cognitive-complexity': ['error', 15],
          'sonarjs/no-nested-conditional': 'error',
          'sonarjs/no-nested-template-literals': 'error',
          'sonarjs/no-identical-functions': 'error',
          'sonarjs/no-nested-functions': 'error',
          'sonarjs/no-ignored-exceptions': 'error',
          'sonarjs/no-inverted-boolean-check': 'error',
          'unicorn/no-negated-condition': 'error',
          'unicorn/prefer-at': 'error',
          'unicorn/no-zero-fractions': 'error',
          'unicorn/prefer-set-has': 'error',
          'unicorn/prefer-native-coercion-functions': 'error',
          'unicorn/prefer-code-point': 'error',
          'unicorn/prefer-math-min-max': 'error',
          'unicorn/catch-error-name': ['error', {name: 'err'}],
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
