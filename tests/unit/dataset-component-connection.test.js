import { describe, expect, test } from 'vitest';

import { DataSetComponent } from '../../src/DataSet/DataSetComponent.js';

describe('DataSetComponent datasource connection lifecycle', () => {
  test('refreshes cached managed connection after datasource changes', async () => {
    const datasource1 = {
      getManagedConnection: async () => 'connection-1',
    };
    const datasource2 = {
      getManagedConnection: async () => 'connection-2',
    };

    const queryModel = new EventTarget();
    queryModel.datasource = datasource1;
    queryModel.getDatasource = () => queryModel.datasource;

    const component = new DataSetComponent(queryModel, {});
    await expect(component.getManagedConnection()).resolves.toBe('connection-1');

    queryModel.datasource = datasource2;
    const event = new Event('change');
    event.eventData = {
      propertiesChanged: {
        datasource: {
          previousValue: datasource1,
          newValue: datasource2,
        }
      }
    };
    queryModel.dispatchEvent(event);

    await expect(component.getManagedConnection()).resolves.toBe('connection-2');
  });
});
