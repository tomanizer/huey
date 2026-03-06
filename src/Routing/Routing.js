
import { QueryModel } from '../QueryModel/QueryModel.js';

export class Routing {
 
  static getQueryModelStateFromRoute(route){
    try {
      const base64 = route;
      const ascii = atob( base64 ); 
      const json = decodeURIComponent( ascii );
      const state = JSON.parse( json );
            
      return state;
    }
    catch(_error){
      return null;
    }
  }
      
  static getRouteForQueryModel(queryModel){
    let queryModelState;
    if (queryModel instanceof QueryModel) {
      queryModelState = queryModel.getState();
    }
    else
    if (typeof queryModel === 'object') {
      queryModelState = queryModel;
    }
    else {
      throw new Error(`Invalid argument: expected query model instance or query model state.`);
    }
    
    if (queryModelState === null) {
      return undefined;
    }
    
    const routeObject = queryModelState.queryModel ? queryModelState : {
      queryModel: queryModelState 
    };
    const json = JSON.stringify( routeObject );
    const ascii = encodeURIComponent( json );
    const base64 = btoa( ascii ); 
    const route = base64;
    return route;
  }

  static getCurrentRoute(){
    let hash = document.location.hash;

    if (hash.startsWith('#')){
      hash = hash.substring(1);
    }

    if (hash === ''){
      return undefined;
    }
    
    return hash;
  }
  
  static isSynced(queryModel) {
    const route = Routing.getRouteForQueryModel(queryModel);
    const currentRoute = Routing.getCurrentRoute();
    return route === currentRoute;
  }

  static updateRouteFromQueryModel(queryModel){
    const newRoute = Routing.getRouteForQueryModel(queryModel);
    const hash = newRoute ? `#${newRoute}` : '';
    if (history.state === newRoute && Routing.getCurrentRoute() === newRoute){
      return;
    }
    history.pushState(newRoute, undefined, hash);
    if (Routing.getCurrentRoute() !== newRoute){
      document.location.hash = hash;
    }
  }
  
}
