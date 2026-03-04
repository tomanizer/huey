import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    rules: {
      'no-var': 'warn',
      'prefer-const': 'warn',
      'prefer-arrow-callback': 'warn',
      'no-prototype-builtins': 'warn',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-case-declarations': 'off',
      'no-fallthrough': 'off',
      'no-unused-private-class-members': 'off',
      'no-debugger': 'off',
      'no-useless-escape': 'off',
      'no-useless-assignment': 'off',
      'no-unreachable': 'off',
      'no-unassigned-vars': 'off',
      'no-async-promise-executor': 'off',
      'no-constant-condition': 'off',
      'no-dupe-keys': 'off',
      'no-empty': 'off',
      'no-redeclare': 'off',
      'no-unused-labels': 'off',
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
