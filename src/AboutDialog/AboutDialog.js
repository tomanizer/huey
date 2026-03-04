import { byId } from '../util/dom/dom.js';
import { hueyVersionNumber, hueyVersionName, tablerIconsFontVersion, duckDbLibraryUrl, duckdbLibraryVersion } from '../version.js';

export function initAboutDialog(){
  let el;

  el = byId('logoVersion');
  el.textContent = `v ${hueyVersionNumber} (${hueyVersionName})` ;

  el = byId('hueyVersion');
  el.textContent = `Huey version ${hueyVersionNumber} - ${hueyVersionName}`;

  el = byId('tablerIconsUrl');
  el.textContent = `Tabler Icons v${tablerIconsFontVersion}`;
  
  el = byId('duckDbLibraryUrl');
  el.setAttribute('href', duckDbLibraryUrl);
  el.textContent = `DuckDB WASM ${duckdbLibraryVersion}`;
}

initAboutDialog();