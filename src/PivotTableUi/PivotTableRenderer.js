import { getChildWithClassName, createEl } from '../util/dom/dom.js';
import { TupleSet } from '../DataSet/TupleSet.js';
import { CellSet } from '../DataSet/CellSet.js';
import { QueryModel, QueryAxisItem } from '../QueryModel/QueryModel.js';
import { AttributeUi } from '../AttributeUi/AttributeUi.js';
import { getDuckDbLiteralForValue, quoteStringLiteral } from '../util/sql/SQLHelper.js';
import { getTotalsItemsIndices, isTotalsMember } from './PivotTableUiUtils.js';

export class PivotTableRenderer {

  #pivotTableUi = undefined;

  constructor(pivotTableUi){
    this.#pivotTableUi = pivotTableUi;
  }

  #getMaximumCellWidth(){
    return this.#pivotTableUi.getMaxCellWidthLimit();
  }

  getTupleGroupingId(tuple){
    return tuple ? tuple[TupleSet.groupingIdAlias] : undefined;
  }

  setCellItemId(cellElement, queryAxisItem, queryAxisItemIndex){
    if (!queryAxisItem){
      return;
    }
    cellElement.setAttribute('data-axis', queryAxisItem.axis);
    const itemId = QueryAxisItem.getIdForQueryAxisItem(queryAxisItem);
    cellElement.setAttribute('data-axis-item', itemId);
    cellElement.setAttribute('data-axis-item-index', queryAxisItemIndex);
  }

  setCellValueLiteral(cellElement, queryAxisItem, tupleValue, tupleValueField){
    if (!queryAxisItem){
      console.warn('No query axis item!');
      return;
    }

    if (!tupleValue && !tupleValueField) {
      console.warn('No tuple value and no tuple value field.');
      return;
    }

    if (!tupleValueField?.type || tupleValueField.type.typeId === null) {
      const safeLiteral = tupleValue === null ? 'NULL' : (typeof tupleValue === 'string' ? quoteStringLiteral(tupleValue) : String(tupleValue));
      cellElement.setAttribute('data-value-literal', safeLiteral);
      cellElement.setAttribute('data-value-type', queryAxisItem.columnType || 'VARCHAR');
      cellElement.setAttribute('data-axis', queryAxisItem.axis);
      cellElement.setAttribute('data-axis-item', QueryAxisItem.getIdForQueryAxisItem(queryAxisItem));
      return;
    }

    switch (tupleValueField.type.typeId){
      case 12:
        if (tupleValue !== null){
          console.warn('Tuple value is a variable length list. Refuse to write out its literal value.');
        }
        return;
      default:
    }

    cellElement.setAttribute('data-axis', queryAxisItem.axis);
    const itemId = QueryAxisItem.getIdForQueryAxisItem(queryAxisItem);
    cellElement.setAttribute('data-axis-item', itemId);

    let valueLiteral;
    const literalWriter = queryAxisItem.literalWriter;
    if (literalWriter){
      valueLiteral = literalWriter(tupleValue, tupleValueField);
    }
    else {
      valueLiteral = getDuckDbLiteralForValue(tupleValue, tupleValueField.type);
    }
    cellElement.setAttribute('data-value-literal', valueLiteral);

    let cellValueType = String(tupleValueField.type);
    if (queryAxisItem.derivation) {
      const derivationInfo = AttributeUi.getDerivationInfo(queryAxisItem.derivation);
      if (derivationInfo.dataValueTypeOverride) {
        cellValueType = derivationInfo.dataValueTypeOverride;
      }
    }
    cellElement.setAttribute('data-value-type', cellValueType);
  }

  renderCellValue(cell, cellsAxisItem, cellElement){
    const label = getChildWithClassName(cellElement, 'pivotTableUiCellLabel');
    if (!cell || !cellsAxisItem){
      label.title = '';
      return label.textContant = '';
    }

    const values = cell.values;
    const sqlExpression = QueryAxisItem.getSqlForQueryAxisItem(cellsAxisItem, CellSet.datasetRelationName);
    const value = values[sqlExpression];

    const cellValueFields = this.#pivotTableUi.getCellSet().getCellValueFields();
    const cellValueField = cellValueFields[sqlExpression];
    this.setCellValueLiteral(cellElement, cellsAxisItem, value, cellValueField);

    let labelText;
    const formatter = cellsAxisItem.formatter;
    if (formatter) {
      labelText = formatter(value, cellValueField);
    }
    else if (value === null){
      labelText = '';
    }
    else {
      labelText = String(value);
    }
    label.textContent = labelText;

    const caption = QueryAxisItem.getCaptionForQueryAxisItem(cellsAxisItem);
    label.title = `${caption}: ${labelText}`;
    return labelText;
  }

  renderHeader() {
    const tableHeaderDom = this.#pivotTableUi.getTableHeaderDom();
    const tableBodyDom = this.#pivotTableUi.getTableBodyDom();
    const queryModel = this.#pivotTableUi.getQueryModel();
    const cellHeadersAxis = queryModel.getCellHeadersAxis();
    const rowsAxisItems = queryModel.getRowsAxis().getItems();
    const columnsAxisItems = queryModel.getColumnsAxis().getItems();
    const cellsAxisItems = queryModel.getCellsAxis().getItems();

    let numColumnAxisRows = columnsAxisItems.length;
    if (cellHeadersAxis === QueryModel.AXIS_COLUMNS && cellsAxisItems.length || rowsAxisItems.length && columnsAxisItems.length && !cellsAxisItems.length) {
      numColumnAxisRows += 1;
    }
    if (numColumnAxisRows === 0) {
      numColumnAxisRows = 1;
    }

    let numRowAxisColumns = rowsAxisItems.length;
    if (cellHeadersAxis === QueryModel.AXIS_ROWS && (columnsAxisItems.length || cellsAxisItems.length)) {
      numRowAxisColumns += 1;
    }
    if (numRowAxisColumns === 0) {
      numRowAxisColumns = 1;
    }

    let firstTableHeaderRow;
    for (let i = 0; i < numColumnAxisRows; i++){
      const tableRow = createEl('div', { 'class': 'pivotTableUiRow', 'role': 'row' });
      tableHeaderDom.appendChild(tableRow);

      let tableCell;
      let labelText;
      let label;
      let columnWidth;
      for (let j = 0; j < numRowAxisColumns; j++) {
        tableCell = createEl('div', { 'class': 'pivotTableUiCell pivotTableUiHeaderCell', 'role': 'columnheader' });
        tableRow.appendChild(tableCell);

        if (i === (numColumnAxisRows - 1)) {
          if (j < rowsAxisItems.length){
            tableCell.className += ' pivotTableUiRowsAxisHeaderCell';
            const rowsAxisItem = rowsAxisItems[j];
            this.setCellItemId(tableCell, rowsAxisItem, j);
            labelText = QueryAxisItem.getCaptionForQueryAxisItem(rowsAxisItem);
            columnWidth = Math.min(labelText.length + 2, this.#getMaximumCellWidth()) + 'ch';
            label = createEl('span', { 'class': 'pivotTableUiCellLabel pivotTableUiAxisHeaderLabel' });
            label.title = labelText;
            label.textContent = labelText;
            tableCell.appendChild(label);
          }
          else if (cellHeadersAxis === QueryModel.AXIS_ROWS) {
            columnWidth = rowsAxisItems.reduce((acc, curr) =>{
              const itemWidth = QueryAxisItem.getCaptionForQueryAxisItem(curr).length;
              return itemWidth > acc ? itemWidth : acc;
            }, 0);
            columnWidth = Math.min(columnWidth + 1, this.#getMaximumCellWidth()) + 'ch';
          }

          firstTableHeaderRow = tableHeaderDom.childNodes.item(0);
          const firstTableHeaderRowCell = firstTableHeaderRow.childNodes.item(j);
          firstTableHeaderRowCell.style.width = columnWidth;
        }
      }

      if (i < columnsAxisItems.length) {
        tableCell.className += ' pivotTableUiColumnsAxisHeaderCell';
        const columnsAxisItem = columnsAxisItems[i];
        this.setCellItemId(tableCell, columnsAxisItem, i);
        labelText = QueryAxisItem.getCaptionForQueryAxisItem(columnsAxisItem);
        label = createEl('span', { 'class': 'pivotTableUiCellLabel pivotTableUiAxisHeaderLabel' });
        label.title = labelText;
        label.textContent = labelText;
        tableCell.style.width = Math.min(labelText.length + 1, this.#getMaximumCellWidth()) + 'ch';
        tableCell.appendChild(label);
      }
    }

    firstTableHeaderRow = tableHeaderDom.childNodes.item(0);
    firstTableHeaderRow.appendChild(createEl('div', {
      'class': 'pivotTableUiCell pivotTableUiHeaderCell pivotTableUiStufferCell',
      'role': 'presentation'
    }));

    const stufferRow = createEl('div', { 'class': 'pivotTableUiRow', 'role': 'row' });
    tableBodyDom.appendChild(stufferRow);
    stufferRow.appendChild(createEl('div', {
      'class': 'pivotTableUiCell pivotTableUiHeaderCell pivotTableUiStufferCell',
      'role': 'presentation'
    }));
  }

  renderColumns(tuples){
    const innerContainerWidth = this.#pivotTableUi.getInnerContainerDom().clientWidth;
    const tableDom = this.#pivotTableUi.getTableDom();
    const queryModel = this.#pivotTableUi.getQueryModel();
    const queryAxisItems = queryModel.getColumnsAxis().getItems();
    const totalsItemsIndices = getTotalsItemsIndices(queryAxisItems);
    const tupleValueFields = this.#pivotTableUi.getColumnsTupleSet().getTupleValueFields();
    const cellItems = queryModel.getCellsAxis().getItems();
    const renderCellHeaders = queryModel.getCellHeadersAxis() === QueryModel.AXIS_COLUMNS;
    let numCellHeaders = renderCellHeaders ? cellItems.length || 1 : 1;
    const numTuples = tuples.length;
    let numColumns = numTuples;
    if (numColumns === 0 && cellItems.length) {
      numColumns = 1;
    }

    const tableHeaderDom = this.#pivotTableUi.getTableHeaderDom();
    const headerRows = tableHeaderDom.childNodes;
    const firstHeaderRow = headerRows.item(0);
    if (!firstHeaderRow) {
      return;
    }

    const stufferCell = firstHeaderRow.childNodes.item(firstHeaderRow.childNodes.length - 1);
    for (let i = 0; i < numColumns; i++){
      const tuple = i < numTuples ? tuples[i] : undefined;
      const values = tuple ? tuple.values : undefined;
      const groupingId = tuple ? tuple[TupleSet.groupingIdAlias] : undefined;
      let valuesMaxWidth = 0;
      let columnWidth = 0;

      for (let k = 0; k < numCellHeaders; k++){
        for (let j = 0; j < headerRows.length; j++){
          const queryAxisItem = queryAxisItems[j];
          const totalsIndex = isTotalsMember(groupingId, totalsItemsIndices, queryAxisItem ? j : undefined);
          const headerRow = headerRows.item(j);
          const cell = createEl('div', {
            'class': 'pivotTableUiCell pivotTableUiHeaderCell',
            'role': 'columnheader',
            'data-totals': groupingId > 0
          });
          this.setCellItemId(cell, queryAxisItem, j);
          if (j >= queryAxisItems.length && renderCellHeaders) {
            cell.className += ' pivotTableUiCellAxisHeaderCell';
            cell.setAttribute('data-axis', QueryModel.AXIS_CELLS);
          }

          let labelText;
          if (totalsIndex > j){
            if (values && j < values.length) {
              if (k === 0) {
                const value = values[j];
                const tupleValueField = tupleValueFields[j];
                labelText = queryAxisItem.formatter ? queryAxisItem.formatter(value, tupleValueField) : String(value);
                this.setCellValueLiteral(cell, queryAxisItem, value, tupleValueField);
              }
              else {
                labelText = String.fromCharCode(160);
              }
              if (labelText.length > valuesMaxWidth){
                valuesMaxWidth = labelText.length;
                columnWidth = valuesMaxWidth;
              }
            }
            else if (renderCellHeaders && k < cellItems.length) {
              const cellItem = cellItems[k];
              labelText = QueryAxisItem.getCaptionForQueryAxisItem(cellItem);
              columnWidth = labelText.length > valuesMaxWidth ? labelText.length : valuesMaxWidth;
              this.setCellItemId(cell, cellItem, k);
            }
          }
          else if (totalsIndex === j) {
            labelText = this.#pivotTableUi.getTotalsString(queryAxisItem);
          }
          if (labelText === undefined) {
            labelText = String.fromCharCode(160);
          }

          const label = createEl('span', { 'class': 'pivotTableUiCellLabel' });
          label.title = labelText;
          label.textContent = labelText;
          cell.appendChild(label);
          if (j === 0){
            headerRow.insertBefore(cell, stufferCell);
          }
          else {
            headerRow.appendChild(cell);
          }

          if (j === headerRows.length - 1) {
            columnWidth = Math.min(columnWidth + 1, this.#getMaximumCellWidth());
            stufferCell.previousSibling.style.width = columnWidth + 'ch';
          }
        }

        if (tableDom.clientWidth > innerContainerWidth) {
          return;
        }
      }
    }
  }

  removeExcessColumns(){
    const tableHeaderDom = this.#pivotTableUi.getTableHeaderDom();
    const headerRows = tableHeaderDom.childNodes;
    const firstHeaderRow = headerRows.item(0);
    if (!firstHeaderRow) {
      return;
    }

    const innerContainerWidth = this.#pivotTableUi.getInnerContainerDom().clientWidth;
    const tableDom = this.#pivotTableUi.getTableDom();
    if (innerContainerWidth <= 0) {
      return;
    }

    const firstHeaderRowCells = firstHeaderRow.childNodes;
    const lastHeaderRowIndex = headerRows.length - 1;
    while (tableDom.clientWidth > innerContainerWidth) {
      for (let j = lastHeaderRowIndex; j >= 0; j--){
        const headerRow = headerRows.item(j);
        const lastCellIndex = firstHeaderRowCells.length - 2;
        if (lastCellIndex < 0 || lastCellIndex >= headerRow.childNodes.length) {
          return;
        }
        const lastCell = headerRow.childNodes.item(lastCellIndex);
        if (j === lastHeaderRowIndex && (tableDom.clientWidth - lastCell.clientWidth) < innerContainerWidth) {
          return;
        }
        headerRow.removeChild(lastCell);
      }
    }
  }

  removeExcessRows(){
    const innerContainerHeight = this.#pivotTableUi.getInnerContainerDom().clientHeight;
    const tableDom = this.#pivotTableUi.getTableDom();
    if (innerContainerHeight <= 0) {
      return;
    }

    const tableBodyDom = this.#pivotTableUi.getTableBodyDom();
    while (tableDom.clientHeight > innerContainerHeight && tableBodyDom.childNodes.length > 1) {
      tableBodyDom.removeChild(tableBodyDom.childNodes[tableBodyDom.childNodes.length - 2]);
    }
  }

  renderRows(tuples){
    const innerContainerHeight = this.#pivotTableUi.getInnerContainerDom().clientHeight;
    const tableDom = this.#pivotTableUi.getTableDom();
    const queryModel = this.#pivotTableUi.getQueryModel();
    const rowAxisItems = queryModel.getRowsAxis().getItems();
    let numColumns = rowAxisItems.length;
    const tupleValueFields = this.#pivotTableUi.getRowsTupleSet().getTupleValueFields();
    const renderCellHeaders = queryModel.getCellHeadersAxis() === QueryModel.AXIS_ROWS;
    const cellAxisItems = queryModel.getCellsAxis().getItems();
    let numCellHeaders = 1;
    let numRows = tuples.length;

    if (renderCellHeaders) {
      numCellHeaders = cellAxisItems.length || 1;
      if (cellAxisItems.length === 0 && queryModel.getColumnsAxis().getItems().length) {
        numColumns += 1;
      }
      else if (cellAxisItems.length) {
        numColumns += 1;
      }
    }
    else if (numColumns === 0) {
      numColumns = 1;
    }

    if (numRows === 0 && cellAxisItems.length) {
      numRows = 1;
    }

    const tableHeaderDom = this.#pivotTableUi.getTableHeaderDom();
    const firstTableHeaderRow = tableHeaderDom.childNodes.item(0);
    if (!firstTableHeaderRow){
      return;
    }

    const tableBodyDom = this.#pivotTableUi.getTableBodyDom();
    const stufferRow = tableBodyDom.childNodes.item(0);
    for (let i = 0; i < numRows; i++){
      const tuple = tuples[i];
      const groupingId = tuple ? tuple[TupleSet.groupingIdAlias] : undefined;
      for (let k = 0; k < numCellHeaders; k++){
        const bodyRow = createEl('div', {
          'class': 'pivotTableUiRow',
          'role': 'row',
          'data-totals': groupingId > 0
        });
        tableBodyDom.insertBefore(bodyRow, stufferRow);

        for (let j = 0; j < numColumns; j++){
          const cell = createEl('div', { 'class': 'pivotTableUiCell pivotTableUiHeaderCell', 'role': 'rowheader' });
          const headerCell = firstTableHeaderRow.childNodes[bodyRow.childNodes.length];
          let headerCellWidth = parseInt(headerCell.style.width, 10);
          bodyRow.appendChild(cell);

          let labelText;
          if (j < rowAxisItems.length) {
            if (k === 0 && tuple) {
              const value = tuple.values[j];
              const rowAxisItem = rowAxisItems[j];
              this.setCellItemId(cell, rowAxisItem, j);
              const tupleValueField = tupleValueFields[j];
              labelText = rowAxisItem.formatter ? rowAxisItem.formatter(value, tupleValueField) : String(value);
              this.setCellValueLiteral(cell, rowAxisItem, value, tupleValueField);
            }
          }
          else {
            cell.className += ' pivotTableUiCellAxisHeaderCell';
            if (k < cellAxisItems.length && renderCellHeaders) {
              const cellsAxisItem = cellAxisItems[k];
              labelText = QueryAxisItem.getCaptionForQueryAxisItem(cellsAxisItem);
              this.setCellItemId(cell, cellsAxisItem, k);
            }
          }

          if (!labelText || !labelText.length) {
            labelText = String.fromCharCode(160);
          }
          const label = createEl('span', { 'class': 'pivotTableUiCellLabel' });
          label.title = labelText;
          label.textContent = labelText;
          cell.appendChild(label);

          if (headerCellWidth < labelText.length){
            headerCellWidth = Math.min(labelText.length + 1, this.#getMaximumCellWidth());
            headerCell.style.width = headerCellWidth + 'ch';
            cell.style.width = headerCellWidth + 'ch';
          }
        }

        if (tableDom.clientHeight > innerContainerHeight) {
          return;
        }
      }
    }
  }

  renderCells(){
    const columnAxisSizeInfo = this.#pivotTableUi.getScroller().getColumnsAxisSizeInfo();
    if (!columnAxisSizeInfo) {
      return;
    }

    const columnOffset = columnAxisSizeInfo.headers.columnCount;
    const columnCount = columnAxisSizeInfo.headers.columnCount + columnAxisSizeInfo.columns.columnCount;
    const tableBodyRows = this.#pivotTableUi.getTableBodyDom().childNodes;
    for (let i = 0; i < tableBodyRows.length - 1; i++){
      const bodyRow = tableBodyRows.item(i);
      for (let j = columnOffset; j < columnCount; j++){
        const cell = createEl('div', {
          'class': 'pivotTableUiCell pivotTableUiValueCell',
          'role': 'gridcell',
          'data-axis': QueryModel.AXIS_CELLS
        });
        bodyRow.appendChild(cell);
        cell.appendChild(createEl('span', { 'class': 'pivotTableUiCellLabel' }, ''));
      }
    }
  }
}
