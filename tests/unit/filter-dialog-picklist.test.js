/**
 * Tests for FilterDialog value picklist behavior, including #381: clearing
 * stale picklist on search input so the wrong value cannot be applied.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings(keyPath) {
      const key = Array.isArray(keyPath) ? keyPath[keyPath.length - 1] : keyPath;
      const defaults = {
        querySettings: { filterValuePicklistPageSize: 100, filterSearchAutoQueryTimeoutInMilliseconds: 500 },
        filterDialogSettings: { filterSearchApplyAll: false },
      };
      return defaults[key] ?? 500;
    },
    assignSettings() {},
    addEventListener() {},
    removeEventListener() {},
  },
}));

vi.mock('../../src/ErrorDialog/ErrorDialog.js', () => ({
  showErrorDialog: vi.fn(),
  initErrorDialog: vi.fn(),
}));

describe('FilterDialog value picklist (e.g. #381)', () => {
  /**
   * Build minimal DOM required for FilterDialog constructor and search input handler.
   * FilterDialog #initEvents and #initSearchQueryHandler use these byId elements.
   */
  function createFilterDialogDom() {
    const dialog = document.createElement('dialog');
    dialog.id = 'filterDialog';
    const picklist = document.createElement('select');
    picklist.id = 'filterPicklist';
    picklist.multiple = true;
    const search = document.createElement('input');
    search.id = 'filterSearch';
    search.type = 'text';
    const filterType = document.createElement('select');
    filterType.id = 'filterType';
    const addFilterValueButton = document.createElement('button');
    addFilterValueButton.id = 'addFilterValueButton';

    const ids = [
      'filterDialogOkButton', 'filterDialogRemoveButton', 'filterDialogCancelButton',
      'filterDialogClearButton', 'filterDialogClearSelectedButton', 'filterDialogSpinner',
      'filterSearchStatus', 'filterValueSelectionStatus', 'filterSearchApplyAll',
      'filterSearchAutoWildcards', 'filterSearchCaseSensitive', 'filterValueList', 'toFilterValueList',
    ];
    ids.forEach((id) => {
      const el = id.includes('List') ? document.createElement('select') : document.createElement('div');
      el.id = id;
      if (id === 'filterSearchApplyAll' || id === 'filterSearchAutoWildcards' || id === 'filterSearchCaseSensitive') {
        el.checked = false;
      }
      document.body.appendChild(el);
    });

    document.body.appendChild(dialog);
    document.body.appendChild(picklist);
    document.body.appendChild(search);
    document.body.appendChild(filterType);
    document.body.appendChild(addFilterValueButton);
    return { dialog, picklist, search, filterType };
  }

  function removeFilterDialogDom() {
    [
      'filterDialog', 'filterPicklist', 'filterSearch', 'filterType', 'addFilterValueButton',
      'filterDialogOkButton', 'filterDialogRemoveButton', 'filterDialogCancelButton',
      'filterDialogClearButton', 'filterDialogClearSelectedButton', 'filterDialogSpinner',
      'filterSearchStatus', 'filterValueSelectionStatus', 'filterSearchApplyAll',
      'filterSearchAutoWildcards', 'filterSearchCaseSensitive', 'filterValueList', 'toFilterValueList',
    ].forEach((id) => document.getElementById(id)?.remove());
  }

  beforeEach(() => {
    vi.useFakeTimers();
    createFilterDialogDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    removeFilterDialogDom();
    vi.clearAllMocks();
  });

  test('clears value picklist on first search input so stale values cannot be selected (#381)', async () => {
    const { FilterDialog } = await import('../../src/FilterUi/FilterUi.js');
    const picklist = document.getElementById('filterPicklist');
    const search = document.getElementById('filterSearch');

    const filterDialog = new FilterDialog({
      id: 'filterDialog',
      queryModel: {},
      settings: { getSettings: () => 500, assignSettings: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
    });

    // Simulate stale options in the picklist (e.g. from a previous query showing AAPL)
    const staleOption = document.createElement('option');
    staleOption.value = 'AAPL';
    staleOption.textContent = 'AAPL';
    picklist.appendChild(staleOption);
    expect(picklist.children.length).toBe(1);

    // User types in search (e.g. "GOOG"); handler runs with count=0 and clears picklist
    search.dispatchEvent(new Event('input', { bubbles: true }));

    // Picklist must be cleared so user cannot select stale AAPL (fixes #381)
    expect(picklist.children.length).toBe(0);
  });
});
