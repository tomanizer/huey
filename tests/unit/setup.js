const fs = require('fs');
const path = require('path');
const { TextEncoder, TextDecoder } = require('util');

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = TextDecoder;
}

const { JSDOM } = require('jsdom');

// Load scripts in dependency order (matching index.html)
const scriptOrder = [
  'src/util/dom/dom.js',
  'src/util/event/EventEmitter.js',
  'src/util/event/EventBuffer.js',
  'src/util/sql/SQLHelper.js',
  'src/Internationalization/Internationalization.js',
  'src/AttributeUi/AttributeUi.js',
  'src/FilterUi/FilterUi.js',
  'src/QueryModel/QueryModel.js',
];

function createSettingsStub(window) {
  const defaults = {
    sqlSettings: {
      alwaysQuoteIdentifiers: false,
      keywordCase: 'upperCase',
    },
    localeSettings: {
      nullString: 'NULL',
      locale: 'en-US',
      minimumIntegerDigits: 1,
      minimumFractionDigits: 0,
      maximumFractionDigits: 3,
      linkMinimumAndMaximumDecimals: false,
    },
    querySettings: {
      autoRunQuery: true,
      filterValuePicklistPageSize: 100,
      filterSearchAutoWildcards: false,
      filterSearchApplyAll: false,
    },
    filterDialogSettings: {
      filterSearchApplyAll: false,
      filterSearchAutoWildcards: false,
    },
  };

  window.settings = {
    getSettings(keyPath) {
      const key =
        keyPath instanceof Array ? keyPath[keyPath.length - 1] : keyPath;
      return defaults[key] || {};
    },
    assignSettings() {
      // noop stub for tests
    },
  };
}

function ensureNavigatorLanguages(window) {
  if (!window.navigator.languages || !window.navigator.languages.length) {
    Object.defineProperty(window.navigator, 'languages', {
      value: ['en'],
      configurable: true,
    });
  }
}

function loadScripts() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  ensureNavigatorLanguages(dom.window);
  createSettingsStub(dom.window);
  if (!dom.window.hueyDb) {
    dom.window.hueyDb = { reservedWords: [] };
  }

  for (const script of scriptOrder) {
    const code = fs.readFileSync(
      path.resolve(__dirname, '../../', script),
      'utf-8'
    );
    const scriptElement = dom.window.document.createElement('script');
    scriptElement.textContent = code;
    try {
      dom.window.document.body.appendChild(scriptElement);
    } catch (error) {
      throw new Error(`Failed to evaluate ${script}: ${error.message}`);
    }
  }

  const globalNames = [
    'QueryModel',
    'QueryAxisItem',
    'FilterDialog',
    'AttributeUi',
  ];
  globalNames.forEach((name) => {
    if (typeof dom.window[name] === 'undefined') {
      const value = dom.window.eval(`typeof ${name} !== 'undefined' ? ${name} : undefined`);
      if (value !== undefined) {
        dom.window[name] = value;
      }
    }
  });

  // Avoid running full DOMContentLoaded handlers (they rely on browser-only selectors),
  // but ensure basic Internationalization helpers are available.
  if (dom.window.Internationalization) {
    dom.window.Internationalization.getCurrentLanguage = function () {
      return 'en';
    };
    dom.window.Internationalization.getText = function (key) {
      if (typeof key !== 'string') {
        return key;
      }
      var args = Array.prototype.slice.call(arguments, 1);
      return key.replace(/\{[1-9]\d*\}/g, function (match) {
        var index = parseInt(match.slice(1, -1), 10);
        return args[index - 1];
      });
    };
  }

  return dom.window;
}

module.exports = { loadScripts };
