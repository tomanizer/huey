const valueGetterRegistry = {
  splitCommaSeparatedValue(control) {
    if (!control.value) {
      return [];
    }
    return control.value.split(',');
  },
  parseJsonValue(control) {
    return JSON.parse(control.value);
  }
};

const valueSetterRegistry = {
  joinCommaSeparatedValue(control, value) {
    control.value = value.join();
  },
  stringifyJsonValue(control, value) {
    control.value = JSON.stringify(value);
  }
};

function getValueGetter(control) {
  const valueGetterName = control.getAttribute('data-value-getter');
  if (!valueGetterName){
    return;
  }
  const valueGetter = valueGetterRegistry[valueGetterName];
  if (!valueGetter){
    throw new Error(`Unknown value getter: ${valueGetterName}`);
  }
  return valueGetter;
}

function getValueSetter(control) {
  const valueSetterName = control.getAttribute('data-value-setter');
  if (!valueSetterName){
    return;
  }
  const valueSetter = valueSetterRegistry[valueSetterName];
  if (!valueSetter){
    throw new Error(`Unknown value setter: ${valueSetterName}`);
  }
  return valueSetter;
}

export {
  getValueGetter,
  getValueSetter,
  valueGetterRegistry,
  valueSetterRegistry
};
