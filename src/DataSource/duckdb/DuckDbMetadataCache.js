const COLUMN_METADATA_CACHE_PREFIX = 'huey:columnMetadata:v1:';

function getLocalStorage() {
  try {
    if (typeof globalThis === 'undefined' || typeof globalThis.localStorage === 'undefined') {
      return null;
    }
    return globalThis.localStorage;
  }
  catch (_error) {
    return null;
  }
}

export function buildColumnMetadataCacheKey(fingerprint) {
  if (!fingerprint) {
    return undefined;
  }
  return `${COLUMN_METADATA_CACHE_PREFIX}${fingerprint}`;
}

export function getCachedColumnMetadata(cacheKey) {
  const storage = getLocalStorage();
  if (!storage || !cacheKey) {
    return undefined;
  }
  try {
    const raw = storage.getItem(cacheKey);
    if (!raw) {
      return undefined;
    }
    const payload = JSON.parse(raw);
    if (payload && Array.isArray(payload.rows) && payload.schema) {
      return {
        rows: payload.rows,
        schema: payload.schema,
      };
    }
    return undefined;
  }
  catch (_error) {
    return undefined;
  }
}

export function cacheColumnMetadata(cacheKey, data) {
  const storage = getLocalStorage();
  if (!storage || !cacheKey || !data || !Array.isArray(data.rows) || !data.schema) {
    return;
  }
  try {
    storage.setItem(cacheKey, JSON.stringify({
      cachedAt: Date.now(),
      rows: data.rows,
      schema: data.schema,
    }));
  }
  catch (_error) {
    // ignore storage quota or serialization failures
  }
}

export function createCachedColumnMetadataResult(data) {
  const rows = data && data.rows;
  const schema = data && data.schema;
  const safeRows = Array.isArray(rows) ? rows : [];
  return {
    numRows: safeRows.length,
    schema: schema || { fields: [] },
    get(index) {
      const row = safeRows[index];
      if (!row) {
        return undefined;
      }
      return Object.assign({}, row, {
        toJSON() {
          return Object.assign({}, row);
        }
      });
    }
  };
}

export function serializeColumnMetadataResult(resultSet) {
  const numRows = resultSet && typeof resultSet.numRows === 'number' ? resultSet.numRows : 0;
  const rows = [];
  const schema = resultSet && resultSet.schema ? resultSet.schema : { fields: [] };
  for (let i = 0; i < numRows; i++) {
    const row = resultSet.get(i);
    if (!row) {
      continue;
    }
    if (typeof row.toJSON === 'function') {
      rows.push(row.toJSON());
      continue;
    }
    const schemaFields = resultSet.schema && resultSet.schema.fields ? resultSet.schema.fields : [];
    const plainRow = {};
    for (let j = 0; j < schemaFields.length; j++) {
      const fieldName = schemaFields[j].name;
      plainRow[fieldName] = row[fieldName];
    }
    rows.push(plainRow);
  }
  return {
    rows,
    schema,
  };
}
