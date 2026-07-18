import js from '@eslint/js'
import globals from 'globals'
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
    files: ['src/main/agent.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './db',
              importNames: ['runQuery'],
              message: 'Agent code must use runAgentQuery — the guarded read-only channel.'
            }
          ]
        }
      ]
    }
  }
)
