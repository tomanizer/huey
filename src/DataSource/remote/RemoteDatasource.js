import { EventEmitter } from '../../util/event/EventEmitter.js';
import { RemoteDatasourceConfig } from './RemoteDatasourceConfig.js';

/**
 * RemoteDatasource: fetches schema and query results from QueryService.
 * Use with RemoteDatasourceConfig. Implements getId(), getType(), getManagedConnection()
 * for compatibility with Huey; connection exposes getSchema(), fetchTuples(), fetchCells(), fetchPicklist().
 */

/** Default date when none set (matches common sample data: 2026-03-01). */
const DEFAULT_SINGLE_DATE = '2026-03-01';

/**
 * Normalize date_range to backend shape: { type: 'single', date } or { type: 'range', start, end }.
 * Handles from/to vs start/end and ensures valid YYYY-MM-DD.
 */
function normalizeDateRange(dateRange) {
  if (!dateRange || typeof dateRange !== 'object') {
    return { type: 'single', date: DEFAULT_SINGLE_DATE };
  }
  const type = dateRange.type === 'range' ? 'range' : 'single';
  if (type === 'range') {
    const start = dateRange.start ?? dateRange.from;
    const end = dateRange.end ?? dateRange.to;
    const s = typeof start === 'string' && start ? start.slice(0, 10) : DEFAULT_SINGLE_DATE;
    const e = typeof end === 'string' && end ? end.slice(0, 10) : s;
    return { type: 'range', start: s, end: e };
  }
  const d = dateRange.date;
  const date = typeof d === 'string' && d ? d.slice(0, 10) : DEFAULT_SINGLE_DATE;
  return { type: 'single', date };
}

function buildEnvelope(datasetId, dateRange, query, clientContext) {
  const envelope = {
    dataset_id: datasetId,
    date_range: normalizeDateRange(dateRange),
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
          const msg = body?.message || body?.detail || res.statusText;
          const details = body?.details?.errors ? ` ${JSON.stringify(body.details.errors)}` : '';
          const err = new Error(msg + details || 'Schema request failed');
          err.status = res.status;
          throw err;
        }).catch((e) => {
          if (e instanceof Error && e.status) throw e;
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
          const msg = body?.message || body?.detail || res.statusText;
          const details = body?.details?.errors ? ` ${JSON.stringify(body.details.errors)}` : '';
          const err = new Error(msg + details || 'Tuples request failed');
          err.status = res.status;
          throw err;
        }).catch((e) => {
          if (e instanceof Error && e.status) throw e;
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
          const msg = body?.message || body?.detail || res.statusText;
          const details = body?.details?.errors ? ` ${JSON.stringify(body.details.errors)}` : '';
          const err = new Error(msg + details || 'Cells request failed');
          err.status = res.status;
          throw err;
        }).catch((e) => {
          if (e instanceof Error && e.status) throw e;
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
          const msg = body?.message || body?.detail || res.statusText;
          const details = body?.details?.errors ? ` ${JSON.stringify(body.details.errors)}` : '';
          const err = new Error(msg + details || 'Picklist request failed');
          err.status = res.status;
          throw err;
        }).catch((e) => {
          if (e instanceof Error && e.status) throw e;
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

export class RemoteDatasource extends EventEmitter {
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
