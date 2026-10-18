import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';

const CI_COMMIT_ENVIRONMENT_VARIABLES = ['GITHUB_SHA', 'CI_COMMIT_SHA', 'VITE_GIT_COMMIT'] as const;

function isFullCommitHash(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function getBuildCommit(): string {
  for (const name of CI_COMMIT_ENVIRONMENT_VARIABLES) {
    const value = process.env[name]?.trim();
    if (value && isFullCommitHash(value)) return value.toLowerCase();
  }

  try {
    const value = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return isFullCommitHash(value) ? value.toLowerCase() : '';
  } catch {
    return '';
  }
}

export default defineConfig(({ command }) => ({
  define: {
    __BUILD_COMMIT__: JSON.stringify(command === 'build' ? getBuildCommit() : ''),
  },
}));
