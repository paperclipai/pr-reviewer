import { z } from 'zod';
import path from 'path';

const configSchema = z.object({
  GITHUB_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  DB_BACKEND: z.enum(['sqlite', 'd1']).default('sqlite'),
  // SQLite config
  DB_PATH: z.string().default('./data/pr-triage.db'),
  // D1 config (required when DB_BACKEND=d1)
  D1_ACCOUNT_ID: z.string().optional(),
  D1_DATABASE_ID: z.string().optional(),
  D1_API_TOKEN: z.string().optional(),
}).refine(
  (data) => {
    if (data.DB_BACKEND === 'd1') {
      return !!data.D1_ACCOUNT_ID && !!data.D1_DATABASE_ID && !!data.D1_API_TOKEN;
    }
    return true;
  },
  { message: 'D1_ACCOUNT_ID, D1_DATABASE_ID, and D1_API_TOKEN are required when DB_BACKEND=d1' }
);

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`Configuration error:\n${missing}`);
    process.exit(1);
  }

  const config = result.data;
  config.DB_PATH = path.resolve(config.DB_PATH);

  _config = config;
  return config;
}
