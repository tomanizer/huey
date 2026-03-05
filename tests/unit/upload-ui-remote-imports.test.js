import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('UploadUi remote datasource imports', () => {
  it('keeps required imports used by the add remote datasource flow', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/UploadUi/UploadUi.js'), 'utf8');

    expect(source).toContain("import { PromptUi } from '../PromptUi/PromptUi.js';");
    expect(source).toContain("import { TabUi } from '../Tabs/Tabs.js';");
    expect(source).toContain("import { RemoteDatasource } from '../DataSource/remote/RemoteDatasource.js';");
    expect(source).toContain("import { RemoteDatasourceConfig } from '../DataSource/remote/RemoteDatasourceConfig.js';");
  });
});
