import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../../src/QueryModel/QueryModel.js');
  vi.doUnmock('../../src/DataSource/DataSourcesUi.js');
  vi.doUnmock('../../src/DataSource/duckdb/DuckDbDataSource.js');
  document.body.innerHTML = '';
});

describe('DataSourceMenu', () => {
  test('updates menu for compatible file datasource without unhandled rejection', async () => {
    const getReferencedColumns = vi.fn(() => ({}));
    vi.doMock('../../src/QueryModel/QueryModel.js', () => ({
      QueryModel: { getReferencedColumns },
      queryModel: {},
    }));
    vi.doMock('../../src/DataSource/DataSourcesUi.js', () => ({
      DataSourcesUi: class {
        static getCaptionForDatasource(datasource) {
          return `Datasource ${datasource.getId()}`;
        }
      },
      datasourcesUi: { addEventListener() {} },
    }));
    vi.doMock('../../src/DataSource/duckdb/DuckDbDataSource.js', () => ({
      DuckDbDataSource: {
        types: { FILE: 'FILE' },
        getFileNameParts(fileName) {
          return { lowerCaseExtension: fileName.split('.').pop().toLowerCase() };
        },
      },
    }));

    document.body.innerHTML = '<menu id="dataSourceMenu"></menu>';

    const currentDatasource = {
      getId: () => 'current',
    };
    const parquetDatasource = {
      getId: () => 'parquet-ds',
      getType: () => 'FILE',
      getFileName: () => '/data/parquet-folder/example.parquet',
    };

    class MockEventTarget extends EventTarget {
      addEventListener(...args) {
        super.addEventListener(...args);
      }
    }

    class MockDataSourcesUi extends MockEventTarget {
      async findDataSourcesWithColumns() {
        return {
          'parquet-ds': parquetDatasource,
        };
      }
    }

    const queryModel = new MockEventTarget();
    queryModel.getDatasource = () => currentDatasource;
    queryModel.getState = () => ({
      datasourceId: 'current',
    });
    queryModel.setDatasource = vi.fn();

    const datasourcesUi = new MockDataSourcesUi();
    const unhandledRejectionHandler = vi.fn();
    window.addEventListener('unhandledrejection', unhandledRejectionHandler);

    const { DataSourceMenu } = await import('../../src/DataSourceMenu/DataSourceMenu.js');
    new DataSourceMenu('dataSourceMenu', queryModel, datasourcesUi);

    datasourcesUi.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    const menuItems = document.querySelectorAll('#dataSourceMenu li[data-nodetype="datasource"]');
    expect(menuItems.length).toBe(1);
    expect(menuItems.item(0).getAttribute('data-filetype')).toBe('parquet');
    expect(unhandledRejectionHandler).not.toHaveBeenCalled();

    window.removeEventListener('unhandledrejection', unhandledRejectionHandler);
  });
});
