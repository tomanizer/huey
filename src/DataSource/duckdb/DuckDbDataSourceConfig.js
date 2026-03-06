/**
 * Static configuration for DuckDB data source types and file type definitions.
 * Extracted from DuckDbDataSource to improve modularity.
 */

/**
 * Datasource type constants.
 */
export const datasourceTypes = {
  "DUCKDB": 'duckdb',
  "FILE": 'file',
  "FILES": 'files',
  "SQLITE": 'sqlite',
  "SQLQUERY": 'sql',
  "TABLE": 'table',
  "TABLEFUNCTION": 'table function',
  "URL": 'url',
  "VIEW": 'view'
};

/**
 * Supported file type definitions with their DuckDB readers and MIME types.
 */
export const fileTypeDefinitions = {
  "csv": {
    datasourceType: datasourceTypes.FILE,
    duckdb_reader: 'read_csv',
    duckdb_sniffer: 'sniff_csv',
    reader_arguments_settings_key: 'csvReader',
    mimeType: 'text/csv'
  },
  "tsv": {
    datasourceType: datasourceTypes.FILE,
    duckdb_reader: 'read_csv',
    duckdb_sniffer: 'sniff_csv',
    reader_arguments_settings_key: 'csvReader',
    mimeType: 'text/tab-separated-values'
  },
  "txt": {
    datasourceType: datasourceTypes.FILE,
    duckdb_reader: 'read_csv',
    duckdb_sniffer: 'sniff_csv',
    reader_arguments_settings_key: 'csvReader',
    mimeType: 'text/plain'
  },
  "json": {
    datasourceType: datasourceTypes.FILE,
    duckdb_reader: 'read_json_auto',
    duckdb_extension: 'json',
    mimeType: 'application/json'
  },
  "jsonl": {
    datasourceType: datasourceTypes.FILE,
    duckdb_reader: 'read_json_auto',
    duckdb_extension: 'json',
    mimeType: 'application/json'
  },
  "parquet": {
    datasourceType: datasourceTypes.FILE,
    duckdb_reader: 'read_parquet',
    mimeType: 'application/vnd.apache.parquet'
  },
  "xlsx": {
    datasourceType: datasourceTypes.FILE,
    duckdb_reader: 'read_xlsx',
    duckdb_extension: 'excel',
    //duckdb_extension_repository: 'core_nightly',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  },
  "duckdb": {
    datasourceType: datasourceTypes.DUCKDB,
    mimeType: 'application/vnd.duckdb'
  },
  "sqlite": {
    datasourceType: datasourceTypes.SQLITE,
    duckdb_extension: 'sqlite_scanner',
    mimeType: 'application/vnd.sqlite3'
  }
};

/**
 * Default reader arguments per DuckDB reader function.
 */
export const readerArguments = {
  read_csv: {
    // https://duckdb.org/docs/data/csv/reading_faulty_csv_files.html#retrieving-faulty-csv-lines
    //"ignore_errors" : true,
    "store_rejects" : false
    //"rejects_scan": 'reject_scans',
    //"rejects_table": 'reject_errors',
    //"rejects_limit": 0
  },
  sniff_csv: {
    "sample_size": 20480
  },
  read_json_auto: {
    "ignore_errors": true,
    "maximum_object_size": 16777216
  }
};

/**
 * Parse a filename into its extension parts.
 * @param {string|File} fileName - The filename or File object
 * @returns {{ extension: string, lowerCaseExtension: string, fileNameWithoutExtension: string } | undefined}
 */
export function getFileNameParts(fileName){
  if (fileName instanceof File) {
    fileName = fileName.name;
  }

  const separator = '.';
  const fileNameParts = fileName.split( separator );
  if (fileNameParts.length < 2){
    return undefined;
  }
  const extension = fileNameParts.pop();
  const lowerCaseExtension = extension.toLowerCase();
  const fileNameWithoutExtension = fileNameParts.join( separator );
  return {
    extension: extension,
    lowerCaseExtension: lowerCaseExtension,
    fileNameWithoutExtension: fileNameWithoutExtension
  };
}

/**
 * Get the file type info for a given extension.
 * @param {string} fileType - File extension (e.g., 'csv', 'parquet')
 * @returns {Object|undefined}
 */
export function getFileTypeInfo(fileType){
  return fileTypeDefinitions[fileType];
}

/**
 * Perform an HTTP request (HEAD/GET) to retrieve resource info.
 * @param {string} url - The URL to query
 * @param {string} [httpMethod='GET'] - HTTP method
 * @param {Object} [requestHeaders] - Additional headers
 * @returns {Promise<{headers: Object, status: number, statusText: string, responseType: string, responseText: string}>}
 */
export async function getResourceInfoForUrl(url, httpMethod, requestHeaders){
  return new Promise((resolve, reject) =>{
    try {
      const xhr = new XMLHttpRequest();
      xhr.addEventListener("error", (progressEvent) =>{
        const status = xhr.status;
        let message = 'XHR emitted error event.'
        if (status === 0){
          message += [
            '',
            'The server may not be available, or the request may have failed due to same origin policy / missing CORS header.',
            'The network tab in your browser\'s development tools may reveal additional information.'
          ].join(' ')
          ;
        }
        else {
          message += ` HTTP ${xhr.status} - ${xhr.statusText}`;
        }
        const error = new Error(message, {
          cause: progressEvent
        });
        reject(error);
      });

      xhr.addEventListener("load", () =>{
        const allResponseHeaders = xhr.getAllResponseHeaders();
        const headersArray = allResponseHeaders.split('\r\n');
        const headers = headersArray.reduce((headers, header) =>{
          const nameValue = header.split(':');
          let name = nameValue.shift().trim();
          if (name.length) {
            name = name.toLowerCase();
            const value = nameValue.join(':').trim();
            headers[name] = value;
          }
          return headers;
        }, {});
        resolve({
          headers: headers,
          status: xhr.status,
          statusText: xhr.statusText,
          responseType: xhr.responseType,
          responseText: xhr.responseText
        });
      });

      xhr.open(httpMethod || 'GET', url);
      if (requestHeaders){
        for (const requestHeader in requestHeaders){
          xhr.setRequestHeader(requestHeader, requestHeaders[requestHeader]);
        }
      }
      xhr.send();
    }
    catch(e){
      reject(e);
    }
  });
}

/**
 * Glob path pattern for detecting wildcard paths.
 */
export const globPathPattern = /[*?\[\]]/;
