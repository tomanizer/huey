vi.mock('../../src/SettingsDialog/SettingsDialog.js');

vi.mock('../../src/ErrorDialog/ErrorDialog.js');

import { QueryAxisItem } from '../../src/QueryModel/QueryModel.js';
import { QueryModel } from '../../src/QueryModel/QueryModel.js';
import { FilterDialog } from '../../src/FilterUi/FilterUi.js';

describe('QueryAxisItem.getSqlForQueryAxisItem', () => {
  test('simple column returns qualified identifier', () => {
    const sql = QueryAxisItem.getSqlForQueryAxisItem({
      columnName: 'city',
      columnType: 'VARCHAR',
    });
    expect(sql).toBe('city');
  });

  test('column with derivation wraps in expression', () => {
    const sql = QueryAxisItem.getSqlForQueryAxisItem(
      {
        columnName: 'order_date',
        columnType: 'DATE',
        derivation: 'year',
      },
      't'
    );
    expect(sql).toContain('YEAR( t.order_date )');
  });

  test('column with aggregator wraps in aggregation', () => {
    const sql = QueryAxisItem.getSqlForQueryAxisItem(
      {
        columnName: 'revenue',
        columnType: 'DOUBLE',
        aggregator: 'sum',
      },
      'f'
    );
    expect(sql).toContain('SUM');
    expect(sql).toContain('f.revenue');
  });

  test('column with both derivation and aggregation', () => {
    const sql = QueryAxisItem.getSqlForQueryAxisItem(
      {
        columnName: 'order_date',
        columnType: 'DATE',
        derivation: 'year',
        aggregator: 'count',
      },
      'fact'
    );
    expect(sql).toContain('COUNT');
    expect(sql).toContain('YEAR(');
  });

  test('getSqlForColumnExpression supports member expression paths', () => {
    const sql = QueryAxisItem.getSqlForColumnExpression(
      {
        columnName: 'payload',
        memberExpressionPath: ['items', 'unnest()'],
      },
      'src'
    );
    expect(sql).toContain("src.payload['items']");
    expect(sql).toContain('unnest(');
  });
});

describe('QueryAxisItem helpers', () => {
  test('createFormatter and createParser return functions for known derivations', () => {
    const formatter = QueryAxisItem.createFormatter({
      columnName: 'order_date',
      columnType: 'DATE',
      derivation: 'month name',
    });
    const parser = QueryAxisItem.createParser({
      columnName: 'order_date',
      columnType: 'DATE',
      derivation: 'month name',
    });
    expect(typeof formatter).toBe('function');
    expect(typeof parser).toBe('function');
  });

  test('createLiteralWriter and getLiteralWriter work for scalar types', () => {
    const item = {
      columnName: 'revenue',
      columnType: 'DOUBLE',
    };
    const literalWriter = QueryAxisItem.createLiteralWriter(item);
    expect(typeof literalWriter).toBe('function');
    const memoizedWriter = QueryAxisItem.getLiteralWriter({
      ...item,
      literalWriter,
    });
    expect(memoizedWriter).toBe(literalWriter);
  });

  test('createLiteralWriter returns null when result type is unknown', () => {
    const item = {
      columnName: 'tags',
      columnType: 'VARCHAR[]',
      aggregator: 'list',
    };
    expect(QueryAxisItem.createLiteralWriter(item)).toBeNull();
  });

  test('caption and id generation include derivation and filter labels', () => {
    const filterItem = {
      axis: QueryModel.AXIS_FILTERS,
      columnName: 'order_year',
      columnType: 'INTEGER',
      filter: {
        filterType: FilterDialog.filterTypes.INCLUDE,
        values: { y2024: { literal: '2024', label: '2024', enabled: true } },
      },
    };
    const caption = QueryAxisItem.getCaptionForQueryAxisItem(filterItem);
    const id = QueryAxisItem.getIdForQueryAxisItem(filterItem);
    expect(caption).toContain('year');
    expect(caption).toContain('in 2024');
    expect(id).toContain('AS');
  });

  test('filter effectiveness reflects configured values', () => {
    const none = QueryAxisItem.isFilterItemEffective({
      columnName: 'city',
      columnType: 'VARCHAR',
    });
    const effective = QueryAxisItem.isFilterItemEffective({
      columnName: 'city',
      columnType: 'VARCHAR',
      filter: {
        filterType: FilterDialog.filterTypes.INCLUDE,
        values: { ams: { literal: "'Amsterdam'", label: 'Amsterdam', enabled: true } },
      },
    });
    expect(none).toBeUndefined();
    expect(effective).toBe(true);
  });
});
