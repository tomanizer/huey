import { byId } from '../util/dom/dom.js';
import { bufferEvents } from '../util/event/EventBuffer.js';
import { settings } from '../SettingsDialog/SettingsDialog.js';
import { getQuotedIdentifier, createNumberFormatter } from '../util/sql/SQLHelper.js';
import { showErrorDialog } from '../ErrorDialog/ErrorDialog.js';
import { initDragableDialogs } from '../DragAndDrop/DragableDialogs.js';
import { QueryModel, queryModel, initQueryModel } from '../QueryModel/QueryModel.js';
import { initAttributeUi } from '../AttributeUi/AttributeUi.js';
import { initSearch } from '../Search/Search.js';
import { uploadUi, initUploadUi } from '../UploadUi/UploadUi.js';
import { ExportUi, initExportDialog } from '../ExportUi/ExportDialog.js';
import { DataSourcesUi, initDataSourcesUi } from '../DataSource/DataSourcesUi.js';
import { initDatasourceSettingsDialog } from '../DatasourceSettingsDialog/DatasourceSettingsDialog.js';
import { initFilterUi } from '../FilterUi/FilterUi.js';
import { initQueryUi } from '../QueryUi/QueryUi.js';
import { pivotTableUi, initPivotTableUi } from '../PivotTableUi/PivotTableUi.js';
import { Routing } from '../Routing/Routing.js';
import { pageStateManager, initPageStateManager } from '../PageStateManager/PageStateManager.js';
import { initSessionCloner } from '../SessionCloner/SessionCloner.js';
import { initQuickQueryMenu } from '../QuickQueryMenu/QuickQueryMenu.js';
import { initDataSourceMenu } from '../DataSourceMenu/DataSourceMenu.js';
import { postMessageInterface, initPostMessageInterface } from '../PostMessageInterface/PostMessageInterface.js';
import { analyzeDatasource } from './analyzeDatasource.js';

const queryParams = Object.fromEntries(new URLSearchParams(document.location.search));

export function getDuckDbLogLevel(duckdb){
  let loglevel;
  const paramLoglevel = queryParams.loglevel;
  if (paramLoglevel){
    loglevel = duckdb.LogLevel[paramLoglevel];
    if (typeof loglevel !== 'number'){
      loglevel = duckdb.LogLevel[loglevel];
    }
  }
  return typeof loglevel === 'number' ? loglevel : duckdb.LogLevel.INFO;
}

export function duckDbRowToJSON(object){
  let pojo;
  if (typeof object.toJSON === 'function'){
    pojo = object.toJSON();
  }
  else {
    pojo = object;
  }
  return JSON.stringify(pojo, (key, value) =>{
    if (value && value.constructor === BigInt){
      return parseFloat(value.toString());
    }
    else {
      return value;
    }
  }, 2);
}

export function initDuckdbVersion(){
  if (!window.hueyDb) {
    return;
  }
  const connection = window.hueyDb.connection;
  const versionColumn = 'version';
  const apiColumn = 'api';
  const reservedWordsColumn = 'reserved_words';
  const columns = {
    "version()": versionColumn,
    "current_setting('duckdb_api')": apiColumn,
    "list( keyword_name )": reservedWordsColumn,
  };
  const selectListSql = Object.keys(columns).map((key) =>{
    return `${key} AS ${getQuotedIdentifier(columns[key])}`;
  }).join('\n,');
  let sql = `SELECT ${selectListSql}`;
  sql += `\nFROM duckdb_keywords()\nWHERE keyword_category != 'unreserved'`;
  const result = connection.query(sql)
  .then((resultset) =>{
    const row = resultset.get(0);
    const version = row[versionColumn];
    const api = row[apiColumn];
    let reservedWords = row[reservedWordsColumn];
    reservedWords = String(reservedWords).slice(1, -1).split(',');
    window.hueyDb.reservedWords = reservedWords;

    const duckdbVersionLabel = byId('duckdbVersionLabel');
    duckdbVersionLabel.textContent = `DuckDB ${version}, API: ${api}`;
    
    const duckdbAvatar = byId('duckdb-version-specific-avatar');
    const duckdbVersionParts = /v(\d+)\.(\d+).(\d)/.exec(version);
    duckdbAvatar.src = `https://duckdb.org/images/release-icons/${duckdbVersionParts[1]}.${duckdbVersionParts[2]}.0.svg`
  })
  .catch(() =>{
    console.error(`Error fetching duckdb version info.`);
  })
}

export { analyzeDatasource } from './analyzeDatasource.js';

export function initExecuteQuery(){

  byId('runQueryButton').addEventListener('click', (event) =>{
    pivotTableUi.updatePivotTableUi();
  });

  const autoRunQuery = byId('autoRunQuery');
  const settingsPath = ['querySettings', 'autoRunQuery'];
  autoRunQuery.checked = Boolean( settings.getSettings(settingsPath) );
  autoRunQuery.addEventListener('change', (event) =>{
    const target = event.target;
    const checked = target.checked;
    settings.assignSettings('querySettings', {
      'autoRunQuery': checked
    });
    if (checked) {
      pivotTableUi.updatePivotTableUi();
    }
  });
}

export function initApplication(){
  initDragableDialogs();
  initDuckdbVersion();
  initDataSourcesUi();
  initQueryModel();
  initExportDialog();
  initAttributeUi();
  initSearch();
  initFilterUi();
  initQueryUi();
  initPivotTableUi();
  initExecuteQuery();
  initPageStateManager();
  initUploadUi();
  initDatasourceSettingsDialog();
  initSessionCloner();
  initQuickQueryMenu();
  initDataSourceMenu();

  const currentRoute = Routing.getCurrentRoute();
  if (currentRoute){
    pageStateManager.setPageState(currentRoute);
  }

  bufferEvents(queryModel, 'change', (event, count) =>{
    if (count !== undefined) {
      return;
    }

    console.log(`buffered Events, event:`);
    const eventData = event.eventData;
    console.log(eventData);

    let currentDatasourceCaption, datasource = queryModel.getDatasource();
    if (datasource) {
      currentDatasourceCaption = DataSourcesUi.getCaptionForDatasource(datasource);
    }
    else {
      currentDatasourceCaption = '';
    }
    byId('currentDatasource').setAttribute('data-current-datasource', currentDatasourceCaption);
    byId('currentDatasource').firstChild.data = currentDatasourceCaption;

    const title = ExportUi.generateExportTitle(queryModel);
    document.title = 'Huey - ' + title;

    Routing.updateRouteFromQueryModel(queryModel);
  }, null, 50);

  const tupleNumberFormatter = createNumberFormatter(0).format;
  pivotTableUi.addEventListener('updated', async (e) =>{
    const eventData = e.eventData;
    const status = eventData.status;
    
    let numRowsTuples = '';
    let numColumnsTuples = '';
    
    switch (status) {
      case 'error':
        showErrorDialog(eventData.error);
        break;
      case 'success':
        {
          const tupleCounts = eventData.tupleCounts;

          const cellsInfo = tupleCounts[QueryModel.AXIS_CELLS];

          numRowsTuples = tupleCounts[QueryModel.AXIS_ROWS];
          numRowsTuples = typeof numRowsTuples === 'number' ? tupleNumberFormatter(numRowsTuples) : '';
          if (cellsInfo.count > 1 && cellsInfo.axis === QueryModel.AXIS_ROWS) {
            numRowsTuples += ` × ${cellsInfo.count}`;
          }
          
          numColumnsTuples = tupleCounts[QueryModel.AXIS_COLUMNS];
          numColumnsTuples = typeof numColumnsTuples === 'number' ? tupleNumberFormatter(numColumnsTuples) : '';
          if (cellsInfo.count > 1 && cellsInfo.axis === QueryModel.AXIS_COLUMNS) {
            numColumnsTuples += ` × ${cellsInfo.count}`;
          }
        }

        break;
    }
    byId('queryResultRowsInfo').textContent = numRowsTuples;
    byId('queryResultColumnsInfo').textContent = numColumnsTuples;

    const metrics = eventData.metrics;
    if (metrics) {
      byId('queryPerformanceInfo').textContent = `Query: ${metrics.queryTimeMs}ms | Render: ${metrics.renderTimeMs}ms`;
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        console.log('[Performance]', {
          query: metrics.queryTimeMs + 'ms',
          render: metrics.renderTimeMs + 'ms',
          total: metrics.totalTimeMs + 'ms',
        });
      }
    }
    else {
      byId('queryPerformanceInfo').textContent = '';
    }
  });

  bufferEvents(pivotTableUi, 'busy', (event, count) =>{
    if (count !== undefined) {
      return;
    }
    const busy = event.eventData.busy;
    const busyDialog = byId('visualizationProgressDialog');
    if (busy) {
      busyDialog.showModal();
    }
    else {
      busyDialog.close();
    }
  });

  initPostMessageInterface();
  if (postMessageInterface) {
    postMessageInterface.sendReadyMessage();
  }
}
