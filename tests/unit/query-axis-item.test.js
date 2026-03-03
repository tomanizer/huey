const { loadScripts } = require('./setup');

describe('QueryAxisItem.getSqlForQueryAxisItem', () => {
  let QueryAxisItem;

  beforeAll(() => {
    ({ QueryAxisItem } = loadScripts());
  });

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
});
