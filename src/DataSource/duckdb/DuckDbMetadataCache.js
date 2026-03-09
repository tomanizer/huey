const COLUMN_METADATA_CACHE_PREFIX = 'huey:columnMetadata:v1:';

function getLocalStorage() {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  return localStorage;
}

export function buildColumnMetadataCacheKey(fingerprint) {
  if (!fingerprint) {
    return undefined;
  }
  return `${COLUMN_METADATA_CACHE_PREFIX}${fingerprint}`;
}

export function getCachedColumnMetadataRows(cacheKey) {
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
    const rows = payload && payload.rows;
    return Array.isArray(rows) ? rows : undefined;
  }
  catch (_error) {
    return undefined;
  }
}

export function cacheColumnMetadataRows(cacheKey, rows) {
  const storage = getLocalStorage();
  if (!storage || !cacheKey || !Array.isArray(rows)) {
    return;
  }
  try {
    storage.setItem(cacheKey, JSON.stringify({
      cachedAt: Date.now(),
      rows,
    }));
  }
  catch (_error) {
    // ignore storage quota or serialization failures
  }
}

export function createCachedColumnMetadataResult(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const fields = safeRows.length ? Object.keys(safeRows[0]).map((name) => ({ name })) : [];
  return {
    numRows: safeRows.length,
    schema: { fields },
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
  return rows;
}
