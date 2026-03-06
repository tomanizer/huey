import { byId } from '../util/dom/dom.js';
import { QueryAxisItem, QueryModel, queryModel } from '../QueryModel/QueryModel.js';
import { AttributeUi } from '../AttributeUi/AttributeUi.js';
import { pivotTableUi } from '../PivotTableUi/PivotTableUi.js';

export class QuickQueryMenu {
  
  #queryModel = undefined;
  
  constructor(queryModel){
    this.#queryModel = queryModel;
    
    this.#initFlipAxesButton();
    this.#initCellHeadersOnColumnsButton();
    this.#initCellHeadersOnRowsButton();
    this.#initClearAllButton();
    this.#initColumnStatisticsButton();
    this.#initDataPreviewButton();
    this.#initDestructuredDataPreviewButton();
  }
  
  async #forEachColumn(callback, callbackScope){
    if (!callbackScope) {
      callbackScope = this;
    }
    const queryModel = this.#queryModel;
    const datasource = queryModel.getDatasource();
    const columnsMetadata = await datasource.getColumnMetadata();
    
    const callbackResults = [];
    for (let i = 0; i < columnsMetadata.numRows; i++){
      const columnMetadata = columnsMetadata.get(i);
      callbackResults.push( callback.call(callbackScope, columnMetadata, i) );
    }
    
    return callbackResults;
  }
  
  #newQueryModelState(){
    const queryModel = this.#queryModel;
    const datasource = queryModel.getDatasource();
    const datasourceId = datasource.getId();
    
    return {
      datasourceId: datasourceId,
      cellsHeaders: QueryModel.AXIS_COLUMNS,
      axes: {}
    }
  }
    
  #initFlipAxesButton(){
    byId('quickQueryFlipAxesButton')
    .addEventListener('click', this.#flipAxesButtonClickHandler.bind(this));
  }
  
  #flipAxesButtonClickHandler(event){
    const queryModel = this.#queryModel;
    queryModel.flipAxes();
  }

  #initCellHeadersOnColumnsButton(){
    byId('quickQueryCellHeadersOnColumnsButton')
    .addEventListener('click', this.#cellHeadersOnColumnsButtonClickHandler.bind(this));
  }
  
  #cellHeadersOnColumnsButtonClickHandler(event){
    const queryModel = this.#queryModel;
    queryModel.setCellHeadersAxis(QueryModel.AXIS_COLUMNS);
  }

  #initCellHeadersOnRowsButton(){
    byId('quickQueryCellHeadersOnRowsButton')
    .addEventListener('click', this.#cellHeadersOnRowsButtonClickHandler.bind(this));
  }
  
  #cellHeadersOnRowsButtonClickHandler(event){
    const queryModel = this.#queryModel;
    queryModel.setCellHeadersAxis(QueryModel.AXIS_ROWS);
  }

  #initClearAllButton(){
    byId('quickQueryClearAllButton')
    .addEventListener('click', this.#clearAllButtonClickHandler.bind(this));
  }
  
  async #clearAllButtonClickHandler(event){
    const queryModelState = this.#newQueryModelState();
    const queryModel = this.#queryModel;
    await queryModel.setState(queryModelState);
    await pivotTableUi.updatePivotTableUi();
  }
  
  #initColumnStatisticsButton(){
    byId('quickQueryColumnStatisticsButton')
    .addEventListener('click', this.#columnStatisticsButtonClickHandler.bind(this));
  }
  
  async #columnStatisticsButtonClickHandler(event){
    const queryModelState = this.#newQueryModelState();
    queryModelState.cellsHeaders = QueryModel.AXIS_ROWS;
    const items = queryModelState.axes[QueryModel.AXIS_CELLS] = [];
    const aggregators = ['min', 'max', 'count', 'distinct count'];
    
    await this.#forEachColumn((columnMetadata,columnIndex) =>{
      const columnName = columnMetadata.column_name;
      const columnType = columnMetadata.column_type;
      for (let i = 0; i < aggregators.length; i++) {
        const aggregator = aggregators[i];
        const item = {
          column: columnName,
          columnType: columnType,
          aggregator: aggregator
        };
        items.push(item);
      }
    });

    const queryModel = this.#queryModel;
    await queryModel.setState(queryModelState);
    await pivotTableUi.updatePivotTableUi();
  }
  
  #initDataPreviewButton(){
    byId('quickQueryDataPreviewButton')
    .addEventListener('click', this.#dataPreviewButtonClickHandler.bind(this));
  }
  
  async #dataPreviewButtonClickHandler(event){
    const queryModelState = this.#newQueryModelState();
    
    const rowsAxisItems = queryModelState.axes[QueryModel.AXIS_ROWS] = [];
    rowsAxisItems.push({
      derivation: 'row number',
      caption: '#'
    });
    
    const cellsAxisItems = queryModelState.axes[QueryModel.AXIS_CELLS] = [];
    
    await this.#forEachColumn((columnMetadata,columnIndex) =>{
      const columnName = columnMetadata.column_name;
      const columnType = columnMetadata.column_type;
      const item = {
        column: columnName,
        columnType: columnType,
        caption: columnName,
        aggregator: 'min'
      };
      item.formatter = QueryAxisItem.createFormatter(item);
      item.literalWriter = QueryAxisItem.createLiteralWriter(item);
      item.parser = QueryAxisItem.createParser(item);
      cellsAxisItems.push(item);
    });
    
    const samplingConfig = {
      size: 100,
      unit: 'ROWS',
      method: 'LIMIT',
      seed: 100
    };
    queryModelState.sampling = {};
    queryModelState.sampling[QueryModel.AXIS_ROWS] = samplingConfig;
    queryModelState.sampling[QueryModel.AXIS_CELLS] = samplingConfig;

    const queryModel = this.#queryModel;
    await queryModel.setState(queryModelState);
    await pivotTableUi.updatePivotTableUi();
  }
  
  #initDestructuredDataPreviewButton(){
    const button = byId('quickQueryDestructuredDataPreviewButton');
    button.disabled = true;
    button.title = 'Coming soon';
  }

}

export let quickQueryMenu;
export function initQuickQueryMenu(){
  quickQueryMenu = new QuickQueryMenu(queryModel);
}
