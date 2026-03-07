export class DataSetComponent {

  #queryModel = undefined;
  #managedConnection = undefined;
  #settings = undefined;
  #queryModelChangeListener = undefined;
  
  constructor(queryModel, settings){
    this.#queryModel = queryModel;
    this.#settings = settings;
    if (queryModel && typeof queryModel.addEventListener === 'function') {
      this.#queryModelChangeListener = this.#handleQueryModelChange.bind(this);
      queryModel.addEventListener('change', this.#queryModelChangeListener);
    }
  }
  
  getSettings(){
    return this.#settings;
  }

  async #getDatasouceManagedConnection(){
    const queryModel = this.#queryModel;
    const datasource = queryModel.getDatasource();
    if (!datasource){
      return undefined;
    }
    const managedConnection = await datasource.getManagedConnection();
    return managedConnection;
  }
  
  getQueryModel(){
    return this.#queryModel;
  }

  #handleQueryModelChange(event) {
    const propertiesChanged = event?.eventData?.propertiesChanged;
    if (!propertiesChanged || !propertiesChanged.datasource) {
      return;
    }
    this.#managedConnection = undefined;
  }

  async getManagedConnection(){
    if (this.#managedConnection === undefined) {
      this.#managedConnection = await this.#getDatasouceManagedConnection();
    }
    return this.#managedConnection;
  }
  
  async cancelPendingQuery(){
    const connection = await this.getManagedConnection();
    return await connection.cancelPendingQuery();
  }  
}
