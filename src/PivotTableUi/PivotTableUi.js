import { EventEmitter } from '../util/event/EventEmitter.js';
import { bufferEvents } from '../util/event/EventBuffer.js';
import { byId, instantiateTemplate, getChildWithClassName, registerTemplates } from '../util/dom/dom.js';
import pivotTableTemplatesHtml from './templates.html?raw';
import { settings } from '../SettingsDialog/SettingsDialog.js';
import { ContextMenu } from '../ContextMenu/ContextMenu.js';
import { TupleSet } from '../DataSet/TupleSet.js';
import { CellSet } from '../DataSet/CellSet.js';
import { QueryModel, queryModel } from '../QueryModel/QueryModel.js';
import { PivotTableUiHighlighting } from './PivotTableUiHighlighting.js';
import { pivotTableUiDefaults, getDittoMark, getHideRepeatingAxisValues, getMaxCellWidth } from './PivotTableUiUtils.js';
import { PivotTableRenderer } from './PivotTableRenderer.js';
import { PivotTableScroller } from './PivotTableScroller.js';
import { PivotTableResizer } from './PivotTableResizer.js';
import { PivotTableContextMenu } from './PivotTableContextMenu.js';

export class PivotTableUi extends EventEmitter {

  static #templateId = pivotTableUiDefaults.templateId;

  #id = undefined;
  #queryModel = undefined;
  #settings = undefined;
  #columnsTupleSet = undefined;
  #rowsTupleSet = undefined;
  #cellsSet = undefined;
  #renderer = undefined;
  #scroller = undefined;
  #resizer = undefined;
  #contextMenu = undefined;
  #queryModelStateBeforeChange = undefined;
  #queryModelFilterConditionBeforeChange = undefined;
  #lastMetrics = undefined;
  #maximumCellWidth = pivotTableUiDefaults.maximumCellWidth;

  constructor(config){
    super(['updated', 'busy']);
    registerTemplates(pivotTableTemplatesHtml);
    this.#initDom(config);
    this.#id = config.id;
    this.#initSettings(config.settings);
    this.#queryModel = config.queryModel;

    this.#columnsTupleSet = new TupleSet(this.#queryModel, QueryModel.AXIS_COLUMNS, this.#settings);
    this.#rowsTupleSet = new TupleSet(this.#queryModel, QueryModel.AXIS_ROWS, this.#settings);
    this.#cellsSet = new CellSet(this.#queryModel, [this.#rowsTupleSet, this.#columnsTupleSet], this.#settings);

    this.#renderer = new PivotTableRenderer(this);
    this.#scroller = new PivotTableScroller(this, { scrollTimeout: pivotTableUiDefaults.scrollTimeout });
    this.#resizer = new PivotTableResizer(this, {
      resizeTimeout: pivotTableUiDefaults.resizeTimeout,
      columnHeaderResizeTimeout: pivotTableUiDefaults.columnHeaderResizeTimeout,
    });
    this.#contextMenu = new PivotTableContextMenu(this);

    this.#initQueryModelChangeHandler();
    this.#initCancelQueryButtonClickHandler();
  }

  #initDom(config) {
    const dom = instantiateTemplate(PivotTableUi.#templateId, config.id);
    let container = config.container;
    if (typeof container === 'string') {
      container = byId(container);
    }
    container.appendChild(dom);
  }

  #initSettings(settings){
    this.#settings = settings;
  }

  #initCancelQueryButtonClickHandler(){
    const cancelButton = byId('cancelQueryButton');
    if (!cancelButton) {
      return;
    }
    cancelButton.addEventListener('click', this.#cancelQueryButtonClicked.bind(this));
  }

  async #cancelQueryButtonClicked(_event){
    await this.cancelPendingQuery();
  }

  async cancelPendingQuery(){
    await Promise.all([
      this.#columnsTupleSet.cancelPendingQuery(),
      this.#rowsTupleSet.cancelPendingQuery(),
      this.#cellsSet.cancelPendingQuery()
    ]);
    this.setNeedsUpdate(true);
  }

  #initQueryModelChangeHandler(){
    const timeoutCallback = () =>{
      let timeoutValue;
      if (this.#settings){
        if (typeof this.#settings.getSettings === 'function'){
          timeoutValue = this.#settings.getSettings(['querySettings', 'autoRunQueryTimeout']);
        }
        else {
          timeoutValue = this.#settings.autoRunQueryTimeout || 1000;
        }
        if (typeof timeoutValue === 'function'){
          timeoutValue = timeoutValue();
        }
      }
      return timeoutValue;
    };

    bufferEvents(this.#queryModel, 'beforechange', this.#queryModelBeforeChangeHandler, this, timeoutCallback);
    bufferEvents(this.#queryModel, 'change', this.#queryModelChangeHandler, this, timeoutCallback);
  }

  #queryModelBeforeChangeHandler(_event, count){
    if (count !== 0) {
      return;
    }
    this.#queryModelStateBeforeChange = JSON.stringify(this.#queryModel.getState({includeItemIndices: true}));
    this.#queryModelFilterConditionBeforeChange = this.#queryModel.getFilterConditionSql(false);
  }

  async #queryModelChangeHandler(_event, count){
    if (count !== undefined) {
      return;
    }
    const stateBefore = this.#queryModelStateBeforeChange;
    const queryModelStateAfterChange = this.#queryModel.getState({includeItemIndices: true});
    const stateAfter = JSON.stringify(queryModelStateAfterChange);
    if (stateBefore === stateAfter){
      this.#queryModelStateBeforeChange = undefined;
      return;
    }

    const queryModelStateBeforeChange = JSON.parse(stateBefore);
    const stateChange = QueryModel.compareStates(queryModelStateBeforeChange, queryModelStateAfterChange);
    let needsClearing = false;
    let needsUpdate = false;
    let clearRowsTupleSet = false;
    let clearColumnsTupleSet = false;
    let clearCellsSet = false;

    const axesChangedInfo = stateChange.axesChanged;
    if (axesChangedInfo){
      if (axesChangedInfo[QueryModel.AXIS_ROWS] !== undefined) {
        clearCellsSet = clearRowsTupleSet = true;
      }
      if (axesChangedInfo[QueryModel.AXIS_COLUMNS] !== undefined) {
        clearCellsSet = clearColumnsTupleSet = true;
      }
      if (axesChangedInfo[QueryModel.AXIS_CELLS] !== undefined) {
        needsUpdate = true;
      }
      if (axesChangedInfo[QueryModel.AXIS_FILTERS]) {
        const filterConditionSql = this.#queryModel.getFilterConditionSql(false);
        if (filterConditionSql !== this.#queryModelFilterConditionBeforeChange) {
          needsUpdate = true;
          clearCellsSet = clearColumnsTupleSet = clearRowsTupleSet = true;
        }
      }
    }

    if (stateChange.propertiesChanged){
      const propertiesChangedInfo = stateChange.propertiesChanged;
      if (propertiesChangedInfo.datasource || propertiesChangedInfo.datasourceId) {
        clearCellsSet = clearRowsTupleSet = clearColumnsTupleSet = true;
        const hadDatasourceBefore = queryModelStateBeforeChange && (queryModelStateBeforeChange.datasourceId || queryModelStateBeforeChange.datasource);
        if (hadDatasourceBefore) {
          needsClearing = true;
        }
      }
      if (propertiesChangedInfo.cellsHeaders){
        needsUpdate = true;
      }
    }

    if (clearColumnsTupleSet) {
      this.#columnsTupleSet.clearCache();
      needsUpdate = true;
    }
    if (clearRowsTupleSet) {
      this.#rowsTupleSet.clearCache();
      needsUpdate = true;
    }
    if (clearCellsSet) {
      this.#cellsSet.clearCache();
      needsUpdate = true;
    }

    const countQueryAxisItems = [QueryModel.AXIS_ROWS, QueryModel.AXIS_COLUMNS, QueryModel.AXIS_CELLS].reduce((acc, curr) => {
      return acc + this.getQueryModel().getQueryAxis(curr).getItems().length;
    }, 0);
    if (countQueryAxisItems === 0) {
      needsClearing = true;
    }
    if (needsClearing) {
      this.clear();
    }

    this.setNeedsUpdate(needsUpdate);
    if (!this.getAutoUpdate()){
      this.#queryModelStateBeforeChange = undefined;
      return;
    }
    if (needsUpdate){
      await this.updatePivotTableUi();
    }
    this.#queryModelStateBeforeChange = undefined;
  }

  getQueryModel(){
    return this.#queryModel;
  }

  getSettings(){
    return this.#settings;
  }

  getColumnsTupleSet(){
    return this.#columnsTupleSet;
  }

  getRowsTupleSet(){
    return this.#rowsTupleSet;
  }

  getCellSet(){
    return this.#cellsSet;
  }

  getRenderer(){
    return this.#renderer;
  }

  getScroller(){
    return this.#scroller;
  }

  getResizer(){
    return this.#resizer;
  }

  getDom(){
    return document.getElementById(this.#id);
  }

  getInnerContainerDom(){
    return getChildWithClassName(this.getDom(), 'pivotTableUiInnerContainer');
  }

  getTableDom(){
    return getChildWithClassName(this.getInnerContainerDom(), 'pivotTableUiTable');
  }

  getTableHeaderDom(){
    return getChildWithClassName(this.getTableDom(), 'pivotTableUiTableHeader');
  }

  getTableBodyDom(){
    return getChildWithClassName(this.getTableDom(), 'pivotTableUiTableBody');
  }

  getHorizontalSizer() {
    return getChildWithClassName(this.getInnerContainerDom(), 'pivotTableUiHorizontalSizer');
  }

  getVerticalSizer() {
    return getChildWithClassName(this.getInnerContainerDom(), 'pivotTableUiVerticalSizer');
  }

  setHorizontalSize(size){
    this.getHorizontalSizer().style.width = size + 'px';
  }

  setVerticalSize(size){
    this.getVerticalSizer().style.height = size + 'px';
  }

  getTotalsString(_axisItem){
    return this.#settings.getSettings('pivotSettings').totalsString;
  }

  getDittoMark(){
    return getDittoMark(this.#settings);
  }

  getHideRepeatingAxisValues(){
    return getHideRepeatingAxisValues(this.#settings);
  }

  getMaxCellWidthLimit(){
    return this.#maximumCellWidth;
  }

  setMaxCellWidthLimit(maxCellWidth){
    this.#maximumCellWidth = maxCellWidth;
  }

  getLastMetrics(){
    return this.#lastMetrics;
  }

  setLastMetrics(metrics){
    this.#lastMetrics = metrics;
  }

  setNeedsUpdate(needsUpdate){
    this.getDom().setAttribute('data-needs-update', String(Boolean(needsUpdate)));
  }

  setBusy(busy){
    this.getDom().setAttribute('aria-busy', String(Boolean(busy)));
    this.fireEvent('busy', { busy: Boolean(busy) });
  }

  getBusy(){
    return this.getDom().getAttribute('aria-busy') === 'true';
  }

  getAutoUpdate(){
    let settings = this.#settings || {};
    if (settings && typeof settings.getSettings === 'function'){
      settings = settings.getSettings('querySettings');
    }
    return settings.autoRunQuery !== undefined ? settings.autoRunQuery : false;
  }

  hasPendingModelChange(){
    return this.#queryModelStateBeforeChange !== undefined;
  }

  fireUpdatedSuccess(){
    const tupleCounts = {};
    tupleCounts[QueryModel.AXIS_ROWS] = this.#rowsTupleSet.getTupleCountSync();
    tupleCounts[QueryModel.AXIS_COLUMNS] = this.#columnsTupleSet.getTupleCountSync();
    tupleCounts[QueryModel.AXIS_CELLS] = {
      axis: this.#queryModel.getCellHeadersAxis(),
      count: this.#queryModel.getCellsAxis().getItems().length
    };
    this.fireEvent('updated', { status: 'success', tupleCounts: tupleCounts, metrics: this.#lastMetrics });
  }

  beforeShowContextMenu(event, contextMenu){
    return this.#contextMenu.beforeShowContextMenu(event, contextMenu);
  }

  async contextMenuItemClicked(event){
    return this.#contextMenu.contextMenuItemClicked(event);
  }

  clear(){
    this.#resizer.toggleObserveColumnsResizing(false);
    this.getTableHeaderDom().replaceChildren();
    this.getTableBodyDom().replaceChildren();
    this.setHorizontalSize(0);
    this.setVerticalSize(0);
    this.fireUpdatedSuccess();
  }

  async #estimateColumnsAxisPageSize(){
    return pivotTableUiDefaults.defaultPageSize;
  }

  async #estimateRowsAxisPageSize(){
    return pivotTableUiDefaults.defaultPageSize;
  }

  async updatePivotTableUi(){
    if (this.getBusy()) {
      return;
    }

    this.setMaxCellWidthLimit(getMaxCellWidth(this.#settings));
    const tableDom = this.getTableDom();
    try {
      const cellHeadersAxis = this.#queryModel.getCellHeadersAxis();
      if (cellHeadersAxis !== tableDom.getAttribute('data-cellheadersaxis')) {
        tableDom.setAttribute('data-cellheadersaxis', cellHeadersAxis);
      }

      this.setBusy(true);
      this.clear();
      const totalStart = performance.now();
      this.#renderer.renderHeader();
      tableDom.style.width = '';

      const pageSizes = await Promise.all([
        this.#estimateColumnsAxisPageSize(),
        this.#estimateRowsAxisPageSize(),
      ]);
      this.#columnsTupleSet.setPageSize(pageSizes[0]);
      this.#rowsTupleSet.setPageSize(pageSizes[1]);

      const [columnTuples, rowTuples] = await Promise.all([
        this.#columnsTupleSet.getTuples(this.#columnsTupleSet.getPageSize(), 0),
        this.#rowsTupleSet.getTuples(this.#rowsTupleSet.getPageSize(), 0)
      ]);
      const queryTimeMs = Math.round(performance.now() - totalStart);
      const renderStart = performance.now();

      this.setHorizontalSize(0);
      this.#renderer.renderColumns(columnTuples);
      this.setVerticalSize(0);
      this.#renderer.renderRows(rowTuples);
      this.#scroller.updateVerticalSizer();
      this.#resizer.toggleObserveColumnsResizing(true);
      this.#renderer.renderCells();
      await this.#scroller.updateDataToScrollPosition();

      this.#lastMetrics = {
        queryTimeMs: queryTimeMs,
        renderTimeMs: Math.round(performance.now() - renderStart),
        totalTimeMs: Math.round(performance.now() - totalStart)
      };
      setTimeout(() => {
        const columnsSizeInfo = this.#scroller.getColumnsAxisSizeInfo();
        if (!columnsSizeInfo) {
          return;
        }
        this.#renderer.removeExcessColumns();
        this.#scroller.updateHorizontalSizer();
        this.#renderer.removeExcessRows();
        this.#scroller.updateVerticalSizer();
      }, 1000);
      this.setNeedsUpdate(false);
      this.fireUpdatedSuccess();
    }
    catch(error){
      console.error(error);
      this.fireEvent('updated', { status: 'error', error: error });
    }
    finally {
      tableDom.style.width = '99.99%';
      this.setBusy(false);
    }
  }
}

export let pivotTableUi;
export let pivotTableUiHighlighting;
export function initPivotTableUi(){
  pivotTableUi = new PivotTableUi({
    container: 'workarea',
    id: 'pivotTableUi',
    queryModel: queryModel,
    settings: settings
  });

  const _pivotTableUiContextMenu = new ContextMenu(pivotTableUi, 'pivotTableContextMenu');
  pivotTableUiHighlighting = new PivotTableUiHighlighting(pivotTableUi);

  function updateAppearance(){
    const pivotTableSettings = settings.getSettings('pivotSettings');
    pivotTableUiHighlighting.enableAlternatingRowColors(pivotTableSettings.alternatingRowColors);
    pivotTableUiHighlighting.enableHoverRowHighlighting(pivotTableSettings.hoverRowHighlight);
    pivotTableUiHighlighting.enableHoverColumnHighlighting(pivotTableSettings.hoverColumnHighlight);
  }

  updateAppearance();
  settings.addEventListener('change', () =>{
    updateAppearance();
  });
}
