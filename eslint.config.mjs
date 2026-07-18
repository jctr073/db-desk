import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['node_modules', 'out', 'dist', 'coverage']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'electron.vite.config.ts',
      'vitest.config.ts',
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'test/**/*.ts'
    ],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },
  {
    // rules-of-hooks and exhaustive-deps only: the rest of the plugin's
    // recommended set (set-state-in-effect etc.) targets React-Compiler
    // readiness and flags the deliberate, documented state-sync idioms this
    // codebase uses; adopting those rules is a refactor, not a lint fix.
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error'
    }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ]
    }
  },
  {
    files: ['src/main/agent.ts', 'src/main/agent/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './db',
              importNames: ['runQuery'],
              message: 'Agent code must use runAgentQuery — the guarded read-only channel.'
            },
            {
              name: '../db',
              importNames: ['runQuery'],
              message: 'Agent code must use runAgentQuery — the guarded read-only channel.'
            }
          ]
        }
      ]
    }
  }
)
