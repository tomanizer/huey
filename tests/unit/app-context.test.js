import { AppContext } from '../../src/App/AppContext.js';

describe('AppContext', () => {
  test('registers services and exposes convenience getters', () => {
    const context = new AppContext();
    const settings = { getSettings: () => ({}) };
    const queryModel = {};
    const filterDialog = {};

    context.register('settings', settings);
    context.register('queryModel', queryModel);
    context.register('filterUi', filterDialog);

    expect(context.settings).toBe(settings);
    expect(context.queryModel).toBe(queryModel);
    expect(context.filterUi).toBe(filterDialog);
    expect(context.filterDialog).toBe(filterDialog);
    expect(context.has('queryModel')).toBe(true);
  });

  test('throws when reading an unregistered service', () => {
    const context = new AppContext();

    expect(() => {
      return context.get('queryModel');
    }).toThrow('Service "queryModel" not registered');
  });
});
