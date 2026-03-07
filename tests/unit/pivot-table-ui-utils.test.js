import {
  appendNodes,
  waitForAnimationFrame,
  pivotTableUiDefaults,
  getTotalsItemsIndices,
  isTotalsMember,
  getDittoMark,
  getHideRepeatingAxisValues,
  getMaxCellWidth,
} from '../../src/PivotTableUi/PivotTableUiUtils.js';

describe('PivotTableUiUtils', () => {

  describe('pivotTableUiDefaults', () => {
    it('should export expected default values', () => {
      expect(pivotTableUiDefaults.resizeTimeout).toBe(1000);
      expect(pivotTableUiDefaults.scrollTimeout).toBe(500);
      expect(pivotTableUiDefaults.columnHeaderResizeTimeout).toBe(500);
      expect(pivotTableUiDefaults.maximumCellWidth).toBe(30);
      expect(pivotTableUiDefaults.defaultDittoMark).toBe('〃');
      expect(pivotTableUiDefaults.defaultHideRepeatingAxisValues).toBe(true);
      expect(pivotTableUiDefaults.defaultPageSize).toBe(100);
      expect(pivotTableUiDefaults.renderBatchSize).toBe(10);
      expect(pivotTableUiDefaults.templateId).toBe('pivotTableUiTemplate');
    });
  });

  describe('appendNodes', () => {
    it('should append nodes via a document fragment in order', () => {
      const parent = document.createElement('div');
      const first = document.createElement('span');
      first.textContent = 'first';
      const second = document.createElement('span');
      second.textContent = 'second';

      appendNodes(parent, [first, second]);

      expect(Array.from(parent.childNodes).map((node) => node.textContent)).toEqual(['first', 'second']);
    });

    it('should insert nodes before the provided sibling', () => {
      const parent = document.createElement('div');
      const anchor = document.createElement('span');
      anchor.textContent = 'anchor';
      parent.appendChild(anchor);
      const first = document.createElement('span');
      first.textContent = 'first';
      const second = document.createElement('span');
      second.textContent = 'second';

      appendNodes(parent, [first, second], anchor);

      expect(Array.from(parent.childNodes).map((node) => node.textContent)).toEqual(['first', 'second', 'anchor']);
    });
  });

  describe('waitForAnimationFrame', () => {
    it('should resolve on the provided animation frame scheduler', async () => {
      const callbacks = [];
      const promise = waitForAnimationFrame((callback) => {
        callbacks.push(callback);
      });

      expect(callbacks).toHaveLength(1);
      callbacks[0]();
      await expect(promise).resolves.toBeUndefined();
    });

    it('should resolve immediately when requestAnimationFrame is unavailable', async () => {
      await expect(waitForAnimationFrame(undefined)).resolves.toBeUndefined();
    });
  });

  describe('getTotalsItemsIndices', () => {
    it('should return undefined for null/empty input', () => {
      expect(getTotalsItemsIndices(null)).toBeUndefined();
      expect(getTotalsItemsIndices([])).toBeUndefined();
      expect(getTotalsItemsIndices(undefined)).toBeUndefined();
    });

    it('should return undefined when no items have includeTotals', () => {
      const items = [
        { columnName: 'a' },
        { columnName: 'b' },
      ];
      const result = getTotalsItemsIndices(items);
      expect(result).toEqual([]);
    });

    it('should return indices of items with includeTotals in reverse order', () => {
      const items = [
        { columnName: 'a', includeTotals: true },
        { columnName: 'b' },
        { columnName: 'c', includeTotals: true },
      ];
      const result = getTotalsItemsIndices(items);
      expect(result).toEqual([2, 0]);
    });

    it('should return single index when one item has includeTotals', () => {
      const items = [
        { columnName: 'a' },
        { columnName: 'b', includeTotals: true },
      ];
      const result = getTotalsItemsIndices(items);
      expect(result).toEqual([1]);
    });

    it('should return all indices when all items have includeTotals', () => {
      const items = [
        { includeTotals: true },
        { includeTotals: true },
        { includeTotals: true },
      ];
      const result = getTotalsItemsIndices(items);
      expect(result).toEqual([2, 1, 0]);
    });
  });

  describe('isTotalsMember', () => {
    it('should return Infinity when groupingId is falsy', () => {
      expect(isTotalsMember(undefined, [0], 0)).toBe(Infinity);
      expect(isTotalsMember(null, [0], 0)).toBe(Infinity);
      expect(isTotalsMember(0n, [0], 0)).toBe(Infinity);
    });

    it('should return Infinity when totalsItemsIndices is empty or null', () => {
      expect(isTotalsMember(1n, null, 0)).toBe(Infinity);
      expect(isTotalsMember(1n, [], 0)).toBe(Infinity);
      expect(isTotalsMember(1n, undefined, 0)).toBe(Infinity);
    });

    it('should return Infinity when currentItemIndex is undefined', () => {
      expect(isTotalsMember(1n, [0], undefined)).toBe(Infinity);
    });

    it('should identify totals member with single totals item', () => {
      // groupingId = 1n means bit 0 is set
      const result = isTotalsMember(1n, [2], 0);
      expect(result).toBe(2);
    });

    it('should identify totals member with multiple totals items', () => {
      // groupingId = 2n means bit 1 is set (the higher-order bit)
      // With totalsItemsIndices [1, 0], i starts at 1n, bit 1 is set, so returns totalsItemsIndices[1] = 0
      const result = isTotalsMember(2n, [1, 0], 0);
      expect(result).toBe(0);
    });

    it('should return Infinity when no bits match', () => {
      // groupingId has no bits set that correspond to totals indices
      const result = isTotalsMember(0n, [0], 0);
      expect(result).toBe(Infinity);
    });
  });

  describe('getDittoMark', () => {
    it('should return default ditto mark when settings is null', () => {
      expect(getDittoMark(null)).toBe('〃');
    });

    it('should return default ditto mark when settings is undefined', () => {
      expect(getDittoMark(undefined)).toBe('〃');
    });

    it('should return custom ditto mark from plain settings object', () => {
      const settings = { dittoMark: '″' };
      expect(getDittoMark(settings)).toBe('″');
    });

    it('should use getSettings method when available', () => {
      const settings = {
        getSettings(key) {
          if (key === 'pivotSettings') return { dittoMark: '--' };
          return {};
        }
      };
      expect(getDittoMark(settings)).toBe('--');
    });

    it('should return default when getSettings returns no dittoMark', () => {
      const settings = {
        getSettings() { return {}; }
      };
      expect(getDittoMark(settings)).toBe('〃');
    });
  });

  describe('getHideRepeatingAxisValues', () => {
    it('should return true by default when settings is null', () => {
      expect(getHideRepeatingAxisValues(null)).toBe(true);
    });

    it('should return true by default when settings is undefined', () => {
      expect(getHideRepeatingAxisValues(undefined)).toBe(true);
    });

    it('should return false when setting is explicitly false', () => {
      const settings = { hideRepeatingAxisValues: false };
      expect(getHideRepeatingAxisValues(settings)).toBe(false);
    });

    it('should use getSettings method when available', () => {
      const settings = {
        getSettings(key) {
          if (key === 'pivotSettings') return { hideRepeatingAxisValues: false };
          return {};
        }
      };
      expect(getHideRepeatingAxisValues(settings)).toBe(false);
    });
  });

  describe('getMaxCellWidth', () => {
    it('should return 30 by default when settings is null', () => {
      expect(getMaxCellWidth(null)).toBe(30);
    });

    it('should return 30 by default when settings is undefined', () => {
      expect(getMaxCellWidth(undefined)).toBe(30);
    });

    it('should parse and return custom width from settings', () => {
      const settings = { maxCellWidth: '50' };
      expect(getMaxCellWidth(settings)).toBe(50);
    });

    it('should return default for zero width', () => {
      const settings = { maxCellWidth: '0' };
      expect(getMaxCellWidth(settings)).toBe(30);
    });

    it('should return default for negative width', () => {
      const settings = { maxCellWidth: '-5' };
      expect(getMaxCellWidth(settings)).toBe(30);
    });

    it('should return default for non-numeric width', () => {
      const settings = { maxCellWidth: 'abc' };
      expect(getMaxCellWidth(settings)).toBe(30);
    });

    it('should use getSettings method when available', () => {
      const settings = {
        getSettings(key) {
          if (key === 'pivotSettings') return { maxCellWidth: '100' };
          return {};
        }
      };
      expect(getMaxCellWidth(settings)).toBe(100);
    });
  });
});
