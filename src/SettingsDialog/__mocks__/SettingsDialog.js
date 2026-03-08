/**
 * Automatic Vitest mock for SettingsDialog.
 * Used when a test file calls vi.mock('../../src/SettingsDialog/SettingsDialog.js')
 * without a factory function.
 *
 * Default locale/SQL/query values match the real Settings defaults so tests
 * that don't care about specific settings work without any extra setup.
 */
import { vi } from 'vitest';

const DEFAULT_SETTINGS_VALUES = {
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

export const settings = {
  getSettings(keyPath) {
    const key = Array.isArray(keyPath) ? keyPath[keyPath.length - 1] : keyPath;
    return DEFAULT_SETTINGS_VALUES[key] || {};
  },
  assignSettings: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  ready: vi.fn(),
};
