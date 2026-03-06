/**
 * Remote datasource configuration model.
 * Describes a dataset served by QueryService (see docs/huey-large-scale-olap-tech-spec.md).
 *
 * Config shape:
 * - type: 'remote'
 * - baseUrl: string (QueryService base URL, e.g. 'https://api.example.com')
 * - datasetId: string (logical dataset id, e.g. 'trades_v1')
 * - id: string (optional; stable id for this datasource instance in the UI)
 */
export const RemoteDatasourceConfig = (function () {
  const REMOTE_DATASOURCE_TYPE = 'remote';
  const REMOTE_CONFIG_KEYS = ['type', 'baseUrl', 'datasetId', 'apiKey'];

  function createRemoteDatasourceConfig(opts) {
    const baseUrl = opts && opts.baseUrl;
    const datasetId = opts && opts.datasetId;
    const id = opts && opts.id;
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
      throw new Error('Remote datasource config requires baseUrl');
    }
    if (typeof datasetId !== 'string' || !datasetId.trim()) {
      throw new Error('Remote datasource config requires datasetId');
    }
    const config = {
      type: REMOTE_DATASOURCE_TYPE,
      baseUrl: baseUrl.replace(/\/$/, ''),
      datasetId: datasetId.trim()
    };
    if (opts && typeof opts.apiKey === 'string' && opts.apiKey.trim()) {
      config.apiKey = opts.apiKey.trim();
    }
    if (id !== null && id !== undefined && String(id).trim()) {
      config.id = String(id).trim();
    }
    return config;
  }

  function isRemoteDatasourceConfig(config) {
    if (!config || typeof config !== 'object') return false;
    if (config.type !== REMOTE_DATASOURCE_TYPE) return false;
    if (typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) return false;
    if (typeof config.datasetId !== 'string' || !config.datasetId.trim()) return false;
    return true;
  }

  return {
    REMOTE_DATASOURCE_TYPE: REMOTE_DATASOURCE_TYPE,
    REMOTE_CONFIG_KEYS: REMOTE_CONFIG_KEYS,
    createRemoteDatasourceConfig: createRemoteDatasourceConfig,
    isRemoteDatasourceConfig: isRemoteDatasourceConfig
  };
})();
