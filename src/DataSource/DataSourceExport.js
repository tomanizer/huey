/**
 * Export/download utilities extracted from DataSourcesUi.
 * Contains the datasource export menu, format prompt, and settings builder.
 */

import { DuckDbDataSource } from './duckdb/DuckDbDataSource.js';
import { PromptUi } from '../PromptUi/PromptUi.js';
import { settings } from '../SettingsDialog/SettingsDialog.js';

export const datasourceExportMenuId = 'datasourceExportMenu';

/**
 * Generate the HTML for the file type selection menu used during export.
 * @param {string} [fromFileType] - The source file type to optionally filter
 * @param {boolean} [includeFromFileType=true] - Whether to include the source file type in the menu
 * @returns {string} HTML string for the menu
 */
export function getDownloadMenuHTML(fromFileType, includeFromFileType) {
  const fileTypes = Object.keys(DuckDbDataSource.fileTypes)
    .filter((fileType) => {
      if (fromFileType) {
        switch (fileType) {
          case fromFileType:
            return includeFromFileType !== false;
        }
      }
      return true;
    });
  const menuItems = fileTypes.sort().map((fileType) => {
    const id = `fileType-${fileType}`;
    return `
        <li role="menuitem">
          <input
            type="radio"
            name="fileTypes"
            value="${fileType}"
            id="${id}"
          />
          <label for="${id}">${fileType}</label>
        </li>
      `;
  });
  const menu = `
      <menu class="fileTypes" id="${datasourceExportMenuId}">
        ${menuItems.join('\n')}
      </menu>
    `;
  return menu;
}

/**
 * Show a prompt dialog asking the user to select an export file format.
 * @param {string} [fromFileType] - The source file type
 * @param {boolean} [includeFromFileType=true] - Whether to include the source type
 * @returns {Promise<string|undefined>} The selected file type, or undefined if cancelled
 */
export async function promptExportDataFormat(fromFileType, includeFromFileType) {
  const menu = getDownloadMenuHTML(fromFileType, includeFromFileType);
  const result = await PromptUi.show({
    title: 'Export Datasource',
    contents: menu,
    allowUnsafeHtml: true
  });

  if (result !== 'accept') {
    return undefined;
  }
  const selectedItemCss = `menu#${datasourceExportMenuId} > li > input[type=radio]:checked`;
  const selected = document.querySelector(selectedItemCss);
  if (!selected) {
    return undefined;
  }
  const fileType = selected.value;
  return fileType;
}

/**
 * Build the export settings object for a given target file type.
 * @param {string} targetFileType - The file type to export to (e.g., 'csv', 'parquet', 'sqlite')
 * @returns {Object} Export settings object with type flags and merged user settings
 */
export function getDatasourceExportSettings(targetFileType) {
  const fileTypeInfo = DuckDbDataSource.getFileTypeInfo(targetFileType);
  let exportType = null;
  let exportDelimited = false;
  let exportJson = false;
  let exportParquet = false;
  let exportSqlite = false;
  let exportDuckdb = false;
  let exportXlsx = false;

  switch (targetFileType) {
    case 'sqlite':
      exportType = 'exportSqlite';
      exportSqlite = true;
      break;
    case 'duckdb':
      exportType = 'exportDuckdb';
      exportDuckdb = true;
      break;
    default:
      switch (fileTypeInfo.duckdb_reader) {
        case 'read_csv':
          exportType = 'exportDelimited';
          exportDelimited = true;
          break;
        case 'read_json':
          exportType = 'exportJson';
          exportJson = true;
          break;
        case 'read_parquet':
          exportType = 'exportParquet';
          exportParquet = true;
          break;
        case 'read_xlsx':
          exportType = 'exportXlsx';
          exportXlsx = true;
          break;
      }
  }
  const exportSettings = Object.assign(
    {}, settings.getSettings('exportUi'), {
    exportDestinationFile: true,
    exportDestinationClipboard: false,
    exportType: exportType,
    exportDelimited: exportDelimited,
    exportJson: exportJson,
    exportParquet: exportParquet,
    exportSqlite: exportSqlite,
    exportDuckdb: exportDuckdb,
    exportXlsx: exportXlsx,
  });
  return exportSettings;
}

/**
 * Get a display caption for a datasource based on its type.
 * @param {Object} datasource - The datasource object
 * @returns {string} A human-readable caption
 */
export function getCaptionForDatasource(datasource) {
  const type = datasource.getType();
  switch (type) {
    case DuckDbDataSource.types.DUCKDB:
    case DuckDbDataSource.types.SQLITE:
    case DuckDbDataSource.types.FILE:
      return datasource.getFileNameWithoutExtension();
    case DuckDbDataSource.types.TABLE:
    case DuckDbDataSource.types.TABLEFUNCTION:
    case DuckDbDataSource.types.VIEW:
      return datasource.getObjectName();
    case 'remote':
      return `${datasource.getBaseUrl()} — ${datasource.getDatasetId()}`;
    default:
      return datasource.getId();
  }
}

/**
 * Sort a datasources object by caption.
 * @param {Object} datasources - Object keyed by datasource ID
 * @returns {Object} New object with same keys, sorted by caption
 */
export function sortDatasources(datasources) {
  const datasourceKeys = Object.keys(datasources);
  datasourceKeys
    .sort((a, b) => {
      const datasourceA = getCaptionForDatasource(datasources[a]);
      const datasourceB = getCaptionForDatasource(datasources[b]);
      if (datasourceA > datasourceB) {
        return 1;
      }
      else if (datasourceA < datasourceB) {
        return -1;
      }
      return 0;
    });
  return datasourceKeys.reduce((sortedDatasources, datasourceKey) => {
    sortedDatasources[datasourceKey] = datasources[datasourceKey];
    return sortedDatasources;
  }, {});
}
