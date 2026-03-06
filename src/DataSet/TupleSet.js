import { DataSetComponent } from './DataSetComponent.js';
import { SqlQueryGenerator } from './SqlQueryGenerator.js';
import { QueryAxisItem } from '../QueryModel/QueryModel.js';
import { RemoteQueryAdapter } from '../DataSource/remote/RemoteQueryAdapter.js';

export class TupleSet extends DataSetComponent {

  static groupingIdAlias = '__huey_grouping_id';
  static #defaultMaxCacheEntries = 10000;
  static #defaultMaxCacheSizeMb = 50;

  //
  /**
   * @param {import('../QueryModel/QueryModel.js').QueryModel} queryModel
   * @param {string} axisId
   * @param {boolean} includeCountAll
   * @returns {Object<string, string>|undefined}
   */
  static getSqlSelectExpressions(queryModel, axisId, includeCountAll){
    const queryAxis = queryModel.getQueryAxis(axisId);
    const queryAxisItems = queryAxis.getItems();
    if (!queryAxisItems.length) {
      return undefined;
    }

    const selectListExpressions = {};
    for (let i = 0; i < queryAxisItems.length; i++) {
      const queryAxisItem = queryAxisItems[i];
      const caption = QueryAxisItem.getCaptionForQueryAxisItem(queryAxisItem);
      const selectListExpression = QueryAxisItem.getSqlForQueryAxisItem(queryAxisItem);
      selectListExpressions[caption] = selectListExpression;
    }

    if (includeCountAll) {
      const countExpression = 'COUNT(*) OVER ()';
      selectListExpressions[countExpression] = countExpression;
    }
    return selectListExpressions;
  }

  /**
   * @param {import('../QueryModel/QueryModel.js').QueryModel} queryModel
   * @param {string} axisId
   * @param {boolean} includeCountAll
   * @param {'FIRST'|'LAST'} nullsSortOrder
   * @param {'AFTER'|'BEFORE'} totalsPosition
   * @returns {string}
   */
  static getSqlSelectStatement(queryModel, axisId, includeCountAll, nullsSortOrder, totalsPosition){
    const datasource = queryModel.getDatasource();

    const queryAxis = queryModel.getQueryAxis(axisId);
    const queryAxisItems = queryAxis.getItems();

    const filterAxis = queryModel.getFiltersAxis();
    const filterAxisItems = filterAxis.getItems();

    let samplingConfig;
    if (includeCountAll) {
      samplingConfig = queryModel.getSampling(axisId);
    }

    const sql = SqlQueryGenerator.getSqlSelectStatementForAxisItems({
      datasource: datasource,
      queryAxisItems: queryAxisItems,
      filterAxisItems: filterAxisItems,
      includeCountAll: includeCountAll,
      countAllAlias: undefined,
      nullsSortOrder: nullsSortOrder,
      totalsPosition: totalsPosition,
      samplingConfig: samplingConfig
    });
    return sql;
  }

  #queryAxisId = undefined;

  #tuples = [];
  #tupleValueFields = [];

  #tupleCount = undefined;
  #pageSize = 50;
  #tupleAccessTimestamps = new Map();
  #accessCounter = 0;

  constructor(queryModel, axisId, settings){
    super(queryModel, settings);
    this.#queryAxisId = axisId;
  }
  
  #getNullsSortOrder(){
    const settings = this.getSettings();
    let nullsSortOrder;
    if (typeof settings.getSettings === 'function'){
      nullsSortOrder = settings.getSettings([
        'localeSettings', 
        'nullsSortOrder', 
        'value'
      ]);
    };
    if (!nullsSortOrder) {
      nullsSortOrder = 'FIRST';
    }
    if (['FIRST','LAST'].indexOf(nullsSortOrder) === -1) {
      console.warn(`Wrong value for nullsSortOrder "${nullsSortOrder}"`);
      nullsSortOrder = 'FIRST';
    }
    return nullsSortOrder;
  }
  
  #getTotalsPosition(){
    const settings = this.getSettings();
    let totalsPosition;
    if (typeof settings.getSettings === 'function'){
      totalsPosition = settings.getSettings([
        'pivotSettings', 
        'totalsPosition', 
        'value'
      ]);
    }
    if (!totalsPosition){
      totalsPosition = 'AFTER';
    }
    if (['AFTER','BEFORE'].indexOf(totalsPosition) === -1) {
      console.warn(`Wrong value for totalsPosition "${totalsPosition}"`);
      totalsPosition = 'AFTER';
    }
    return totalsPosition;
  }

  /**
   * @returns {Object[]}
   */
  getTupleValueFields(){
    return this.#tupleValueFields;
  }

  /**
   * @returns {number}
   */
  getPageSize(){
    return this.#pageSize;
  }

  /**
   * @param {number} pageSize
   * @returns {void}
   */
  setPageSize(pageSize){
    this.#pageSize = pageSize;
  }

  /**
   * @returns {string}
   */
  getQueryAxisId(){
    return this.#queryAxisId;
  }

  /**
   * @returns {Object[]}
   */
  getQueryAxisItems(){
    const queryModel = this.getQueryModel();
    const axisId = this.#queryAxisId;

    const queryAxis = queryModel.getQueryAxis(axisId);
    const items = queryAxis.getItems();
    return items;
  }

  #getSqlSelectStatement(includeCountAll){
    const queryModel = this.getQueryModel();
    if (!queryModel) {
      return undefined;
    }
    const nullsSortOrder = this.#getNullsSortOrder();
    const totalsPosition = this.#getTotalsPosition();    
    const sql = TupleSet.getSqlSelectStatement(
      queryModel,
      this.#queryAxisId,
      includeCountAll,
      nullsSortOrder,
      totalsPosition
    );
    return sql;
  }

  clear(){
    this.#tuples = [];
    this.#tupleCount = undefined;
    this.#tupleAccessTimestamps.clear();
    this.#accessCounter = 0;
  }

  clearCache(){
    this.clear();
  }

  #touchTuple(index){
    this.#accessCounter += 1;
    this.#tupleAccessTimestamps.set(index, this.#accessCounter);
  }

  #removeTuple(index){
    this.#tuples[index] = undefined;
    this.#tupleAccessTimestamps.delete(index);
  }

  #getMaxCacheEntries(){
    const settings = this.getSettings();
    let maxCacheEntries;
    if (settings && typeof settings.getSettings === 'function'){
      maxCacheEntries = Number(settings.getSettings(['querySettings', 'tupleSetMaxCacheEntries']));
    }
    if (!Number.isFinite(maxCacheEntries) || maxCacheEntries < 0) {
      maxCacheEntries = TupleSet.#defaultMaxCacheEntries;
    }
    return maxCacheEntries;
  }

  #getMaxCacheSizeBytes(){
    const settings = this.getSettings();
    let maxCacheSizeMb;
    if (settings && typeof settings.getSettings === 'function'){
      maxCacheSizeMb = Number(settings.getSettings(['querySettings', 'tupleSetMaxCacheSizeMb']));
    }
    if (!Number.isFinite(maxCacheSizeMb) || maxCacheSizeMb < 0) {
      maxCacheSizeMb = TupleSet.#defaultMaxCacheSizeMb;
    }
    return maxCacheSizeMb * 1024 * 1024;
  }

  get cacheSize(){
    const tuples = {};
    this.#tupleAccessTimestamps.forEach((value, index) => {
      tuples[index] = this.#tuples[index];
    });
    return JSON.stringify(tuples).length;
  }

  #enforceCacheLimits(){
    const maxEntries = this.#getMaxCacheEntries();
    const maxSizeBytes = this.#getMaxCacheSizeBytes();
    let currentCacheSize = this.cacheSize;

    while (this.#tupleAccessTimestamps.size > maxEntries || currentCacheSize > maxSizeBytes){
      let oldestIndex;
      let oldestAccess = Infinity;
      this.#tupleAccessTimestamps.forEach((access, index) =>{
        if (access < oldestAccess) {
          oldestAccess = access;
          oldestIndex = index;
        }
      });
      if (oldestIndex === undefined){
        break;
      }
      this.#removeTuple(oldestIndex);
      currentCacheSize = this.cacheSize;
    }
  }

  /**
   * @returns {number|undefined}
   */
  getTupleCountSync() {
    return this.#tupleCount;
  }

  /**
   * Return a range of tuples for the current page window.
   * @param {number} from inclusive start index
   * @param {number} to exclusive end index
   * @returns {Object[]}
   */
  getTuplesSync(from, to){
    const tuples = this.#tuples.slice(from, to);
    for (let i = 0; i < tuples.length; i++){
      if (tuples[i] !== undefined) {
        this.#touchTuple(from + i);
      }
    }
    return tuples;
  }

  /**
   * @param {number} index
   * @returns {Object|undefined}
   */
  getTupleSync(index){
    const tuple = this.#tuples[index];
    if (tuple !== undefined) {
      this.#touchTuple(index);
    }
    return tuple;
  }

  /**
   * @returns {Promise<number|undefined>}
   */
  async getTupleCount(){
    return new Promise(function(resolve, _reject){
      resolve(this.#tupleCount);
    });
  }

  #loadTuples(resultSet, offset) {
    const numRows = resultSet.numRows;

    const fields = resultSet.schema.fields;

    const items = this.getQueryAxisItems();
    let hasGroupingId = false, fieldOffset = 0, fieldCount = items.length;
    if (fields[0].name === TupleSet.groupingIdAlias) {
      hasGroupingId = true;
      fieldOffset += 1;
      fieldCount += 1;
    }

    const tuples = this.#tuples;

    // if the offset is 0 we should have included an expression that computes the total count as last
    if (offset === 0) {
      if (numRows === 0){
        this.#tupleCount = 0;
      }
      else {
        const firstRow = resultSet.get(0);
        const lastField = fields[fields.length - 1];
        const totalCount = firstRow[lastField.name];
        this.#tupleCount = parseInt(String(totalCount), 10);
      }
    }
    this.#tupleValueFields = fields.slice(fieldOffset, fieldCount);

    for (let i = 0; i < numRows; i++){

      const row = resultSet.get(i);
      const values = [];
      const tuple = {values: values};

      if (hasGroupingId){
        const groupingId = row[TupleSet.groupingIdAlias];
        if (groupingId > 0) {
          tuple[TupleSet.groupingIdAlias] = groupingId;
        }
      }

      for (let j = fieldOffset; j < fieldCount; j++){
        const field = fields[j];
        const fieldName = field.name;
        const value = row[fieldName];
        values[j - fieldOffset] = value;
      }

      tuples[offset + i] = tuple;
      this.#touchTuple(offset + i);
    }
    this.#enforceCacheLimits();
  }

  #buildRemoteTuplesQuery(limit, offset){
    const queryModel = this.getQueryModel();
    return RemoteQueryAdapter.createRemoteTuplesQuery(queryModel, this.#queryAxisId, limit, offset);
  }

  /** Map QueryService/columnType string to Arrow typeId so pivot formatters and literal writers work. */
  static #columnTypeToArrowTypeId(columnType) {
    const t = (columnType || 'VARCHAR').toUpperCase();
    if (t === 'DATE') return 8;
    if (t === 'TIMESTAMP' || t.indexOf('TIMESTAMP') >= 0) return 10;
    if (t === 'BIGINT' || t === 'INTEGER' || t === 'INT64') return -5;
    if (t === 'DOUBLE' || t === 'FLOAT' || t === 'FLOAT64') return -12;
    if (t === 'BOOLEAN' || t === 'BOOL') return 6;
    return 5; // Utf8 / VARCHAR
  }

  #remoteResponseToResultSet(apiResponse, axisItems, includeCountAll){
    const items = apiResponse.items || [];
    const totalCount = apiResponse.total_count !== null ? apiResponse.total_count : items.length;
    const hasGroupingId = items.some((item) => { return item.grouping_id !== null; });
    const fields = [];
    if (hasGroupingId) fields.push({ name: TupleSet.groupingIdAlias });
    axisItems.forEach((item) => {
      const typeId = TupleSet.#columnTypeToArrowTypeId(item.columnType);
      fields.push({ name: item.columnName, type: { typeId: typeId } });
    });
    if (includeCountAll) fields.push({ name: '__huey_count' });
    const fieldNames = axisItems.map((item) => { return item.columnName; });
    const numRows = items.length;
    const get = (function(items, fieldNames, totalCount, includeCountAll, hasGroupingId) {
      return function(i) {
        const row = {};
        const item = items[i];
        if (!item) return row;
        // eslint-disable-next-line eqeqeq
        if (hasGroupingId) row[TupleSet.groupingIdAlias] = item.grouping_id != null ? item.grouping_id : 0;
        const vals = item.values || [];
        for (let j = 0; j < fieldNames.length; j++) {
          row[fieldNames[j]] = vals[j];
        }
        if (includeCountAll) {
          row['__huey_count'] = i === 0 ? totalCount : (numRows > 0 ? totalCount : 0);
        }
        return row;
      };
    })(items, fieldNames, totalCount, includeCountAll, hasGroupingId);
    return {
      numRows: numRows,
      schema: { fields: fields },
      get: get
    };
  }

  async #executeAxisQuery(limit, offset){
    const includeCountExpression = offset === 0;
    const queryModel = this.getQueryModel();
    const datasource = queryModel.getDatasource();
    const isRemote = datasource && datasource.getType && datasource.getType() === 'remote';

    if (isRemote && datasource.getManagedConnection().fetchTuples) {
      const query = this.#buildRemoteTuplesQuery(limit, offset);
      if (!query) return 0;
      const dateRange = RemoteQueryAdapter.getDateRange(queryModel);
      const connection = datasource.getManagedConnection();
      let apiResponse;
      try {
        apiResponse = await connection.fetchTuples(dateRange, query);
      } catch (e) {
        console.error('Remote tuples fetch failed', e);
        throw e;
      }
      if (connection.getState() === 'canceled') return 0;
      const axisItems = this.getQueryAxisItems();
      const resultSet = this.#remoteResponseToResultSet(apiResponse, axisItems, includeCountExpression);
      this.#loadTuples(resultSet, offset);
      return resultSet.numRows;
    }

    let axisSql = this.#getSqlSelectStatement(includeCountExpression);
    if (!axisSql){
      return 0;
    }
    axisSql = `${axisSql}\nLIMIT ${limit} OFFSET ${offset}`;

    const connection = await this.getManagedConnection();
    const resultset = await connection.query(axisSql);
    const _rejects = await this.getQueryModel().getDatasource().getRejects();
    if (connection.getState() === 'canceled') {
      return 0;
    }
    this.#loadTuples(resultset, offset);

    return resultset.numRows;
  }

  getCachedTupleCount(offset){
    const data = this.#tuples;
    let cachedTupleCount = 0;
    for (let i = offset; i < this.#tupleCount; i++){
      const tuple = data[i];
      if (!tuple){
        break;
      }
      cachedTupleCount += 1;
    }
    return cachedTupleCount;
  }

  async getTuples(count, offset){

    const data = this.#tuples;
    let tuples = [];

    let i = 0;
    let firstIndexToFetch, lastIndexToFetch;

    if (this.#tupleCount !== undefined && offset + count > this.#tupleCount) {
      count = this.#tupleCount - offset;
    }

    while (i < count) {
      const tupleIndex = offset + i;
      const tuple = data[tupleIndex];
      if (tuple === undefined) {
        if (firstIndexToFetch === undefined) {
          firstIndexToFetch = tupleIndex;
          lastIndexToFetch = tupleIndex;
        }
        else
        if (tupleIndex > lastIndexToFetch) {
          lastIndexToFetch = tupleIndex;
        }
      }
      else {
        tuples[i] = tuple;
      }
      i += 1;
    }

    if (firstIndexToFetch === undefined) {
      return tuples;
    }

    lastIndexToFetch += 1;
    let newCount = (lastIndexToFetch - firstIndexToFetch);
    if (newCount < this.#pageSize && (offset + count === lastIndexToFetch) && lastIndexToFetch < this.#tupleCount) {
      newCount = this.#pageSize;
    }

    const _numRows = await this.#executeAxisQuery(newCount, firstIndexToFetch);
    tuples = data.slice(offset, offset + count);
    return tuples;
  }

}
