import { byId } from '../util/dom/dom.js';
import { settings } from '../SettingsDialog/SettingsDialog.js';
import { QueryModel, queryModel } from '../QueryModel/QueryModel.js';
import { DataSourcesUi } from '../DataSource/DataSourcesUi.js';
import { DuckDbDataSource } from '../DataSource/duckdb/DuckDbDataSource.js';
import { showErrorDialog } from '../ErrorDialog/ErrorDialog.js';
import { copyToClipboard } from '../util/clipboard/clipboard.js';
import { ensureDuckDbExtensionLoadedAndInstalled, getCopyToStatement, getQuotedIdentifier, quoteStringLiteral, unQuote } from '../util/sql/SQLHelper.js';

/** Format a DuckDB query result as CSV (browser fallback when COPY TO cannot write). */
export function formatQueryResultAsCsv(result, options) {
  const { delimiter, nullString, header, quoteChar, escapeChar } = options;
  const numRows = result.numRows ?? 0;
  if (numRows === 0) {
    return header ? '' : '';
  }
  const first = result.get(0);
  const columnNames = result.columnNames ?? Object.keys(first);
  const escapeRe = new RegExp(quoteChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const escapeVal = (v) => {
    if (v === null || v === undefined) return nullString;
    const s = String(v);
    return s.replace(escapeRe, escapeChar + quoteChar);
  };
  const needQuote = (s) => /[\r\n"\\]/.test(s) || s.includes(delimiter) || s.includes(quoteChar);
  const cell = (v) => {
    const escaped = escapeVal(v);
    return needQuote(escaped) ? quoteChar + escaped + quoteChar : escaped;
  };
  const rows = [];
  if (header) {
    rows.push(columnNames.map((c) => cell(c)).join(delimiter));
  }
  for (let i = 0; i < numRows; i++) {
    const row = result.get(i);
    rows.push(columnNames.map((col) => cell(row[col])).join(delimiter));
  }
  return rows.join('\n');
}

export class ExportUi {

  static downloadURL(url, fileName) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.style = 'display: none';
    a.click();
    a.remove();
  }

  static downloadBlob(data, fileName, mimeType, timeout) {
    const blob = new Blob(
      [data]
    , {type: mimeType}
    );
    const url = window.URL.createObjectURL(blob);
    ExportUi.downloadURL(url, fileName);
    timeout = timeout === undefined ? 1000 : timeout;
    setTimeout(() => {
      return window.URL.revokeObjectURL(url);
    }, timeout);
  }

  static #exportTitleFields = {
    'datasource': function(queryModel){
      if (!queryModel) {
        queryModel = window.queryModel;
      }
      const datasource = queryModel.getDatasource();
      if (!datasource) {
        return '<no datasource>';
      }
      const caption = DataSourcesUi.getCaptionForDatasource(datasource);
      return caption;
    },
    'columns-items': function(queryModel){
      if (!queryModel) {
        queryModel = window.queryModel;
      }
      const caption = queryModel.getCaptionForQueryAxis(QueryModel.AXIS_COLUMNS);
      return caption;
    },
    'rows-items': function(queryModel){
      if (!queryModel) {
        queryModel = window.queryModel;
      }
      const caption = queryModel.getCaptionForQueryAxis(QueryModel.AXIS_ROWS);
      return caption;
    },
    'cells-items': function(queryModel){
      if (!queryModel) {
        queryModel = window.queryModel;
      }
      const caption = queryModel.getCaptionForQueryAxis(QueryModel.AXIS_CELLS);
      return caption;
    },
    'filters-items': function(queryModel){
      if (!queryModel) {
        queryModel = window.queryModel;
      }
      const caption = queryModel.getCaptionForQueryAxis(QueryModel.AXIS_FILTERS);
      return caption;
    },
    'utc-timestamp': function(_queryModel){
      return (new Date(Date.now())).toISOString().split('.')[0];
    },
    'timestamp': function(_queryModel){
      const date = new Date();

      function padDigit(digit) {
        return digit < 10 ? '0' + digit : digit;
      }

      return [
        date.getFullYear()
      , padDigit(date.getMonth() + 1)
      , padDigit(date.getDate())
      ].join('-') +
      'T'+ [
        padDigit(date.getHours())
      , padDigit(date.getMinutes())
      , padDigit(date.getSeconds())
      ].join(':')
    }
  }

  static generateExportTitle(queryModel, titleTemplate){
    if (queryModel === undefined) {
      queryModel = window.queryModel;
    }
    if (titleTemplate === undefined){
      const exportTemplate = byId('exportTitleTemplate')
      titleTemplate = exportTemplate.value;
    }
    const replacedTemplate = titleTemplate.replace(/\$\{[^\}]+\}/g, (fieldRef) =>{
      const fieldName = unQuote(fieldRef, '${', '}');
      const func = ExportUi.#exportTitleFields[fieldName];
      if (typeof func === 'function'){
        return func(queryModel);
      }
      else {
        return fieldRef;
      }
    });
    return replacedTemplate;
  }
  
  static #getSqlForExport(queryModel, options){
    const rowsAxisItems = queryModel.getRowsAxis().getItems();
    const columnsAxisItems = queryModel.getColumnsAxis().getItems();
    const cellsAxisItems = queryModel.getCellsAxis().getItems();
    const axisItems = [].concat(rowsAxisItems, columnsAxisItems, cellsAxisItems);
    const filterAxisItems = queryModel.getFiltersAxis().getItems();

    const datasource = queryModel.getDatasource();
    const opts = Object.assign({}, options, {
      datasource: datasource,
      queryAxisItems: axisItems, 
      filterAxisItems: filterAxisItems,
    });
    const sql = SqlQueryGenerator.getSqlSelectStatementForAxisItems(opts);
    return sql
  }

  static getSqlForTabularExport(queryModel, sqlOptions){
    const options = Object.assign({}, {
      sqlOptions: sqlOptions
    });
    const sql = ExportUi.#getSqlForExport(queryModel, options);
    return sql;
  }
  
  static getSqlForPivotExport(queryModel, sqlOptions){
    const columnsAxisItems = queryModel.getColumnsAxis().getItems();
    if (!columnsAxisItems.length) {
      return ExportUi.getSqlForTabularExport(queryModel, sqlOptions);
    }
    
    const options = Object.assign({}, {
      sqlOptions: sqlOptions || {},
      includeOrderBy: false,
      finalStateAsCte: true,
      cteName: '__huey_cells'
    });
    let sql = ExportUi.#getSqlForExport(queryModel, options);
    
    const columns = columnsAxisItems
    .map((queryAxisItem) =>{
      const caption = QueryAxisItem.getCaptionForQueryAxisItem(queryAxisItem);
      return quoteIdentifierWhenRequired(caption);
    })
    .join(getComma(options.sqlOptions.commaStyle));
    
    let aggregates;
    const cellsAxisItems = queryModel.getCellsAxis().getItems();
    if (cellsAxisItems.length) {
      aggregates = cellsAxisItems
      .map((queryAxisItem) =>{
        let caption = QueryAxisItem.getCaptionForQueryAxisItem(queryAxisItem);
        caption = quoteIdentifierWhenRequired(caption);
        return `FIRST( ${caption} ) AS ${caption}`;
      })
      .join(getComma(options.sqlOptions.commaStyle));
    }
    else {
      aggregates = `FIRST( NULL ) AS _`
    }

    let pivot = [
      `PIVOT (FROM "__huey_cells")`,
      `ON (${columns})`,
      `USING ${aggregates}`
    ].join('\n')
    
    const rowsAxisItems = queryModel.getRowsAxis().getItems();
    if (rowsAxisItems.length) {
      const orderBy = rowsAxisItems
      .map((queryAxisItem) =>{
        const caption = QueryAxisItem.getCaptionForQueryAxisItem(queryAxisItem);
        return quoteIdentifierWhenRequired(caption);
      })
      .join(getComma(options.sqlOptions.commaStyle));
      pivot += `\nORDER BY ${orderBy}`;
    }

    sql += `\n${pivot}`;
    return sql;
  }
  
  static getExportSqlForQueryModel(queryModel, exportSettings, exportType){
    
    let sql, _structure;
    if (exportSettings.exportResultShapePivot){
      _structure = 'pivot';
      sql = ExportUi.getSqlForPivotExport(queryModel, sqlOptions);
    }
    else
    if (exportSettings.exportResultShapeTable){
      _structure = 'table';
      sql = ExportUi.getSqlForTabularExport(queryModel, sqlOptions);
    }

    const sqlOptions = {
      keywordLettercase: exportSettings[exportType + 'KeywordLettercase'],
      alwaysQuoteIdentifiers: exportSettings[exportType + 'AlwaysQuoteIdentifiers'],
      commaStyle: exportSettings[exportType + 'CommaStyle']
    };
    if (sqlOptions) {
      sql = [
        `/***********************************`,
        `* DuckDB query generated by Huey`,
        `* ${(new Date(Date.now())).toISOString()}`,
        `* https://github.com/rpbouman/huey`,
        `***********************************/`,
        sql
      ].join('\n');
    }

    return sql;
  }

  static async exportDataForQueryModel(queryModel, exportSettings, progressCallback){
    const sql = ExportUi.getExportSqlForQueryModel(queryModel, exportSettings);
    const datasource = queryModel.getDatasource();
    return ExportUi.exportData(datasource, sql, exportSettings, progressCallback);
  }

  static async #exportQueryToDatabaseFile(datasource, sql, fileExtension, tableName, progressCallback){
    const exportTableName = (tableName || 'export_result').trim() || 'export_result';
    const quotedTableName = getQuotedIdentifier(exportTableName);
    const tmpFileName = [crypto.randomUUID(), fileExtension].join('.');
    const exportDbAlias = '__huey_export_db';
    const quotedExportDbAlias = getQuotedIdentifier(exportDbAlias);
    const connection = datasource.getManagedConnection();
    let data;
    try {
      progressCallback(`Preparing ${fileExtension} database ${tmpFileName}`);
      const attachSql = fileExtension === 'sqlite'
        ? `ATTACH ${quoteStringLiteral(tmpFileName)} AS ${quotedExportDbAlias} (TYPE SQLITE)`
        : `ATTACH ${quoteStringLiteral(tmpFileName)} AS ${quotedExportDbAlias}`
      ;
      await connection.query(attachSql);
      await connection.query(`CREATE TABLE ${quotedExportDbAlias}.main.${quotedTableName} AS SELECT * FROM (${sql}) AS __huey_export_subquery`);
      await connection.query(`DETACH ${quotedExportDbAlias}`);
      progressCallback(`Extracting from ${tmpFileName}`);
      data = await connection.copyFileToBuffer(tmpFileName);
      return data;
    }
    finally {
      try {
        await connection.query(`DETACH ${quotedExportDbAlias}`);
      } catch (error) {
        console.error('Error detaching export database alias', error);
      }
      if (data) {
        await connection.dropFile(tmpFileName);
      }
    }
  }

  static async exportData(datasource, sql, exportSettings, progressCallback){
    try {
      if (typeof progressCallback !== 'function'){
        progressCallback = function(_text){
        };
      }
      progressCallback('initSettings');

      const _title = exportSettings.exportTitle;
      const exportType = exportSettings.exportType;

      let mimeType, compression, includeHeaders,
          dateFormat, timestampFormat, nullValueString,
          columnDelimiter, quote, escape, rowDelimiter
      ;
      let fileExtension, data, copyStatementOptions;
      switch (exportType) {
        case 'exportDelimited':
          columnDelimiter = exportSettings[exportType + 'ColumnDelimiter'];
          nullValueString = exportSettings[exportType + 'NullString'];
          includeHeaders = exportSettings[exportType + 'IncludeHeaders'];
          quote = exportSettings[exportType + 'Quote'];
          escape = exportSettings[exportType + 'Escape'];
          dateFormat = exportSettings[exportType + 'DateFormat'];
          timestampFormat = exportSettings[exportType + 'TimestampFormat'];
          compression = exportSettings[exportType + 'Compression'];

          copyStatementOptions = {
            "FORMAT": 'CSV',
            "DELIMITER": `'${columnDelimiter.replace('\'', "''")}'`,
            "NULL": `'${nullValueString.replace('\'', "''")}'`,
            "HEADER": includeHeaders ? 'TRUE' : 'FALSE',
            "QUOTE": `'${quote.replace('\'', "''")}'`,
            "ESCAPE": `'${escape.replace('\'', "''")}'`,
            "DATEFORMAT": `'${dateFormat.replace('\'', "''")}'`,
            "TIMESTAMPFORMAT": `'${timestampFormat.replace('\'', "''")}'`,
            "COMPRESSION": compression.value,
          };
          if (columnDelimiter === '\\t') {
            fileExtension = 'tsv';
          }
          else {
            fileExtension = 'csv';
          }
          break;
        case 'exportJson':
          compression = exportSettings[exportType + 'Compression'];
          dateFormat = exportSettings[exportType + 'DateFormat'];
          timestampFormat = exportSettings[exportType + 'TimestampFormat'];
          rowDelimiter = exportSettings[exportType + 'RowDelimiter'];
          copyStatementOptions = {
            "FORMAT": 'JSON',
            "DATEFORMAT": `'${dateFormat.replace('\'', "''")}'`,
            "TIMESTAMPFORMAT": `'${timestampFormat.replace('\'', "''")}'`,
            "COMPRESSION": compression.value,
            "ARRAY": rowDelimiter.value
          };
          fileExtension = 'json';
          break;
        case 'exportParquet':
          compression = exportSettings[exportType + 'Compression'];
          const parquetVersion = exportSettings[exportType + 'Version'];
          copyStatementOptions = {
            "FORMAT": 'PARQUET',
            "ROW_GROUP_SIZE": exportSettings['exportParquetRowGroupSize'],
            //this option requires preserve_insertion_order to be disabled.
            //"ROW_GROUP_SIZE_BYTES": exportSettings['exportParquetRowGroupSizeBytes'],
            "COMPRESSION": compression.value,
            "PARQUET_VERSION": parquetVersion.value
          };
          if (compression.value === 'ZSTD') {
            const compressionLevel = exportSettings[exportType + 'CompressionLevel'];
            copyStatementOptions['COMPRESSION_LEVEL'] = compressionLevel;
          }
          fileExtension = 'parquet';
          break;
        case 'exportSql':
          mimeType = 'text/plain';
          fileExtension = 'sql';
          data = sql;
          break;
        case 'exportXlsx':
          fileExtension = 'xlsx';
          copyStatementOptions = {
            "FORMAT": '\'xlsx\'',
            "HEADER": `${Boolean(exportSettings.exportXlsxIncludeHeaders)}`,
            "SHEET_ROW_LIMIT": exportSettings.exportXlsxSheetRowLimit,
          };
          let sheetName = (exportSettings.exportXlsxSheet || '').trim();
          if ( sheetName.length ) {
            sheetName = quoteStringLiteral(sheetName);
            copyStatementOptions["SHEET"] = sheetName;
          }
          break;
        case 'exportSqlite':
          fileExtension = 'sqlite';
          data = await ExportUi.#exportQueryToDatabaseFile(
            datasource,
            sql,
            fileExtension,
            exportSettings.exportSqliteTableName,
            progressCallback
          );
          break;
        case 'exportDuckdb':
          fileExtension = 'duckdb';
          data = await ExportUi.#exportQueryToDatabaseFile(
            datasource,
            sql,
            fileExtension,
            exportSettings.exportDuckdbTableName,
            progressCallback
          );
          break;
        case 'exportQuery':
          const encodingSettings = exportSettings[exportType + 'Encoding'];
          const encodingOption = encodingSettings.value;
          const indent = exportSettings[exportType + 'Indentation'];
          data = {
            queryModel: queryModel.getState()
          };
          data = JSON.stringify(data, null, indent);
          switch  (encodingOption) {
            case 'HASH':
              data = encodeURIComponent( data );
              data = btoa( data );
              data = '#' + data;
              fileExtension = 'hueyqh';
              mimeType = 'text/plain';
              break;
            case 'JSON':
              fileExtension = 'hueyq';
              mimeType = 'application/json';
              break;
            default:
          }
          break;
        default:
          console.error(`Don't know how to handle export type "${exportType}".`);
      }

      const fileTypeInfo = DuckDbDataSource.getFileTypeInfo(fileExtension);
      if (fileTypeInfo) {
        if (!mimeType){
          mimeType = fileTypeInfo.mimeType;
        }
        if (fileTypeInfo.duckdb_extension){
          await ensureDuckDbExtensionLoadedAndInstalled(
            fileTypeInfo.duckdb_extension, 
            fileTypeInfo.duckdb_extension_repository
          );
        }
      }

      if (compression && compression.value !== 'UNCOMPRESSED'){
        if (exportType === 'exportParquet'){
          fileExtension = `${compression.value.toLowerCase()}.${fileExtension}`;
        }
        else {
          switch (compression.value){
            case 'GZIP':
              mimeType = 'application/gzip';
              break;
            case 'ZSTD':
              mimeType = 'application/zstd';
              break;
            default:
              mimeType = 'application/octet-stream';
          }
          fileExtension += `.${compression.value.toLowerCase()}`;
        }
      }

      if (copyStatementOptions){
        const tmpFileName = [crypto.randomUUID(), fileExtension].join('.');
        const isCsvTsvUncompressed = (fileExtension === 'csv' || fileExtension === 'tsv') &&
          compression?.value === 'UNCOMPRESSED';
        let connection;
        let usedFallback = false;
        try {
          connection = datasource.getManagedConnection();
          progressCallback(`Preparing copy to ${tmpFileName}`);
          const copyStatement = getCopyToStatement(sql, tmpFileName, copyStatementOptions);
          await connection.query(copyStatement);
          progressCallback(`Extracting from ${tmpFileName}`);
          data = await connection.copyFileToBuffer(tmpFileName);

          // fix for https://github.com/rpbouman/huey/issues/627
          // for some reason, we get the buffer back with a leading byte.
          // It does not appear to be the same byte
          if (fileExtension === 'xlsx' && data.length >= 3 && data[1] === 'P'.charCodeAt(0) && data[2] === 'K'.charCodeAt(0)){
            console.warn(`Corrupt excel file! First byte was ${data[0]} - slicing from position 1.`);
            data  = data.slice(1);
          }
        }
        catch (e) {
          if (isCsvTsvUncompressed && connection) {
            progressCallback('Exporting as CSV (browser fallback)');
            const queryResult = await connection.query(sql);
            const delim = columnDelimiter === '\\t' ? '\t' : columnDelimiter;
            const csvText = formatQueryResultAsCsv(queryResult, {
              delimiter: delim,
              nullString: nullValueString,
              header: includeHeaders,
              quoteChar: quote,
              escapeChar: escape,
            });
            data = new TextEncoder().encode(csvText);
            usedFallback = true;
          }
          else {
            throw e;
          }
        }
        finally {
          if (connection && !usedFallback) {
            await connection.dropFile(tmpFileName).catch((err) => {
              console.error('Error dropping temporary export file', err);
            });
          }
        }
      }

      let destination;
      if (exportSettings.exportDestinationFile){
        destination = 'file';
      }
      else
      if (exportSettings.exportDestinationClipboard){
        destination = 'clipboard';
      }

      switch (destination){
        case 'file':
          let fileName = [exportSettings.exportTitle, fileExtension].join('.');
          fileName = fileName.replace(/\"/g, "'");
          progressCallback(`Download as ${fileName}`);
          ExportUi.downloadBlob(data, fileName, mimeType);
          break;
        case 'clipboard':
          let text;
          if (typeof data === 'string'){
            text = data;
          }
          else {
            progressCallback(`Copying to clipboard..`);
            text = new TextDecoder('utf-8').decode(data);
          }
          await copyToClipboard(text, mimeType);
          break;
      }
      progressCallback(`Success!`);
    }
    catch (e){
      progressCallback(`Error!`);
      showErrorDialog(e);
    }
    finally {
    }
  }

  static async exportAxisData(queryModel, axisId, exportSettings, progressCallback){
    const state = queryModel.getState();
    const newAxes = {};
    newAxes[QueryModel.AXIS_FILTERS] = state.axes[QueryModel.AXIS_FILTERS];
    newAxes[axisId] = state.axes[axisId];
    state.axes = newAxes;
    
    const exportQueryModel = new QueryModel();
    await exportQueryModel.setState(state);

    await ExportUi.exportDataForQueryModel(exportQueryModel, exportSettings, progressCallback);
  }

}

export class ExportDialog {

  static #id = 'exportDialog';

  #queryModel = undefined;
  #settings = undefined;

  constructor(config = {}){
    this.#queryModel = config.queryModel;
    this.#settings = config.settings;
    this.#initExportDialog();
  }

  #initExportDialog(){
    byId('exportDialogCloseButton')
    .addEventListener('click', this.close.bind(this));

    byId('exportDialogExecuteButton')
    .addEventListener('click', this.#executeExport.bind(this));

    const exportTitleTemplate = byId('exportTitleTemplate');
    exportTitleTemplate.addEventListener('change', this.#titleTemplateChangedHandler.bind(this));
    exportTitleTemplate.addEventListener('input', this.#titleTemplateChangedHandler.bind(this));

  }

  #titleTemplateChangedHandler(_event){
    const exportTitleTemplate = byId('exportTitleTemplate');
    this.#settings.assignSettings(['exportUi', 'exportTitleTemplate'], exportTitleTemplate.value);
    this.#updateExportTitle();
  }

  #updateExportTitle(){
    const queryModel = this.#queryModel;
    const exportTemplate = byId('exportTitleTemplate')
    const titleTemplate = exportTemplate.value;

    const title = ExportUi.generateExportTitle(queryModel, titleTemplate);
    byId('exportTitle').textContent = title;
  }

  #updateDialog(){
    const dialog = this.#getDialog();
    const settings = this.#settings;

    Settings.synchronize(
      dialog,
      {"_": settings.getSettings('exportUi')},
      'dialog'
    );
    this.#updateExportTitle();
  }

  #getDialog(){
    return byId(ExportDialog.#id);
  }

  open(config = {}){
    this.#queryModel = config.queryModel || this.#queryModel || queryModel;
    this.#settings = config.settings || this.#settings || settings;
    this.#updateDialog();
    const dialog = this.#getDialog();
    dialog.showModal();
  }

  close(){
    const dialog = this.#getDialog();
    dialog.close();
  }

  async #executeExport(){
    try {
      const dialog = this.#getDialog();
      dialog.setAttribute('aria-busy', String(true));

      const settings = this.#settings;
      exportSettings = settings.getSettings('exportUi');
      Settings.synchronize(dialog, {"_": exportSettings}, 'settings');
      this.#settings.assignSettings('exportUi', exportSettings);
      
      const progressMessageElement = dialog.querySelector('*[role=progressbar] *[role=status]');
      const progressCallback = function(text){
        progressMessageElement.textContent = text;
      }
      progressCallback('Preparing export...');

      let exportSettings = settings.getSettings('exportUi');

      exportSettings.exportTitle = byId('exportTitle').textContent;
      const tabName = TabUi.getSelectedTab('#exportDialog').getAttribute('for');

      function copyUiSetting(setting, exportTypePrefix){
        exportTypePrefix = exportTypePrefix || '';
        const typeOfSetting = typeof setting;
        switch (typeOfSetting) {
          case 'string':
            const id = exportTypePrefix + setting;
            const control = byId(id);
            let valueProperty;
            switch (control.type){
              case 'radio':
              case 'checkbox':
                valueProperty = 'checked';
                break;
              case 'input':
              default:
                valueProperty = 'value';
            }
            const value = control[valueProperty];
            exportSettings[id] = control.tagName === 'SELECT' ? {value: value} : value;
            return;
          case 'object':
            if (setting instanceof Array) {
              break;
            }
          default:
            throw new Error(`Wrong type for setting "${setting}": should be string or array of strings, not "${typeOfSetting}".`);
        }
        setting.forEach((setting) =>{
          copyUiSetting(setting, exportTypePrefix);
        });
      }

      exportSettings.exportType = tabName;

      let _mimeType, _compression, _includeHeaders,
          _dateFormat, _timestampFormat, _nullValueString,
          _columnDelimiter, _quote, _escape, _rowDelimiter
      ;
      let _fileExtension, _data, _copyStatementOptions, _sqlOptions;
      switch (tabName) {
        case 'exportDelimited':
          copyUiSetting([
            'ColumnDelimiter',
            'NullString',
            'IncludeHeaders',
            'Quote',
            'Escape',
            'DateFormat',
            'TimestampFormat',
            'Compression'
          ], tabName);
          break;
        case 'exportJson':
          copyUiSetting([
            'DateFormat',
            'TimestampFormat',
            'RowDelimiter',
            'Compression'
          ], tabName);
          break;
        case 'exportParquet':
          copyUiSetting([
            'Compression'
          ], tabName);
          break;
        case 'exportSql':
          copyUiSetting([
            'KeywordLettercase',
            'AlwaysQuoteIdentifiers',
            'CommaStyle'
          ], tabName);
          break;
        case 'exportSqlite':
          copyUiSetting([
            'TableName'
          ], tabName);
          break;
        case 'exportDuckdb':
          copyUiSetting([
            'TableName'
          ], tabName);
          break;
      }
      copyUiSetting([
        'exportResultShapePivot',
        'exportResultShapeTable',
        'exportDestinationFile',
        'exportDestinationClipboard',
      ]);

      const queryModel = this.#queryModel;
      await ExportUi.exportDataForQueryModel(queryModel, exportSettings, progressCallback);

    }
    catch (e){
      showErrorDialog(e);
    }
    finally {
      dialog.setAttribute('aria-busy', String(false));
    }
  }

}

export let exportDialog;
export function initExportDialog(context){
  exportDialog = new ExportDialog({
    queryModel: context && context.has('queryModel') ? context.queryModel : queryModel,
    settings: context && context.has('settings') ? context.settings : settings
  });
  if (context) {
    context.register('exportDialog', exportDialog);
  }

  const exportButton = byId('exportButton');

  exportButton.addEventListener('click', (_event) =>{
    exportDialog.open({
      queryModel: context && context.has('queryModel') ? context.queryModel : queryModel,
      settings: context && context.has('settings') ? context.settings : settings
    });
  });

  const exportTitleTemplate = byId('exportTitleTemplate');
  function _titleTemplateChanged(){
    settings.assignSettings(['exportUi', 'exportTitleTemplate'], exportTitleTemplate.value);
    updateExportTitle();
  }
  return exportDialog;
}
