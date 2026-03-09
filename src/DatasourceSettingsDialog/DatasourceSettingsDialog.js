import { DuckDbDataSource } from '../DataSource/duckdb/DuckDbDataSource.js';
import { SettingsDialogBase } from '../SettingsDialog/SettingsDialogBase.js';
import { TabUi } from '../Tabs/Tabs.js';
import { byId } from '../util/dom/dom.js';
import { QueryModel } from '../QueryModel/QueryModel.js';
import { PivotTableUi } from '../PivotTableUi/PivotTableUi.js';
import { SettingsBase } from '../SettingsDialog/SettingsBase.js';
import { DatasourceSettings } from './DatasourceSettings.js';
import { settings } from '../SettingsDialog/SettingsDialog.js';
import { DataSourcesUi } from '../DataSource/DataSourcesUi.js';
import { getDatabase, getDuckDbModule } from '../DataSource/duckdb/database.js';

export class RejectsDatasource extends DuckDbDataSource {

  #delegateDatasource = undefined;

  constructor(){
    super(getDuckDbModule(), getDatabase(), {
      type: DuckDbDataSource.types.SQLQUERY,
      sql: 'SELECT 1'
    });
  }

  setDelegateDatasource(datasource){
    this.#delegateDatasource = datasource;
    const sql = datasource.getRejectsSql();
    this.setSqlQuery(sql);
  }

  getManagedConnection(){
    const delegateDatasource = this.#delegateDatasource;
    const managedConnection = delegateDatasource.getManagedConnection();
    return managedConnection;
  }

  getId(){
    const delegateDatasource = this.#delegateDatasource;
    const delegateDatasourceId = delegateDatasource.getId();
    const id = `Rejects of ${delegateDatasourceId}`;
    return id;
  }

}

export class DatasourceSettingsDialog extends SettingsDialogBase {

  static #id = 'datasourceSettingsDialog';
  static #tabListSelector = `#${DatasourceSettingsDialog.#id} > *[role=tablist]`;


  #datasource = undefined;

  #columnsTabDatasource = undefined;
  #columnsTabPanel = undefined;

  #rejectsDatasource = undefined;
  #rejectsTabQueryModel = undefined;
  #rejectsTabPivotTableUi = undefined;

  static #fileSizeFormatter = new Intl.NumberFormat();
  
  static #formatFileSize(fileSize){
    return DatasourceSettingsDialog.#fileSizeFormatter.format(fileSize);
  }

  /** Settings stub for dialog pivots: no auto-run, safe defaults for TupleSet/PivotTableUi. */
  static #dialogPivotSettings(){
    return {
      getSettings(path) {
        const p = Array.isArray(path) ? path : (path ? [path] : []);
        if (p[0] === 'querySettings') {
          if (p.length <= 1) return { autoRunQuery: false, autoRunQueryTimeout: 1000 };
          if (p[1] === 'autoRunQueryTimeout') return 1000;
          return false;
        }
        if (p[0] === 'pivotSettings') {
          if (p.length <= 1) return { totalsString: 'Total' };
          if (p[1] === 'totalsPosition' && p[2] === 'value') return 'AFTER';
          return undefined;
        }
        if (p[0] === 'localeSettings' && p[1] === 'nullsSortOrder' && p[2] === 'value') return 'FIRST';
        return undefined;
      }
    };
  }

  constructor(){
    super({
      id: DatasourceSettingsDialog.#id
    });
    this.#initDatasourceSettingsDialog();
  }

  #initDatasourceSettingsDialog(){
    this.#initCsvReaderOptionsTab();
    this.#initColumnsTab();
    this.#initRejectsTab();
  }

  async #waitForDialogLayout(){
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  }

  async #getColumnsTabQueryResult(sql){
    const connection = this.#columnsTabDatasource.getManagedConnection();
    const result = await connection.query(sql);
    const rowCount = result.numRows || 0;
    const fields = result.schema && result.schema.fields ? result.schema.fields.map((field) => field.name) : [];
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      const row = result.get(i);
      const plainRow = {};
      for (let j = 0; j < fields.length; j++) {
        const fieldName = fields[j];
        plainRow[fieldName] = row[fieldName];
      }
      rows.push(plainRow);
    }
    return {
      fields,
      rows
    };
  }

  #renderColumnsTabResult(fields, rows){
    if (!this.#columnsTabPanel) {
      return;
    }

    const fieldOrder = ['#', 'column_name', 'column_type'].filter((fieldName) => {
      return fields.indexOf(fieldName) !== -1;
    });
    const fieldLabels = {
      '#': '#',
      column_name: 'Column Name',
      column_type: 'Data Type'
    };

    const table = document.createElement('table');
    table.className = 'datasourceSettingsColumnsTable';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    fieldOrder.forEach((fieldName) => {
      const th = document.createElement('th');
      th.textContent = fieldLabels[fieldName];
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      fieldOrder.forEach((fieldName) => {
        const td = document.createElement('td');
        const value = row[fieldName];
        td.textContent = value === null || value === undefined ? '' : String(value);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    this.#columnsTabPanel.replaceChildren(table);
  }

  async #autodetectCsvReaderSettings(_event){
    const datasource = this.#datasource;
    if (datasource.getType() !== DuckDbDataSource.types.FILE){
      throw new Error(`Datasource is not of type ${DuckDbDataSource.types.FILE}`);
    }
    const fileType = datasource.getFileType();
    const fileTypeInfo = DuckDbDataSource.getFileTypeInfo(fileType);
    if (fileTypeInfo.duckdb_reader !== 'read_csv'){
      throw new Error(`Datasource is not a CSV file`);
    }

    const datasourceSettings = datasource.getSettings();
    const csvReaderArguments = datasourceSettings.getReaderArguments('csvReader');
    //csvReaderArguments['ignore_errors'] = true;
    let csvReaderArgumentsSql = DatasourceSettings.getReaderArgumentsSql(csvReaderArguments);
    if (csvReaderArgumentsSql && csvReaderArgumentsSql.length) {
      csvReaderArgumentsSql = `, ${csvReaderArgumentsSql}`;
    }
    else {
      csvReaderArgumentsSql = '';
    }

    const fileName = datasource.getFileName();

    const sniffer = fileTypeInfo.duckdb_sniffer;
    const snifferSql = `SELECT * FROM ${sniffer}('${fileName}'${csvReaderArgumentsSql})`;

    const managedConnection = datasource.getManagedConnection();
    // TODO: show a busy spinner
    const result = await managedConnection.query(snifferSql);
    // TODO: hide the busy spinner
    const row = result.get(0);

    function escapeDelimiter(delim){
      return delim.replace(/[\t\r\n\0]/g, (ch) =>{
        switch (ch){
          case '\t':
            ch = '\\t';
            break;
          case '\r':
            ch = '\\r';
            break;
          case '\n':
            ch = '\\n';
            break;
          case '\0':
            ch = '\\0';
            break;
        }
        return ch;
      });
    }

    const detectedSettings = {
      csvReaderDelim: escapeDelimiter(row.Delimiter),
      csvReaderQuote: escapeDelimiter(row.Quote),
      csvReaderEscape: escapeDelimiter(row.Escape),
      csvReaderNewLine: {
        value: escapeDelimiter(row.NewLineDelimiter)
      },
      csvReaderSkip: row.SkipRows,
      csvReaderHeader: row.HasHeader,
      //csvReaderColumns = row.Columns,
      csvReaderDateformat: row.DateFormat,
      csvReaderTimestampformat: row.TimestampFormat
    };
    datasourceSettings.assignSettings('csvReader', detectedSettings);
    this.updateDialogFromSettings();
  }

  #initCsvReaderOptionsTab(){
    byId('csvReaderRestoreDefaults')
    .addEventListener(
      'click',
      this.restoreToDefaultHandler.bind(this)
    );
    byId('csvReaderDetectSettings')
    .addEventListener(
      'click',
      this.#autodetectCsvReaderSettings.bind(this)
    );
  }

  #initColumnsTab(){
    this.#columnsTabDatasource = DuckDbDataSource.createFromSql(
      getDuckDbModule(),
      getDatabase(),
      'DESCRIBE SELECT 1'
    );
    
    const tabId = 'datasourceSettingsDialogColumnsTab';
    this.#columnsTabPanel = TabUi.getTabPanel(
      DatasourceSettingsDialog.#tabListSelector,
      `#${tabId}`
    );
  }

  #downloadCsvReaderRejectsHandler(_event){
    const exportUiSettings = settings.getSettings('exportUi');
    exportUiSettings.exportTitleTemplate = '${datasource}';
    exportUiSettings.exportResultShapePivot = true;

    const ourSettings = new SettingsBase({
      template: {exportUi: exportUiSettings}
    });
    exportDialog.open({
      queryModel: this.#rejectsTabQueryModel,
      settings: ourSettings
    });
  }

  async #clearCsvReaderRejectsHandler(_event){
    await this.#datasource.clearRejects();
    this.#updateRejectsTabData();
  }

  #initRejectsTab(){

    byId('csvReaderDownloadRejects')
    .addEventListener(
      'click',
      this.#downloadCsvReaderRejectsHandler.bind(this)
    );
    byId('csvReaderClearRejects')
    .addEventListener(
      'click',
      this.#clearCsvReaderRejectsHandler.bind(this)
    );

    this.#rejectsDatasource = new RejectsDatasource();
    this.#rejectsTabQueryModel = new QueryModel();

    const tabId = 'datasourceSettingsDialogCsvReaderRejectsTab';
    const rejectsTabPanel = TabUi.getTabPanel(
      DatasourceSettingsDialog.#tabListSelector,
      `#${tabId}`
    );
    const section = rejectsTabPanel.querySelector('section');
    this.#rejectsTabPivotTableUi = new PivotTableUi({
      container: section,
      id: tabId + 'PivotTableUi',
      queryModel: this.#rejectsTabQueryModel,
      settings: DatasourceSettingsDialog.#dialogPivotSettings()
    });
  }

  async #updateColumnsTabData(){
    const datasource = this.#datasource;

    // Prepare our column datasource (reuse same instance; setState will clear and repopulate)
    const sql = [
      'SELECT CAST(ROW_NUMBER() OVER () AS USMALLINT) AS "#"',
      ', ds_schema.*',
      `FROM (${datasource.getSqlForTableSchema()}) as ds_schema`
    ].join('\n');
    this.#columnsTabDatasource.setSqlQuery(sql);
    const result = await this.#getColumnsTabQueryResult(sql);
    this.#renderColumnsTabResult(result.fields, result.rows);
  }

  async #updateRejectsTabData(){
    const datasource = this.#datasource;

    // first clean up the datasource
    this.#rejectsTabQueryModel.setDatasource( null );

    if (typeof datasource.supportsRejectsDetection !== 'function' || !datasource.supportsRejectsDetection()){
      return;
    }

    const rejectsDatasource = this.#rejectsDatasource;
    rejectsDatasource.setDelegateDatasource(datasource);

    // re-initialize the query model.
    const axes = {};
    axes[QueryModel.AXIS_ROWS] = [{column: 'id', columnType: 'BIGINT'}];
    axes[QueryModel.AXIS_CELLS] = [
      {caption: "Scan", column: 'max_scan_id', columnType: 'BIGINT', aggregator: 'min'},
      {caption: "File", column: 'filename', columnType: 'VARCHAR', aggregator: 'min'},
      {caption: "Line Number", column: 'line_position', columnType: 'BIGINT', aggregator: 'min'},
      {caption: "Column Number", column: 'column_position', columnType: 'BIGINT', aggregator: 'min'},
      {caption: "Column Name", column: 'column_name', columnType: 'VARCHAR', aggregator: 'min'},
      {caption: "Position", column: 'error_position', columnType: 'BIGINT', aggregator: 'min'},
      {caption: "Errors", column: 'errors', columnType: 'VARCHAR', aggregator: 'min'},
      {caption: "Line Text", column: 'csv_line', columnType: 'VARCHAR', aggregator: 'min'},
    ];
    this.#rejectsTabQueryModel.setState({
      axes: axes,
      datasource: rejectsDatasource
    });
    await this.#rejectsTabPivotTableUi.updatePivotTableUi();
  }

  async setDatasource(datasource){
    this.#datasource = datasource;

    const datasourceType = datasource.getType();
    byId('datasourceType').value = datasourceType;
    byId('datasourceName').value = DataSourcesUi.getCaptionForDatasource(datasource);

    let fileType, fileSize;
    switch(datasourceType){
      case DuckDbDataSource.types.FILE:
        fileSize = datasource.isUrl ? '' : datasource.getFileSize();
        fileSize = DatasourceSettingsDialog.#formatFileSize(fileSize);
      case DuckDbDataSource.types.FILES:
        fileType = datasource.getFileType();
        break;
      default:
        fileType = '';
        fileSize = '';
    }
    const fileTypeControl = byId('datasourceFileType');
    // we need to set the value property to update the output,
    // but we also need to set the value attribute because we use that in CSS to control visibility of reader param tabs.
    fileTypeControl.setAttribute('value', fileType);
    fileTypeControl.value = fileType;

    byId('datasourceFileSize').value = fileSize;

    TabUi.setSelectedTab(
      DatasourceSettingsDialog.#tabListSelector,
      '#datasourceSettingsDialogColumnsTab'
    );

    await this.#waitForDialogLayout();
    await this.#updateColumnsTabData();
    await this.#updateRejectsTabData();
  }

  open(datasource) {
    const settings = datasource.getSettings();
    super.open(settings);
    void this.setDatasource(datasource);
  }
}

export let datasourceSettingsDialog;
export function initDatasourceSettingsDialog(){
  datasourceSettingsDialog = new DatasourceSettingsDialog();
}
