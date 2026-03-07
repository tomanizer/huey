import { bufferEvents } from '../util/event/EventBuffer.js';
import { getChildWithClassName } from '../util/dom/dom.js';
import { TupleSet } from '../DataSet/TupleSet.js';
import { QueryModel, QueryAxisItem } from '../QueryModel/QueryModel.js';
import { getTotalsItemsIndices, isTotalsMember } from './PivotTableUiUtils.js';

export class PivotTableScroller {

  #pivotTableUi = undefined;
  #scrollTimeout = 500;

  constructor(pivotTableUi, config = {}) {
    this.#pivotTableUi = pivotTableUi;
    this.#scrollTimeout = config.scrollTimeout ?? this.#scrollTimeout;
    this.initScrollHandler();
  }

  initScrollHandler(){
    bufferEvents(
      this.#pivotTableUi.getInnerContainerDom(),
      'scroll',
      this.handleInnerContainerScrolled,
      this,
      this.#scrollTimeout
    );
  }

  async handleInnerContainerScrolled(_event, count){
    if (count !== undefined) {
      return count === 0 ? undefined : undefined;
    }
    if (this.#pivotTableUi.hasPendingModelChange() || this.#pivotTableUi.getBusy()) {
      return;
    }
    try {
      this.#pivotTableUi.setBusy(true);
      await this.updateDataToScrollPosition();
      this.#pivotTableUi.fireUpdatedSuccess();
    }
    catch(error){
      console.error(error);
      this.#pivotTableUi.fireEvent('updated', { status: 'error', error: error });
    }
    finally {
      setTimeout(() => this.#pivotTableUi.setBusy(false), 1);
    }
  }

  getPhysicalTupleIndices(){
    const innerContainer = this.#pivotTableUi.getInnerContainerDom();
    const columnsAxisSizeInfo = this.getColumnsAxisSizeInfo();
    const headersWidth = columnsAxisSizeInfo ? columnsAxisSizeInfo.headers.width : 0;
    const horizontalDenominator = innerContainer.scrollWidth - headersWidth;
    const horizontalFraction = horizontalDenominator <= 0 ? 0 : innerContainer.scrollLeft / horizontalDenominator;
    const physicalColumnsAxisTupleIndex = Math.ceil(this.getNumberOfPhysicalTuplesForAxis(QueryModel.AXIS_COLUMNS) * horizontalFraction);

    const rowsAxisSizeInfo = this.getRowsAxisSizeInfo();
    const headersHeight = rowsAxisSizeInfo.headers.height;
    const verticalDenominator = innerContainer.scrollHeight - headersHeight;
    const verticalFraction = verticalDenominator <= 0 ? 0 : innerContainer.scrollTop / verticalDenominator;
    const physicalRowsAxisTupleIndex = Math.ceil(this.getNumberOfPhysicalTuplesForAxis(QueryModel.AXIS_ROWS) * verticalFraction);

    return {
      columnsAxisSizeInfo,
      physicalColumnsAxisTupleIndex,
      rowsAxisSizeInfo,
      physicalRowsAxisTupleIndex,
    };
  }

  async updateDataToScrollPosition(){
    const physicalTupleIndices = this.getPhysicalTupleIndices();
    let physicalColumnsAxisTupleIndex = physicalTupleIndices.physicalColumnsAxisTupleIndex;
    const tupleIndexInfo = this.getTupleIndexForPhysicalIndex(QueryModel.AXIS_COLUMNS, physicalColumnsAxisTupleIndex);
    const columnsAxisSizeInfo = this.getColumnsAxisSizeInfo();
    if (!columnsAxisSizeInfo){
      return;
    }

    const count = columnsAxisSizeInfo.columns ? columnsAxisSizeInfo.columns.columnCount : 0;
    let tupleCount = Math.ceil(count / tupleIndexInfo.factor);
    if (tupleIndexInfo.cellsAxisItemIndex) {
      tupleCount += 1;
    }
    const allTupleCount = this.#pivotTableUi.getColumnsTupleSet().getTupleCountSync();
    if (tupleIndexInfo.tupleIndex + tupleCount >= allTupleCount) {
      const maxPhysicalColumn = allTupleCount * tupleIndexInfo.factor;
      physicalColumnsAxisTupleIndex = maxPhysicalColumn - count;
    }

    const physicalRowsAxisTupleIndex = physicalTupleIndices.physicalRowsAxisTupleIndex;
    await Promise.all([
      this.updateColumnsAxisTupleData(physicalColumnsAxisTupleIndex),
      this.updateRowsAxisTupleData(physicalRowsAxisTupleIndex),
    ]);
    await this.updateCellData(physicalColumnsAxisTupleIndex, physicalRowsAxisTupleIndex);
  }

  getTupleIndexForPhysicalIndex(axisId, physicalIndex){
    const queryModel = this.#pivotTableUi.getQueryModel();
    let factor = 1;
    if (queryModel.getCellHeadersAxis() === axisId) {
      const numCellsAxisItems = queryModel.getCellsAxis().getItems().length;
      factor = numCellsAxisItems === 0 ? 1 : numCellsAxisItems;
    }
    const fractionalIndex = physicalIndex / factor;
    const tupleIndex = Math.floor(fractionalIndex);
    const fraction = fractionalIndex - tupleIndex;
    return {
      physicalIndex,
      axisId,
      factor,
      tupleIndex,
      cellsAxisItemIndex: Math.round(fraction * factor)
    };
  }

  async updateColumnsAxisTupleData(physicalColumnsAxisTupleIndex){
    if (isNaN(physicalColumnsAxisTupleIndex)) {
      return;
    }

    let repeatingValuesIndex;
    const hideRepeatingAxisValues = this.#pivotTableUi.getHideRepeatingAxisValues();
    const dittoMark = hideRepeatingAxisValues ? this.#pivotTableUi.getDittoMark() : '';
    const tupleIndexInfo = this.getTupleIndexForPhysicalIndex(QueryModel.AXIS_COLUMNS, physicalColumnsAxisTupleIndex);
    const columnsAxisSizeInfo = this.getColumnsAxisSizeInfo();
    const count = columnsAxisSizeInfo.columns.columnCount;
    const maxColumnIndex = columnsAxisSizeInfo.headers.columnCount + count;
    let tupleCount = Math.ceil(count / tupleIndexInfo.factor);
    if (tupleIndexInfo.cellsAxisItemIndex) {
      tupleCount += 1;
    }

    const tupleSet = this.#pivotTableUi.getColumnsTupleSet();
    const lastTupleIndex = tupleSet.getTupleCountSync() - 1;
    const queryModel = this.#pivotTableUi.getQueryModel();
    const queryAxisItems = queryModel.getColumnsAxis().getItems();
    const totalsItemsIndices = getTotalsItemsIndices(queryAxisItems);
    const tupleValueFields = tupleSet.getTupleValueFields();
    const tuples = await tupleSet.getTuples(tupleCount, tupleIndexInfo.tupleIndex);

    const cellHeadersAxis = queryModel.getCellHeadersAxis();
    let cellsAxisItems = [];
    let doCellHeaders = cellHeadersAxis === QueryModel.AXIS_COLUMNS;
    if (doCellHeaders) {
      cellsAxisItems = queryModel.getCellsAxis().getItems();
      if (cellsAxisItems.length === 0){
        doCellHeaders = false;
      }
    }

    let tupleIndex = 0;
    let cellsAxisItemIndex = tupleIndexInfo.cellsAxisItemIndex;
    const rows = this.#pivotTableUi.getTableHeaderDom().childNodes;
    const columnsOffset = columnsAxisSizeInfo.headers.columnCount;
    const renderer = this.#pivotTableUi.getRenderer();
    for (let i = columnsOffset; i < maxColumnIndex; i++){
      const tuple = tuples[tupleIndex];
      const prevTuple = tuples[tupleIndex - 1];
      repeatingValuesIndex = undefined;
      const groupingId = renderer.getTupleGroupingId(tuple);

      for (let j = 0; j < rows.length; j++){
        const queryAxisItem = queryAxisItems[j];
        const cell = rows.item(j).childNodes.item(i);
        cell.setAttribute('data-column-index', tupleIndex);
        cell.setAttribute('data-column-tuple-index', tupleIndexInfo.tupleIndex + tupleIndex);
        cell.setAttribute('data-is-last-column-tuple', (tupleIndexInfo.tupleIndex + tupleIndex) === lastTupleIndex);
        const label = getChildWithClassName(cell, 'pivotTableUiCellLabel');
        const totalsIndex = isTotalsMember(groupingId, totalsItemsIndices, queryAxisItem ? j : rows.length - 1);
        cell.setAttribute('data-totals', totalsIndex <= j);
        cell.setAttribute('data-totals-origin', totalsIndex === j);
        if (doCellHeaders){
          cell.setAttribute('data-cells-axis-item-index', cellsAxisItemIndex);
        }

        let labelText;
        let titleText;
        if (tuple && j < tuple.values.length){
          const tupleValue = tuple.values[j];
          const tupleValueField = tupleValueFields[j];
          if (hideRepeatingAxisValues && prevTuple && (repeatingValuesIndex === undefined || repeatingValuesIndex === j - 1)){
            const prevTupleValue = prevTuple.values[j];
            if (tupleValue !== null && tupleValue === prevTupleValue || tupleValue === null && prevTupleValue === null && totalsIndex === isTotalsMember(renderer.getTupleGroupingId(prevTupleValue), totalsItemsIndices, queryAxisItem ? j : rows.length - 1)) {
              repeatingValuesIndex = j;
            }
            else if (repeatingValuesIndex === undefined){
              repeatingValuesIndex = j - 1;
            }
          }

          renderer.setCellValueLiteral(cell, queryAxisItem, tupleValue, tupleValueField);
          if (totalsIndex > j) {
            titleText = queryAxisItem?.formatter ? queryAxisItem.formatter(tupleValue, tupleValueField) : String(tupleValue);
            if (cellsAxisItemIndex === 0 || i === columnsOffset) {
              labelText = titleText;
            }
          }
          else if (totalsIndex === j){
            titleText = queryAxisItem ? this.#pivotTableUi.getTotalsString(queryAxisItem) : '';
            if (cellsAxisItemIndex === 0 || i === columnsOffset) {
              labelText = titleText;
            }
          }
          else {
            labelText = '';
          }
          titleText = queryAxisItem ? `${QueryAxisItem.getCaptionForQueryAxisItem(queryAxisItem)} (${tupleIndex + 1}): ${titleText}` : `${tupleIndex + 1}: ${titleText}`;

          if (hideRepeatingAxisValues){
            const isRepeatingValue = repeatingValuesIndex === j || doCellHeaders && cellsAxisItems.length && (cellsAxisItemIndex > 0 && i !== columnsOffset);
            labelText = isRepeatingValue ? (totalsIndex <= j ? undefined : dittoMark) : labelText;
            cell.setAttribute('data-is-repeating-value', isRepeatingValue);
          }
          else {
            cell.removeAttribute('data-is-repeating-value');
          }
        }
        else if (doCellHeaders && cellsAxisItems.length) {
          const cellsAxisItem = cellsAxisItems[cellsAxisItemIndex];
          renderer.setCellItemId(cell, cellsAxisItem, cellsAxisItemIndex);
          titleText = labelText = QueryAxisItem.getCaptionForQueryAxisItem(cellsAxisItem);
        }

        label.textContent = labelText && labelText.length ? labelText : String.fromCharCode(160);
        label.title = titleText;
        if (j === 0 && tuple?.widths) {
          const cellsAxisItem = cellsAxisItems.length === 0 ? null : cellsAxisItems[cellsAxisItemIndex];
          const cellsAxisItemLabel = cellsAxisItems.length === 0 ? '' : QueryAxisItem.getIdForQueryAxisItem(cellsAxisItem);
          const width = tuple.widths[cellsAxisItemLabel];
          if (width !== undefined) {
            cell.style.width = width + 'px';
          }
        }
      }

      if (doCellHeaders) {
        cellsAxisItemIndex += 1;
        if (cellsAxisItemIndex === cellsAxisItems.length) {
          cellsAxisItemIndex = 0;
          tupleIndex += 1;
        }
      }
      else {
        tupleIndex += 1;
      }
    }
  }

  async updateRowsAxisTupleData(physicalRowsAxisTupleIndex){
    let repeatingValuesIndex;
    const hideRepeatingAxisValues = this.#pivotTableUi.getHideRepeatingAxisValues();
    const dittoMark = hideRepeatingAxisValues ? this.#pivotTableUi.getDittoMark() : '';
    const tupleIndexInfo = this.getTupleIndexForPhysicalIndex(QueryModel.AXIS_ROWS, physicalRowsAxisTupleIndex);
    const rowsAxisSizeInfo = this.getRowsAxisSizeInfo();
    const columnsAxisSizeInfo = this.getColumnsAxisSizeInfo();
    const count = rowsAxisSizeInfo.rows.rowCount;
    let tupleCount = Math.ceil(count / tupleIndexInfo.factor);
    if (tupleIndexInfo.cellsAxisItemIndex > 0) {
      tupleCount += 1;
    }

    const tupleSet = this.#pivotTableUi.getRowsTupleSet();
    const lastTupleIndex = tupleSet.getTupleCountSync() - 1;
    const queryModel = this.#pivotTableUi.getQueryModel();
    const queryAxisItems = queryModel.getRowsAxis().getItems();
    const totalsItemsIndices = getTotalsItemsIndices(queryAxisItems);
    const tupleValueFields = tupleSet.getTupleValueFields();
    const tuples = await tupleSet.getTuples(tupleCount, tupleIndexInfo.tupleIndex || 0);

    const cellHeadersAxis = queryModel.getCellHeadersAxis();
    const cellsAxisItems = cellHeadersAxis === QueryModel.AXIS_ROWS ? queryModel.getCellsAxis().getItems() : [];
    const doCellHeaders = cellHeadersAxis === QueryModel.AXIS_ROWS;
    let tupleIndex = 0;
    let cellsAxisItemIndex = tupleIndexInfo.cellsAxisItemIndex;
    const rows = this.#pivotTableUi.getTableBodyDom().childNodes;
    const renderer = this.#pivotTableUi.getRenderer();
    for (let i = 0; i < rows.length - 1; i++) {
      const row = rows.item(i);
      const tuple = tuples[tupleIndex];
      const prevTuple = tuples[tupleIndex - 1];
      repeatingValuesIndex = undefined;
      row.setAttribute('data-row-index', tupleIndex);
      row.setAttribute('data-row-tuple-index', tupleIndexInfo.tupleIndex + tupleIndex);
      row.setAttribute('data-is-last-row-tuple', (tupleIndexInfo.tupleIndex + tupleIndex) === lastTupleIndex || isNaN(lastTupleIndex));
      const groupingId = renderer.getTupleGroupingId(tuple);
      const isTotalsRow = Boolean(groupingId);
      row.setAttribute('data-totals', isTotalsRow);

      const columnsOffset = columnsAxisSizeInfo.headers.columnCount;
      for (let j = 0; j < columnsOffset; j++){
        const queryAxisItem = queryAxisItems[j];
        const cell = row.childNodes.item(j);
        const label = getChildWithClassName(cell, 'pivotTableUiCellLabel');
        const numMembers = tuple ? tuple.values.length : 0;
        const totalsIndex = isTotalsMember(groupingId, totalsItemsIndices, queryAxisItem ? j : undefined);
        let labelText;
        let titleText;
        let isTotals = false;
        let isTotalsOrigin = false;

        if (tuple && j < numMembers) {
          const tupleValue = tuple.values[j];
          if (hideRepeatingAxisValues && prevTuple && (repeatingValuesIndex === undefined || repeatingValuesIndex === j - 1)){
            const prevTupleValue = prevTuple.values[j];
            if (tupleValue !== null && tupleValue === prevTupleValue || tupleValue === null && prevTupleValue === null && totalsIndex === isTotalsMember(renderer.getTupleGroupingId(prevTupleValue), totalsItemsIndices, queryAxisItem ? j : rows.length - 1)) {
              repeatingValuesIndex = j;
            }
            else if (repeatingValuesIndex === undefined){
              repeatingValuesIndex = j - 1;
            }
          }

          renderer.setCellValueLiteral(cell, queryAxisItem, tupleValue, tupleValueFields[j]);
          if (totalsIndex > j) {
            labelText = queryAxisItem?.formatter ? queryAxisItem.formatter(tupleValue, tupleValueFields[j]) : String(tupleValue);
          }
          else if (totalsIndex === j) {
            isTotals = isTotalsOrigin = true;
            labelText = doCellHeaders ? (i === 0 || cellsAxisItemIndex === 0 ? this.#pivotTableUi.getTotalsString(queryAxisItem) : undefined) : this.#pivotTableUi.getTotalsString(queryAxisItem);
          }
          else {
            labelText = '';
            isTotals = true;
          }
          titleText = queryAxisItem ? `${QueryAxisItem.getCaptionForQueryAxisItem(queryAxisItem)}: ${labelText}` : String(labelText);

          if (hideRepeatingAxisValues){
            const isRepeatingValue = repeatingValuesIndex === j || doCellHeaders && cellsAxisItems.length && (cellsAxisItemIndex > 0 && i !== 0);
            labelText = isRepeatingValue ? (totalsIndex <= j ? undefined : dittoMark) : labelText;
            cell.setAttribute('data-is-repeating-value', isRepeatingValue);
          }
          else {
            cell.removeAttribute('data-is-repeating-value');
          }
        }
        else if (doCellHeaders && j === columnsOffset - 1) {
          const cellsAxisItem = cellsAxisItems[cellsAxisItemIndex];
          labelText = QueryAxisItem.getCaptionForQueryAxisItem(cellsAxisItem);
          titleText = labelText;
          isTotals = isTotalsRow;
          cell.setAttribute('data-axis-item', QueryAxisItem.getIdForQueryAxisItem(cellsAxisItem));
          cell.setAttribute('data-axis-item-index', cellsAxisItemIndex);
        }

        label.textContent = labelText && labelText.length ? labelText : String.fromCharCode(160);
        label.title = titleText;
        if (isTotals) {
          cell.setAttribute('data-totals', isTotals);
        }
        else {
          cell.removeAttribute('data-totals');
        }
        if (isTotalsOrigin) {
          cell.setAttribute('data-totals-origin', isTotalsOrigin);
        }
        else {
          cell.removeAttribute('data-totals-origin');
        }
      }

      if (doCellHeaders) {
        cellsAxisItemIndex += 1;
        if (cellsAxisItemIndex === cellsAxisItems.length || cellsAxisItems.length === 0) {
          cellsAxisItemIndex = 0;
          tupleIndex += 1;
        }
      }
      else {
        tupleIndex += 1;
      }
    }
  }

  async updateCellData(physicalColumnsAxisTupleIndex, physicalRowsAxisTupleIndex){
    const tableBodyRows = this.#pivotTableUi.getTableBodyDom().childNodes;
    const tableHeaderRows = this.#pivotTableUi.getTableHeaderDom().childNodes;
    const firstTableHeaderRowCells = tableHeaderRows.item(0).childNodes;
    const lastTableHeaderRowCells = tableHeaderRows.item(tableHeaderRows.length - 1).childNodes;
    const queryModel = this.#pivotTableUi.getQueryModel();
    const cellHeadersAxis = queryModel.getCellHeadersAxis();
    const rowsAxisItems = queryModel.getRowsAxis().getItems();
    const columnsAxisItems = queryModel.getColumnsAxis().getItems();
    const cellsAxisItems = queryModel.getCellsAxis().getItems();
    const columnTupleIndexInfo = this.getTupleIndexForPhysicalIndex(QueryModel.AXIS_COLUMNS, physicalColumnsAxisTupleIndex);
    const headerColumnCount = this.getColumnsAxisSizeInfo().headers.columnCount;
    const rowTupleIndexInfo = this.getTupleIndexForPhysicalIndex(QueryModel.AXIS_ROWS, physicalRowsAxisTupleIndex);
    const columnCount = firstTableHeaderRowCells.length - headerColumnCount - 1;

    let columnsAxisTupleIndex = columnTupleIndexInfo.tupleIndex;
    let rowsAxisTupleIndex = rowTupleIndexInfo.tupleIndex;
    let numRowsAxisTuples;
    let numColumnsAxisTuples;
    switch (cellHeadersAxis){
      case QueryModel.AXIS_COLUMNS:
        numColumnsAxisTuples = columnsAxisItems.length ? Math.ceil(columnCount / columnTupleIndexInfo.factor) + (columnTupleIndexInfo.cellsAxisItemIndex ? 1 : 0) : 0;
        numRowsAxisTuples = rowsAxisItems.length ? tableBodyRows.length - 1 : 0;
        break;
      case QueryModel.AXIS_ROWS:
        numColumnsAxisTuples = columnsAxisItems.length ? columnCount : 0;
        numRowsAxisTuples = rowsAxisItems.length ? Math.ceil((tableBodyRows.length - 1) / rowTupleIndexInfo.factor) + (rowTupleIndexInfo.cellsAxisItemIndex ? 1 : 0) : 0;
        break;
    }

    const cellsSet = this.#pivotTableUi.getCellSet();
    const cells = await cellsSet.getCells([
      [rowsAxisTupleIndex, rowsAxisTupleIndex + numRowsAxisTuples],
      [columnsAxisTupleIndex, columnsAxisTupleIndex + numColumnsAxisTuples]
    ]);
    const renderer = this.#pivotTableUi.getRenderer();
    for (let i = 0; i < tableBodyRows.length - 1; i++){
      const tableRow = tableBodyRows.item(i);
      const isTotalsRow = tableRow.getAttribute('data-totals') === 'true';
      const cellElements = tableRow.childNodes;
      let cellsAxisItemIndex;
      if (cellHeadersAxis === QueryModel.AXIS_ROWS && i === 0){
        cellsAxisItemIndex = rowTupleIndexInfo.cellsAxisItemIndex;
        rowsAxisTupleIndex = rowTupleIndexInfo.tupleIndex;
      }

      for (let j = headerColumnCount; j < headerColumnCount + columnCount; j++){
        if (j === headerColumnCount) {
          columnsAxisTupleIndex = columnTupleIndexInfo.tupleIndex;
          if (cellHeadersAxis === QueryModel.AXIS_COLUMNS) {
            cellsAxisItemIndex = columnTupleIndexInfo.cellsAxisItemIndex;
          }
        }

        const cellElement = cellElements.item(j);
        if (!cellElement){
          console.warn(`Warning: no DOM found for cell ${i},${j}`);
          continue;
        }

        const cell = cells ? cells[cellsSet.getCellIndex(rowsAxisTupleIndex, columnsAxisTupleIndex)] : undefined;
        const cellsAxisItem = cellsAxisItems[cellsAxisItemIndex];
        const labelText = renderer.renderCellValue(cell, cellsAxisItem, cellElement);
        const headerCell = firstTableHeaderRowCells.item(j);
        if (!headerCell){
          console.warn(`Warning: no header cell at position ${j}`);
        }
        else {
          const lastTableHeaderRowCell = lastTableHeaderRowCells.item(j);
          if (isTotalsRow || (lastTableHeaderRowCell ? lastTableHeaderRowCell.getAttribute('data-totals') === 'true' : false)) {
            cellElement.setAttribute('data-totals', true);
          }
          else {
            cellElement.removeAttribute('data-totals');
          }
          const width = headerCell.style.width;
          if (width.endsWith('ch')) {
            let newWidth = labelText.length + 1;
            if (newWidth > this.#pivotTableUi.getMaxCellWidthLimit()) {
              newWidth = this.#pivotTableUi.getMaxCellWidthLimit();
            }
            if (newWidth > parseInt(width, 10)) {
              headerCell.style.width = newWidth + 'ch';
            }
          }
        }

        if (cellHeadersAxis === QueryModel.AXIS_COLUMNS){
          cellElement.setAttribute('data-cells-axis-item-index', cellsAxisItemIndex);
          cellsAxisItemIndex += 1;
          if (cellsAxisItemIndex >= cellsAxisItems.length) {
            cellsAxisItemIndex = 0;
            columnsAxisTupleIndex += 1;
          }
        }
        else {
          cellElement.removeAttribute('data-cells-axis-item-index');
          columnsAxisTupleIndex += 1;
        }
      }

      if (cellHeadersAxis === QueryModel.AXIS_ROWS){
        cellsAxisItemIndex += 1;
        if (cellsAxisItemIndex >= cellsAxisItems.length) {
          cellsAxisItemIndex = 0;
          rowsAxisTupleIndex += 1;
        }
      }
      else {
        rowsAxisTupleIndex += 1;
      }
    }
  }

  getNumberOfPhysicalTuplesForAxis(axisId){
    const queryModel = this.#pivotTableUi.getQueryModel();
    let factor;
    if (queryModel.getCellHeadersAxis() === axisId) {
      factor = queryModel.getCellsAxis().getItems().length;
    }
    if (!factor) {
      factor = 1;
    }

    let tupleSet;
    switch (axisId){
      case QueryModel.AXIS_COLUMNS:
        tupleSet = this.#pivotTableUi.getColumnsTupleSet();
        break;
      case QueryModel.AXIS_ROWS:
        tupleSet = this.#pivotTableUi.getRowsTupleSet();
        break;
      default:
        throw new Error(`Invalid axis id ${axisId}.`);
    }
    let tupleCount = tupleSet.getTupleCountSync();
    if (tupleCount === undefined) {
      tupleCount = 1;
    }
    return tupleCount * factor;
  }

  getColumnsAxisSizeInfo(){
    const firstHeaderRow = this.#pivotTableUi.getTableHeaderDom().childNodes.item(0);
    if (!firstHeaderRow ) {
      return undefined;
    }

    const cells = firstHeaderRow.childNodes;
    const queryModel = this.#pivotTableUi.getQueryModel();
    const rowsAxisItems = queryModel.getQueryAxis(QueryModel.AXIS_ROWS).getItems();
    const cellsAxisItems = queryModel.getQueryAxis(QueryModel.AXIS_CELLS).getItems();
    let numHeaderItems = rowsAxisItems.length;
    if (queryModel.getCellHeadersAxis() === QueryModel.AXIS_ROWS && cellsAxisItems.length) {
      numHeaderItems += 1;
    }
    if (numHeaderItems === 0) {
      numHeaderItems = 1;
    }

    const sizeInfo = { headers: { width: 0, columnCount: numHeaderItems, numPhysicalHeaders: 0 }, columns: { width: 0, columnCount: 0 } };
    for (let i = 0; i < cells.length - 1; i++){
      const cell = cells.item(i);
      if (i < numHeaderItems) {
        sizeInfo.headers.width += cell.clientWidth;
        sizeInfo.headers.numPhysicalHeaders += 1;
      }
      else {
        sizeInfo.columns.width += cell.clientWidth;
        sizeInfo.columns.columnCount += 1;
      }
    }
    return sizeInfo;
  }

  updateHorizontalSizer(){
    const sizeInfo = this.getColumnsAxisSizeInfo();
    if (!sizeInfo) {
      console.warn('updateHorizontalSizer: no sizeInfo');
      return;
    }

    const avgColumnWidth = sizeInfo.columns.columnCount === 0 ? 0 : sizeInfo.columns.width / sizeInfo.columns.columnCount;
    const requiredWidth = avgColumnWidth * this.getNumberOfPhysicalTuplesForAxis(QueryModel.AXIS_COLUMNS);
    const headersWidth = sizeInfo.headers.numPhysicalHeaders === sizeInfo.headers.columnCount
      ? sizeInfo.headers.width
      : sizeInfo.headers.width / sizeInfo.headers.numPhysicalHeaders * sizeInfo.headers.columnCount;
    this.#pivotTableUi.setHorizontalSize(headersWidth + requiredWidth);
  }

  getRowsAxisSizeInfo(){
    const tableHeaderDom = this.#pivotTableUi.getTableHeaderDom();
    const tableBodyDom = this.#pivotTableUi.getTableBodyDom();
    return {
      headers: { height: tableHeaderDom.clientHeight, rowCount: tableHeaderDom.childNodes.length },
      rows: { height: tableBodyDom.clientHeight, rowCount: tableBodyDom.childNodes.length - 1 }
    };
  }

  updateVerticalSizer(){
    const sizeInfo = this.getRowsAxisSizeInfo();
    if (!sizeInfo) {
      console.warn('updateVerticalSizer: no sizeInfo');
      return;
    }
    const physicalRowHeight = sizeInfo.rows.height / sizeInfo.rows.rowCount;
    this.#pivotTableUi.setVerticalSize(sizeInfo.headers.height + physicalRowHeight * this.getNumberOfPhysicalTuplesForAxis(QueryModel.AXIS_ROWS));
  }
}
