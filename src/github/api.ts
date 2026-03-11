import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { loadConfig } from '../config';

const ThrottledOctokit = Octokit.plugin(throttling);

let _octokit: Octokit | null = null;

export const REPO_OWNER = 'paperclipai';
export const REPO_NAME = 'paperclip';

export function getOctokit(): Octokit {
  if (_octokit) return _octokit;

  const config = loadConfig();

  _octokit = new ThrottledOctokit({
    auth: config.GITHUB_TOKEN,
    throttle: {
      onRateLimit: (retryAfter: number, options: any, octokit: any, retryCount: number) => {
        octokit.log.warn(`Rate limit hit for ${options.method} ${options.url}`);
        if (retryCount < 2) {
          octokit.log.info(`Retrying after ${retryAfter} seconds`);
          return true;
        }
        return false;
      },
      onSecondaryRateLimit: (retryAfter: number, options: any, octokit: any) => {
        octokit.log.warn(`Secondary rate limit hit for ${options.method} ${options.url}`);
        return true;
      },
    },
  });

  return _octokit;
}
