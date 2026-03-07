import { PostMessageProtocol } from './PostMessageProtocol.js';
import { pageStateManager } from '../PageStateManager/PageStateManager.js';
import { datasourcesUi } from '../DataSource/DataSourcesUi.js';
import { DuckDbDataSource } from '../DataSource/duckdb/DuckDbDataSource.js';
import { getDatabase, getDuckDbModule } from '../DataSource/duckdb/database.js';
import { registerPostMessageGlobals } from './register-globals.js';
import { analyzeDatasource } from '../App/analyzeDatasource.js';

/**
 * @typedef {Object} PostMessageRequestEnvelope
 * @property {string} messageType
 * @property {string} [requestId]
 * @property {Object} [body]
 */

/**
 * @typedef {Object} PostMessageResponseEnvelope
 * @property {string} messageType
 * @property {{messageType: string, requestId?: string, received: number}} [request]
 * @property {{code: string, message: string, sent: number}} status
 * @property {Object} [body]
 */

export class PostMessageInterface {

  static #trustedOrigins = undefined;
    
  constructor(){
    this.#init();
  }

  #init(){
    window.addEventListener('message', this.#messageHandler.bind(this));
  }

  static #normalizeOrigin(origin){
    if (typeof origin !== 'string' || !origin) {
      return undefined;
    }
    if (origin === 'null') {
      return undefined;
    }
    try {
      return new URL(origin).origin;
    }
    catch (_error) {
      return undefined;
    }
  }

  static #parseOriginsParam(value){
    if (!value || typeof value !== 'string') {
      return [];
    }
    return value
      .split(',')
      .map((origin) =>{
        return origin.trim();
      })
      .filter(Boolean)
      .map(PostMessageInterface.#normalizeOrigin)
      .filter(Boolean);
  }

  static #getHostingWindowOriginFromReferrer(){
    const referrer = document.referrer;
    if (!referrer) {
      return undefined;
    }
    try {
      return new URL(referrer).origin;
    }
    catch (_error) {
      return undefined;
    }
  }

  static getTrustedOrigins(){
    if (PostMessageInterface.#trustedOrigins) {
      return PostMessageInterface.#trustedOrigins;
    }

    let trustedOrigins = [window.location.origin];
    const params = new URLSearchParams(window.location.search);

    const configured = PostMessageInterface.#parseOriginsParam(params.get('postMessageOrigins'));
    trustedOrigins = trustedOrigins.concat(configured);

    const singleOrigin = PostMessageInterface.#normalizeOrigin(params.get('postMessageOrigin'));
    if (singleOrigin) {
      trustedOrigins.push(singleOrigin);
    }

    const hostingWindowOrigin = PostMessageInterface.#getHostingWindowOriginFromReferrer();
    if (hostingWindowOrigin) {
      trustedOrigins.push(hostingWindowOrigin);
    }

    trustedOrigins = Array.from(new Set(trustedOrigins.filter(Boolean)));
    PostMessageInterface.#trustedOrigins = trustedOrigins;
    return trustedOrigins;
  }

  static isTrustedOrigin(origin){
    const normalizedOrigin = PostMessageInterface.#normalizeOrigin(origin);
    if (!normalizedOrigin) {
      return false;
    }
    return PostMessageInterface.getTrustedOrigins().indexOf(normalizedOrigin) !== -1;
  }

  static getTargetOriginForHostingWindow(){
    const trustedOrigins = PostMessageInterface.getTrustedOrigins();
    const referrerOrigin = PostMessageInterface.#getHostingWindowOriginFromReferrer();
    if (referrerOrigin && trustedOrigins.indexOf(referrerOrigin) !== -1) {
      return referrerOrigin;
    }

    for (let i = 0; i < trustedOrigins.length; i++){
      const origin = trustedOrigins[i];
      if (origin !== window.location.origin) {
        return origin;
      }
    }

    return undefined;
  }

  static resetTrustedOriginsForTesting(){
    PostMessageInterface.#trustedOrigins = undefined;
  }

  /**
   * @param {PostMessageRequestEnvelope} request
   * @returns {boolean}
   */
  #isValidRequestEnvelope(request){
    if (!request || typeof request !== 'object') {
      return false;
    }
    if (typeof request.messageType !== 'string' || !request.messageType.length) {
      return false;
    }
    return true;
  }
  
  /**
   * Handle inbound postMessage requests and send typed response envelopes.
   * @param {MessageEvent<PostMessageRequestEnvelope>} event
   * @returns {Promise<PostMessageResponseEnvelope|undefined>}
   */
  async #messageHandler(event){
    const request = event.data;

    if (!PostMessageInterface.isTrustedOrigin(event.origin)) {
      console.warn('Ignoring postMessage request from untrusted origin:', event.origin);
      return;
    }

    if (!event.source || typeof event.source.postMessage !== 'function') {
      console.warn('Ignoring postMessage request without a valid source window.');
      return;
    }

    if (!this.#isValidRequestEnvelope(request)) {
      event.source.postMessage({
        messageType: PostMessageProtocol.RESPONSE,
        status: {
          code: PostMessageProtocol.STATUS_BAD_REQUEST,
          message: 'Malformed request envelope.',
          sent: Date.now()
        }
      }, {targetOrigin: event.origin});
      return;
    }

    const requestType = request.messageType;
    
    const requestId = request.requestId;
    const response = {
      messageType: PostMessageProtocol.RESPONSE,
      request: {
        messageType: requestType,
        requestId: requestId,
        received: Date.now()
      },
      status: {
        code: undefined,
        message: undefined,
        sent: undefined
      }
    };
    
    switch (requestType){
      case PostMessageProtocol.RESPONSE:
        return;
      case PostMessageProtocol.REQUEST_PING:
        this.#handlePingRequest(request, response);
        break;
      case PostMessageProtocol.REQUEST_CREATE_DATASOURCE:
        await this.#handleCreateDatasourceRequest(request, response);
        break;
      case PostMessageProtocol.REQUEST_SET_ROUTE:
        this.#handleSetRouteRequest(request, response);
        break;
      default:
        response.status.code = PostMessageProtocol.STATUS_BAD_REQUEST;
        response.status.message = `Unrecognized messageType '${requestType}'.`;
    }

    response.status.sent = Date.now();
    event.source.postMessage(response, {targetOrigin: event.origin});
    return response;
  }
    
  #getErrorResponseBody(error){
    return {
      error: {
        name: error.name,
        message: error.message
      }
    };
  }    
    
  #initInternalErrorResponse(error, response){
    response.status.code = PostMessageProtocol.STATUS_INTERNAL_ERROR;
    response.status.message = error.message;
    response.body = this.#getErrorResponseBody(error);
  }

  #initBadRequestResponse(error, response){
    response.status.code = PostMessageProtocol.STATUS_BAD_REQUEST;
    response.status.message = error.message;
    if (error.cause){
      response.body = this.#getErrorResponseBody(error.cause);
    }
  }
  
  #handleSetRouteRequest(request, response){
    try{
      let body;
      let route;
      try {
        body = request.body;
        if (typeof body !== 'object' || body === null) {
          throw new Error('Request body is mandatory', {cause: 'body is null or not an object'});
        }
        route = body.route;
      }
      catch (error){
        this.#initBadRequestResponse(error, response);
        return;
      }

      if (route){
        pageStateManager.setPageState(route);
      }
      
      response.status.code = PostMessageProtocol.STATUS_OK;
      response.status.message = `New route set.`;
    } 
    catch (error){
      this.#initInternalErrorResponse(error, response);
    }
  }
  
  async #handleCreateDatasourceRequest(request, response){
    try {
      let body;
      let duckDbDataSource;
      try {
        body = request.body;
        if (typeof body !== 'object' || body === null) {
          throw new Error('Request body is mandatory', {cause: 'body is null or not an object'});
        }
        
        const duckdb = getDuckDbModule();
        const duckDbInstance = getDatabase();
        const datasourceConfig = body.datasourceConfig;
        duckDbDataSource = new DuckDbDataSource(duckdb, duckDbInstance, datasourceConfig);

      }
      catch (error){
        this.#initBadRequestResponse(error, response);
        return;
      }
      
      const datasources = [duckDbDataSource];
      await datasourcesUi.addDatasources(datasources);
      
      if (body.selectForAnalysis === true){
        analyzeDatasource(duckDbDataSource);
      }
      
      response.status.code = PostMessageProtocol.STATUS_OK;
      response.status.message = `Datasource '${duckDbDataSource.getId()}' created.`;
      response.body = {
        datasource: {
          id: duckDbDataSource.getId(),
          type: duckDbDataSource.getType()
        }
      }
    }
    catch (error){
      this.#initInternalErrorResponse(error, response);
    }
  }

  #handlePingRequest(request, response){
    response.status.code = PostMessageProtocol.STATUS_OK;
    response.status.message = 'pong';
  }
  
  static getHostingWindow(){
    if (window.parent !== window){
      return window.parent;
    }
    if (window.opener){
      return window.opener;
    }
    return undefined;
  }
  
  sendReadyMessage(){
    if (!window.opener && window.parent === window) {
      console.warn('This is a standalone Huey instance - There is no opener or parent window to send the ready message to.');
      return;
    }
    
    let search = window.location.search;
    const params = {};
    if (search && search.length){
      search = search.substring(1).split('&').reduce((params, param) =>{
        const nameValue = param.split('=');
        const name = nameValue[0];
        const value = nameValue[1];
        params[name] = value;
        return params;
      }, params);
    }
    
    const hostingWindow = PostMessageInterface.getHostingWindow();
    const targetOrigin = PostMessageInterface.getTargetOriginForHostingWindow();
    if (!targetOrigin) {
      console.warn('Could not determine trusted hosting window origin for ready message. Configure postMessageOrigins or use a trusted referrer origin.');
      return;
    }
    
    hostingWindow.postMessage({
      status: {
        code: PostMessageProtocol.STATUS_READY,
        message: 'Huey PostMessageInterface ready for requests.',
        sent: Date.now()
      },
      body: {
        params: params
      }
    }, {targetOrigin: targetOrigin});
  }
  
}

export let postMessageInterface = undefined;
export function initPostMessageInterface(skipHostingWindowCheck){
  if (!skipHostingWindowCheck && !PostMessageInterface.getHostingWindow()) {
    registerPostMessageGlobals();
    return;
  }
  postMessageInterface = new PostMessageInterface();
  registerPostMessageGlobals();
}
