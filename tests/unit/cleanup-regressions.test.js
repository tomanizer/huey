vi.mock('../../src/QueryModel/QueryModel.js', () => ({
  QueryAxisItem: {
    createFormatter: vi.fn(),
    createLiteralWriter: vi.fn(),
    createParser: vi.fn(),
  },
  QueryModel: {
    AXIS_COLUMNS: 'columns',
    AXIS_ROWS: 'rows',
    AXIS_CELLS: 'cells',
  },
  queryModel: {},
}));

vi.mock('../../src/AttributeUi/AttributeUi.js', () => ({
  AttributeUi: {},
}));

vi.mock('../../src/PivotTableUi/PivotTableUi.js', () => ({
  pivotTableUi: {
    updatePivotTableUi: vi.fn(),
  },
}));

import { QuickQueryMenu } from '../../src/QuickQueryMenu/QuickQueryMenu.js';

describe('cleanup regressions', () => {
  test('destructured data preview button is disabled until implemented', () => {
    document.body.innerHTML = `
      <button id="quickQueryFlipAxesButton"></button>
      <button id="quickQueryCellHeadersOnColumnsButton"></button>
      <button id="quickQueryCellHeadersOnRowsButton"></button>
      <button id="quickQueryClearAllButton"></button>
      <button id="quickQueryColumnStatisticsButton"></button>
      <button id="quickQueryDataPreviewButton"></button>
      <button id="quickQueryDestructuredDataPreviewButton" title="old"></button>
    `;

    new QuickQueryMenu({});

    const button = document.getElementById('quickQueryDestructuredDataPreviewButton');
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Coming soon');
  });
});
