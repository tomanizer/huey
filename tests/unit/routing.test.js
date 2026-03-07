vi.mock('../../src/QueryModel/QueryModel.js', () => ({
  QueryModel: class QueryModel {
    constructor(state) {
      this._state = state;
    }

    getState() {
      return this._state;
    }
  },
}));

import { QueryModel } from '../../src/QueryModel/QueryModel.js';
import { Routing } from '../../src/Routing/Routing.js';

describe('Routing', () => {
  test('getRouteForQueryModel returns base64 encoded state', () => {
    const route = Routing.getRouteForQueryModel({
      datasourceId: 'ds1',
      axes: { rows: [] },
    });

    expect(typeof route).toBe('string');
    expect(route.length).toBeGreaterThan(0);

    const decoded = JSON.parse(decodeURIComponent(atob(route)));
    expect(decoded.queryModel.datasourceId).toBe('ds1');
  });

  test('getQueryModelStateFromRoute decodes route object', () => {
    const state = { queryModel: { datasourceId: 'ds2', axes: { columns: [] } } };
    const route = btoa(encodeURIComponent(JSON.stringify(state)));

    expect(Routing.getQueryModelStateFromRoute(route)).toEqual(state);
  });

  test('round-trip encode/decode returns original data with special chars', () => {
    const original = {
      datasourceId: 'remote-ä',
      filters: {
        text: 'A&B <C> "D"',
      },
    };

    const route = Routing.getRouteForQueryModel(original);
    const decoded = Routing.getQueryModelStateFromRoute(route);

    expect(decoded).toEqual({ queryModel: original });
  });

  test('invalid base64 route is handled gracefully', () => {
    expect(Routing.getQueryModelStateFromRoute('%%%not-base64%%%')).toBeNull();
  });

  test('empty state and null state are handled', () => {
    const fromInstance = Routing.getRouteForQueryModel(new QueryModel({}));
    expect(Routing.getQueryModelStateFromRoute(fromInstance)).toEqual({ queryModel: {} });

    expect(Routing.getRouteForQueryModel({})).toBeDefined();
    expect(Routing.getRouteForQueryModel({ queryModel: {} })).toBeDefined();
    expect(Routing.getRouteForQueryModel(null)).toBeUndefined();
  });

  test('oversized route state is not serialized into the hash', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const route = Routing.getRouteForQueryModel({
      datasourceId: 'ds1',
      axes: {
        rows: [{ columnName: 'x'.repeat(9000) }],
      },
    });

    expect(route).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
