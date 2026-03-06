import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const scriptPath = resolve(process.cwd(), 'scripts/check-node-version.js');

describe('Node runtime preflight', () => {
  it('fails fast with guidance when Node runtime is too old', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        HUEY_NODE_VERSION_OVERRIDE: 'v12.16.1',
        HUEY_NPM_USER_AGENT_OVERRIDE: 'npm/6.14.4 node/v12.16.1 linux x64',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Node.js 20+ is required');
    expect(result.stderr).toContain('nvm install 20');
  });

  it('passes when Node and npm satisfy the baseline', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        HUEY_NODE_VERSION_OVERRIDE: 'v20.11.1',
        HUEY_NPM_USER_AGENT_OVERRIDE: 'npm/10.8.2 node/v20.11.1 linux x64',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
