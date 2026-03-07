import { byId } from '../util/dom/dom.js';
import { bufferEvents } from '../util/event/EventBuffer.js';
import { settings } from '../SettingsDialog/SettingsDialog.js';
import { getQuotedIdentifier, createNumberFormatter } from '../util/sql/SQLHelper.js';
import { showErrorDialog } from '../ErrorDialog/ErrorDialog.js';
import { initDragableDialogs } from '../DragAndDrop/DragableDialogs.js';
import { QueryModel, queryModel, initQueryModel } from '../QueryModel/QueryModel.js';
import { initAttributeUi } from '../AttributeUi/AttributeUi.js';
import { initSearch } from '../Search/Search.js';
import { initUploadUi } from '../UploadUi/UploadUi.js';
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
import { PostMessageProtocol } from '../PostMessageInterface/PostMessageProtocol.js';
import { getConnection, setReservedWords } from '../DataSource/duckdb/database.js';
import { Theme } from '../Theme/Theme.js';


const queryParams = Object.fromEntries(new URLSearchParams(document.location.search));
window.Theme = Theme;

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
  const connection = getConnection();
  if (!connection) {
    return;
  }
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
  connection.query(sql)
  .then((resultset) =>{
    const row = resultset.get(0);
    const version = row[versionColumn];
    const api = row[apiColumn];
    let reservedWords = row[reservedWordsColumn];
    reservedWords = String(reservedWords).slice(1, -1).split(',');
    setReservedWords(reservedWords);

    const duckdbVersionLabel = byId('duckdbVersionLabel');
    duckdbVersionLabel.textContent = `DuckDB ${version}, API: ${api}`;
    
    const duckdbAvatar = byId('duckdb-version-specific-avatar');
    if (duckdbAvatar) {
      if (window.crossOriginIsolated) {
        duckdbAvatar.hidden = true;
      }
      else {
        const duckdbVersionParts = /v(\d+)\.(\d+)\.(\d+)/.exec(version);
        if (duckdbVersionParts) {
          duckdbAvatar.hidden = false;
          duckdbAvatar.onerror = () => {
            duckdbAvatar.hidden = true;
          };
          duckdbAvatar.src = `https://duckdb.org/images/release-icons/${duckdbVersionParts[1]}.${duckdbVersionParts[2]}.0.svg`;
        }
        else {
          duckdbAvatar.hidden = true;
        }
      }
    }
  })
  .catch((err) => {
    console.error('Error fetching duckdb version info.', err);
    const duckdbVersionLabel = byId('duckdbVersionLabel');
    if (duckdbVersionLabel) {
      duckdbVersionLabel.textContent = 'DuckDB version unknown';
    }
  });
}

export { analyzeDatasource } from './analyzeDatasource.js';

export function initExecuteQuery(){

  byId('runQueryButton').addEventListener('click', (_event) =>{
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

  bufferEvents(queryModel, 'change', (event, count) => {
    if (count !== undefined) {
      return;
    }
    try {
      const datasource = queryModel.getDatasource();
      let currentDatasourceCaption;
      if (datasource) {
        currentDatasourceCaption = DataSourcesUi.getCaptionForDatasource(datasource);
      } else {
        currentDatasourceCaption = '';
      }
      byId('currentDatasource').setAttribute('data-current-datasource', currentDatasourceCaption);
      byId('currentDatasource').firstChild.data = currentDatasourceCaption;

      const title = ExportUi.generateExportTitle(queryModel);
      document.title = 'Huey - ' + title;

      Routing.updateRouteFromQueryModel(queryModel);
    } catch (err) {
      console.error('Error handling buffered query change event', err);
      showErrorDialog({ title: 'Query update failed', description: err?.message || String(err) });
    }
  }, null, 50);

  const tupleNumberFormatter = createNumberFormatter(0).format;
  pivotTableUi.addEventListener('updated', (e) => {
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
    const queryPerformanceInfo = byId('queryPerformanceInfo');
    const queryTimeInfo = byId('queryTimeInfo');
    const renderTimeInfo = byId('renderTimeInfo');
    if (metrics) {
      queryTimeInfo.textContent = `Query: ${metrics.queryTimeMs}ms`;
      renderTimeInfo.textContent = `Render: ${metrics.renderTimeMs}ms`;
      queryPerformanceInfo.hidden = false;
      if (postMessageInterface && typeof postMessageInterface.sendMessage === 'function') {
        postMessageInterface.sendMessage({
          messageType: PostMessageProtocol.EVENT_PERFORMANCE,
          body: {
            queryTimeMs: metrics.queryTimeMs,
            renderTimeMs: metrics.renderTimeMs,
            totalTimeMs: metrics.totalTimeMs,
            rowCount: metrics.rowCount,
            columnCount: metrics.columnCount
          }
        });
      }
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        // eslint-disable-next-line no-console
        console.log('[Performance]', {
          query: metrics.queryTimeMs + 'ms',
          render: metrics.renderTimeMs + 'ms',
          total: metrics.totalTimeMs + 'ms',
          rows: metrics.rowCount,
          columns: metrics.columnCount,
        });
      }
    }
    else {
      queryTimeInfo.textContent = '';
      renderTimeInfo.textContent = '';
      queryPerformanceInfo.hidden = true;
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
