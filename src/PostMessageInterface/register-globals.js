import { RemoteDatasource } from '../DataSource/remote/RemoteDatasource.js';
import { RemoteQueryAdapter } from '../DataSource/remote/RemoteQueryAdapter.js';
import { postMessageInterface } from './PostMessageInterface.js';

export function registerPostMessageGlobals() {
  // These globals are intentional: hosting pages use them for the PostMessage external API.
  window.RemoteDatasource = RemoteDatasource;
  window.RemoteQueryAdapter = RemoteQueryAdapter;
  window.postMessageInterface = postMessageInterface;
}
