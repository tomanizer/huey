import { getValueGetter, getValueSetter } from '../../src/SettingsDialog/valueGetterSetterRegistry.js';

describe('settings dialog value getter/setter registry', () => {
  test('resolves and executes registered locale getter/setter', () => {
    const control = {
      value: 'en-US,de-DE',
      getAttribute(name){
        if (name === 'data-value-getter') {
          return 'splitCommaSeparatedValue';
        }
        if (name === 'data-value-setter') {
          return 'joinCommaSeparatedValue';
        }
      }
    };

    const valueGetter = getValueGetter(control);
    expect(valueGetter(control)).toEqual(['en-US', 'de-DE']);

    const valueSetter = getValueSetter(control);
    valueSetter(control, ['fr-FR', 'nl-NL']);
    expect(control.value).toBe('fr-FR,nl-NL');
  });

  test('resolves and executes registered JSON getter/setter', () => {
    const control = {
      value: '{"theme":"Dark"}',
      getAttribute(name){
        if (name === 'data-value-getter') {
          return 'parseJsonValue';
        }
        if (name === 'data-value-setter') {
          return 'stringifyJsonValue';
        }
      }
    };

    const valueGetter = getValueGetter(control);
    expect(valueGetter(control)).toEqual({ theme: 'Dark' });

    const valueSetter = getValueSetter(control);
    valueSetter(control, { theme: 'Light' });
    expect(control.value).toBe('{"theme":"Light"}');
  });

  test('throws for unknown getter/setter names', () => {
    const getterControl = {
      getAttribute(name){
        if (name === 'data-value-getter') {
          return 'doesNotExist';
        }
      }
    };
    const setterControl = {
      getAttribute(name){
        if (name === 'data-value-setter') {
          return 'doesNotExist';
        }
      }
    };

    expect(() => getValueGetter(getterControl)).toThrow('Unknown value getter: doesNotExist');
    expect(() => getValueSetter(setterControl)).toThrow('Unknown value setter: doesNotExist');
  });
});
