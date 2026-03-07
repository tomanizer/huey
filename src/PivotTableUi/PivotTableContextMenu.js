import { byId, hasClass } from '../util/dom/dom.js';
import { QueryModel, QueryAxisItem } from '../QueryModel/QueryModel.js';
import { FilterDialog } from '../FilterUi/FilterUi.js';
import { showErrorDialog } from '../ErrorDialog/ErrorDialog.js';
import { copyToClipboard } from '../util/clipboard/clipboard.js';
import { ExportUi } from '../ExportUi/ExportDialog.js';
import { DuckDbDataSource } from '../DataSource/duckdb/DuckDbDataSource.js';

export class PivotTableContextMenu {

  #pivotTableUi = undefined;
  #contextMenuContext = null;

  constructor(pivotTableUi) {
    this.#pivotTableUi = pivotTableUi;
  }

  beforeShowContextMenu(event, _contextMenu){
    const dom = this.#pivotTableUi.getDom();
    let cell = event.target;
    while (cell !== dom && cell && !hasClass(cell, 'pivotTableUiCell')){
      cell = cell.parentNode;
    }
    if (!cell || cell === dom) {
      return false;
    }
    this.#contextMenuContext = cell;
  }

  async contextMenuItemClicked(event){
    const id = event.target.id;
    if (id.slice('pivotTableContextMenuItem'.length).startsWith('Copy')){
      await this.#contextMenuCopyClicked(event);
    }
    else if (id.slice('pivotTableContextMenuItem'.length).startsWith('Filter')){
      await this.#contextMenuFilterClicked(event);
    }
  }

  async #contextMenuFilterClicked(event){
    const id = event.target.id;
    const contextMenuContext = this.#contextMenuContext;
    this.#contextMenuContext = null;
    const axis = contextMenuContext.getAttribute('data-axis');
    switch(axis){
      case QueryModel.AXIS_COLUMNS:
      case QueryModel.AXIS_ROWS:
        break;
      default:
        showErrorDialog({
          title: `Invalid axis: ${axis}`,
          description: `Can not filter on items from the "${axis}" axis.`
        });
        return;
    }

    let filterType = FilterDialog.equalityFilterTypes.INCLUDE;
    switch(id){
      case 'pivotTableContextMenuItemFilterExcludeValue':
        filterType = FilterDialog.equalityFilterTypes.EXCLUDE;
      case 'pivotTableContextMenuItemFilterIncludeValue':
        break;
      default:
        throw new Error(`Unrecognized context menu option "${id}"`);
    }

    const queryModel = this.#pivotTableUi.getQueryModel();
    const queryModelAxis = queryModel.getQueryAxis(axis);
    const axisItemIndex = contextMenuContext.getAttribute('data-axis-item-index');
    const queryModelItem = Object.assign({}, queryModelAxis.getItems()[parseInt(axisItemIndex, 10)]);
    const filterValue = contextMenuContext.textContent;
    const literal = contextMenuContext.getAttribute('data-value-literal');

    queryModelItem.axis = QueryModel.AXIS_FILTERS;
    let newFilter;
    const newFilterValues = {};
    const newFilterValueListValue = { value: filterValue, label: filterValue, literal: literal };
    let newFilterItem = queryModel.findItem(queryModelItem);
    if (newFilterItem){
      const oldFilter = newFilterItem.filter;
      const oldFilterValues = oldFilter ? oldFilter.values : undefined;
      const oldFilterValueEntry = oldFilterValues ? oldFilterValues[filterValue] : undefined;
      const oldFilterValueEntryDisabled = oldFilterValueEntry ? oldFilterValueEntry.enabled === false : false;
      const numOldFilterValues = oldFilterValues ? Object.keys(oldFilterValues).length : 0;

      switch(filterType){
        case FilterDialog.equalityFilterTypes.INCLUDE:
          newFilterValues[filterValue] = newFilterValueListValue;
          newFilter = { filterType: filterType, values: newFilterValues };
          break;
        case FilterDialog.equalityFilterTypes.EXCLUDE:
          switch (oldFilter.filterType){
            case FilterDialog.equalityFilterTypes.INCLUDE:
              if (numOldFilterValues === 0) {
                oldFilter.filterType = FilterDialog.equalityFilterTypes.EXCLUDE;
                newFilter = oldFilter;
              }
              else if (oldFilterValueEntry) {
                if (oldFilterValueEntryDisabled) {
                  throw new Error('Unexpected: old filter entry is disabled');
                }
                else if (numOldFilterValues === 1) {
                  oldFilter.filterType = FilterDialog.equalityFilterTypes.EXCLUDE;
                  newFilter = oldFilter;
                }
                else {
                  delete oldFilterValues[filterValue];
                  newFilter = oldFilter;
                }
              }
              else {
                throw new Error('Unexpected: old filter does not have an entry for the value');
              }
              break;
            case FilterDialog.equalityFilterTypes.EXCLUDE:
              if (oldFilterValueEntry) {
                if (oldFilterValueEntryDisabled){
                  delete oldFilterValueEntry.enabled;
                  newFilter = oldFilter;
                }
                else {
                  throw new Error('Unexpected: old filter entry is not disabled');
                }
              }
              else {
                oldFilterValues[filterValue] = newFilterValueListValue;
                newFilter = oldFilter;
              }
              break;
            case FilterDialog.simplePatternFilterTypes.LIKE:
            case FilterDialog.simplePatternFilterTypes.NOTLIKE:
            case FilterDialog.rangeFilterTypes.BETWEEN:
            case FilterDialog.rangeFilterTypes.NOTBETWEEN:
            case FilterDialog.arrayFilterTypes.HASANY:
            case FilterDialog.arrayFilterTypes.HASALL:
            case FilterDialog.arrayFilterTypes.NOTHASANY:
            case FilterDialog.arrayFilterTypes.NOTHASALL:
            default:
          }
          break;
        default:
      }
      queryModel.setQueryAxisItemFilter(newFilterItem, newFilter);
    }
    else {
      newFilterItem = queryModelItem;
      newFilterValues[filterValue] = newFilterValueListValue;
      newFilter = { filterType: filterType, values: newFilterValues };
      newFilterItem.filter = newFilter;
      queryModel.addItem(newFilterItem);
    }
  }

  async #contextMenuCopyClicked(event) {
    const id = event.target.id;
    const contextMenuContext = this.#contextMenuContext;
    this.#contextMenuContext = null;
    if (id === 'pivotTableContextMenuItemCopyCell'){
      copyToClipboard(contextMenuContext.textContent, 'text/plain');
      return;
    }

    const exportSettings = this.#pivotTableUi.getSettings().getSettings('exportUi');
    exportSettings.exportType = 'exportDelimited';
    exportSettings.exportDelimitedCompression = {value: 'UNCOMPRESSED'};
    exportSettings.exportResultShapePivot = !(exportSettings.exportResultShapeTable = true);
    exportSettings.exportDestinationClipboard = true;
    exportSettings.exportDestinationFile = false;

    let queryAxisItem, cellsAxisItem, filter, filterAxisItem, itemId;
    const queryModel = this.#pivotTableUi.getQueryModel();
    const datasource = queryModel.getDatasource();
    const cellHeadersAxis = queryModel.getCellHeadersAxis();
    const queryModelState = queryModel.getState();
    const queryModelAxes = queryModelState.axes;
    let filterAxisItems = queryModelAxes[QueryModel.AXIS_FILTERS];
    const cellsAxisItems = queryModelAxes[QueryModel.AXIS_CELLS];
    const rowsAxisItems = queryModelAxes[QueryModel.AXIS_ROWS];
    const columnsAxisItems = queryModelAxes[QueryModel.AXIS_COLUMNS];
    const tableHeaderRows = this.#pivotTableUi.getTableHeaderDom().childNodes;
    const tableBodyDom = this.#pivotTableUi.getTableBodyDom();

    let numRowHeaders = rowsAxisItems ? rowsAxisItems.length : 0;
    let numColumnHeaders = columnsAxisItems ? columnsAxisItems.length : 0;
    if (cellsAxisItems && cellsAxisItems.length) {
      switch (cellHeadersAxis){
        case QueryModel.AXIS_COLUMNS:
          numColumnHeaders += 1;
          break;
        case QueryModel.AXIS_ROWS:
          numRowHeaders += 1;
          break;
      }
    }

    const busyDialog = byId('visualizationProgressDialog');
    busyDialog.showModal();
    switch (id){
      case 'pivotTableContextMenuItemCopyColumnTuples':
        delete queryModelAxes[QueryModel.AXIS_ROWS];
        delete queryModelAxes[QueryModel.AXIS_CELLS];
        break;
      case 'pivotTableContextMenuItemCopyRowTuples':
        delete queryModelAxes[QueryModel.AXIS_COLUMNS];
        delete queryModelAxes[QueryModel.AXIS_CELLS];
        break;
      case 'pivotTableContextMenuItemCopyTable':
        exportSettings.exportResultShapePivot = !(exportSettings.exportResultShapeTable = false);
        break;
      case 'pivotTableContextMenuItemCopyColumn': {
        let columnIndex = 0;
        let cell = contextMenuContext;
        while (cell && cell.previousSibling) {
          columnIndex += 1;
          cell = cell.previousSibling;
        }

        if (columnIndex < rowsAxisItems.length) {
          delete queryModelAxes[QueryModel.AXIS_COLUMNS];
          delete queryModelAxes[QueryModel.AXIS_CELLS];
          queryAxisItem = rowsAxisItems[columnIndex];
          queryModelAxes[QueryModel.AXIS_ROWS].length = 0;
          queryModelAxes[QueryModel.AXIS_ROWS].push(queryAxisItem);
        }
        else if (columnIndex >= numRowHeaders) {
          exportSettings.exportResultShapePivot = !(exportSettings.exportResultShapeTable = false);
          if (!filterAxisItems){
            queryModelAxes[QueryModel.AXIS_FILTERS] = filterAxisItems = [];
          }

          for (let i = 0; i < tableHeaderRows.length; i++){
            const tableHeaderRow = tableHeaderRows.item(i);
            cell = tableHeaderRow.childNodes.item(columnIndex);
            if (i < columnsAxisItems.length){
              queryAxisItem = columnsAxisItems[i];
              itemId = QueryAxisItem.getIdForQueryAxisItem(queryAxisItem);
              filterAxisItem = filterAxisItems.find((candidate) => QueryAxisItem.getIdForQueryAxisItem(candidate) === itemId);
              if (filterAxisItem){
                filter = filterAxisItem.filter;
              }
              else {
                filterAxisItem = Object.assign({}, queryAxisItem);
                filter = filterAxisItem.filter = {};
                filterAxisItems.push(filterAxisItem);
              }
              filter.filterType = FilterDialog.filterTypes.INCLUDE;
              filter.values = {};
              filter.values[cell.textContent] = {
                value: cell.textContent,
                label: cell.textContent,
                literal: cell.getAttribute('data-value-literal')
              };
            }
            else if (cellHeadersAxis === QueryModel.AXIS_COLUMNS){
              itemId = cell.getAttribute('data-axis-item');
              cellsAxisItem = cellsAxisItems.find((candidate) => QueryAxisItem.getIdForQueryAxisItem(candidate) === itemId);
              cellsAxisItems.length = 0;
              cellsAxisItems.push(cellsAxisItem);
            }
          }
        }
        break;
      }
      case 'pivotTableContextMenuItemCopyRow': {
        let row = contextMenuContext.parentNode;
        let rowIndex = 0;
        while (row && row.previousSibling) {
          rowIndex += 1;
          row = row.previousSibling;
        }

        row = contextMenuContext.parentNode;
        if (row.parentNode === this.#pivotTableUi.getTableHeaderDom()) {
          if (rowIndex < columnsAxisItems.length){
            delete queryModelAxes[QueryModel.AXIS_ROWS];
            delete queryModelAxes[QueryModel.AXIS_CELLS];
            queryAxisItem = columnsAxisItems[rowIndex];
            queryModelAxes[QueryModel.AXIS_COLUMNS].length = 0;
            queryModelAxes[QueryModel.AXIS_COLUMNS].push(queryAxisItem);
          }
        }
        else if (row.parentNode === tableBodyDom){
          exportSettings.exportResultShapePivot = !(exportSettings.exportResultShapeTable = false);
          if (!filterAxisItems){
            queryModelAxes[QueryModel.AXIS_FILTERS] = filterAxisItems = [];
          }

          const cells = row.childNodes;
          for (let i = 0; i < numRowHeaders; i++){
            const cell = cells.item(i);
            if (i < rowsAxisItems.length){
              queryAxisItem = rowsAxisItems[i];
              itemId = QueryAxisItem.getIdForQueryAxisItem(queryAxisItem);
              filterAxisItem = filterAxisItems.find((candidate) => QueryAxisItem.getIdForQueryAxisItem(candidate) === itemId);
              if (filterAxisItem){
                filter = filterAxisItem.filter;
              }
              else {
                filterAxisItem = Object.assign({}, queryAxisItem);
                filter = filterAxisItem.filter = {};
                filterAxisItems.push(filterAxisItem);
              }
              filter.filterType = FilterDialog.filterTypes.INCLUDE;
              filter.values = {};
              filter.values[cell.textContent] = {
                value: cell.textContent,
                label: cell.textContent,
                literal: cell.getAttribute('data-value-literal')
              };
            }
            else if (cellHeadersAxis === QueryModel.AXIS_ROWS){
              itemId = cell.getAttribute('data-axis-item');
              cellsAxisItem = cellsAxisItems.find((candidate) => QueryAxisItem.getIdForQueryAxisItem(candidate) === itemId);
              cellsAxisItems.length = 0;
              cellsAxisItems.push(cellsAxisItem);
            }
          }
        }
        break;
      }
      default:
        throw new Error(`Unrecognized context menu option "${id}"`);
    }

    try {
      const exportQueryModel = new QueryModel();
      const datasourceId = queryModelState.datasourceId;
      const parts = DuckDbDataSource.parseId(datasourceId);
      if (parts.type === DuckDbDataSource.types.FILES){
        delete queryModelState.datasourceId;
        exportQueryModel.setDatasource(datasource);
      }
      await exportQueryModel.setState(queryModelState);
      await ExportUi.exportDataForQueryModel(exportQueryModel, exportSettings);
    }
    catch(error) {
      showErrorDialog(error);
    }
    busyDialog.close();
  }
}
