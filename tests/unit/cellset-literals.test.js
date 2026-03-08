vi.mock('../../src/SettingsDialog/SettingsDialog.js');
vi.mock('../../src/ErrorDialog/ErrorDialog.js');

import { getTupleValueLiteral } from '../../src/DataSet/CellSet.js';

describe('CellSet tuple literal fallback', () => {
  test('quotes string tuple values when literalWriter is missing', () => {
    expect(getTupleValueLiteral({}, 'N')).toBe('\'N\'');
    expect(getTupleValueLiteral({}, 'Y')).toBe('\'Y\'');
    expect(getTupleValueLiteral({}, 'O\'Reilly')).toBe('\'O\'\'Reilly\'');
  });

  test('renders missing fallback values as SQL NULL', () => {
    expect(getTupleValueLiteral({}, null)).toBe('NULL');
    expect(getTupleValueLiteral({}, undefined)).toBe('NULL');
  });

  test('keeps numeric tuple values unquoted', () => {
    expect(getTupleValueLiteral({}, 7)).toBe('7');
    expect(getTupleValueLiteral({}, 3.14)).toBe('3.14');
  });

  test('uses literalWriter when provided', () => {
    const literalWriter = vi.fn(() => 'custom_literal');
    expect(getTupleValueLiteral({ literalWriter }, 'N')).toBe('custom_literal');
    expect(literalWriter).toHaveBeenCalledWith('N', undefined);
  });
});
