export class AppContext {

  #services = {};

  register(name, instance) {
    this.#services[name] = instance;
    return instance;
  }

  has(name) {
    return this.#services[name] !== undefined;
  }

  get(name) {
    const service = this.#services[name];
    if (service === undefined) {
      throw new Error(`Service "${name}" not registered`);
    }
    return service;
  }

  get settings() {
    return this.get('settings');
  }

  get queryModel() {
    return this.get('queryModel');
  }

  get datasourcesUi() {
    return this.get('datasourcesUi');
  }

  get uploadUi() {
    return this.get('uploadUi');
  }

  get attributeUi() {
    return this.get('attributeUi');
  }

  get filterUi() {
    return this.get('filterUi');
  }

  get filterDialog() {
    return this.get('filterUi');
  }

  get exportDialog() {
    return this.get('exportDialog');
  }

  get queryUi() {
    return this.get('queryUi');
  }

  get pivotTableUi() {
    return this.get('pivotTableUi');
  }

  get pageStateManager() {
    return this.get('pageStateManager');
  }

  get postMessageInterface() {
    return this.get('postMessageInterface');
  }
}

const globalScope = typeof window !== 'undefined' ? window : globalThis;

export const appContext = globalScope.appContext instanceof AppContext
  ? globalScope.appContext
  : new AppContext();

globalScope.appContext = appContext;
