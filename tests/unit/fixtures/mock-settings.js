/**
 * Shared mock factories for SettingsDialog and ErrorDialog.
 *
 * Usage in test files (must use vi.hoisted to make available in vi.mock factories):
 *
 *   const mocks = vi.hoisted(() => require('./fixtures/mock-settings.js'));
 *
 * Or more simply, paste the vi.mock calls and import the DEFAULT_SETTINGS_VALUES
 * for custom overrides.
 *
 * These factories are intended for new test files created in Phase 3+.
 * Existing test files retain their inline mocks.
 */

export const DEFAULT_SETTINGS_VALUES = {
  sqlSettings: {
    alwaysQuoteIdentifiers: false,
    keywordLetterCase: 'upperCase',
    commaStyle: 'newlineBefore',
  },
  localeSettings: {
    nullString: 'NULL',
    locale: ['en-US'],
    minimumIntegerDigits: 1,
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
    linkMinimumAndMaximumDecimals: false,
    nullsSortOrder: { value: 'FIRST' },
  },
  querySettings: {
    autoRunQuery: true,
    filterValuePicklistPageSize: 100,
    filterSearchAutoWildcards: false,
    filterSearchApplyAll: false,
    autoRunQueryTimeout: 1000,
  },
  filterDialogSettings: {
    filterSearchApplyAll: false,
    filterSearchAutoWildcards: false,
  },
  pivotSettings: {
    maxCellWidth: 30,
    totalsString: 'Total',
    totalsPosition: { value: 'AFTER' },
    hideRepeatingAxisValues: true,
    dittoMark: '〃',
    alternatingRowColors: true,
    hoverRowHighlight: true,
    hoverColumnHighlight: true,
  },
};

/**
 * Returns a settings mock object suitable for use as a vi.mock factory return value.
 * @param {Partial<typeof DEFAULT_SETTINGS_VALUES>} [overrides]
 */
export function createSettingsMock(overrides = {}) {
  const merged = Object.assign({}, DEFAULT_SETTINGS_VALUES, overrides);
  return {
    settings: {
      getSettings(keyPath) {
        const key = Array.isArray(keyPath) ? keyPath[keyPath.length - 1] : keyPath;
        return merged[key] || {};
      },
      assignSettings() {},
      addEventListener() {},
      removeEventListener() {},
    },
    Settings: class {
      getSettings(keyPath) {
        const key = Array.isArray(keyPath) ? keyPath[keyPath.length - 1] : keyPath;
        return merged[key] || {};
      }
      assignSettings() {}
      addEventListener() {}
      removeEventListener() {}
      ready() {}
    },
  };
}

/**
 * Returns an ErrorDialog mock object suitable for use as a vi.mock factory return value.
 */
export function createErrorDialogMock() {
  return {
    showErrorDialog: vi.fn(),
    getDataFromError: vi.fn((e) => ({ title: String(e), description: String(e) })),
    initErrorDialog: vi.fn(),
  };
}
