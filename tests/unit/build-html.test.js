import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = process.cwd();
const templatePath = resolve(repoRoot, 'src/index.template.html');
const indexHtmlPath = resolve(repoRoot, 'src/index.html');
const buildHtmlScriptPath = resolve(repoRoot, 'scripts/build-html.js');
const extractedPartials = [
  'src/App/App.html',
  'src/UploadUi/UploadUi.html',
  'src/ExportUi/ExportUi.html',
  'src/FilterUi/FilterUi.html',
  'src/ErrorDialog/ErrorDialog.html',
  'src/SettingsDialog/SettingsDialog.html',
  'src/PromptUi/PromptUi.html',
  'src/AboutDialog/AboutDialog.html',
  'src/DatasourceSettingsDialog/DatasourceSettingsDialog.html',
  'src/PivotTableUi/PivotTableUi.html',
  'src/ContextMenu/ContextMenu.html',
];

describe('HTML build script', () => {
  it('keeps the source template small and extracts the major inline sections', () => {
    const templateHtml = readFileSync(templatePath, 'utf8');

    expect(templateHtml.split('\n').length).toBeLessThan(200);
    expect(templateHtml).toContain('<!-- @include(UploadUi/UploadUi.html) -->');
    expect(templateHtml).toContain('<!-- @include(App/App.html) -->');

    extractedPartials.forEach((partialPath) => {
      expect(existsSync(resolve(repoRoot, partialPath))).toBe(true);
    });
  });

  it('regenerates src/index.html from the extracted template partials', () => {
    const beforeBuild = readFileSync(indexHtmlPath, 'utf8');

    execFileSync('node', [buildHtmlScriptPath], { cwd: repoRoot });

    const afterBuild = readFileSync(indexHtmlPath, 'utf8');
    expect(afterBuild).toBe(beforeBuild);
    expect(afterBuild).not.toContain('@include(');
    expect(afterBuild).toContain('id="exportDialog"');
    expect(afterBuild).toContain('id="settingsDialog"');
    expect(afterBuild).toContain('id="pivotTableContextMenu"');
    expect(afterBuild).toContain('data-testid="app-layout"');
  });
});
