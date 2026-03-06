import { byId, registerTemplates } from '../util/dom/dom.js';
import { bufferEvents } from '../util/event/EventBuffer.js';
import { QueryModel, queryModel } from '../QueryModel/QueryModel.js';
import { datasourcesUi } from '../DataSource/DataSourcesUi.js';
import dataSourceMenuTemplatesHtml from './templates.html?raw';

export class DataSourceMenu {

  #id = undefined;
  #queryModel = undefined;
  #datasourcesUi = undefined;
  #queryModelStateBeforeChange;

  constructor(id, queryModel, datasourcesUi){
    registerTemplates(dataSourceMenuTemplatesHtml);
    this.#id = id;
    this.#queryModel = queryModel;
    this.#datasourcesUi = datasourcesUi;
    
    bufferEvents(
      queryModel,
      'beforechange',
      this.#queryModelBeforeChangeHandler,
      this,
      500
    );
    bufferEvents(
      queryModel,
      'change',
      this.#queryModelChangeHandler,
      this,
      500
    );
    
    datasourcesUi.addEventListener('change', this.#datasourcesChangedHandler.bind(this));
    this.#initMenuTriggerState();
  }
  
  getDom(){
    return byId(this.#id);
  }

  #datasourcesChangedHandler(_event) {
    this.#update();
  }

  #initMenuTriggerState(){
    const dom = this.getDom();
    const triggerButton = byId('currentDatasourceMenuButton');
    if (!triggerButton) {
      return;
    }
    dom.addEventListener('beforetoggle', (event) =>{
      triggerButton.setAttribute('aria-expanded', String(event.newState === 'open'));
    });
  }

  #queryModelBeforeChangeHandler(event, count){
    if (count !== 0) {
      return;
    }
    const queryModelState = this.#queryModel.getState({includeItemIndices: true});
    this.#queryModelStateBeforeChange = JSON.stringify(queryModelState);
  }
  
  #queryModelChangeHandler(event, count){
    // check if the events have died out
    if (count !== undefined) {
      return;
    }
    
    // check if we have a datasource
    const datasource = this.#queryModel.getDatasource();
    if (!datasource){
      // no. Call update to empty the menu
      this.#update();
      return;
    }
    
    // We have a datasource!
    // Check if it is the same as the previous one
    const newDatassourceId = datasource.getId();
    if (!this.#queryModelStateBeforeChange){
      this.#update();
      return;
    }
    const oldQueryModelState = JSON.parse(this.#queryModelStateBeforeChange);
    if (!oldQueryModelState){
      this.#update();
      return;
    }
    const oldDatasourceId = oldQueryModelState.datasource;
    if (newDatassourceId === oldDatasourceId) {
      //  it hasn't changed. We shouldn't need to #update the menu
      return;
    }
    
    // datasource has changed. #update the menu
    this.#update();
  }
  
  static #getDatasourceMenuItem(config, instantiate){
    const datasourceMenuItemTemplate = byId('datasource-menu-item');
    let item;
    if (instantiate ) {
      item = datasourceMenuItemTemplate.content.cloneNode(true).children.item(0);
    }
    else {
      item = datasourceMenuItemTemplate.content.children.item(0);
    }
    if (config.datasourceType) {
      item.setAttribute('data-datasourcetype', config.datasourceType);
    }
    else {
      item.removeAttribute('data-datasourcetype');
    }
    if (config.fileType) {
      item.setAttribute('data-filetype', config.fileType);
    }
    else {
      item.removeAttribute('data-filetype');
    }
    if (config.datasourceId) {
      item.setAttribute('data-datasource-id', config.datasourceId);
    }
    else {
      item.removeAttribute('data-datasource-id');
    }
    item.setAttribute('title', config.labelText);
    
    const id = 'datasourceMenu' + (typeof config.index === 'number' ? config.index : '');

    const label = item.getElementsByTagName('LABEL').item(0);
    label.setAttribute('for', id);
    label.textContent = config.labelText;
    
    const radio = item.getElementsByTagName('INPUT').item(0);
    const button = item.getElementsByTagName('BUTTON').item(0);
    button.setAttribute('aria-label', `Switch to datasource ${config.labelText}`);
    if (typeof config.clickHandler === 'function'){
      radio.removeAttribute('id')
      button.setAttribute('id', id);
      button.addEventListener('click', config.clickHandler);
    }
    else {
      button.removeAttribute('id')
      radio.setAttribute('id', id);
      radio.setAttribute('value', config.value);
      const checked = Boolean(config.checked);
      if (checked) {
        radio.setAttribute('checked', checked);
      }
      else {
        radio.removeAttribute('checked');
      }
    }
    
    return item;
  }
  
  static getDatasourceMenuItem(config){
    const item = DataSourceMenu.#getDatasourceMenuItem(config, true);
    return item;
  }

  static getDatasourceMenuItemHTML(config){
    const item = DataSourceMenu.#getDatasourceMenuItem(config);
    return item.outerHTML;
  }
  
  #datasourceMenuItemChangeHandler(event){
    const radio = event.target;
    const menuItem = radio.parentNode;
    const datasourceId = menuItem.getAttribute('data-datasource-id');
    const datasource = this.#datasourcesUi.getDatasource(datasourceId);
    this.#queryModel.setDatasource(datasource, true);
  }
  
  async #update(){
    const dom = this.getDom();
    dom.replaceChildren();
    
    const datasource = this.#queryModel.getDatasource();
    if (!datasource) {
      return;
    }
    
    const queryModelState = this.#queryModel.getState();
    if (!queryModelState){
      return;
    }
    const currentDatasourceId = queryModelState.datasourceId;
    const referencedColumns = QueryModel.getReferencedColumns(queryModelState);
    
    const compatibleDatasources = await this.#datasourcesUi.findDataSourcesWithColumns(referencedColumns);
    if (!compatibleDatasources) {
      return
    }
    
    Object.keys(compatibleDatasources).forEach((datasourceKey, index) =>{
      const datasource = compatibleDatasources[datasourceKey];
      const datasourceId = datasource.getId();
      
      if (currentDatasourceId === datasourceId) {
        return;
      }
      
      const caption = DataSourcesUi.getCaptionForDatasource(datasource);
      const datasourceType = datasource.getType();
      let fileName, fileNameParts;
      if ( datasourceType === DuckDbDataSource.types.FILE) {
        fileName = datasource.getFileName();
        fileNameParts = DuckDbDataSource.getFileNameParts(fileName);
      }
      
      const config = {
        datasourceType: datasourceType,
        datasourceId: datasourceId,
        fileType: fileNameParts ? fileNameParts.lowerCaseExtension : undefined,
        index: index,
        value: index,
        labelText: caption,
        clickHandler: this.#datasourceMenuItemChangeHandler.bind(this)
      };
      const item = DataSourceMenu.getDatasourceMenuItem(config);
      dom.appendChild(item);
    });
  }
  
}


export function initDataSourceMenu(){
  const _datasourceMenu = new DataSourceMenu('dataSourceMenu', queryModel, datasourcesUi);
}
