import { z } from 'zod';

const DEMO_DEPOSIT_CENTS = 1;

const productionSecrets = [
  'PEY_API_KEY',
  'PEY_WEBHOOK_SECRET',
  'PEY_BASE_URL',
  'BUSINESS_PIN',
  'COOKIE_SECRET',
  'PHONE_HASH_SALT',
  'PUBLIC_BASE_URL',
] as const;

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1),
    PEY_API_KEY: optionalString,
    PEY_WEBHOOK_SECRET: optionalString,
    PEY_BASE_URL: optionalString,
    BUSINESS_PIN: optionalString.pipe(z.string().regex(/^\d{6,}$/, 'must be at least 6 digits').optional()),
    COOKIE_SECRET: optionalString.pipe(z.string().min(32, 'must be at least 32 characters').optional()),
    PHONE_HASH_SALT: optionalString,
    PUBLIC_BASE_URL: optionalString,
    /** Built SPA directory; defaults to `apps/web/dist` next to this package. */
    WEB_ROOT: optionalString,
    DEMO_DEPOSIT_CENTS: z.coerce
      .number()
      .pipe(z.literal(DEMO_DEPOSIT_CENTS, 'DEMO_DEPOSIT_CENTS must be 1'))
      .default(DEMO_DEPOSIT_CENTS),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const key of productionSecrets) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export type EnvResult =
  | { readonly ok: true; readonly env: Env }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Validates a variable bag. Problems name the variable only, never its value. */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): EnvResult {
  const result = envSchema.safeParse(source);
  if (result.success) return { ok: true, env: result.data };
  return {
    ok: false,
    problems: result.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
  };
}

/** Reads `process.env`; exits the process on invalid configuration. */
export function loadEnv(source: Readonly<Record<string, string | undefined>> = process.env): Env {
  const result = parseEnv(source);
  if (result.ok) return result.env;
  console.error(`Invalid environment configuration:\n${result.problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
