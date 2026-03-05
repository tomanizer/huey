import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.resolve(dirname, '../../src/App/App.js');
const indexHtmlPath = path.resolve(dirname, '../../src/index.html');

describe('theme selector binding', () => {
  test('App exposes Theme globally when inline Theme.applyTheme handler is present', () => {
    const appJs = readFileSync(appJsPath, 'utf8');
    const indexHtml = readFileSync(indexHtmlPath, 'utf8');
    const hasInlineThemeHandler = indexHtml.includes('onchange="Theme.applyTheme(this.selectedIndex)"');

    if (hasInlineThemeHandler) {
      expect(appJs).toContain('window.Theme = Theme;');
    }
  });
});
