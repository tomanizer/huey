import { byId, escapeHtmlText } from '../util/dom/dom.js';
import { Routing } from '../Routing/Routing.js';
import { Internationalization } from '../Internationalization/Internationalization.js';
import { PromptUi } from '../PromptUi/PromptUi.js';
import { settings } from '../SettingsDialog/SettingsDialog.js';
import { QueryModel, queryModel } from '../QueryModel/QueryModel.js';
import { DataSourcesUi, datasourcesUi } from '../DataSource/DataSourcesUi.js';
import { DuckDbDataSource } from '../DataSource/duckdb/DuckDbDataSource.js';
import { DataSourceMenu } from '../DataSourceMenu/DataSourceMenu.js';
import { uploadUi } from '../UploadUi/UploadUi.js';
import { attributeUi } from '../AttributeUi/AttributeUi.js';
import { analyzeDatasource } from '../App/analyzeDatasource.js';

export class PageStateManager {

  static #escapePromptText(text) {
    return escapeHtmlText(String(text));
  }

  static #formatColumnForPrompt(columnName, columnType) {
    const name = String(columnName);
    const type = columnType ? String(columnType) : '';
    return `${name}${type ? ` ${type}` : ''}`;
  }

  constructor(){
    this.#initPopStateHandler();
    //this.#initHashChangeHandler();
  }

  #initPopStateHandler(){
    window.addEventListener('popstate', this.#popStateHandler.bind(this));
  }

  #initHashChangeHandler(){
    window.addEventListener('hashchange', this.#hashChangeHandler.bind(this));
  }

  // this basically means: load the query
  #hashChangeHandler(_event){
    const currentRoute = Routing.getCurrentRoute();
    // TODO: check if the current state already matches the route, if it does we're done.
    this.setPageState(currentRoute);
  }

  // this basically means: load the query
  #popStateHandler(event){
    const newRoute = event.state;
    // TODO: check if the current state already matches the route, if it does we're done.
    this.setPageState(newRoute);
  }

  async chooseDataSourceForPageStateChangeDialog(referencedColumns, desiredDatasourceId, compatibleDatasources, newDatasources){
    let desiredDataSource = compatibleDatasources ? compatibleDatasources[desiredDatasourceId] : undefined;
    if (desiredDataSource){
      return desiredDataSource;
    }

    const desiredDatasourceIdParts = DuckDbDataSource.parseId(desiredDatasourceId);
    
    if (desiredDatasourceIdParts.isUrl) {
      const url = desiredDatasourceIdParts.resource;
      await uploadUi.uploadFiles([url]);
      desiredDataSource = datasourcesUi.getDatasource(desiredDatasourceId);
      if (desiredDataSource) {
        const isCompatible = await datasourcesUi.isDatasourceCompatibleWithColumnsSpec(
          desiredDatasourceId,
          referencedColumns,
          true
        );
        if (isCompatible === true) {
          uploadUi.close();
          return desiredDataSource;
        }
      }
    }

    let title;
    let message;
    const existingDatasource = datasourcesUi.getDatasource(desiredDatasourceId);
    let openNewDatasourceItem;
    if (existingDatasource) {
      openNewDatasourceItem = DataSourceMenu.getDatasourceMenuItemHTML({
        value: -1,
        checked: true,
        labelText: Internationalization.getText('Browse for a new Datasource')
      });
      title = 'Incompatible Datasource';
      message = PageStateManager.#escapePromptText(Internationalization.getText(
        'The requested {1} {2} isn\'t compatible with your query.', 
        desiredDatasourceIdParts.type, desiredDatasourceIdParts.localId
      ));
      
      if (newDatasources && newDatasources.length) {
        const mismatchedColumns = [];
        const datasourceSettings = settings.getSettings('datasourceSettings');
        const useLooseColumnComparisonType = datasourceSettings.useLooseColumnTypeComparison;
        for (let i = 0; i < newDatasources.length; i++){
          const newDatasource = newDatasources[i];
          const datasourceId = newDatasource.getId();
          const isCompatible = await datasourcesUi.isDatasourceCompatibleWithColumnsSpec(
            datasourceId, 
            referencedColumns, 
            useLooseColumnComparisonType
          );
          if (isCompatible === true){
            continue;
          }
          isCompatible.forEach((columnName) =>{
            if (mismatchedColumns.indexOf(columnName) === -1) {
              mismatchedColumns.push(columnName);
            }
          });
        }
        const mismatchedColumnsString = mismatchedColumns.map((mismatchedColumnName) =>{
          const columnDef = referencedColumns[mismatchedColumnName];
          return PageStateManager.#formatColumnForPrompt(
            mismatchedColumnName,
            columnDef ? columnDef.columnType : undefined
          );
        }).join(', ');
        message += '<br/>' + PageStateManager.#escapePromptText(
          Internationalization.getText('Missing or unmatched columns: {1}', mismatchedColumnsString)
        );
      }
    }
    else {
      message = PageStateManager.#escapePromptText(Internationalization.getText(
        'The requested {1} {2} doesn\'t exist.', 
        desiredDatasourceIdParts.type, desiredDatasourceIdParts.localId
      ));
      openNewDatasourceItem = DataSourceMenu.getDatasourceMenuItemHTML({
        datasourceType: desiredDatasourceIdParts.type,
        value: -1,
        checked: true,
        labelText: Internationalization.getText('Browse to open {1}', desiredDatasourceIdParts.localId)
      });
      title = 'Datasource not found';
    }

    let list = '<menu class="dataSources">';
    let datasourceType;
    const compatibleDatasourceIds = compatibleDatasources ? Object.keys(compatibleDatasources) : [];
    if (compatibleDatasourceIds.length) {
      message += '<br/>' + PageStateManager.#escapePromptText(
        Internationalization.getText('Choose any of the compatible datasources instead, or browse for a new one:')
      );
      list += compatibleDatasourceIds.map((compatibleDatasourceId, index) =>{
        const compatibleDatasource = compatibleDatasources[compatibleDatasourceId];
        datasourceType = compatibleDatasource.getType();
        let fileNameParts;
        switch (datasourceType) {
          case DuckDbDataSource.types.FILE:
            const fileName = compatibleDatasource.getFileName();
            fileNameParts = DuckDbDataSource.getFileNameParts(fileName);
            break;
          default:
        }
        const caption = DataSourcesUi.getCaptionForDatasource(compatibleDatasource);
        const datasourceItem = DataSourceMenu.getDatasourceMenuItemHTML({
          datasourceType: datasourceType,
          fileType: fileNameParts ? fileNameParts.lowerCaseExtension : undefined,
          index: index,
          value: index,
          labelText: caption
        });
        return datasourceItem;
      }).join('\n');
    }

    list += openNewDatasourceItem;
    list += '</menu>';
    message += list;

    const choice = await PromptUi.show({
      title: Internationalization.getText(title),
      contents: message,
      allowUnsafeHtml: true
    });

    switch (choice) {
      case 'accept':
        if (compatibleDatasources) {
          const promptUi = byId('promptUi');
          const radio = promptUi ? promptUi.querySelector('input[name=compatibleDatasources]:checked') : null;
          const chosenOption = radio ? parseInt(radio.value, 10) : -1;
          if (chosenOption !== -1) {
            const compatibleDatasourceId = compatibleDatasourceIds[chosenOption];
            return compatibleDatasources[compatibleDatasourceId];
          }
        }
        byId('uploader')?.click();
        return null;
      case 'reject':
      case '':
      case undefined:
        throw new Error('Datasource selection canceled.');
      default:
        throw new Error(`Unexpected prompt result: ${choice}`);
    }
  }

  async setPageState(newRoute, newUploadResults){

    if (!newRoute){
      // TODO: maybe throw an error?
      return;
    }

    const currentRoute = Routing.getRouteForQueryModel(queryModel);
    if (newRoute === currentRoute) {
      return;
    }

    const state = Routing.getQueryModelStateFromRoute(newRoute);
    if (!state) {
      // TODO: maybe throw an error?
      return;
    }

    const queryModelState = state.queryModel;
    const referencedColumns = QueryModel.getReferencedColumns(queryModelState);

    const datasourceId = queryModelState.datasourceId;
    const compatibleDatasources = await datasourcesUi.findDataSourcesWithColumns(referencedColumns, true);

    let datasource;
    if (compatibleDatasources && compatibleDatasources[datasourceId]) {
      datasource = datasourcesUi.getDatasource(datasourceId);
    }
    else {
      try {
        datasource = await this.chooseDataSourceForPageStateChangeDialog(
          referencedColumns,
          datasourceId,
          compatibleDatasources,
          newUploadResults ? newUploadResults.datasources : undefined
        );
        // TODO: this is a bit funky, we're getting null because the ui flow to select a datasource
        // at some point gets disconnected when we have to open the filepicker.
        // For now we'll leave it but we need to find a more rigourous wat to define UI workflows
        // because now it's just a load of Promispaghetti
        if (datasource === null) {
          Routing.updateRouteFromQueryModel(queryModelState);
          return;
        }
      }
      catch (_error){
        queryModel.clear();
        Routing.updateRouteFromQueryModel(queryModel);
      }
      if (!datasource) {
        return;
      }
    }
    queryModelState.datasourceId = datasource.getId();
    queryModel.setState(queryModelState);
    analyzeDatasource(datasource);
    setTimeout(() =>{
      attributeUi.revealAllQueryAttributes();
    }, 1000);
  }

}

export let pageStateManager;
export function initPageStateManager(context){
  pageStateManager = new PageStateManager();
  if (context) {
    context.register('pageStateManager', pageStateManager);
  }
  return pageStateManager;
}
