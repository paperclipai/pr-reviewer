import { z } from 'zod';
import path from 'path';

const configSchema = z.object({
  GITHUB_TOKEN: z.string().min(1, 'GITHUB_TOKEN is required'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  DB_PATH: z.string().default('./data/pr-triage.db'),
});

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

  // Resolve DB_PATH to absolute
  const config = result.data;
  config.DB_PATH = path.resolve(config.DB_PATH);

  _config = config;
  return config;
}
