/**
 * RemoteDatasource: fetches schema and query results from QueryService.
 * Use with RemoteDatasourceConfig. Implements getId(), getType(), getManagedConnection()
 * for compatibility with Huey; connection exposes getSchema(), fetchTuples(), fetchCells(), fetchPicklist().
 */
function buildEnvelope(datasetId, dateRange, query, clientContext) {
  const envelope = {
    dataset_id: datasetId,
    date_range: dateRange || { type: 'single', date: new Date().toISOString().slice(0, 10) },
    query: query || {}
  };
  if (clientContext) {
    envelope.client_context = clientContext;
  }
  return envelope;
}

function buildHeaders(datasource, includeJson) {
  const headers = {};
  if (includeJson) {
    headers['Content-Type'] = 'application/json';
  }
  const apiKey = datasource.getApiKey && datasource.getApiKey();
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  return headers;
}

class RemoteConnection {
  #datasource;
  #abortController = null;
  #state = 'queried';

  constructor(datasource) {
    this.#datasource = datasource;
  }

  getConnectionId() {
    return 'remote';
  }

  getState() {
    return this.#state;
  }

  getSchema() {
    const baseUrl = this.#datasource.getBaseUrl();
    const datasetId = this.#datasource.getDatasetId();
    const url = `${baseUrl}/schema?dataset_id=${encodeURIComponent(datasetId)}`;
    this.#abortController = new AbortController();
    return fetch(url, {
      signal: this.#abortController.signal,
      headers: buildHeaders(this.#datasource, false)
    }).then((res) => {
      if (!res.ok) {
        return res.json().then((body) => {
          const err = new Error(body.detail || res.statusText);
          err.status = res.status;
          throw err;
        }).catch(() => {
          throw new Error(res.statusText || 'Schema request failed');
        });
      }
      return res.json();
    });
  }

  fetchTuples(dateRange, query, clientContext) {
    const baseUrl = this.#datasource.getBaseUrl();
    const datasetId = this.#datasource.getDatasetId();
    const envelope = buildEnvelope(datasetId, dateRange, query, clientContext);
    this.#abortController = new AbortController();
    return fetch(`${baseUrl}/query/tuples`, {
      method: 'POST',
      headers: buildHeaders(this.#datasource, true),
      body: JSON.stringify(envelope),
      signal: this.#abortController.signal
    }).then((res) => {
      if (!res.ok) {
        return res.json().then((body) => {
          const err = new Error(body.detail || res.statusText);
          err.status = res.status;
          throw err;
        }).catch(() => {
          throw new Error(res.statusText || 'Tuples request failed');
        });
      }
      return res.json();
    });
  }

  fetchCells(dateRange, query, clientContext) {
    const baseUrl = this.#datasource.getBaseUrl();
    const datasetId = this.#datasource.getDatasetId();
    const envelope = buildEnvelope(datasetId, dateRange, query, clientContext);
    this.#abortController = new AbortController();
    return fetch(`${baseUrl}/query/cells`, {
      method: 'POST',
      headers: buildHeaders(this.#datasource, true),
      body: JSON.stringify(envelope),
      signal: this.#abortController.signal
    }).then((res) => {
      if (!res.ok) {
        return res.json().then((body) => {
          const err = new Error(body.detail || res.statusText);
          err.status = res.status;
          throw err;
        }).catch(() => {
          throw new Error(res.statusText || 'Cells request failed');
        });
      }
      return res.json();
    });
  }

  fetchPicklist(dateRange, query, clientContext) {
    const baseUrl = this.#datasource.getBaseUrl();
    const datasetId = this.#datasource.getDatasetId();
    const envelope = buildEnvelope(datasetId, dateRange, query, clientContext);
    this.#abortController = new AbortController();
    return fetch(`${baseUrl}/query/picklist`, {
      method: 'POST',
      headers: buildHeaders(this.#datasource, true),
      body: JSON.stringify(envelope),
      signal: this.#abortController.signal
    }).then((res) => {
      if (!res.ok) {
        return res.json().then((body) => {
          const err = new Error(body.detail || res.statusText);
          err.status = res.status;
          throw err;
        }).catch(() => {
          throw new Error(res.statusText || 'Picklist request failed');
        });
      }
      return res.json();
    });
  }

  query() {
    return Promise.reject(new Error('Remote datasource does not support SQL; use fetchTuples, fetchCells, or fetchPicklist.'));
  }

  cancelPendingQuery() {
    if (this.#abortController) {
      this.#state = 'canceled';
      this.#abortController.abort();
      this.#abortController = null;
    }
    return Promise.resolve();
  }
}

class RemoteDatasource extends EventEmitter {
  #baseUrl;
  #datasetId;
  #apiKey;
  #id;
  #connection;

  constructor(config) {
    if (typeof EventEmitter === 'undefined') {
      throw new Error('RemoteDatasource requires EventEmitter');
    }
    if (!RemoteDatasourceConfig.isRemoteDatasourceConfig(config)) {
      throw new Error('Invalid remote datasource config');
    }
    super(['destroy', 'change']);
    this.#baseUrl = config.baseUrl.replace(/\/$/, '');
    this.#datasetId = config.datasetId;
    this.#apiKey = config.apiKey;
    this.#id = config.id || `remote:${this.#baseUrl}:${this.#datasetId}`;
    this.#connection = new RemoteConnection(this);
  }

  getType() {
    return RemoteDatasourceConfig.REMOTE_DATASOURCE_TYPE;
  }

  getId() {
    return this.#id;
  }

  getBaseUrl() {
    return this.#baseUrl;
  }

  getDatasetId() {
    return this.#datasetId;
  }

  getApiKey() {
    return this.#apiKey;
  }

  getManagedConnection() {
    return this.#connection;
  }

  getSchema() {
    return this.#connection.getSchema();
  }

  getRejects() {
    return Promise.resolve();
  }

  destroy() {
    this.fireEvent('destroy', {});
  }
}

window.RemoteDatasource = RemoteDatasource;
