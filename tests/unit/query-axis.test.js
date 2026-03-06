vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings(keyPath) {
      const key = Array.isArray(keyPath) ? keyPath[keyPath.length - 1] : keyPath;
      const defaults = {
        sqlSettings: { alwaysQuoteIdentifiers: false, keywordLetterCase: 'upperCase', commaStyle: 'newlineBefore' },
        localeSettings: { nullString: 'NULL', locale: ['en-US'] },
      };
      return defaults[key] || {};
    },
    assignSettings() {},
    addEventListener() {},
    removeEventListener() {},
  },
}));

vi.mock('../../src/ErrorDialog/ErrorDialog.js', () => ({
  showErrorDialog: vi.fn(),
  getDataFromError: vi.fn((e) => ({ title: String(e), description: String(e) })),
  initErrorDialog: vi.fn(),
}));

import { QueryAxis } from '../../src/QueryModel/QueryModel.js';

describe('QueryAxis', () => {
  let axis;

  beforeEach(() => {
    axis = new QueryAxis();
  });

  describe('addItem', () => {
    it('should add an item and return it with an index', () => {
      const result = axis.addItem({ columnName: 'col1', columnType: 'VARCHAR' });
      expect(result.columnName).toBe('col1');
      expect(result.index).toBe(0);
    });

    it('should add multiple items with sequential indices', () => {
      axis.addItem({ columnName: 'col1' });
      axis.addItem({ columnName: 'col2' });
      const items = axis.getItems();
      expect(items.length).toBe(2);
      expect(items[0].columnName).toBe('col1');
      expect(items[1].columnName).toBe('col2');
    });

    it('should insert at specific index', () => {
      axis.addItem({ columnName: 'col1' });
      axis.addItem({ columnName: 'col3' });
      axis.addItem({ columnName: 'col2', index: 1 });
      const items = axis.getItems();
      expect(items[1].columnName).toBe('col2');
    });

    it('should clamp negative index to 0', () => {
      axis.addItem({ columnName: 'col1' });
      axis.addItem({ columnName: 'col0', index: -5 });
      const items = axis.getItems();
      expect(items[0].columnName).toBe('col0');
    });

    it('should clamp out-of-bounds index to end', () => {
      axis.addItem({ columnName: 'col1' });
      axis.addItem({ columnName: 'col2', index: 100 });
      const items = axis.getItems();
      expect(items[1].columnName).toBe('col2');
    });

    it('should not include axis property in the added item', () => {
      const result = axis.addItem({ columnName: 'col1', axis: 'rows' });
      expect(result.axis).toBeUndefined();
    });
  });

  describe('findItem', () => {
    it('should find an item by columnName', () => {
      axis.addItem({ columnName: 'col1' });
      const found = axis.findItem({ columnName: 'col1' });
      expect(found).toBeDefined();
      expect(found.columnName).toBe('col1');
      expect(found.index).toBe(0);
    });

    it('should return undefined when item not found', () => {
      axis.addItem({ columnName: 'col1' });
      const found = axis.findItem({ columnName: 'col2' });
      expect(found).toBeUndefined();
    });

    it('should find item by columnName and derivation', () => {
      axis.addItem({ columnName: 'date_col', derivation: 'year' });
      axis.addItem({ columnName: 'date_col', derivation: 'month' });
      const found = axis.findItem({ columnName: 'date_col', derivation: 'month' });
      expect(found).toBeDefined();
      expect(found.derivation).toBe('month');
      expect(found.index).toBe(1);
    });

    it('should find item by columnName and aggregator', () => {
      axis.addItem({ columnName: 'amount', aggregator: 'sum' });
      axis.addItem({ columnName: 'amount', aggregator: 'avg' });
      const found = axis.findItem({ columnName: 'amount', aggregator: 'avg' });
      expect(found).toBeDefined();
      expect(found.aggregator).toBe('avg');
    });

    it('should return a copy of the item (not the original)', () => {
      axis.addItem({ columnName: 'col1' });
      const found = axis.findItem({ columnName: 'col1' });
      found.columnName = 'modified';
      const foundAgain = axis.findItem({ columnName: 'col1' });
      expect(foundAgain).toBeDefined();
    });

    it('should deep copy filter when present', () => {
      axis.addItem({ columnName: 'col1', filter: { values: [1, 2, 3] } });
      const found = axis.findItem({ columnName: 'col1' });
      found.filter.values.push(4);
      const foundAgain = axis.findItem({ columnName: 'col1' });
      expect(foundAgain.filter.values).toEqual([1, 2, 3]);
    });

    it('should match memberExpressionPath as array', () => {
      axis.addItem({ columnName: 'col1', memberExpressionPath: ['a', 'b'] });
      const found = axis.findItem({ columnName: 'col1', memberExpressionPath: ['a', 'b'] });
      expect(found).toBeDefined();
    });

    it('should not match when memberExpressionPath differs', () => {
      axis.addItem({ columnName: 'col1', memberExpressionPath: ['a', 'b'] });
      const found = axis.findItem({ columnName: 'col1', memberExpressionPath: ['a', 'c'] });
      expect(found).toBeUndefined();
    });
  });

  describe('removeItem', () => {
    it('should remove an existing item', () => {
      axis.addItem({ columnName: 'col1' });
      axis.addItem({ columnName: 'col2' });
      const removed = axis.removeItem({ columnName: 'col1' });
      expect(removed).toBeDefined();
      expect(removed.columnName).toBe('col1');
      expect(axis.getItems().length).toBe(1);
    });

    it('should return undefined when item not found', () => {
      const removed = axis.removeItem({ columnName: 'nonexistent' });
      expect(removed).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should remove all items', () => {
      axis.addItem({ columnName: 'col1' });
      axis.addItem({ columnName: 'col2' });
      axis.clear();
      expect(axis.getItems().length).toBe(0);
    });
  });

  describe('getItems', () => {
    it('should return a copy of the items array', () => {
      axis.addItem({ columnName: 'col1' });
      const items = axis.getItems();
      items.push({ columnName: 'col2' });
      expect(axis.getItems().length).toBe(1);
    });
  });

  describe('syncItemIndices', () => {
    it('should update indices after removal', () => {
      axis.addItem({ columnName: 'col1' });
      axis.addItem({ columnName: 'col2' });
      axis.addItem({ columnName: 'col3' });
      axis.removeItem({ columnName: 'col1' });
      axis.syncItemIndices();
      const items = axis.getItems();
      expect(items[0].index).toBe(0);
      expect(items[1].index).toBe(1);
    });
  });

  describe('getTotalsItems', () => {
    it('should return undefined when no items have includeTotals', () => {
      axis.addItem({ columnName: 'col1' });
      expect(axis.getTotalsItems()).toBeUndefined();
    });

    it('should return items with includeTotals', () => {
      axis.addItem({ columnName: 'col1', includeTotals: true });
      axis.addItem({ columnName: 'col2' });
      const totals = axis.getTotalsItems();
      expect(totals).toBeDefined();
      expect(totals.length).toBe(1);
      expect(totals[0].columnName).toBe('col1');
    });
  });

  describe('getCaption', () => {
    it('should return <empty> for empty axis', () => {
      expect(axis.getCaption()).toBe('<empty>');
    });

    it('should return quoted item caption for single item', () => {
      axis.addItem({ columnName: 'col1', columnType: 'INTEGER' });
      const caption = axis.getCaption();
      expect(caption).toContain('col1');
    });
  });

  describe('setItems', () => {
    it('should replace all items', () => {
      axis.addItem({ columnName: 'col1' });
      axis.setItems([{ columnName: 'new1' }, { columnName: 'new2' }]);
      const items = axis.getItems();
      expect(items.length).toBe(2);
      expect(items[0].columnName).toBe('new1');
    });
  });
});
