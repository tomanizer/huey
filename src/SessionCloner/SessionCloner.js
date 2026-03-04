import { byId } from '../util/dom/dom.js';
import { PostMessageProtocol } from '../PostMessageInterface/PostMessageProtocol.js';
import { PostMessageInterface, postMessageInterface, initPostMessageInterface } from '../PostMessageInterface/PostMessageInterface.js';
import { datasourcesUi } from '../DataSource/DataSourcesUi.js';
import { Routing } from '../Routing/Routing.js';

export class SessionCloner {

  constructor(){
    this.#init();
  }

  #init(){
    window.addEventListener('message', this.#messageHandler.bind(this));
    this.#initCloneHueySession();
  }
  
  #messageHandler(event){
    const request = event.data;
    if (!PostMessageInterface.isTrustedOrigin(event.origin)) {
      return;
    }
    const requestType = request.messageType;
    
    if (requestType) {
      return;
    }
    
    if (
      !request.status ||
      request.status.code !== PostMessageProtocol.STATUS_READY ||
      !request.body ||
      !request.body.params ||
      !request.body.params.cloneHueySession ||
      request.body.params.cloneHueySession !== 'true'
    ){
      return;
    }
    this.#copyWindowStateToHueyClone(event.source);
  }
  
  #copyWindowStateToHueyClone(clonedWindow){
    const targetOrigin = window.location.origin;
    const datasourceIds = datasourcesUi.getDatasourceIds();
    for (let i = 0; i < datasourceIds.length; i++) {
      const datasourceId = datasourceIds[i];
      const datasource = datasourcesUi.getDatasource(datasourceId);
      const originalConfig = datasource.getOriginalConfig();
      const request = {
        requestId: i,
        messageType: PostMessageProtocol.REQUEST_CREATE_DATASOURCE,
        body: {
          datasourceConfig: originalConfig
        }        
      };
      clonedWindow.postMessage(request, {targetOrigin: targetOrigin});
    }
    const route = Routing.getCurrentRoute();
    if (route) {
      const request = {
        requestId: i+1,
        messageType: PostMessageProtocol.REQUEST_SET_ROUTE,
        body: {
          route: route
        }        
      };
      clonedWindow.postMessage(request, {targetOrigin: targetOrigin});
    }
  }

  #initCloneHueySession(){
    byId('cloneHueySession').addEventListener('click', (event) =>{
      const location = document.location;
      const url = `${location.protocol}//${location.hostname}${location.pathname}?cloneHueySession=true`;
      
      if (!postMessageInterface) {
        initPostMessageInterface(true);
      }
      
      const windowProxy = window.open(url);
    });
  }

}

export let sessionCloner = undefined;
export function initSessionCloner() {
  sessionCloner = new SessionCloner();
}