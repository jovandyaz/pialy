import tseslint from 'typescript-eslint';
import { importX } from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

const forbiddenDomainModules = [
  { name: 'drizzle-orm', message: 'Domain must not depend on drizzle-orm.' },
  { name: 'fastify', message: 'Domain must not depend on fastify.' },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.superpowers/**', 'design/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver()],
    },
  },
  {
    // Hexagonal boundary: the payments domain is pure.
    files: ['packages/payments/src/domain/**/*.ts'],
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: import.meta.dirname,
          zones: [
            {
              target: './packages/payments/src/domain',
              from: [
                './packages/payments/src/application',
                './apps',
                './packages/connector-pey',
              ],
              message: 'payments/domain must not import application, apps or connector-pey.',
            },
          ],
        },
      ],
      'no-restricted-imports': ['error', { paths: forbiddenDomainModules }],
    },
  },
  {
    // Hexagonal boundary: server module domains do not know infrastructure.
    files: ['apps/server/src/modules/*/domain/**/*.ts'],
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: import.meta.dirname,
          zones: [
            {
              target: './apps/server/src/modules/*/domain/**/*',
              from: './apps/server/src/modules/*/infrastructure/**/*',
              message: 'Module domain must not import infrastructure.',
            },
          ],
        },
      ],
      'no-restricted-imports': ['error', { paths: forbiddenDomainModules }],
    },
  },
);
