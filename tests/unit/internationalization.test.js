async function loadI18nWithLanguages(languages) {
  vi.resetModules();
  document.body.innerHTML = '';
  Object.defineProperty(navigator, 'languages', {
    value: languages,
    configurable: true,
  });
  const module = await import('../../src/Internationalization/Internationalization.js');
  return module.Internationalization;
}

function mockUnsupportedSelector() {
  const originalQuerySelectorAll = Document.prototype.querySelectorAll;
  return vi.spyOn(Document.prototype, 'querySelectorAll').mockImplementation(function(selector) {
    if (selector.includes(':has(')) {
      return document.createDocumentFragment().querySelectorAll('*');
    }
    return originalQuerySelectorAll.call(this, selector);
  });
}

describe('Internationalization', () => {
  test('getText returns translated text after locale is loaded', async () => {
    const Internationalization = await loadI18nWithLanguages(['fr']);
    const selectorSpy = mockUnsupportedSelector();

    Internationalization.setTexts({ Hello: 'Bonjour' });
    const script = document.createElement('script');
    script.src = 'https://localhost/Internationalization/i18n/fr.js';
    Internationalization.textsLoaded({ target: script });

    expect(Internationalization.getText('Hello')).toBe('Bonjour');
    selectorSpy.mockRestore();
  });

  test('getText replaces placeholders with values', async () => {
    const Internationalization = await loadI18nWithLanguages(['fr']);
    const selectorSpy = mockUnsupportedSelector();

    Internationalization.setTexts({ 'Hello {1}': 'Bonjour {1}' });
    const script = document.createElement('script');
    script.src = 'https://localhost/Internationalization/i18n/fr.js';
    Internationalization.textsLoaded({ target: script });

    expect(Internationalization.getText('Hello {1}', 'Alice')).toBe('Bonjour Alice');
    selectorSpy.mockRestore();
  });

  test('missing translation returns undefined', async () => {
    const Internationalization = await loadI18nWithLanguages(['fr']);
    const selectorSpy = mockUnsupportedSelector();

    Internationalization.setTexts({ Hello: 'Bonjour' });
    const script = document.createElement('script');
    script.src = 'https://localhost/Internationalization/i18n/fr.js';
    Internationalization.textsLoaded({ target: script });

    expect(Internationalization.getText('Unknown key')).toBeUndefined();
    selectorSpy.mockRestore();
  });

  test('multiple placeholders are replaced correctly', async () => {
    const Internationalization = await loadI18nWithLanguages(['fr']);
    const selectorSpy = mockUnsupportedSelector();

    Internationalization.setTexts({ 'Pair: {1}, {2}': 'Paire : {1}, {2}' });
    const script = document.createElement('script');
    script.src = 'https://localhost/Internationalization/i18n/fr.js';
    Internationalization.textsLoaded({ target: script });

    expect(Internationalization.getText('Pair: {1}, {2}', 'A', 'B')).toBe('Paire : A, B');
    selectorSpy.mockRestore();
  });

  test('initialization attempts to load locale file for non-native language', async () => {
    await loadI18nWithLanguages(['fr-FR', 'en']);
    document.dispatchEvent(new Event('DOMContentLoaded'));

    const script = document.getElementById('InternationalizationTexts');
    expect(script).not.toBeNull();
    expect(script.getAttribute('src')).toContain('Internationalization/i18n/fr-FR.js');
  });
});
