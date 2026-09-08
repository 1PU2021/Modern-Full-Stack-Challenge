import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';

export default [
  { ignores: ['dist/**'] },
  { files: ['vite.config.js'], languageOptions: { globals: { process: 'readonly' } } },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', sessionStorage: 'readonly',
        fetch: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        URL: 'readonly', import: 'readonly', FileReader: 'readonly', File: 'readonly',
      },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: { ...react.configs.recommended.rules, ...reactHooks.configs.recommended.rules, 'react/react-in-jsx-scope': 'off', 'react/prop-types': 'off' },
  },
];
