import { EventEmitter } from '../../util/event/EventEmitter.js';
import { DuckDbConnection } from './DuckDbConnection.js';
import { showErrorDialog } from '../../ErrorDialog/ErrorDialog.js';
import { DatasourceSettings } from '../../DatasourceSettingsDialog/DatasourceSettings.js';
import { getDatabase } from './database.js';
import {
  quoteStringLiteral,
  isQuotedIdentifier,
  unQuoteIdentifier,
  getQuotedIdentifier,
  getQualifiedIdentifier,
  formatKeyword,
  normalizeSqlOptions,
  getComma,
  getIdentifier
} from '../../util/sql/SQLHelper.js';
import {
  datasourceTypes,
  fileTypeDefinitions,
  readerArguments,
  getFileNameParts as _getFileNameParts,
  getFileTypeInfo as _getFileTypeInfo,
  getResourceInfoForUrl as _getResourceInfoForUrl,
  globPathPattern,
} from './DuckDbDataSourceConfig.js';

export class DuckDbDataSource extends EventEmitter {
  
  static #defaultNumberOfAccessAttempts = 1;
  static #globPathPattern = globPathPattern;

  // Delegate to shared config (also available via direct import from DuckDbDataSourceConfig.js)
  static types = datasourceTypes;
  static fileTypes = fileTypeDefinitions;
  static duckdb_reader_arguments = readerArguments;

  // this is a crutch for reading from url.
  // basically this lets us find out what reader duckdb chose to read the url
  static async #whatFileType(url, connection, contentType){
    let fileTypes = DuckDbDataSource.fileTypes;
    const candidateFileTypes = {};
    
    for (const fileTypeName in fileTypes){
      const fileType = fileTypes[fileTypeName];
      if (fileType.mimeType === contentType){
        candidateFileTypes[fileTypeName] = fileType;
        continue;
      }
      
      switch (contentType){
        case 'binary/octet-stream':
          if (!fileType.mimeType.startsWith('text/') && !fileType.mimeType.startsWith('application/json')) {
            candidateFileTypes[fileTypeName] = fileType;
          }
          continue;
        case 'text/plain':
          if (fileType.mimeType.startsWith('text/') || fileType.mimeType.startsWith('application/json')) {
            candidateFileTypes[fileTypeName] = fileType;
          }
          continue;
      }
    }
    
    if (Object.keys(candidateFileTypes).length){
      fileTypes = candidateFileTypes;
    }
    
    const readers = Object.keys(fileTypes).reduce((acc, curr, _index) =>{
      const fileType = fileTypes[curr];
      const reader = fileType.duckdb_reader;
      if (reader !== undefined && acc.indexOf(reader) === -1){
        acc.push(reader);
      }
      return acc;
    }, []);

    const statementLines = [
      'SELECT *',
      'FROM',
      '',
      'LIMIT 0'
    ];
    const possibleTypes = [];
    try {
      const promises = readers.map(async (reader) =>{
        const readerCall = `${reader}( ${quoteStringLiteral(url)} )`;
        statementLines[2] = readerCall;
        const sql = statementLines.join('\n');
        // create a new connection for each try. 
        // see: issue https://github.com/rpbouman/huey/issues/536.
        // if we hit the xlsx reader and that runs into issues, the connection is borked and we get uncaught errors.
        // this does not appear to happen when we create a new connection.
        const connection = await getDatabase().connect();
        const promise = connection.query(sql);
        promise.finally(() =>{
          try {
            connection.close();
          }
          catch(_e){
          }
        });
        return promise;
      });

      let _reader;
      const promiseResults = await Promise.allSettled(promises);
      const fulfilled = [];
      promiseResults.forEach((promiseResult, index) =>{
        if (promiseResult.status === 'fulfilled'){
          fulfilled.push(index);
        }
      });
      switch (fulfilled.length) {
        case 0:
          return null;
        case 1:
        default:
          for (let i = 0; i < fulfilled.length; i++){
            const index = fulfilled[i];
            const reader = readers[index];
            for (const fileTypeKey in fileTypes){
              const fileType = fileTypes[fileTypeKey];
              if (fileType.duckdb_reader === reader) {
                possibleTypes.push( fileTypeKey );
              }
            }
          }
          break;
      }
    }
    catch (_e){
      return null;
    }
    if (possibleTypes.length){
      return possibleTypes;
    }
    return null;
  }

  static #datasource_uid_generator = 0;
  #datasource_uid = undefined;
  #rejects_tables = undefined;
  #rejects_balance = 0n;
  #reject_count = 0n;

  #originalConfig = undefined;

  #defaultSampleSize = 100;

  #duckDb = undefined;
  #duckDbInstance = undefined;
  #connection = undefined;
  #managedConnection = undefined;
  #catalogName = undefined;
  #schemaName = undefined;
  #objectName = undefined;
  #url = undefined;
  #contentType = undefined;
  #file = undefined;
  #fileRegistered = undefined;
  #fileNames = undefined;
  #fileType = undefined;
  #fileProtocol = undefined;
  #type = undefined;
  #columnMetadata = undefined;
  #alias = undefined;
  #sqlQuery = undefined;
  #cloudUri = undefined;

  #settings = new DatasourceSettings();

  constructor(duckDb, duckDbInstance, config){
    super(['destroy', 'rejectsdetected', 'change']);
    this.#originalConfig = Object.assign({}, config);
    this.#datasource_uid = ++DuckDbDataSource.#datasource_uid_generator;
    this.#duckDb = duckDb;
    this.#duckDbInstance = duckDbInstance;
    this.#init(config);
  }

  getOriginalConfig(){
    return this.#originalConfig;
  }

  getSettings(){
    return this.#settings;
  }

  get isUrl(){
    return Boolean(this.#url);
  }

  getCloudUri(){
    return this.#cloudUri;
  }
  // Delegate to extracted utilities (also available via direct import from DuckDbDataSourceConfig.js)
  static getFileNameParts(fileName){ return _getFileNameParts(fileName); }
  static async getResourceInfoForUrl(url, httpMethod, requestHeaders){ return _getResourceInfoForUrl(url, httpMethod, requestHeaders); }

  // this is a light weight method that should produce the id of a datasource that would be created for the given file.
  // this should not actually instantiate a datasource, merely its identifier.
  // It is a service to easily create UI elements that may refer to a datasource without having to actually create one.
  static getDatasourceIdForFileName(fileName){
    return `${this.types.FILE}:${getQuotedIdentifier(fileName)}`;
  }

  static getFileTypeInfo(fileType){ return _getFileTypeInfo(fileType); }

  static async createFromUrl(duckdb, instance, url) {
    if (!(typeof url === 'string')){
      throw new Error(`The url should be of type string`);
    }

    const pathPart = url.split(/[?#]/).shift();
    const fileNameParts = DuckDbDataSource.getFileNameParts(pathPart);
    const fileType = fileNameParts ? fileNameParts.lowerCaseExtension : undefined;
    const isGlobPath = DuckDbDataSource.#globPathPattern.test(pathPart);
    if (isGlobPath && fileType) {
      const fileTypeInfo = DuckDbDataSource.getFileTypeInfo(fileType);
      if (fileTypeInfo && fileTypeInfo.duckdb_reader) {
        return new DuckDbDataSource(duckdb, instance, {
          type: DuckDbDataSource.types.FILE,
          fileName: url,
          url: url,
          fileType: fileType
        });
      }
    }

    const config = {
      type: DuckDbDataSource.types.FILE,
      fileName: url,
      url: url
    };

    const response = await DuckDbDataSource.getResourceInfoForUrl(url, 'HEAD');
    let contentType = response.headers['content-type'];
    if (contentType){
      config.contentType = contentType;
      const contentTypes = contentType.split(';');
      _outer: for (let i = 0; i < contentTypes.length; i++){
        contentType = contentTypes[i];
        for (const fileType in DuckDbDataSource.fileTypes){
          const fileTypeInfo = DuckDbDataSource.getFileTypeInfo(fileType);
          const mimeType = fileTypeInfo.mimeType;
          if (contentType === mimeType) {
            config.fileType = fileType;
            break _outer;
          }
        }
      }
      // if we couldn't identify a file type then we can try to examine the file to read a magic number.
      if (!config.fileType){
        switch (response.headers['accept-ranges']) {
          case 'bytes':
            const response = await DuckDbDataSource.getResourceInfoForUrl(url, 'GET', {
              "Accept": contentType,
              "Range": 'bytes=0-16'
            });
            const responseText = response.responseText;
            if (responseText.startsWith('SQLite format 3\0')) {
              config.type = DuckDbDataSource.types.SQLITE;
            }
            else
            if (responseText.substring(7, 7 + 'DUCK'.length) === 'DUCK') {
              config.type = DuckDbDataSource.types.DUCKDB;
            }
            if (config.type) {
              delete config.url;
            }
            break;
          case 'none':
          case undefined:
          default:
            // alas
        }
      }
    }

    const dsInstance = new DuckDbDataSource(duckdb, instance, config);
    return dsInstance;
  }

  static createFromFile(duckdb, instance, file) {
    if (!(file instanceof File)){
      throw new Error(`The file argument must be an instance of File`);
    }

    const fileName = file.name;
    const fileNameParts = DuckDbDataSource.getFileNameParts(fileName);
    const fileExtension = fileNameParts.lowerCaseExtension;
    const fileType = DuckDbDataSource.getFileTypeInfo(fileExtension);

    if (!fileType){
      throw new Error(`Could not determine filetype of file "${fileName}".`);
    }
    const config = {
      type: fileType.datasourceType,
      file: file,
      fileType: fileType
    };
    const dsInstance = new DuckDbDataSource(duckdb, instance, config);
    return dsInstance;
  }

  /**
   * Create a datasource from a cloud-fetched Blob (S3, GCS, etc.).
   * The caller is responsible for fetching the blob from the cloud provider.
   * @param {*} duckdb
   * @param {*} instance
   * @param {Blob} blob       - The fetched content as a Blob
   * @param {string} fileName - The synthetic file name (including extension) used by DuckDB
   * @param {string} [cloudUri] - Original URI for display purposes (e.g. "s3://bucket/key")
   * @returns {DuckDbDataSource}
   */
  static createFromBlob(duckdb, instance, blob, fileName, cloudUri) {
    if (!(blob instanceof Blob)) {
      throw new Error(`The blob argument must be an instance of Blob`);
    }
    if (typeof fileName !== 'string' || !fileName.length) {
      throw new Error(`A non-empty fileName is required`);
    }

    const fileNameParts = DuckDbDataSource.getFileNameParts(fileName);
    if (!fileNameParts) {
      throw new Error(`Could not determine filetype from fileName "${fileName}".`);
    }
    const fileExtension = fileNameParts.lowerCaseExtension;
    const fileType = DuckDbDataSource.getFileTypeInfo(fileExtension);
    if (!fileType) {
      throw new Error(`Unrecognized file extension "${fileExtension}" in fileName "${fileName}".`);
    }

    const config = {
      type: fileType.datasourceType,
      file: blob,
      fileName: fileName,
      fileType: fileType,
    };
    const dsInstance = new DuckDbDataSource(duckdb, instance, config);
    if (cloudUri) {
      dsInstance.#cloudUri = cloudUri;
    }
    return dsInstance;
  }

  static createFromSql(duckdb, instance, sql){
    const config = {
      type: DuckDbDataSource.types.SQLQUERY,
      sql: sql
    };
    const dsInstance = new DuckDbDataSource(duckdb, instance, config);
    return dsInstance;
  }

  setSqlQuery(sqlQuery){
    // TODO: verify if this is a "query" - a statement that yields a resultset
    // also, verify that this uses existing datasources.
    const oldSqlQuery = this.#sqlQuery;

    //TODO: compare normalized versions of the query
    if (oldSqlQuery === sqlQuery) {
      return;
    }

    this.#sqlQuery = sqlQuery;
    this.fireEvent('change', {
      'propertiesChanged': {
        previousValue: oldSqlQuery,
        newValue: sqlQuery
      }
    });
  }

  #init(config){
    const type = config.type;
    switch (type) {
      case DuckDbDataSource.types.DUCKDB:
      case DuckDbDataSource.types.SQLITE:
      case DuckDbDataSource.types.FILE:
        this.#fileRegistered = false;
        if (config.url){
          this.#url = config.url;
          this.#objectName = config.url;
          this.#fileType = config.fileType;
          this.#contentType = config.contentType;
        }
        else {
          const file = config.file;
          switch (typeof file) {
            case 'string':
              this.#objectName = config.file;
              break;
            case 'object':
              if (file instanceof File) {
                this.#objectName = file.name;
                this.#file = file;
                this.#fileProtocol = config.protocol || this.#duckDb.DuckDBDataProtocol.BROWSER_FILEREADER;
                break;
              }
              if (file instanceof Blob && config.fileName) {
                this.#objectName = config.fileName;
                this.#file = file;
                this.#fileProtocol = config.protocol || this.#duckDb.DuckDBDataProtocol.BROWSER_FILEREADER;
                break;
              }
            case 'undefined':
              if (config.fileName) {
                this.#objectName = config.fileName;
                break;
              }
            default:
              throw new Error(`Could not initialize the datasource of type ${type}: either file or filename must be specified`);
          }
          const parts = DuckDbDataSource.getFileNameParts(this.#objectName);
          this.#fileType = parts.lowerCaseExtension;
        }
        break;
      case DuckDbDataSource.types.FILES:
        const fileNames = config.fileNames;
        if (!fileNames) {
          throw new Error(`Invalid config: fileNames Array is mandatory`);
        }
        if (fileNames instanceof Array) {
          this.#fileNames = fileNames;
        }
        else {
          throw new Error(`Invalid config: fileNames must be an array`);
        }
        if (config.fileType){
          if (DuckDbDataSource.getFileTypeInfo(config.fileType) === undefined) {
            throw new Error(`Invalid config: fileType ${config.fileType} is not recognized.`);
          }
          this.#fileType = config.fileType;
        }
        else {
          throw new Error(`Invalid config: fileType is mandatory`);
        }
        break;
      case DuckDbDataSource.types.TABLE:
        this.#catalogName = config.catalogName;
        this.#schemaName = config.schemaName;
        this.#objectName = config.tableName || config.objectName;
        break;
      case DuckDbDataSource.types.VIEW:
        this.#catalogName = config.catalogName;
        this.#schemaName = config.schemaName;
        this.#objectName = config.viewName || config.objectName;
        break;
      case DuckDbDataSource.types.TABLEFUNCTION:
        this.#catalogName = config.catalogName;
        this.#schemaName = config.schemaName;
        this.#objectName = config.functionName || config.objectName;
        break;
      case DuckDbDataSource.types.SQLQUERY:
        this.#sqlQuery = config.sql;
        break;
      default:
        throw new Error(`Could not initialize the datasource: unrecognized type "${type}"`);
    }
    this.#type = type;
  }

  getType(){
    return this.#type;
  }

  getId(){
    const type = this.getType();
    let postFix;
    switch (type) {
      case DuckDbDataSource.types.FILE:
        const fileName = this.getFileName();
        const id = DuckDbDataSource.getDatasourceIdForFileName(fileName);
        return id;
      case DuckDbDataSource.types.FILES:
        postFix = JSON.stringify(this.#fileNames);
        break;
      case DuckDbDataSource.types.SQLQUERY:
        postFix = this.#sqlQuery;
        break;
      default:
        postFix = this.getQualifiedObjectName();
    }
    return `${type}:${postFix}`;
  }

  static parseId(datasourceId) {
    const parts = datasourceId.split(':');
    const type = parts.shift();
    const localId = parts.join(':');
    let unQuoted;
    let isUrl = false;
    if (isQuotedIdentifier(localId)){
      unQuoted = unQuoteIdentifier(localId);
      try {
        const _url = new URL(unQuoted);
        isUrl = true;
      }
      catch(_e){
      }
    }
    return {
      type: type,
      localId: localId,
      isUrl: isUrl,
      resource: unQuoted
    };
  }

  get isFileRegistered(){
    return Boolean(this.#fileRegistered);
  }

  async registerFile(){
    if (this.isFileRegistered === true) {
      return true;
    }

    const url = this.#url;
    const file = this.#file;
    let _promise;
    if (url){
      const _protocol = this.#fileProtocol || this.#duckDb.DuckDBDataProtocol.HTTP;
      if (!this.#fileType){
        const connection = await this.getConnection();
        const fileTypes = await DuckDbDataSource.#whatFileType(url, connection, this.#contentType);
        if (fileTypes) {
          if (fileTypes.length === 1){
            this.#fileType = fileTypes[0];
          }
          else {
            console.warn(`Found multiple possible filetypes for url "${url}": ${fileTypes.join(';')}`);
            this.#fileType = fileTypes[0];
          }
        }
      }
    }
    else
    if (file){
      if (!(file instanceof File) && !(file instanceof Blob)){
        throw new Error(`Configuration error: datasource of type ${DuckDbDataSource.types.FILE} needs to have a file handle set in order to register it.`);
      }
      const type = this.getType();
      switch (type){
        case DuckDbDataSource.types.DUCKDB:
        case DuckDbDataSource.types.FILE:
        case DuckDbDataSource.types.SQLITE:
          break;
        default:
          throw new Error(`Registerfile is not appropriate for datasources of type ${type}.`);
      }
      const protocol = this.#fileProtocol || this.#duckDb.DuckDBDataProtocol.BROWSER_FILEREADER;
      const fileName = (file instanceof File) ? file.name : this.#objectName;
      await this.#duckDbInstance.registerFileHandle(
        fileName,
        file,
        protocol
      );
    }

    this.#fileRegistered = true;
    return true;
  }

  #getRejectsCountSql(rejects_count_column){
    if (!this.#rejects_tables){
      return undefined;
    }
    const sql = `SELECT COUNT(*) as ${rejects_count_column} FROM ${this.#getRejectsTableName()}`;
    return sql;
  }

  #getRejectsSql(){
    if (!this.#rejects_tables){
      return undefined;
    }
    const rejectsScanTable = this.#getRejectsScanTableName();
    const rejectsTable = this.#getRejectsTableName();
    const sql = [
      'SELECT      row_number() over ()                             AS id',
      ',           max(s.scan_id)                                   AS max_scan_id',
      ',           s.file_path                                      AS filename',
      ',           r.line                                           AS line_position',
      ',           r.column_idx                                     AS column_position',
      ',           any_value(r.column_name)                         AS column_name',
      ',           byte_position - line_byte_position               AS error_position',
      ',           list(distinct error_type||\': \'||error_message) AS errors',
      ',           any_value(r.csv_line)                            AS csv_line',
      `FROM        ${rejectsScanTable}                              AS s`,
      `INNER JOIN  ${rejectsTable}                                  AS r`,
      'ON          s.scan_id = r.scan_id',
      'AND         s.file_id = r.file_id',
      'GROUP BY    s.file_path',
      ',           r.line',
      ',           byte_position',
      ',           line_byte_position',
      ',           r.column_idx',
      'ORDER BY    filename',
      ',           line_position',
      ',           column_position',
      ',           error_position'
    ].join('\n');
    return sql;
  }

  async getRejects(){
    const sql = this.#getRejectsSql();
    if (!sql){
      return undefined;
    }
    try {
      const connection = await this.getManagedConnection();
      const physicalConnection = await connection.getPhysicalConnection();

      const result = await physicalConnection.query(sql);
      return result;
    }
    catch (_e){
      return undefined;
    }
  }

  async clearRejects(){
    if (!this.#rejects_tables){
      return undefined;
    }
    try {
      const connection = await this.getManagedConnection();
      const physicalConnection = await connection.getPhysicalConnection();

      const promises = [];
      for (let i = 0; i < this.#rejects_tables.length; i++){
        const rejectsTable = this.#rejects_tables[i];
        const sql = `TRUNCATE TABLE ${getQuotedIdentifier(rejectsTable)}`;
        promises.push( physicalConnection.query(sql) );
      }
      await Promise.all( promises );

      this.#rejects_balance = 0n;
    }
    catch(_e){
      //
    }
  }

  async destroy(){
    const id = this.getId();
    try {
      this.fireEvent('destroy', {});

      if (this.#file) {
        await this.#duckDbInstance.dropFile(this.#file.name);
      }

      if (this.#rejects_tables){
        const connection = await this.getConnection();

        while(this.#rejects_tables.length) {
          const rejectsTable = this.#rejects_tables.pop();
          const sql = `DROP TABLE IF EXISTS ${getQuotedIdentifier(rejectsTable)}`;
          await connection.query(sql);
        }
      }

      if (this.#connection){
        await this.#connection.close();
      }
    }
    catch (error){
      console.error(`Error destroying datasource ${id}: ${error.message}`);
      console.error(error.stack);
    }
    finally {
      super.destroy();
      this.#duckDb = undefined;
      this.#duckDbInstance = undefined;

      this.#connection = undefined;
      this.#catalogName = undefined;
      this.#schemaName = undefined;
      this.#objectName = undefined;
      this.#file = undefined;
      this.#fileProtocol = undefined;
      this.#type = undefined;
      this.#columnMetadata = undefined;
      this.#alias = undefined;
      this.#sqlQuery = undefined;
      this.#rejects_tables = undefined;
    }
  }

  async validateAccess(){
    let result;
    try{
      const connection = await this.getConnection();
      const type = this.getType();
      let sql;
      switch (type){
        case DuckDbDataSource.types.FILE:
        case DuckDbDataSource.types.TABLE:
        case DuckDbDataSource.types.VIEW:
        case DuckDbDataSource.types.TABLEFUNCTION: {
          const fromClause = this.getFromClauseSql();
          sql = `SELECT * ${fromClause} LIMIT 1`;
          break;
        }
        case DuckDbDataSource.types.DUCKDB:
        case DuckDbDataSource.types.SQLITE: {
          const fileName = this.getFileName();
          const alias = this.#alias || this.getFileNameWithoutExtension();
          const quotedAlias = getQuotedIdentifier(alias);
          sql = `ATTACH '${fileName}' AS ${quotedAlias}`;
          if (type === DuckDbDataSource.types.SQLITE){
            sql += ` (TYPE SQLITE)`;
          }
          break;
        }
      }
      await this.registerFile();
      const _resultSet = await connection.query(sql);
      result = true;
    }
    catch(error){
      result = error;
    }
    return result;
  }
  
  async tryAccess(maxAttempts){
    switch (typeof maxAttempts){
      case undefined:
        maxAttempts = DuckDbDataSource.#defaultNumberOfAccessAttempts;
    }
    const _done = false;
    let success = false;
    let attempts = 0;
    let attempt;
    const datasourceType = this.getType();
    _attempts: while (attempts++ <= maxAttempts) {
      attempt = await this.validateAccess();
      if (attempt === true) {
        success = true;
        break;
      }
      const message = attempt.message;
      if (/^Out of Memory Error: failed to allocate data of size/.test(message)){
        break _attempts;
      }
      
      switch (datasourceType){
        case DuckDbDataSource.types.FILE:
        case DuckDbDataSource.types.FILES:
          const fileType = this.getFileType();
          const fileTypeInfo = DuckDbDataSource.getFileTypeInfo(fileType);
          const reader = fileTypeInfo.duckdb_reader;
          switch (reader){
            case 'read_json_auto':
              if (/"maximum_object_size" of \d+ bytes exceeded/.test(message)){
                const parts = /\(>(\d+) bytes\)/.exec(message);
                const newObjectSize = parseInt(parts[1], 10);
                this.#settings.assignSettings(['jsonReader', 'jsonReaderMaximumObjectSize'], newObjectSize);
              }
              else {
                // all adaptive measures failed, time to throw in the towel.
                break _attempts;
              }
              break;
            case 'read_csv':
            case 'read_parquet':
            case 'read_xlsx':
            default:
              // no adaptive measures implemented, time to throw in the towel.
              break _attempts;
          }
          break;
        default:
          break _attempts;
      }
    };
    return {
      success: success,
      attempts: attempts,
      maxAttempts: maxAttempts,
      lastAttempt: attempt
    };
  }

  getQualifiedObjectName(){
    let qualifiedObjectName;
    const type = this.getType();
    switch (type) {
      case DuckDbDataSource.types.DUCKDB:
      case DuckDbDataSource.types.FILE:
      case DuckDbDataSource.types.SQLITE:
        const fileName = this.#objectName;
        qualifiedObjectName = getQuotedIdentifier(fileName);
        break;
      case DuckDbDataSource.types.TABLE:
        {
          const catalogName = this.#catalogName;
          const schemaName = this.#schemaName;
          const tableName = this.#objectName;
          qualifiedObjectName = getQualifiedIdentifier(catalogName, schemaName, tableName);
        }
        break;
      case DuckDbDataSource.types.VIEW:
        {
          const catalogName = this.#catalogName;
          const schemaName = this.#schemaName;
          const viewName = this.#objectName;
          qualifiedObjectName = getQualifiedIdentifier(catalogName, schemaName, viewName);
        }
        break;
      case DuckDbDataSource.types.TABLEFUNCTION:
        {
          const catalogName = this.#catalogName;
          const schemaName = this.#schemaName;
          const functionName = this.#objectName;
          qualifiedObjectName = getQualifiedIdentifier(catalogName, schemaName, functionName);
        }
        break;
      default:
        throw new Error(`Invalid datasource type ${type} for getting a qualified object name.`);
    }
    return qualifiedObjectName;
  }

  #getRejectsScanTableName(quote){
    let tableName = this.#rejects_tables[0];
    if (quote){
      tableName = getQuotedIdentifier(tableName);
    }
    return tableName;
  }

  #getRejectsTableName(quote){
    let tableName = this.#rejects_tables[1];
    if (quote){
      tableName = getQuotedIdentifier(tableName);
    }
    return tableName;
  }

  #getDuckDbFileReaderCall(duckdb_reader, fileNames, settings){
    if (settings === undefined) {
      settings = this.#settings.getSettings();
    }
    let fileName;
    const duckdbReaderArguments = Object.assign({},
      DuckDbDataSource.duckdb_reader_arguments[duckdb_reader]
    );
    
    if (duckdbReaderArguments.rejects_scan && duckdbReaderArguments.rejects_table){
      this.#rejects_tables = [
        duckdbReaderArguments.rejects_scan,
        duckdbReaderArguments.rejects_table
      ];
    }

    if (fileNames instanceof Array) {
      fileName = '[' + fileNames.map((fileName) =>{
        return quoteStringLiteral(fileName);
      })
      .join(', ') + ']';
      duckdbReaderArguments.filename = true;
    }
    else
    if (typeof fileNames === 'string'){
      fileName = quoteStringLiteral(fileNames);
    }

    let readerArgumentsSql = DatasourceSettings.getReaderArgumentsSql(settings);
    if (readerArgumentsSql && readerArgumentsSql.length){
      readerArgumentsSql = `${fileName}, ${readerArgumentsSql}`;
    }
    else {
      readerArgumentsSql = fileName;
    }
    const readerSql = `${duckdb_reader}( ${readerArgumentsSql} )`;
    return readerSql;
  }

  getRelationExpression(alias, sqlOptions){
    sqlOptions = normalizeSqlOptions(sqlOptions);
    const _comma = getComma(sqlOptions.commaStyle);

    const identifierQuoter = function(identifier){
      return getIdentifier(identifier, sqlOptions.alwaysQuoteIdentifiers);
    }

    let sql = '';
    switch (this.getType()) {
      case DuckDbDataSource.types.FILES:
        {
          const fileType = DuckDbDataSource.getFileTypeInfo(this.#fileType);
          const duckdb_reader = fileType.duckdb_reader;
          const readerSettings = this.#settings.getReaderArguments(duckdb_reader);
          sql = this.#getDuckDbFileReaderCall(duckdb_reader, this.#fileNames, readerSettings);
        }
        break;
      case DuckDbDataSource.types.FILE:
        if (!this.#fileType) {
          const fileExtension = this.getFileExtension();
          this.#fileType = fileExtension;
        }
        {
          const fileType = DuckDbDataSource.getFileTypeInfo(this.#fileType);
          const fileName = this.getFileName();
          if (fileType) {
            const duckdb_reader = fileType.duckdb_reader;
            const readerSettings = this.#settings.getReaderArguments(duckdb_reader);
            sql = this.#getDuckDbFileReaderCall(duckdb_reader, fileName, readerSettings);
          }
          else {
            sql = getQuotedIdentifier(fileName);
          }
        }
        break;
      case DuckDbDataSource.types.SQLQUERY:
        sql = `( ${this.#sqlQuery} )`;
        break;
      case DuckDbDataSource.types.TABLE:
      case DuckDbDataSource.types.VIEW:
        {
          const qualifiedObjectName = this.getQualifiedObjectName();
          sql = qualifiedObjectName;
        }
        break;
      case DuckDbDataSource.types.TABLEFUNCTION:
        {
          const qualifiedObjectName = this.getQualifiedObjectName();
          sql = qualifiedObjectName;
          // TODO: add parameters
          sql += '()';
        }
        break;
    }

    if (!alias) {
      alias = this.#alias;
    }

    if (alias) {
      sql = `${sql} AS ${identifierQuoter(alias)}`;
    }
    return sql;
  }

  getFromClauseSql(alias, sqlOptions){
    sqlOptions = normalizeSqlOptions(sqlOptions);
    let sql = this.getRelationExpression(alias, sqlOptions);
    sql = `${formatKeyword('from', sqlOptions.keywordLetterCase)} ${sql}`;
    return sql;
  }

  getFileName(){
    const type = this.getType();
    switch (type){
      case DuckDbDataSource.types.DUCKDB:
      case DuckDbDataSource.types.FILE:
      case DuckDbDataSource.types.SQLITE:
        break;
      default:
        throw new Error(`getFileName() is not appropriate for datasources of type ${type}.`);
    }
    return this.#objectName;
  }

  #getFileNameParts(){
    const fileName = this.getFileName();
    return DuckDbDataSource.getFileNameParts(fileName);
  }

  getFileExtension(){
    const parts = this.#getFileNameParts();
    return parts.lowerCaseExtension;
  }

  getFileNameWithoutExtension(){
    const parts = this.#getFileNameParts();
    return parts.fileNameWithoutExtension;
  }

  getObjectName(){
    return this.#cloudUri || this.#objectName;
  }

  getSchemaName(){
    return this.#schemaName;
  }

  // this gets the datasource's own connection
  async getConnection(){
    if (this.#connection === undefined) {
      this.#connection = await this.createNewConnection();
    }
    return this.#connection;
  }

  // this creates a new connection.
  // the difference with getConnection is that createNewConnection is not cached and meant to be managed by the caller
  async createNewConnection(){
    return this.#duckDbInstance.connect();
  }

  createManagedConnection(){
    const managedConnection = new DuckDbConnection(this.#duckDbInstance);
    return managedConnection;
  }

  async #queryExecutionListener(event){
    const _managedConnection = event.currentTarget;
    const eventData = event.eventData;
    switch (event.type){
      case 'beforequery':

        break;
      case 'afterquery':
        const rejects_count_column = 'rejects_count';
        const sql = this.#getRejectsCountSql(rejects_count_column);
        if (sql === undefined) {
          return;
        }
        const physicalConnection = eventData.physicalConnection;
        const result = await physicalConnection.query(sql);
        const new_reject_count = result.get(0)[rejects_count_column];
        if (new_reject_count !== this.#reject_count ) {
          const new_reject_balance = new_reject_count - this.#reject_count;
          this.fireEvent('rejectsdetected', {
            old_reject_count: this.#reject_count,
            new_reject_count: new_reject_count,
            old_reject_balance: this.#rejects_balance,
            new_reject_balance: new_reject_balance,
          });
          this.#reject_count = new_reject_count;
          this.#rejects_balance = new_reject_balance;
        }
        break;
    }
  }

  supportsRejectsDetection(){
    switch (this.getType()){
      case DuckDbDataSource.types.FILES:
      case DuckDbDataSource.types.FILE:
        break;
      default:
        return false;
    }
    const fileExtension = this.#fileType;
    const fileType = DuckDbDataSource.getFileTypeInfo(fileExtension);
    const duckdb_reader = fileType.duckdb_reader;
    const reader_arguments = DuckDbDataSource.duckdb_reader_arguments[duckdb_reader];
    if (!reader_arguments){
      return false;
    }
    return Boolean(reader_arguments.store_rejects);
  }

  /**
   * Get normalized file type/extension used to pick DuckDB reader options.
   * @returns {string|undefined}
   */
  getFileType(){
    return this.#fileType;
  }

  getFileSize(){
    if (!this.#file){
      throw new Error(`Not a file!`);
    }
    const fileSize = this.#file.size;
    return fileSize;
  }

  /**
   * Export file statistics from DuckDB for an already-registered file datasource.
   * @returns {Promise<Object>}
   */
  async getFileStatistics(){
    const type = this.getType();
    const expectedType = DuckDbDataSource.types.FILE;
    if (type !== expectedType){
      throw new Error(`Cannot get file statistics from datasource of type "${type}", expected type "${expectedType}".`);
    }
    if (this.isFileRegistered !== true){
      await this.registerFile();
    }
    const duckDbInstance = this.#duckDbInstance;
    const fileName = this.#objectName;
    return duckDbInstance.exportFileStatistics(fileName);
  }

  getManagedConnection(){
    if (this.#managedConnection === undefined){
      this.#managedConnection = this.createManagedConnection();
      if (this.supportsRejectsDetection()){
        this.#managedConnection.addEventListener('beforequery', this.#queryExecutionListener.bind(this));
        this.#managedConnection.addEventListener('afterquery', this.#queryExecutionListener.bind(this));
      }
    }
    return this.#managedConnection;
  }

  async query(sql){
    const connection = await this.getConnection();
    const result = await connection.query(sql);
    return result;
  }

  async prepareStatement(sql){
    const connection = await this.getConnection();
    const preparedStatement = await connection.prepare(sql);
    return preparedStatement;
  }

  #getSqlForDataProfile(sampleSize) {
    const _qualifiedObjectName = this.getQualifiedObjectName();
    const fromClause = this.getFromClauseSql();
    let sql = `SUMMARIZE SELECT * ${fromClause}`;
    if (sampleSize) {
      let sampleSpecification;
      switch (typeof sampleSize){
        case 'number':
          const iSampleSize = parseInt(sampleSize, 10);
          if (iSampleSize === sampleSize){
            sampleSpecification = `${sampleSize} ROWS`;
          }
          else
          if (sampleSize < 1 && sampleSize >= 0) {
            sampleSpecification = `${sampleSize * 100} PERCENT`;
          }
          else {
            throw new Error(`Invalid value for sampleSize ${sampleSize}`);
          }
          break;
        default:
          throw new Error(`Invalid type for sampleSize`);
      }
      sql += ` USING SAMPLE ${sampleSpecification}`;
    }
    return sql;
  }

  async getProfileData(sampleSize){
    if (sampleSize === undefined){
      sampleSize = this.#defaultSampleSize;
    }
    const sql = this.#getSqlForDataProfile(sampleSize);
    const connection = await this.getConnection();
    const resultset = connection.query(sql);
    return resultset;
  }

  getSqlForTableSchema(){
    const fromClause = this.getFromClauseSql();
    const sql = `DESCRIBE SELECT * ${fromClause}`;
    return sql;
  }

  /**
   * Describe columns for this datasource and cache the result.
   * @returns {Promise<Object>}
   */
  async getColumnMetadata(){
    if (this.#columnMetadata) {
      return this.#columnMetadata;
    }

    const sql = this.getSqlForTableSchema();
    const connection = await this.getConnection();
    await this.registerFile();
    let columnMetadata;
    try {
      columnMetadata = await connection.query(sql);
    }
    catch (e) {
      showErrorDialog(e);
      throw e;
    }
    this.#columnMetadata = columnMetadata;
    return columnMetadata;
  }
}
