import { byId, createEl, instantiateTemplate, registerTemplates } from '../util/dom/dom.js';
import uploadTemplatesHtml from './templates.html?raw';
import { Internationalization } from '../Internationalization/Internationalization.js';
import { Routing } from '../Routing/Routing.js';
import { datasourcesUi } from '../DataSource/DataSourcesUi.js';
import { DuckDbDataSource } from '../DataSource/duckdb/DuckDbDataSource.js';
import { RemoteDatasource } from '../DataSource/remote/RemoteDatasource.js';
import { RemoteDatasourceConfig } from '../DataSource/remote/RemoteDatasourceConfig.js';
import { showErrorDialog } from '../ErrorDialog/ErrorDialog.js';
import { PromptUi } from '../PromptUi/PromptUi.js';
import { TabUi } from '../Tabs/Tabs.js';
import { queryModel } from '../QueryModel/QueryModel.js';
import { pageStateManager } from '../PageStateManager/PageStateManager.js';
import { analyzeDatasource } from '../App/analyzeDatasource.js';
import { getDatabase, getDuckDbModule } from '../DataSource/duckdb/database.js';
import {
  parseS3Uri,
  parseGcsUri,
  getBaseNameFromKey,
  fetchS3AsBlob,
  fetchGcsAsBlob,
} from '../util/CloudStorageLoader.js';

export class UploadUi {

  static #fileSizeFormatter = new Intl.NumberFormat(
    navigator.language, {
      style: 'unit',
      notation: 'compact',
      unit: 'byte',
      unitDisplay: 'narrow'
    }
  );

  #id = undefined;
  #pendingUploads = undefined;
  #cancelPendingUploads = false;
  static #uploadItemTemplateId = 'uploadItemTemplate';

  constructor(id){
    this.#id = id;
    this.init();
  }

  init(){
    registerTemplates(uploadTemplatesHtml);
    this.#getCancelButton().addEventListener('click', async () =>{
      await this.#cancelUploads();
      this.getDialog().close();
    });

    this.#getOkButton().addEventListener('click', () =>{
      this.getDialog().close();
    });
  }

  async #cancelUploads(){
    this.#cancelPendingUploads = true;
  }

  #setProgressValue(progressBar, value){
    const max = parseFloat(progressBar.max) || 100;
    let nextValue = Number.isFinite(value) ? value : 0;
    nextValue = Math.max(0, Math.min(max, nextValue));
    progressBar.value = nextValue;
    progressBar.setAttribute('aria-valuemin', '0');
    progressBar.setAttribute('aria-valuemax', String(max));
    progressBar.setAttribute('aria-valuenow', String(nextValue));
  }

  static #handleHueyFileContents(contents, extension){
    let queryModelState;
    switch (extension) {
      case 'hueyqh':
        if (!contents.startsWith('#')){
          throw new Error(`No hash found!`);
        }
        const route = contents.slice(1);
        queryModelState = Routing.getQueryModelStateFromRoute(route);
        break;
      case 'hueyq':
        queryModelState = JSON.parse(contents);
        break;
    }
    return queryModelState;
  }

  static async #handleHueyFile(file, uploadItem){
    const fileName = file.name;
    const extension = fileName.split('.').pop().toLowerCase();
    const fileContents = await file.text();
    return UploadUi.#handleHueyFileContents(fileContents, extension);
  }

  static async #handleHueyFileUrl(url, uploadItem){
    const extension = url.split('.').pop().toLowerCase();
    const contents = await fetch(url);
    return UploadUi.#handleHueyFileContents(contents, extension);
  }

  async #uploadFile(file, uploadItem){

    const progressBar = uploadItem.getElementsByTagName('progress').item(0);

    const duckdb = getDuckDbModule();
    const instance = getDatabase();

    let duckDbDataSource;
    let destroyDatasource = false;
    
    const hueyFileRegex = /\.hueyqh?$/i;
    let hueyQueryState;
    try {
      if (typeof file === 'string'){
        
        if (hueyFileRegex.test(file)){
          hueyQueryState = await UploadUi.#handleHueyFileUrl(file, uploadItem);
        }
        else {
          const s3Parsed = parseS3Uri(file);
          const gcsParsed = !s3Parsed && parseGcsUri(file);
          if (s3Parsed || gcsParsed) {
            duckDbDataSource = await fetchCloudAndCreateDatasource(duckdb, instance, file, s3Parsed, gcsParsed);
            this.#setProgressValue(progressBar, parseInt(progressBar.value, 10) + 60);
          }
          else {
            duckDbDataSource = await DuckDbDataSource.createFromUrl(duckdb, instance, file);
            this.#setProgressValue(progressBar, parseInt(progressBar.value, 10) + 20);

            await duckDbDataSource.registerFile();
            this.#setProgressValue(progressBar, parseInt(progressBar.value, 10) + 40);
          }
        }
      }
      else
      if (file instanceof File){
        
        if (hueyFileRegex.test(file.name)){
          hueyQueryState = await UploadUi.#handleHueyFile(file, uploadItem);
        }
        else {
          duckDbDataSource = DuckDbDataSource.createFromFile(duckdb, instance, file);
          this.#setProgressValue(progressBar, parseInt(progressBar.value, 10) + 20);

          await duckDbDataSource.registerFile();
          this.#setProgressValue(progressBar, parseInt(progressBar.value, 10) + 40);
        }
      }

      let tryResult, isAccessible;
      if (duckDbDataSource) {
        tryResult = await duckDbDataSource.tryAccess(100);
        isAccessible = tryResult.success;
      }
      else 
      if (hueyQueryState){
        isAccessible = true;
      }
      this.#setProgressValue(progressBar, parseInt(progressBar.value, 10) + 30);

      if (isAccessible !== true) {
        destroyDatasource = true;
        const errorMessage = tryResult.lastAttempt.message;
        throw new Error(`Error uploading file ${file.name}: ${errorMessage}.`);
      }

      if (duckDbDataSource) {
        switch (duckDbDataSource.getType()){
          case DuckDbDataSource.types.FILE:
            const columnMetadata = await duckDbDataSource.getColumnMetadata();
            break;
          case DuckDbDataSource.types.DUCKDB:
          case DuckDbDataSource.types.SQLITE:
        }
        return duckDbDataSource;
      }
      else
      if (hueyQueryState){
        return hueyQueryState;
      }
    }
    catch (error){
      destroyDatasource = true;
      return error;
    }
    finally {
      this.#setProgressValue(progressBar, 100);
      if (destroyDatasource && (duckDbDataSource instanceof DuckDbDataSource)){
        duckDbDataSource.destroy();
      }
    }
  }

  #createLoadExtensionItem(extensionId){
    const loadExtensionItem = instantiateTemplate(UploadUi.#uploadItemTemplateId, extensionId);
    loadExtensionItem.getElementsByTagName('p').item(0).setAttribute('id', extensionId + '_message');
    const progressBar = loadExtensionItem.getElementsByTagName('progress').item(0);
    this.#setProgressValue(progressBar, parseInt(progressBar.value, 10));
    return loadExtensionItem;
  }

  #createUploadItem(file){
    let fileName, fileSize;
    if (typeof file === 'string'){
      fileName = file;
    }
    else
    if (file instanceof File) {
      fileName = file.name;
      fileSize = UploadUi.#fileSizeFormatter.format(file.size);
      if (fileSize.endsWith('BB')){
        fileSize = fileSize.replace(/BB/, 'GB');
      }
    }
    else {
      throw new Error(`Don't know how to handle item of type ${typeof file}`);
    }

    const uploadItem = instantiateTemplate(UploadUi.#uploadItemTemplateId, fileName);
    uploadItem.getElementsByTagName('p').item(0).setAttribute('id', fileName + '_message');
    const labelSpan = uploadItem.getElementsByTagName('span').item(0);
    labelSpan.textContent = fileName;
    labelSpan.setAttribute('title', fileName);
    if (fileSize){
      labelSpan.setAttribute('data-file-size', fileSize);
    }
    const progressBar = uploadItem.getElementsByTagName('progress').item(0);
    this.#setProgressValue(progressBar, parseInt(progressBar.value, 10));
    
    return uploadItem;
  }

  #createInstallExtensionItem(extensionName, extensionRepository){
    const extensionItemId = `duckdb_extension:${extensionName}`;
    const uploadItem = this.#createLoadExtensionItem(extensionItemId);
    const label = uploadItem.getElementsByTagName('span').item(0);
    label.textContent = `Extension: ${extensionName}`;
    return uploadItem;
  }

  getRequiredDuckDbExtensions(files){
    const requiredExtensions = []
    for (let i = 0; i < files.length; i++){
      const file = files[i];

      let fileName;
      if (typeof file === 'string') {
        fileName = file;
      }
      else
      if (file instanceof File) {
        fileName = file.name;
      }
      else {
        throw new Error(`Don't know how to handle item of type ${typeof file}.`);
      }

      const fileNameParts = DuckDbDataSource.getFileNameParts(fileName);
      const fileExtension = fileNameParts.lowerCaseExtension;

      const fileType = DuckDbDataSource.getFileTypeInfo(fileExtension);
      if (!fileType){
        continue;
      }

      const requiredDuckDbExtension = fileType.duckdb_extension;
      if (!requiredDuckDbExtension){
        continue;
      }

      if (requiredExtensions.indexOf(requiredDuckDbExtension) === -1) {
        const extensionRepository = fileType.duckdb_extension_repository;
        requiredExtensions.push({
          extensionName: requiredDuckDbExtension,
          extensionRepository: extensionRepository
        });
      }
    }
    return requiredExtensions;
  }

  async loadDuckDbExtension(extensionName){
    
    let extensionRepository;
    switch (typeof extensionName){
      case 'string':
        break;
      case 'object':
        extensionRepository = extensionName.extensionRepository;
        extensionName = extensionName.extensionName;
    }
    
    let invalid = true;
    const body = this.#getBody();
    const installExtensionItem = this.#createInstallExtensionItem(extensionName);
    body.appendChild(installExtensionItem);
    const message = installExtensionItem.getElementsByTagName('p').item(0);
    const appendMessageLine = function(text){
      const messageLine = document.createElement('span');
      messageLine.textContent = text;
      message.appendChild(messageLine);
      message.appendChild(document.createElement('br'));
    };

    try {

      const progressbar = installExtensionItem.getElementsByTagName('progress').item(0);

      const connection = hueyDb.connection;

      appendMessageLine(Internationalization.getText('Preparing extension check'));
      const sql = `SELECT * FROM duckdb_extensions() WHERE extension_name = ?`;
      const statement = await connection.prepare(sql);
      this.#setProgressValue(progressbar, parseInt(progressbar.value, 10) + 20);

      appendMessageLine(Internationalization.getText('Checking extension {1}', extensionName));
      const result = await statement.query(extensionName);
      statement.close();
      this.#setProgressValue(progressbar, parseInt(progressbar.value, 10) + 20);

      if (result.numRows === 0) {
        appendMessageLine(Internationalization.getText('Extension {1} not found', extensionName));
        throw new Error(`Extension not found`);
      }
      else {
        appendMessageLine(Internationalization.getText('Extension {1} exists', extensionName));
      }

      const row = result.get(0);
      if (row['installed']){
        appendMessageLine(Internationalization.getText('Extension {1} already installed', extensionName));
      }
      else {
        appendMessageLine(Internationalization.getText('Extension {1} not installed', extensionName));

        let installSql = `INSTALL ${extensionName}`;
        if (extensionRepository){
          appendMessageLine(Internationalization.getText('Extension {1} comes from non-standard location {2}', extensionName, extensionRepository));
          installSql += ` FROM ${extensionRepository}`;
        }
        appendMessageLine(Internationalization.getText('Installing extension {1}', extensionName));
        const result = await connection.query(installSql);
        appendMessageLine(Internationalization.getText('Extension {1} is now installed', extensionName));
        this.#setProgressValue(progressbar, parseInt(progressbar.value, 10) + 20);
      }

      if (!row['loaded']){
        appendMessageLine(Internationalization.getText('Extension {1} not loaded', extensionName));
        appendMessageLine(Internationalization.getText('Loading extension {1}', extensionName));
        await connection.query(`LOAD ${extensionName}`);
      }
      
      appendMessageLine(Internationalization.getText('Extension {1} is loaded', extensionName));
      this.#setProgressValue(progressbar, parseInt(progressbar.value, 10) + 20);
      invalid = false;
      if (invalid === false) {
        this.#setProgressValue(progressbar, 100);
      }
      return !invalid;
    }
    catch (e){
      appendMessageLine(e.message);
      if (e.stack) {
        e.stack.split('\n').forEach((stackItem) =>{
          const stackElement = document.createElement('pre');
          stackElement.textContent = stackItem;
          message.appendChild(stackElement);
        });
      }
      installExtensionItem.setAttribute('open', true);
      return e;
    }
    finally{
      installExtensionItem.setAttribute('aria-invalid', invalid);
    }
  }

  loadRequiredDuckDbExtensions(requiredDuckDbExtensions){
    const extensionInstallationItems = requiredDuckDbExtensions.map(this.loadDuckDbExtension.bind(this));
    return extensionInstallationItems;
  }

  #updateUploadItem(uploadItem, uploadResult){
    const summary = uploadItem.getElementsByTagName('summary').item(0);

    let messageText;
    const message = uploadItem.getElementsByTagName('p').item(0);
    if (uploadResult instanceof Error){
      messageText = uploadResult.message;
      uploadItem.setAttribute('open', true);
      uploadItem.setAttribute('aria-invalid', String(true));
      uploadItem.setAttribute('aria-errormessage', message.id);
      
      // TODO: see if we can translate
      uploadItem.textContent = messageText;
    }
    else
    if (uploadResult instanceof DuckDbDataSource) {
      const datasourceId = uploadResult.getId();
      const type = uploadResult.getType();
      switch (type){
        case DuckDbDataSource.types.FILE:
        case DuckDbDataSource.types.URL:
          const menu = summary.getElementsByTagName('menu').item(0);
          const objectName = uploadResult.getObjectName();
          const analyzeButton = createEl('label', {
            "class": 'analyzeActionButton',
            "for": `${datasourceId}_analyze`,
          });
          Internationalization.setAttributes(analyzeButton, 'title', 'Start exploring data from {1}', objectName);
          menu.appendChild(analyzeButton);

          const settingsButton = createEl('label', {
            "class": 'editActionButton',
            "for": `${datasourceId}_edit`,
          });
          Internationalization.setAttributes(settingsButton, 'title', 'Configure {1}', objectName);
          menu.appendChild(settingsButton);
          break;
      }
      
      uploadItem.setAttribute('aria-invalid', String(false));
      Internationalization.setTextContent(message, 'Succesfully loaded.');
    }
    else
    if (typeof uploadResult === 'object') {
      const route = Routing.getRouteForQueryModel(uploadResult);
      const menu = summary.getElementsByTagName('menu').item(0);
      const objectName = 'the query';
      
      const id = `link_to_route_${route}`;
      const analyzeButton = createEl('button', {
        id: id,
        'data-route': route
      });
      analyzeButton.addEventListener('click', async (event) =>{
        await pageStateManager.setPageState(route);
      });
      const analyzeButtonLabel = createEl('label', {
        "class": 'analyzeActionButton',
        "for": id
      });
      Internationalization.setAttributes(analyzeButtonLabel, 'title', 'Start exploring data from {1}', objectName);
      analyzeButtonLabel.appendChild(analyzeButton);
      
      menu.appendChild(analyzeButtonLabel);
      uploadItem.setAttribute('aria-invalid', String(false));
      Internationalization.setTextContent(message, 'Succesfully loaded.');
    }
  }

  async uploadFiles(files){
    this.#cancelPendingUploads = false;
    const dom = this.getDialog();
    dom.setAttribute('aria-busy', true);

    const numFiles = files.length;
    const header = this.#getHeader();
    Internationalization.setTextContent(header, `Uploading {1} file${numFiles === 1 ? '' : 's'}.`, numFiles);
    const descriptionElement = this.#getDescription();
    Internationalization.setTextContent(descriptionElement, 'Upload in progress. This will take a few moments...');

    const body = this.#getBody();
    body.replaceChildren();

    dom.showModal();

    const requiredDuckDbExtensions = this.getRequiredDuckDbExtensions(files);
    const loadExtensionsPromises = this.loadRequiredDuckDbExtensions(requiredDuckDbExtensions);
    const loadExtensionsPromiseResults = await Promise.all(loadExtensionsPromises);

    this.#pendingUploads = [];
    for (let i = 0; i < numFiles; i++){
      const file = files[i];
      const uploadItem = this.#createUploadItem(file);
      body.appendChild(uploadItem);
      const uploadPromise = this.#uploadFile(file, uploadItem);
      this.#pendingUploads.push( uploadPromise );
    }
    const uploadResults = await Promise.all(this.#pendingUploads);

    let countFail = 0;
    const datasourceTypes = {}
    const datasources = [];
    for (let i = 0; i < uploadResults.length; i++){
      const uploadResult = uploadResults[i];
      const uploadItem = body.childNodes.item(i + requiredDuckDbExtensions.length);
      this.#updateUploadItem(uploadItem, uploadResult);
      if (uploadResult instanceof Error) {
        countFail += 1;
      }
      else 
      if (uploadResult instanceof DuckDbDataSource ) {
        datasources.push(uploadResult);
        const type = uploadResult.getType();
        let ofTypeCount = datasourceTypes[type];
        if (ofTypeCount === undefined) {
          ofTypeCount = 0;
        }
        ofTypeCount += 1;
        datasourceTypes[type] = ofTypeCount;
      }
      else 
      if (typeof uploadResult === 'object'){
       
      }
    }

    dom.setAttribute('aria-busy', false);
    if (datasources.length) {
      datasourcesUi.addDatasources(datasources);
    }
    
    let message, description;
    const countSuccess = uploadResults.length - countFail;
    if (countFail) {
      if (countSuccess){
        message = Internationalization.getText(`{1} file${countSuccess > 1 ? 's' : ''} succesfully uploaded, {2} failed.`, countSuccess, countFail);
        const datasourcesTab = '<label for="datasourcesTab">' + Internationalization.getText('Datasources tab') + '</label>';
        description = Internationalization.getText('Some uploads failed. Successful uploads are available in the {1}.', datasourcesTab);
      }
      else {
        message = Internationalization.getText(`{1} file${countFail > 1 ? 's' : ''} failed.`, countFail);
        description = Internationalization.getText('All uploads failed. You can review the errors below:');
      }
    }
    else {
      message = `${uploadResults.length} file${uploadResults.length > 1 ? 's' : ''} succesfully uploaded.`
      const datasourcesTab = '<label for="datasourcesTab">' + Internationalization.getText('Datasources tab') + '</label>';
      description = Internationalization.getText('Your uploads are available in the {1}.', datasourcesTab);
    }

    if (countSuccess !== 0){
      if (datasourceTypes[DuckDbDataSource.types.FILE]) {
        description = [
          description,
          '<br/>',
          '<br/>' + Internationalization.getText('Click the {1} button to configure the datasource.', '<span class="editActionButton"></span>'),
         '<br/>' + Internationalization.getText('Click the {1} button to start exploring.', '<span class="analyzeActionButton"></span>')
        ].join('\n');
      }
      
      if (datasourceTypes[DuckDbDataSource.types.DUCKDB] || datasourceTypes[DuckDbDataSource.types.SQLITE]){
        const datasourcesTab = '<label for="datasourcesTab">' + Internationalization.getText('Datasources tab') + '</label>';
        description = [
          description,
          '<br/>',
          '<br/>' + Internationalization.getText('For database files, use the {1} to browse for tables or views to analyze.', datasourcesTab)
        ].join('\n');
      }
    }

    this.#getHeader().textContent = message;
    // description markup is constructed from fixed UI templates and i18n strings only.
    this.#getDescription().innerHTML = description;
    
    return {
      success: countSuccess,
      fail: countFail,
      datasources: datasources
    };
  }

  getDialog(){
    return byId(this.#id);
  }

  close(){
    this.getDialog().close();
  }

  #getHeader(){
    const dom = this.getDialog();
    return byId(dom.getAttribute('aria-labelledby'));
  }

  #getDescription(){
    const dom = this.getDialog();
    return byId(dom.getAttribute('aria-describedby'));
  }

  #getBody(){
    const dom = this.getDialog();
    const article = dom.getElementsByTagName('section').item(0);
    return article;
  }

  #getFooter(){
    const dom = this.getDialog();
    const footer = dom.getElementsByTagName('footer').item(0);
    return footer;
  }

  #getOkButton(){
    const footer = this.#getFooter();
    const okButton = footer.getElementsByTagName('button').item(0);
    return okButton;
  }

  #getCancelButton(){
    const footer = this.#getFooter();
    const okButton = footer.getElementsByTagName('button').item(1);
    return okButton;
  }
}

export let uploadUi;

/**
 * Fetch an object from S3 or GCS and create a DuckDbDataSource from the resulting blob.
 * @param {*} duckdb
 * @param {*} instance
 * @param {string} cloudUri   - Original cloud URI (e.g. "s3://bucket/key.parquet")
 * @param {{ bucket: string, key: string } | null} s3Parsed
 * @param {{ bucket: string, path: string } | null} gcsParsed
 * @param {{ region?: string, accessKeyId?: string, secretAccessKey?: string, sessionToken?: string, accessToken?: string } | undefined} options
 * @returns {Promise<DuckDbDataSource>}
 */
async function fetchCloudAndCreateDatasource(duckdb, instance, cloudUri, s3Parsed, gcsParsed, options = {}) {
  let blob;
  let keyOrPath;

  if (s3Parsed) {
    blob = await fetchS3AsBlob(s3Parsed.bucket, s3Parsed.key, options);
    keyOrPath = s3Parsed.key;
  } else if (gcsParsed) {
    blob = await fetchGcsAsBlob(gcsParsed.bucket, gcsParsed.path, options);
    keyOrPath = gcsParsed.path;
  } else {
    throw new Error(`Neither a parsed S3 nor a parsed GCS URI was provided for "${cloudUri}".`);
  }

  const fileName = getBaseNameFromKey(keyOrPath) || 'data';
  const ds = DuckDbDataSource.createFromBlob(duckdb, instance, blob, fileName, cloudUri);
  await ds.registerFile();
  return ds;
}

export function getUrlsFromInput(urlInput){
  if (typeof urlInput !== 'string') {
    return [];
  }
  return urlInput
  .split(/[\n,]/)
  .map((url) => url.trim())
  .filter((url) => url);
}

export function isParquetUrl(url){
  try {
    const parsed = new URL(url);
    return /\.parquet$/i.test(parsed.pathname);
  }
  catch (error){
    return /\.parquet($|[?#])/i.test(url);
  }
}

async function uploadParquetFilesAsFolderDatasource(files){
  const parquetFiles = Array.from(files || []).filter((file) =>{
    return file instanceof File && /\.parquet$/i.test(file.name);
  });
  if (!parquetFiles.length){
    throw new Error('No parquet files found in selected folder.');
  }

  const duckdb = getDuckDbModule();
  const instance = getDatabase();

  const fileNames = parquetFiles
  .map((file) => file.webkitRelativePath || file.name)
  .sort();

  const protocol = duckdb.DuckDBDataProtocol.BROWSER_FILEREADER;
  for (let i = 0; i < parquetFiles.length; i++){
    const file = parquetFiles[i];
    const fileName = file.webkitRelativePath || file.name;
    await instance.registerFileHandle(
      fileName,
      file,
      protocol
    );
  }

  const datasource = new DuckDbDataSource(duckdb, instance, {
    type: DuckDbDataSource.types.FILES,
    fileNames: fileNames,
    fileType: 'parquet'
  });
  const tryResult = await datasource.tryAccess(100);
  if (!tryResult.success){
    datasource.destroy();
    const lastAttempt = tryResult.lastAttempt || {};
    throw new Error(lastAttempt.message || 'Could not access parquet folder datasource.');
  }
  datasourcesUi.addDatasources([datasource]);
  return datasource;
}

export function afterUploaded(uploadResults){
  const currentRoute = Routing.getCurrentRoute();
  if (!Routing.isSynced(queryModel)) {
    pageStateManager.setPageState(currentRoute, uploadResults);
    return;
  }
  
  if ( uploadResults.fail !== 0 ){
    // failed: keep the dialog open so the user can inspect the details
    return;
  }
  
  if ( uploadResults.success !== 1 ) {
    // multiple results: we can't choose so keep the dialog open so the user can.
    return;
  }
  
  if (currentRoute){
    // there is already a query active, so we won't start analyzing the new datasource.
    // Possible TODO: check if the new datasource is compatible with the current query.
    // if it is, prompt the user to apply it to the new datasource.
    return;
  }
  
  // try to start analyzing the new datasource.
  const datasources = uploadResults.datasources.filter((datasource) =>{
    return datasource instanceof DuckDbDataSource;
  });
  if (datasources.length === 0) {
    return;
  }
  const datasource = datasources[0];
  switch (datasource.getType()){
    case DuckDbDataSource.types.FILE:
    case DuckDbDataSource.types.FILES:
    case DuckDbDataSource.types.URL:
      analyzeDatasource(datasource);
      return;
    default:
  }
}

export function initUploadUi(){
  uploadUi = new UploadUi('uploadUi');

  const uploader = byId('uploader');
  let acceptFileTypes = Object.keys(DuckDbDataSource.fileTypes).sort().map((fileType) =>{
    return `.${fileType}`;
  }).join(', ');
  acceptFileTypes = [].concat(acceptFileTypes, [
    '.hueyq',
    '.hueyqh'
  ]);
  uploader.setAttribute('accept', acceptFileTypes);
  
  uploader
  .addEventListener('change', async (event) =>{
    const fileControl = event.target;
    const files = fileControl.files;
    const uploadResults = await uploadUi.uploadFiles(files);
    fileControl.value = '';
    afterUploaded(uploadResults);
  }, false);  // third arg is 'useCapture'

  byId('uploaderFolder')
  .addEventListener('change', async (event) =>{
    const folderControl = event.target;
    try {
      const datasource = await uploadParquetFilesAsFolderDatasource(folderControl.files);
      afterUploaded({
        success: 1,
        fail: 0,
        datasources: [datasource]
      });
    }
    catch (error){
      showErrorDialog({
        title: 'Could not load parquet folder',
        description: error.message || String(error)
      });
    }
    finally {
      folderControl.value = '';
    }
  }, false);

  byId('loadFromUrl')
  .addEventListener('click', async (event) =>{
    const formHtml = [
      '<form id="loadFromUrlForm">',
      '<label for="loadFromUrlInput">URL or cloud URI</label>',
      '<input type="text" id="loadFromUrlInput" name="url" placeholder="https://… or s3://bucket/key or gs://bucket/path" required autocomplete="off" style="width:100%" />',
      '<div id="loadFromUrlS3Options" style="display:none;margin-top:0.75em;border-top:1px solid var(--border-color,#ccc);padding-top:0.75em">',
      '<p style="margin:0 0 0.5em"><strong>Amazon S3 options</strong></p>',
      '<label for="loadFromUrlS3Region">Region</label>',
      '<input type="text" id="loadFromUrlS3Region" name="s3Region" placeholder="us-east-1" autocomplete="off" />',
      '<label for="loadFromUrlS3AccessKeyId" style="margin-top:0.5em">Access Key ID <em>(leave blank for public bucket)</em></label>',
      '<input type="text" id="loadFromUrlS3AccessKeyId" name="s3AccessKeyId" placeholder="AKIA…" autocomplete="off" />',
      '<label for="loadFromUrlS3SecretKey" style="margin-top:0.5em">Secret Access Key</label>',
      '<input type="password" id="loadFromUrlS3SecretKey" name="s3SecretKey" autocomplete="new-password" />',
      '<label for="loadFromUrlS3SessionToken" style="margin-top:0.5em">Session Token <em>(optional)</em></label>',
      '<input type="password" id="loadFromUrlS3SessionToken" name="s3SessionToken" autocomplete="new-password" />',
      '</div>',
      '<div id="loadFromUrlGcsOptions" style="display:none;margin-top:0.75em;border-top:1px solid var(--border-color,#ccc);padding-top:0.75em">',
      '<p style="margin:0 0 0.5em"><strong>Google Cloud Storage options</strong></p>',
      '<label for="loadFromUrlGcsToken">OAuth2 Access Token <em>(leave blank for public bucket)</em></label>',
      '<input type="password" id="loadFromUrlGcsToken" name="gcsToken" autocomplete="new-password" />',
      '</div>',
      '</form>',
    ].join('');

    const showPromise = PromptUi.show({
      title: 'Load from URL or cloud storage',
      contents: formHtml,
      allowUnsafeHtml: true
    });

    // Attach a live input listener so the S3/GCS credential sections appear as
    // soon as the user types a matching URI scheme.  PromptUi.show() sets the
    // section content synchronously in its Promise executor, so the elements
    // are already in the DOM when we reach this point.
    const urlInput = byId('loadFromUrlInput');
    if (urlInput) {
      const s3Options = byId('loadFromUrlS3Options');
      const gcsOptions = byId('loadFromUrlGcsOptions');
      const updateVisibility = () => {
        const val = urlInput.value.trim();
        if (s3Options) {
          s3Options.style.display = parseS3Uri(val) ? '' : 'none';
        }
        if (gcsOptions) {
          gcsOptions.style.display = parseGcsUri(val) ? '' : 'none';
        }
      };
      urlInput.addEventListener('input', updateVisibility);
    }

    const result = await showPromise;
    if (result !== 'accept') {
      return;
    }

    const url = (urlInput && urlInput.value && urlInput.value.trim()) || '';
    const urls = getUrlsFromInput(url);
    if (!urls.length) {
      return;
    }

    if (urls.length > 1 && urls.every((u) => isParquetUrl(u))) {
      const datasource = new DuckDbDataSource(getDuckDbModule(), getDatabase(), {
        type: DuckDbDataSource.types.FILES,
        fileNames: urls,
        fileType: 'parquet'
      });
      const tryResult = await datasource.tryAccess(100);
      if (!tryResult.success){
        datasource.destroy();
        showErrorDialog({
          title: 'Could not load parquet URLs',
          description: (tryResult.lastAttempt && tryResult.lastAttempt.message) || 'Could not access parquet URLs.'
        });
        return;
      }
      datasourcesUi.addDatasources([datasource]);
      afterUploaded({ success: 1, fail: 0, datasources: [datasource] });
      return;
    }

    if (urls.length === 1) {
      const singleUrl = urls[0];
      const s3Parsed = parseS3Uri(singleUrl);
      const gcsParsed = !s3Parsed && parseGcsUri(singleUrl);

      if (s3Parsed) {
        const region = (byId('loadFromUrlS3Region') && byId('loadFromUrlS3Region').value.trim()) || undefined;
        const accessKeyId = (byId('loadFromUrlS3AccessKeyId') && byId('loadFromUrlS3AccessKeyId').value.trim()) || undefined;
        const secretAccessKey = (byId('loadFromUrlS3SecretKey') && byId('loadFromUrlS3SecretKey').value) || undefined;
        const sessionToken = (byId('loadFromUrlS3SessionToken') && byId('loadFromUrlS3SessionToken').value) || undefined;
        const options = { region, accessKeyId, secretAccessKey, sessionToken };
        const duckdb = getDuckDbModule();
        const instance = getDatabase();

        try {
          const ds = await fetchCloudAndCreateDatasource(duckdb, instance, singleUrl, s3Parsed, null, options);
          datasourcesUi.addDatasources([ds]);
          afterUploaded({ success: 1, fail: 0, datasources: [ds] });
        } catch(e) {
          showErrorDialog({ title: 'Failed to load from S3', description: e.message || String(e) });
        }
      } else if (gcsParsed) {
        const accessToken = (byId('loadFromUrlGcsToken') && byId('loadFromUrlGcsToken').value) || undefined;
        const options = { accessToken };
        const duckdb = getDuckDbModule();
        const instance = getDatabase();

        try {
          const ds = await fetchCloudAndCreateDatasource(duckdb, instance, singleUrl, null, gcsParsed, options);
          datasourcesUi.addDatasources([ds]);
          afterUploaded({ success: 1, fail: 0, datasources: [ds] });
        } catch(e) {
          showErrorDialog({ title: 'Failed to load from GCS', description: e.message || String(e) });
        }
      } else {
        const uploadResults = await uploadUi.uploadFiles([singleUrl]);
        afterUploaded(uploadResults);
      }
    } else {
      const uploadResults = await uploadUi.uploadFiles(urls);
      afterUploaded(uploadResults);
    }
  });

  byId('addRemoteDatasource')
  .addEventListener('click', async (event) =>{
    const formHtml = [
      '<p>Connect to a dataset served by QueryService.</p>',
      '<form id="remoteDatasourceForm">',
      '<label for="remoteDatasourceBaseUrl">Base URL</label>',
      '<input type="text" id="remoteDatasourceBaseUrl" name="baseUrl" placeholder="http://localhost:8002" required />',
      '<label for="remoteDatasourceDatasetId">Dataset ID</label>',
      '<input type="text" id="remoteDatasourceDatasetId" name="datasetId" placeholder="trades_v1" required />',
      '</form>'
    ].join('');
    const result = await PromptUi.show({
      title: 'Add remote dataset',
      contents: formHtml,
      allowUnsafeHtml: true
    });
    if (result !== 'accept') {
      return;
    }
    const baseUrlInput = byId('remoteDatasourceBaseUrl');
    const datasetIdInput = byId('remoteDatasourceDatasetId');
    let baseUrl = (baseUrlInput && baseUrlInput.value && baseUrlInput.value.trim()) || '';
    const datasetId = (datasetIdInput && datasetIdInput.value && datasetIdInput.value.trim()) || '';
    if (!baseUrl || !datasetId) {
      showErrorDialog({ title: 'Invalid input', description: 'Base URL and Dataset ID are required.' });
      return;
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      baseUrl = 'http://' + baseUrl;
    }
    try {
      const config = RemoteDatasourceConfig.createRemoteDatasourceConfig({ baseUrl: baseUrl, datasetId: datasetId });
      const ds = new RemoteDatasource(config);
      await datasourcesUi.addDatasources([ds]);
      const promptDialog = byId('promptUi');
      if (promptDialog && typeof promptDialog.close === 'function') {
        promptDialog.close();
      }
      uploadUi.getDialog().close();
      TabUi.setSelectedTab('#sidebar', '#datasourcesTab');
    } catch (e) {
      showErrorDialog({ title: 'Could not add remote dataset', description: e.message || String(e) });
    }
  });

}
