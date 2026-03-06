import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    rules: {
      'no-var': 'warn',
      'prefer-const': 'warn',
      'prefer-arrow-callback': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-eval': 'error',
      'no-alert': 'warn',
      'eqeqeq': ['warn', 'always'],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'require-await': 'warn',
      'complexity': ['warn', 20],
      'no-prototype-builtins': 'warn',

      // Transitional allowances kept disabled while legacy modules are normalized.
      'no-undef': 'off',
      'no-case-declarations': 'off',
      'no-fallthrough': 'off',
      'no-unused-private-class-members': 'off',
      'no-useless-escape': 'off',
      'no-useless-assignment': 'off',
      'no-unreachable': 'off',
      // This rule catches generated/source-transformed patterns in vendor-style code paths.
      'no-unassigned-vars': 'off',
      'no-async-promise-executor': 'off',
      'no-constant-condition': 'off',
      'no-dupe-keys': 'off',
      'no-empty': 'off',
      'no-redeclare': 'off',
      'no-unused-labels': 'off',
      'no-restricted-properties': ['warn', {
        property: 'innerHTML',
        message: 'Prefer textContent, replaceChildren(), or safe DOM creation over innerHTML.'
      }],
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
      }
    }
  }
];
