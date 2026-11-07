import js from '@eslint/js'
import globals from 'globals'

const sharedRules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': [
    'warn',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
}

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/pdfjs/**',
      'public/pdfium/**',
      'public/fonts/**',
    ],
  },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: globals.browser,
    },
    rules: sharedRules,
  },
  {
    files: ['vite.config.js', 'eslint.config.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
    rules: sharedRules,
  },
]
