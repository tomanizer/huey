import { EventEmitter } from '../util/event/EventEmitter.js';
import { byId, instantiateTemplate } from '../util/dom/dom.js';
import { settings } from '../SettingsDialog/SettingsDialog.js';
import { DuckDbDataSource } from './duckdb/DuckDbDataSource.js';
import { Internationalization } from '../Internationalization/Internationalization.js';
import { getQuotedIdentifier } from '../util/sql/SQLHelper.js';
import { showErrorDialog } from '../ErrorDialog/ErrorDialog.js';
import { ExportUi } from '../ExportUi/ExportDialog.js';
import { uploadUi, afterUploaded } from '../UploadUi/UploadUi.js';
import { analyzeDatasource } from '../App/analyzeDatasource.js';
import { datasourceSettingsDialog } from '../DatasourceSettingsDialog/DatasourceSettingsDialog.js';
import { getConnection, getDatabase, getDuckDbModule } from './duckdb/database.js';
import {
  datasourceExportMenuId,
  getDownloadMenuHTML as _getDownloadMenuHTML,
  promptExportDataFormat as _promptExportDataFormat,
  getDatasourceExportSettings as _getDatasourceExportSettings,
  getCaptionForDatasource as _getCaptionForDatasource,
  sortDatasources as _sortDatasources,
} from './DataSourceExport.js';

export class DataSourcesUi extends EventEmitter {


  #id = undefined;
  #datasources = {};

  constructor(id){
    super(['change']);
    this.#id = id;

    const dom = this.getDom();
    const domParent = dom.parentNode;
    domParent.addEventListener('dragenter', this.#dragEnterHandler.bind(this));
    domParent.addEventListener('dragleave', this.#dragLeaveHandler.bind(this));
    domParent.addEventListener('dragover', this.#dragOverHandler.bind(this));
    domParent.addEventListener('drop', this.#dropHandler.bind(this));
  }

  #dragEnterHandler(event) {
    const dataTransfer = event.dataTransfer;
    dataTransfer.dropEffect = 'copy';
    this.getDom().setAttribute('data-drop-allowed', true);
    event.stopPropagation();
    event.preventDefault();
  }

  #dragLeaveHandler(event) {
    event.stopPropagation();
    event.preventDefault();
    this.getDom().setAttribute('data-drop-allowed', '');
  }

  #dragOverHandler(event) {
    event.stopPropagation();
    event.preventDefault();

    const dataTransfer = event.dataTransfer;
  }

  async #dropHandler(event) {
    event.preventDefault();
    event.stopPropagation();
    const dataTransfer = event.dataTransfer;
    const files = dataTransfer.files;
    const items = dataTransfer.items;
    let uploadResults;
    if (files.length) {
      uploadResults = await uploadUi.uploadFiles(files);
      afterUploaded(uploadResults);
    }
    else
    if (items.length){
      for (let i = 0 ; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== 'string') {
          continue;
        }
        if (item.type !== 'text/uri-list'){
          continue;
        }

        // TODO: we should do something here to makr these data sources as URLs, not "files"
        item.getAsString(async (uri) =>{
          uploadResults = await uploadUi.uploadFiles([uri]);
          afterUploaded(uploadResults);
        });

        // support only 1 url at a time.
        return;
      }
    }
  }

  getDom(){
    return byId(this.#id);
  }

  clear(content){
    const dom = this.getDom();
    dom.replaceChildren();
    if (!content) {
      return;
    }
    if (typeof content === 'string') {
      dom.textContent = content;
      return;
    }
    dom.appendChild(content);
  }

  #getLooseColumnType(columnType){
    const datasourceSettings = settings.getSettings('datasourceSettings');
    const looseColumnTypes = datasourceSettings.looseColumnTypes;
    let comparisonColumnType = undefined;
    for (const looseType in looseColumnTypes){
      const columnTypes = looseColumnTypes[looseType];
      if (columnTypes.indexOf(columnType) === -1) {
        continue;
      }
      comparisonColumnType = looseType;
    }
    if (comparisonColumnType === undefined) {
      comparisonColumnType = columnType;
    }
    return comparisonColumnType;
  }

  async #getTabularDatasourceTypeSignature(datasource){
    let typeSignature;
    const type  = datasource.getType();
    const fileType = datasource.getFileExtension();
    const columnMetadata = await datasource.getColumnMetadata();
    const columnMetadataSerialized = {};
    const datasourceSettings = settings.getSettings('datasourceSettings');
    const useLooseColumnComparisonType = datasourceSettings.useLooseColumnTypeComparison;
    const looseColumnTypes = datasourceSettings.looseColumnTypes;
    for (let i = 0; i < columnMetadata.numRows; i++){
      const row = columnMetadata.get(i);

      const columnType = row.column_type;
      const comparisonColumnType = useLooseColumnComparisonType ? this.#getLooseColumnType(columnType) : columnType;
      columnMetadataSerialized[row.column_name] = comparisonColumnType;
    }
    const columnMetadataSerializedJSON = JSON.stringify(columnMetadataSerialized);
    typeSignature = `${type}:${fileType}:${columnMetadataSerializedJSON}`;
    return typeSignature;
  }

  async #renderDatasources(){
    this.clear();
    let node, group, potentialGroups = {};
    const datasources = this.#datasources;

    const groupingPromises = Object.keys(datasources).map(async (datasourceId) =>{
      const datasource = datasources[datasourceId];
      const type = datasource.getType();

      let group = undefined;
      switch (type){
        case DuckDbDataSource.types.FILE:
          const typeSignature = await this.#getTabularDatasourceTypeSignature(datasource);
          group = potentialGroups[typeSignature];
          if (!group) {
            potentialGroups[typeSignature] = group = {
              type: DuckDbDataSource.types.FILE,
              fileType: datasource.getFileExtension(),
              typeSignature: typeSignature,
              datasources: {}
            };
          }
          break;
        case DuckDbDataSource.types.TABLE:
        case DuckDbDataSource.types.VIEW:
          // noop. these are rendered by the respective database datasource node.
          return;
        case DuckDbDataSource.types.DUCKDB:
        case DuckDbDataSource.types.SQLITE:
        default:
          group = potentialGroups[type];
          if (!group){
            potentialGroups[type] = group = {
              type: type,
              datasources: {}
            };
          }
      }
      group.datasources[datasourceId] = datasource;
      return true;
    });
    await Promise.all(groupingPromises);

    this.#createDataSourceGroupNode(potentialGroups[DuckDbDataSource.types.DUCKDB]);
    delete potentialGroups[DuckDbDataSource.types.DUCKDB];

    this.#createDataSourceGroupNode(potentialGroups[DuckDbDataSource.types.SQLITE]);
    delete potentialGroups[DuckDbDataSource.types.SQLITE];

    for (const groupId in potentialGroups){
      const group = potentialGroups[groupId];
      const datasources = group.datasources;
      const datasourceKeys = Object.keys(datasources);
      if (datasourceKeys.length === 1) {
        const datasourceKey = datasourceKeys[0]
        const datasource = datasources[datasourceKey];
        const datasourceType = datasource.getType();
        let miscGroup = potentialGroups[datasourceType];
        if (!miscGroup) {
          miscGroup = potentialGroups[datasourceType] = {
            type: datasourceType,
            datasources: {}
          }
        }
        miscGroup.datasources[datasource.getId()] = datasource;
        if (miscGroup !== group) {
          delete potentialGroups[groupId];
        }
      }
      else {
        this.#createDataSourceGroupNode(group);
        delete potentialGroups[groupId];
      }
    }

    this.#createDataSourceGroupNode(potentialGroups[DuckDbDataSource.types.FILE], true);
    delete potentialGroups[DuckDbDataSource.types.FILE];

    for (var remainingId in potentialGroups) {
      this.#createDataSourceGroupNode(potentialGroups[remainingId]);
    }

    // TODO: pass some data that tells listeners why we rerendered
    this.fireEvent('change', {});
  }

  static getCaptionForDatasource(datasource){
    return _getCaptionForDatasource(datasource);
  }

  #renderDatasourceActionButton(config){
    const actionButton = instantiateTemplate('dataSourceGroupNodeActionButton');
    actionButton.setAttribute('class', config.className ? (typeof config.className instanceof Array ? config.className.join(' ') : config.className ) : '');
    actionButton.setAttribute('for', config.id);
    actionButton.setAttribute('title', config.title);
    
    const button = actionButton.querySelector('button');
    button.setAttribute('id', config.id);
    
    const events = config.events;
    if (events) {
      for (const eventName in events) {
        const handler = events[eventName];
        button.addEventListener(eventName, handler);
      }
    }
    return actionButton;
  }

  #createDatasourceNodeAnalyzeActionButton(datasourceId, summaryElement){
    const actionButton = this.#renderDatasourceActionButton({
      id: datasourceId + '_analyze',
      "className": "analyzeActionButton",
      popovertarget: 'uploadUi',
      popovertargetaction: 'hide',
      title: Internationalization.getText('Open {1} in the Query editor', datasourceId),
      events: {
        click: this.#analyzeDatasourceClicked.bind(this)
      }
    });
    if (summaryElement) {
      summaryElement.appendChild(actionButton);
    }
    return actionButton;
  }
  
  #createDatasourceNodeRemoveActionButton(datasourceId, summaryElement){
    const actionButton = this.#renderDatasourceActionButton({
      id: datasourceId + '_remove',
      "className": "removeActionButton",
      popovertarget: 'uploadUi',
      popovertargetaction: 'hide',
      title: Internationalization.getText('Remove datasource {1}', datasourceId),
      events: {
        click: this.#removeDatasourceClicked.bind(this)
      }
    });
    if (summaryElement) {
      summaryElement.appendChild(actionButton);
    }
    return actionButton;
  }

  #createDatasourceNodeEditActionButton(datasourceId, summaryElement){
    const actionButton = this.#renderDatasourceActionButton({
      id: datasourceId + '_edit',
      "className": "editActionButton",
      popovertarget: 'uploadUi',
      popovertargetaction: 'hide',
      title: Internationalization.getText('Configure datasource details of {1}', datasourceId),
      events: {
        click: this.#configureDatasourceClicked.bind(this)
      }
    });
    if (summaryElement) {
      summaryElement.appendChild(actionButton);
    }
    return actionButton;
  }

  #createDatasourceNodeDownloadActionButton(datasourceId, summaryElement){
    const actionButton = this.#renderDatasourceActionButton({
      id: datasourceId + '_download',
      "className": "downloadActionButton",
      popovertarget: 'uploadUi',
      popovertargetaction: 'hide',
      title: Internationalization.getText('Download the contents of datasource {1} to a file.', datasourceId),
      events: {
        click: this.#downloadDatasourceClicked.bind(this)
      }
    });
    if (summaryElement) {
      summaryElement.appendChild(actionButton);
    }
    return actionButton;
  }

  #createDatasourceNodeActionButtons(datasourceId, summaryElement) {
    this.#createDatasourceNodeAnalyzeActionButton(datasourceId, summaryElement)
    this.#createDatasourceNodeRemoveActionButton(datasourceId, summaryElement);
    this.#createDatasourceNodeEditActionButton(datasourceId, summaryElement);
    this.#createDatasourceNodeDownloadActionButton(datasourceId, summaryElement);
  }

  async #loadDatabaseDatasource(databaseDatasource){
    const catalogName = databaseDatasource.getFileNameWithoutExtension();
    const connection = getConnection();
    const sql = `
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_catalog = ?
      AND   table_schema NOT IN ('information_schema', 'pg_catalog')
      ORDER BY table_schema, table_name
    `;
    const statement = await connection.prepare(sql);
    const result = await statement.query(catalogName);
    statement.close();

    const datasourceId = databaseDatasource.getId();
    const datasourceTreeNode = byId(datasourceId);

    const schemaNodes = {};
    for (let i = 0; i < result.numRows; i++){
      let summary, label;

      const row = result.get(i);
      const schemaName = row.table_schema;
      let schemaNode = schemaNodes[schemaName];
      if (schemaNode === undefined) {
        schemaNode = instantiateTemplate('dataSourceSchemaNode', datasourceId + ':' + schemaName);
        schemaNode.setAttribute('title', schemaName);
        schemaNode.setAttribute('data-catalog-name', catalogName);
        schemaNode.setAttribute('data-schema-name', catalogName);
        schemaNode.querySelector('span.label').textContent = schemaName;
        schemaNodes[schemaName] = schemaNode;
        datasourceTreeNode.appendChild(schemaNode);
      }
      const tableName = row.table_name;
      const tableType = row.table_type;
      let datasourcetype;
      switch (tableType){
        case 'BASE TABLE':
          datasourcetype = DuckDbDataSource.types.TABLE;
          break;
        case 'VIEW':
          datasourcetype = DuckDbDataSource.types.VIEW;
          break;
      }

      const tableDatasourceId = `${datasourceId}:${getQuotedIdentifier(schemaName)}:${getQuotedIdentifier(tableName)}`;
      let datasource = this.getDatasource(tableDatasourceId);
      if (!datasource) {
        datasource = new DuckDbDataSource(getDuckDbModule(), getDatabase(), {
          type: datasourcetype,
          catalogName: catalogName,
          schemaName: schemaName,
          objectName: tableName
        });
        this.#addDatasource(datasource);
      }

      const tableNode = this.#createDatasourceNode(datasource);
      schemaNode.appendChild(tableNode);
    }
  }

  async #loadDatasource(datasource) {
    switch (datasource.getType()){
      case DuckDbDataSource.types.FILE:
        // noop, files can't be expanded.
        break;
      case DuckDbDataSource.types.DUCKDB:
      case DuckDbDataSource.types.SQLITE:
        this.#loadDatabaseDatasource(datasource);
        break;
      default:
        console.error(`Don't know how to load datasource ${datasource.getId()} of type ${datasource.getType()}`);
    }
  }

  #toggleDataSource(event){
    const target = event.target;

    const oldState = event.oldState;
    const newState = event.newState;

    if (oldState !== 'closed' || newState !== 'open' || target.getElementsByTagName('details').length !== 0) {
      return;
    }

    const datasource = this.#getDatasourceForTreeNode(target);
    this.#loadDatasource(datasource);
  }

  #createDatasourceNode(datasource, attributes){
    const caption = DataSourcesUi.getCaptionForDatasource(datasource);

    const type = datasource.getType();
    const datasourceId = datasource.getId();
    
    const datasourceNode = instantiateTemplate('dataSourceNode', datasourceId);
    datasourceNode.setAttribute('data-datasourcetype', type);
    datasourceNode.setAttribute('title', caption);
    
    const summary = datasourceNode.querySelector('summary');
    const label = summary.querySelector('span.label');
    label.textContent = caption;
    
    if (attributes){
      for (const attributeName in attributes){
        datasourceNode.setAttribute(attributeName, attributes[attributeName]);
      }
    }

    switch (type) {
      case DuckDbDataSource.types.DUCKDB:
      case DuckDbDataSource.types.SQLITE:
        datasourceNode.addEventListener('toggle', this.#toggleDataSource.bind(this));
        break;
      default:
        // noop.
    }

    let extension;
    if (type === DuckDbDataSource.types.FILE) {
      extension = datasource.getFileExtension();
      datasourceNode.setAttribute('data-filetype', extension);
    }

    
    switch (type) {
      case DuckDbDataSource.types.DUCKDB:
        this.#createDatasourceNodeRemoveActionButton(datasourceId, summary);
        break;
      case DuckDbDataSource.types.TABLE:
      case DuckDbDataSource.types.VIEW:
        this.#createDatasourceNodeAnalyzeActionButton(datasourceId, summary);
        this.#createDatasourceNodeDownloadActionButton(datasourceId, summary);
        break;
      case 'remote':
        this.#createDatasourceNodeAnalyzeActionButton(datasourceId, summary);
        this.#createDatasourceNodeRemoveActionButton(datasourceId, summary);
        break;
      default:
        this.#createDatasourceNodeActionButtons(datasourceId, summary);
    }
    return datasourceNode;
  }

  #getTreeNodeFromClickEvent(event){
    const button = event.target;
    const label = button.parentNode;
    const summary = label.parentNode;
    const node = summary.parentNode;
    return node;
  }

  #getDatasourceForTreeNode(datasourceTreeNode) {
    const dataSourceId = datasourceTreeNode.id;
    const datasource = this.getDatasource(dataSourceId);
    return datasource;
  }

  #rejectsDetectedHandler(event){
    const eventData = event.eventData;
    const datasource = event.currentTarget;
    const id = datasource.getId();
    const datasourceNode = document.getElementById(id);
    const new_reject_balance = eventData.new_reject_balance;
    const old_reject_balance = eventData.old_reject_balance;
    let balanceAttribute;
    if (new_reject_balance >= 0){
      balanceAttribute = new_reject_balance;
      datasourceNode.setAttribute('data-reject_count', balanceAttribute);
    }
    else {
      balanceAttribute = 0;
      datasourceNode.removeAttribute('data-reject_count');
    }
    if (new_reject_balance > old_reject_balance){
      const diff = new_reject_balance - old_reject_balance;
      let title, description;
      if (old_reject_balance === 0n){
        title = 'Errors found in Data file';
        description = [
          'Errors were encountered while executing the previous query.',
          `${new_reject_balance} offending records were excluded from the results.`
        ];
      }
      else {
        title = 'New errors found in Data file';
        description = [
          `${diff} new errors were encountered while executing the previous query and skipped from the results.`,
          `The total number of skipped records so far is ${new_reject_balance}.`
        ];
      }
      description.push('Review datasource settings to inspect and fix the errors.');
      showErrorDialog({
        title: title,
        description: description.join('<br/>\n')
      });
    }
  }

  #attachRejectsDetection(datasource) {
    if (typeof datasource.supportsRejectsDetection !== 'function' || !datasource.supportsRejectsDetection()) {
      return;
    }
    datasource.addEventListener('rejectsdetected', this.#rejectsDetectedHandler.bind(this));
  }

  #getDatasourceFromClickEvent(event){
    const node = this.#getTreeNodeFromClickEvent(event);
    const nodeType = node.getAttribute('data-nodetype');

    const duckdb = getDuckDbModule();
    const instance = getDatabase();

    let datasource;
    switch (nodeType) {
      case 'datasource':
        datasource = this.#getDatasourceForTreeNode(node);
        break;
      case 'datasourcegroup':
        const groupType = node.getAttribute('data-grouptype');
        switch (groupType){
          case DuckDbDataSource.types.FILE:
            const datasourceIdsListJSON = node.getAttribute('data-datasourceids');
            const datasourceIdsList = JSON.parse(datasourceIdsListJSON);
            const fileNames = datasourceIdsList.map((datasourceId) =>{
              const datasource = this.#datasources[datasourceId];
              const fileName = datasource.getFileName();
              return fileName;
            });
            const fileType = node.getAttribute('data-filetype');

            datasource = new DuckDbDataSource(duckdb, instance, {
              type: DuckDbDataSource.types.FILES,
              fileNames: fileNames,
              fileType: fileType
            });
            this.#attachRejectsDetection(datasource);
            break;
          case 'remote':
            const remoteIdsJSON = node.getAttribute('data-datasourceids');
            const remoteIds = JSON.parse(remoteIdsJSON);
            datasource = remoteIds.length ? this.#datasources[remoteIds[0]] : undefined;
            break;
          default:
            throw new Error(`Don't know how to get a datasource from a datasourcegroup of type ${groupType}`);
        }
        break;
      default:
        throw new Error(`Don't know how to get a datasource for node of type ${nodeType}.`);
    }
    return datasource;
  }

  #analyzeDatasourceClicked(event){
    const datasource = this.#getDatasourceFromClickEvent(event);
    // todo: replace direct call to global analyze with fireEvent
    analyzeDatasource(datasource);
  }

  #removeDatasourceClicked(event){
    const node = this.#getTreeNodeFromClickEvent(event);
    const nodeType = node.getAttribute('data-nodetype');
    let datasourceIdsList;
    switch (nodeType) {
      case 'datasource':
        const dataSourceId = node.id;
        datasourceIdsList = [dataSourceId];
        break;
      case 'datasourcegroup':
        const groupTypeRemove = node.getAttribute('data-grouptype');
        switch (groupTypeRemove){
          case DuckDbDataSource.types.FILE:
            const datasourceIdsListJSON = node.getAttribute('data-datasourceids');
            datasourceIdsList = JSON.parse(datasourceIdsListJSON);
            break;
          case 'remote':
            datasourceIdsList = JSON.parse(node.getAttribute('data-datasourceids'));
            break;
          default:
            throw new Error(`Don't know how to get a datasource from a datasourcegroup of type ${groupTypeRemove}`);
        }
        break;
    }
    this.destroyDatasources(datasourceIdsList);
  }

  #configureDatasourceClicked(event){
    const datasource = this.#getDatasourceFromClickEvent(event);
    datasourceSettingsDialog.open(datasource);
  }
  
  static #getDownloadMenuHTML(fromFileType, includeFromFileType){
    return _getDownloadMenuHTML(fromFileType, includeFromFileType);
  }

  static async #promptExportDataFormat(fromFileType, includeFromFileType){
    return _promptExportDataFormat(fromFileType, includeFromFileType);
  }

  static #getDatasourceExportSettings(targetFileType){
    return _getDatasourceExportSettings(targetFileType);
  }
  
  async #downloadDatasourceClicked(event) {
    const button = event.target;
    if (button.getAttribute('aria-busy') === 'true'){
      return;
    }
    
    const datasource = this.#getDatasourceFromClickEvent(event);
    let datasourceFileType, includeFromFileType = false;
    switch (datasource.getType()){
      case DuckDbDataSource.types.FILES:
        includeFromFileType = true;
      case DuckDbDataSource.types.FILE:
        datasourceFileType = datasource.getFileType();
    }

    const targetFileType = await DataSourcesUi.#promptExportDataFormat(datasourceFileType, includeFromFileType);
    if (!targetFileType) {
      return;
    }
    button.setAttribute('aria-busy', 'true');
    
    const exportSettings = DataSourcesUi.#getDatasourceExportSettings(targetFileType);
    const exportTitle = DataSourcesUi.getCaptionForDatasource(datasource);
    exportSettings.exportTitle = exportTitle;
    
    const sql = `SELECT * ${datasource.getFromClauseSql()}`;
    await ExportUi.exportData(datasource, sql, exportSettings);
    button.setAttribute('aria-busy', 'false');
  }

  #getCaptionForDataSourceGroup(datasourceGroup, miscGroup){
    switch (datasourceGroup.type) {
      case DuckDbDataSource.types.DUCKDB:
        return 'DuckDB';
      case DuckDbDataSource.types.SQLITE:
        return 'SQLite';
      case 'remote':
        return 'RemoteDS';
      case DuckDbDataSource.types.FILE:
        const datasources = datasourceGroup.datasources;
        if (miscGroup) {
          return Internationalization.getText('Files');
        }
        return Object.keys(datasources).map((datasourceId) =>{
          const datasource = datasources[datasourceId];
          return datasource.getFileNameWithoutExtension();
        }).join(', ');
    }
  }

  #createDataSourceGroupNode(datasourceGroup, miscGroup){
    if (datasourceGroup === undefined){
      return;
    }
    const groupNode = instantiateTemplate('dataSourceGroupNode');
    const groupType = datasourceGroup.type;
    groupNode.setAttribute('data-grouptype', groupType)

    let groupTitle;
    switch (groupType) {
      case 'remote':
        groupTitle = 'RemoteDS';
        break;
      case DuckDbDataSource.types.FILE:
        if (miscGroup === true) {
          groupTitle = 'Miscellanous files';
        }
        else {
          groupNode.setAttribute('data-filetype', datasourceGroup.fileType);
        }

        if (datasourceGroup.typeSignature) {
          groupTitle = 'Bucket of similarly typed files.';
        }
        break;
      default:
        groupTitle = `${groupType}`;
    }
    Internationalization.setAttributes(groupNode, 'title', groupTitle)

    const summary = groupNode.querySelector('summary');
    const label = summary.querySelector('span.label');
    // TODO: some group titels are translateable, some aren't
    const caption = this.#getCaptionForDataSourceGroup(datasourceGroup, miscGroup);
    label.textContent = caption;

    if (datasourceGroup.typeSignature) {
      this.#createDatasourceNodeActionButtons(
        datasourceGroup.typeSignature, 
        summary
      );
    }

    let datasources = datasourceGroup.datasources;
    datasources = DataSourcesUi.sortDatasources(datasources);
    const datasourceKeys = Object.keys(datasources);
    groupNode.setAttribute('data-datasourceids', JSON.stringify(datasourceKeys));

    datasourceKeys.forEach((datasourceId) =>{
      const datasource = datasources[datasourceId];
      const datasourceNode = this.#createDatasourceNode(datasource);
      groupNode.appendChild(datasourceNode);
    });

    const dom = this.getDom();
    dom.appendChild(groupNode);
    return groupNode;
  }
  
  static sortDatasources(datasources){
    return _sortDatasources(datasources);
  }

  #addDatasource(datasource) {
    const id = datasource.getId();
    this.#attachRejectsDetection(datasource);
    this.#datasources[id] = datasource;
  }

  async addDatasources(datasources){
    datasources.forEach((datasource) =>{
      this.#addDatasource(datasource);
    });
    await this.#renderDatasources();
  }

  addDatasource(datasource){
    this.addDatasources([datasource]);
  }

  async destroyDatasources(datasourceIds) {
    for (let i = 0; i < datasourceIds.length; i++){
      const datasourceId = datasourceIds[i];
      const datasource = this.getDatasource(datasourceId);
      if (!datasource) {
        continue;
      }
      datasource.destroy();
      delete this.#datasources[datasourceId];
    }
    await this.#renderDatasources();
  }

  getDatasource(id) {
    return this.#datasources[id];
  }

  getDatasourceIds(){
    return Object.keys(this.#datasources);
  }

  async isDatasourceCompatibleWithColumnsSpec(datasourceId, columnsSpec, useLooseColumnComparisonType){
    const columnNames = Object.keys(columnsSpec || {});
    if (columnNames.length === 0){
      return true;
    }

    let columnName, columnSpec, columnType, searchColumnsSpec;
    if (useLooseColumnComparisonType) {
      searchColumnsSpec = {};
      for (columnName in columnsSpec) {
        columnSpec = columnsSpec[columnName];
        columnType = columnSpec.columnType;
        searchColumnsSpec[columnName] = {
          columnType: this.#getLooseColumnType(columnType)
        };
      }
    }
    else {
      searchColumnsSpec = columnsSpec;
    }

    const datasources = this.#datasources;
    const datasource = datasources[datasourceId];
    if (!datasource){
      return false;
    }

    let columnMetadata;
    const datasourceType = datasource.getType();
    switch (datasourceType) {
      case DuckDbDataSource.types.FILE:
      case DuckDbDataSource.types.FILES:
        columnMetadata = await datasource.getColumnMetadata();
      case DuckDbDataSource.types.DUCKDB:
      case DuckDbDataSource.types.SQLITE:
        // TODO: look for objects in the database that could be a datasource.
        break;
      default:
    }

    if (!columnMetadata){
      return false;
    }

    _columns: for (let i = 0; i < columnMetadata.numRows; i++){
      const row = columnMetadata.get(i);
      const columnName = row.column_name;
      columnSpec = searchColumnsSpec[columnName];
      if (!columnSpec) {
        continue _columns;
      }

      columnType = row.column_type;
      const comparisonColumnType = useLooseColumnComparisonType ? this.#getLooseColumnType(columnType) : columnType;
      if (columnSpec.columnType !== comparisonColumnType) {
        return false;
      }
      columnNames.splice(columnNames.indexOf(columnName), 1);
      if (!columnNames.length){
        return true;
      }
    }
    return columnNames;
  }

  async findDataSourcesWithColumns(columnsSpec, useLooseColumnComparisonType){
    let foundDatasources = {};

    const datasources = this.#datasources;
    for (const datasourceId in datasources){
      const datasource = datasources[datasourceId];
      const isCompatible = await this.isDatasourceCompatibleWithColumnsSpec(datasourceId, columnsSpec, useLooseColumnComparisonType);
      if (isCompatible === true){
        foundDatasources[datasourceId] = datasource;
      }
    }

    if (Object.keys(foundDatasources).length) {
      foundDatasources = DataSourcesUi.sortDatasources(foundDatasources);
      return foundDatasources;
    }
    return undefined;
  }
}

export let datasourcesUi;
export function initDataSourcesUi(){
  datasourcesUi = new DataSourcesUi('datasourcesUi');
}
