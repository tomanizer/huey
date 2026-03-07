import { DataSetComponent } from './DataSetComponent.js';
import { TupleSet } from './TupleSet.js';
import { SqlQueryGenerator } from './SqlQueryGenerator.js';
import { QueryAxisItem, QueryModel } from '../QueryModel/QueryModel.js';
import { RemoteQueryAdapter } from '../DataSource/remote/RemoteQueryAdapter.js';
import { quoteIdentifierWhenRequired, getQualifiedIdentifier, quoteStringLiteral } from '../util/sql/SQLHelper.js';

export function getTupleValueLiteral(queryAxisItem, tupleValue, tupleValueField){
  if (queryAxisItem.literalWriter) {
    return queryAxisItem.literalWriter(tupleValue, tupleValueField);
  }
  if (tupleValue === null || tupleValue === undefined) {
    return 'NULL';
  }
  if (typeof tupleValue === 'string') {
    return quoteStringLiteral(tupleValue);
  }
  return String(tupleValue);
}

/**
 * @typedef {[number, number]} TupleRange
 */

export class CellSet extends DataSetComponent {

  // Cells is an array indexed by columntupleIndex * rowTupleIndex
  // Cells array elements are objects having a values property.
  // The values property is an array of values corresponding (by position) to the items of the cells axis
  #cells = [];
  #cellValueFields = {};

  #tupleSets = [];
  #cellAccessTimestamps = new Map();
  #cellSerializedSizes = new Map();
  #accessCounter = 0;
  #cacheSize = CellSet.#emptyCacheSize;
  #lastQueryTimeMs = undefined;
  #totalQueryTimeMs = 0;

  static datasetRelationName = '__data';
  static #tupleDataRelationName = '__huey_tuples';
  static #cellIndexColumnName = '__huey_cellIndex';
  static #countStarExpressionAlias = '__huey_count_star';
  static #defaultMaxCacheEntries = 10000;
  static #defaultMaxCacheSizeMb = 50;
  static #emptyCacheSize = JSON.stringify({}).length;
  static #serializedEntrySeparatorSize = 1;

  constructor(queryModel, tupleSets, settings){
    super(queryModel, settings);
    this.#tupleSets = tupleSets;
  }

  clear(){
    this.#cells = [];
    this.#cellValueFields = {};
    this.#cellAccessTimestamps.clear();
    this.#cellSerializedSizes.clear();
    this.#accessCounter = 0;
    this.#cacheSize = CellSet.#emptyCacheSize;
    this.#lastQueryTimeMs = undefined;
    this.#totalQueryTimeMs = 0;
  }

  clearCache(){
    this.clear();
  }

  #touchCell(cellIndex){
    this.#accessCounter += 1;
    this.#cellAccessTimestamps.set(cellIndex, this.#accessCounter);
  }

  #removeCell(cellIndex){
    const serializedSize = this.#cellSerializedSizes.get(cellIndex);
    if (serializedSize !== undefined) {
      if (this.#cellSerializedSizes.size === 1) {
        this.#cacheSize = CellSet.#emptyCacheSize;
      }
      else {
        this.#cacheSize -= serializedSize - CellSet.#serializedEntrySeparatorSize;
      }
      this.#cellSerializedSizes.delete(cellIndex);
    }
    this.#cells[cellIndex] = undefined;
    this.#cellAccessTimestamps.delete(cellIndex);
  }

  #getMaxCacheEntries(){
    const settings = this.getSettings();
    let maxCacheEntries;
    if (settings && typeof settings.getSettings === 'function'){
      maxCacheEntries = Number(settings.getSettings(['querySettings', 'cellSetMaxCacheEntries']));
    }
    if (!Number.isFinite(maxCacheEntries) || maxCacheEntries < 0) {
      maxCacheEntries = CellSet.#defaultMaxCacheEntries;
    }
    return maxCacheEntries;
  }

  #getMaxCacheSizeBytes(){
    const settings = this.getSettings();
    let maxCacheSizeMb;
    if (settings && typeof settings.getSettings === 'function'){
      maxCacheSizeMb = Number(settings.getSettings(['querySettings', 'cellSetMaxCacheSizeMb']));
    }
    if (!Number.isFinite(maxCacheSizeMb) || maxCacheSizeMb < 0) {
      maxCacheSizeMb = CellSet.#defaultMaxCacheSizeMb;
    }
    return maxCacheSizeMb * 1024 * 1024;
  }

  get cacheSize(){
    return this.#cacheSize;
  }

  static #cacheSizeJsonReplacer(key, value){
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  }

  #updateCellCacheSize(cellIndex){
    const cell = this.#cells[cellIndex];
    const serializedSize = JSON.stringify(
      {[cellIndex]: cell},
      CellSet.#cacheSizeJsonReplacer
    ).length;
    const currentSerializedSize = this.#cellSerializedSizes.get(cellIndex);
    if (currentSerializedSize !== undefined) {
      this.#cacheSize += serializedSize - currentSerializedSize;
    }
    else if (this.#cellSerializedSizes.size === 0) {
      this.#cacheSize = serializedSize;
    }
    else {
      this.#cacheSize += serializedSize - CellSet.#serializedEntrySeparatorSize;
    }
    this.#cellSerializedSizes.set(cellIndex, serializedSize);
  }

  #enforceCacheLimits(){
    const maxEntries = this.#getMaxCacheEntries();
    const maxSizeBytes = this.#getMaxCacheSizeBytes();
    let currentCacheSize = this.cacheSize;

    while (this.#cellAccessTimestamps.size > maxEntries || currentCacheSize > maxSizeBytes){
      let oldestCellIndex;
      let oldestAccess = Infinity;
      this.#cellAccessTimestamps.forEach((access, index) =>{
        if (access < oldestAccess) {
          oldestAccess = access;
          oldestCellIndex = index;
        }
      });
      if (oldestCellIndex === undefined){
        break;
      }
      this.#removeCell(oldestCellIndex);
      currentCacheSize = this.#cacheSize;
    }
  }

  /**
   * @returns {Object.<string, Object>}
   */
  getCellValueFields(){
    return this.#cellValueFields;
  }

  getLastQueryTimeMs() {
    return this.#lastQueryTimeMs;
  }

  getTotalQueryTimeMs() {
    return this.#totalQueryTimeMs;
  }

  #recordQueryTime(startTime) {
    const queryTimeMs = Math.round(performance.now() - startTime);
    this.#lastQueryTimeMs = queryTimeMs;
    this.#totalQueryTimeMs += queryTimeMs;
  }

  /**
   * Convert tuple coordinates to a single linear cell index.
   *
   * This uses row-major style indexing where each coordinate is multiplied by
   * the product of tuple counts in downstream tuple sets.
   *
   * @param {...number} tupleIndices tuple indexes in the same order as `#tupleSets`
   * @returns {number}
   */
  getCellIndex(){
    let cellIndex = 0;
    const tupleSets = this.#tupleSets;
    const numTupleSets = tupleSets.length || 0;

    // for each tupleset ...
    for (let i = 0; i < numTupleSets; i++){
      const tupleIndex = arguments[i];
      let factor = tupleIndex;
      // ...get the factor for all downstream tuplesets.
      for (let j = i + 1; j < numTupleSets; j++){
        const tupleSet = tupleSets[j];
        const numTuples = tupleSet.getTupleCountSync();
        if (!numTuples) {
          continue;
        }
        factor *= numTuples;
      }
      cellIndex += factor;
    }
    return cellIndex;
  }

  // convenience method.
  // calls getCellIndex and returns the corresponding (cached) cell
  // returns undefined if the cell does not exist.
  #getCell(){
    const cellIndex = this.getCellIndex.apply(this, arguments);
    const cells = this.#cells;
    const cell = cells[cellIndex];
    if (cell !== undefined) {
      this.#touchCell(cellIndex);
    }
    return cell;
  }

  /**
   * Expand tuple index ranges to concrete tuple index combinations.
   *
   * Each range corresponds to a tuple set and recursion generates the Cartesian
   * product of those ranges.
   *
   * @param {TupleRange[]} ranges
   * @param {number[]} [previousTupleIndices]
   * @param {number[][]} [allRanges]
   * @returns {number[][]}
   */
  getTupleRanges(ranges, previousTupleIndices, allRanges){
    if (!previousTupleIndices){
      allRanges = [];
      previousTupleIndices = [];
    }

    const numRanges = ranges.length;
    if (numRanges === 0) {
      allRanges.push(previousTupleIndices);
      return allRanges;
    }

    const tupleSets = this.#tupleSets;
    const numTupleSets = tupleSets.length;

    const tupleSetIndex = numTupleSets - numRanges;
    const tupleSet = tupleSets[tupleSetIndex];
    const tupleCount = tupleSet.getTupleCountSync();

    const range = ranges.shift();
    const fromTuple = range[0];
    let toTuple = range[1];

    if (fromTuple === 0 && toTuple === 0) {
      toTuple = 1;
    }

    // Make sure we stay within the range of actual number of tuples.
    if (toTuple > tupleCount){
      toTuple = tupleCount;
    }

    for (let i = fromTuple; i < toTuple; i++){
      const rangesCopy = [].concat(ranges);
      const previousTupleIndicesCopy = [].concat(previousTupleIndices);
      previousTupleIndicesCopy.push(i);
      this.getTupleRanges(rangesCopy, previousTupleIndicesCopy, allRanges);
    }
    return allRanges;
  }

  #getTuplesCte(tuplesToQuery, tuplesFields, includeGroupingId){
    const tupleSets = this.#tupleSets;
    const totalsItems = [];
    const combinationTuples = [];
    let allQueryAxisItems = [];
    const cellIndices = Object.keys(tuplesToQuery);
    _cells: for (let i = 0; i < cellIndices.length; i++) {
      let groupingId = 0;
      const cellIndex = cellIndices[i];
      const combinationTuple = [cellIndex];
      const tuples = tuplesToQuery[cellIndex];
      _tuples: for (let j = 0; j < tuples.length; j++){
        const tupleSet = tupleSets[j];
        const queryAxisItems = tupleSet.getQueryAxisItems();
        if (i === 0) {
          allQueryAxisItems = allQueryAxisItems.concat(queryAxisItems);
          totalsItems[j] = queryAxisItems.filter((queryAxisItem) =>{
            return queryAxisItem.includeTotals;
          });
        }
        if (j && totalsItems[j] && totalsItems[j].length){
          groupingId <<= totalsItems[j].length;
        }
        const tuple = tuples[j];
        if (tuple){
          groupingId |= parseInt(tuple[TupleSet.groupingIdAlias]) || 0;
          const tupleValues = tuple.values;
          const fields = tuplesFields[j];
          _fields: for (let k = 0; k < queryAxisItems.length; k++){
            const queryAxisItem = queryAxisItems[k];
            const tupleValue = tupleValues[k];
            const tupleValueField = fields[k];
            const literal = getTupleValueLiteral(queryAxisItem, tupleValue, tupleValueField);
            combinationTuple.push(literal);
          }
        }
      }
      if (includeGroupingId) {
        combinationTuple.push(groupingId);
      }
      combinationTuples.push(combinationTuple);
    }
    
    if (cellIndices.length === 0){
      combinationTuples.push([0]);
    }
    let tuplesSql = combinationTuples.map((combinationTuple) =>{
      return `(${combinationTuple.join(', ')})`;
    }).join('\n  , ');
    
    let relationDefinition = allQueryAxisItems.map((queryAxisItem) =>{
      return quoteIdentifierWhenRequired( QueryAxisItem.getCaptionForQueryAxisItem(queryAxisItem) );
    });
    relationDefinition.unshift(quoteIdentifierWhenRequired(CellSet.#cellIndexColumnName));
    if (includeGroupingId) {
      relationDefinition.push(quoteIdentifierWhenRequired(TupleSet.groupingIdAlias));
    }
    
    if (combinationTuples[0].length !== relationDefinition.length){
      // this is https://github.com/rpbouman/huey/issues/360
      // I think this shouldn't happen anymore but we keep this in for now.
      console.error(
        'Tuple/relation length mismatch: combinationTuples[0].length !== relationDefinition.length',
        { combinationLength: combinationTuples[0].length, relationLength: relationDefinition.length }
      );
    }
    
    relationDefinition = `${quoteIdentifierWhenRequired(CellSet.#tupleDataRelationName)}(\n  ${relationDefinition.join('\n, ')}\n)`;
    tuplesSql = `${relationDefinition} AS (\n  FROM (VALUES\n    ${tuplesSql}\n  )\n)`;
    return tuplesSql;
  }
  
  // this method is here to implement
  // https://github.com/rpbouman/huey/issues/134
  // idea is to use the tuples to come up with a more clever/optimized query condition 
  // to be pushed down to the lowest level of the cellset.
  #getFilterAxisItemsForCells(
    // object keyed by cellindex, with an array of tuples as value.
    _tuplesToQuery,
    // fields describing the values of the tuples.
    _tuplesFields,
    // the cell axis items for which to generate aggregates
    _cellsAxisItemsToFetch
  ){
    const queryModel = this.getQueryModel();
    const filterAxis = queryModel.getFiltersAxis();
    const originalFilterAxisItems = filterAxis.getItems();
    
    /*
    // most basic optimization: IN clause for all non-derived items (=columns)
    // we will make a special tuple filter item for this:
    // - a filter item that combines multiple axis items, and a array of tuple value arrays
    var first = true;
    var columnItems = [];
    var fields = [];
    var tupleValues = [];
    var tuplesFilterItem;
    for (var tupleIndex in tuplesToQuery){
      var filterTupleValues = [];
      var tupleToQuery = tuplesToQuery[tupleIndex];
      for (var i = 0; i < tupleSets.length; i++){
        var tuple = tupleToQuery[i];
        if (!tuple) {
          continue;
        }
        var tupleFields = tuplesFields[i];
        var tupleValues = tuple.values;

        var tupleSet = tupleSets[i];
        var queryAxisItems = tupleSet.getQueryAxisItems();
        
        for (var j = 0; j < queryAxisItems.length; j++){
          var queryAxisItem = queryAxisItems[j];
          if (queryAxisItem.derivation) {
            continue;
          }
          // check if this tuple item appears in the filters axis
          var sqlForQueryAxisItem = QueryAxisItem.getSqlForQueryAxisItem(queryAxisItem);
          var originalFilterAxisItemIndex = originalFilterAxisItems.findIndex(function(filterAxisItem){
            return QueryAxisItem.getSqlForQueryAxisItem(filterAxisItem) === sqlForQueryAxisItem;
          });
          // If it exists as fitler axis item, we can now remove it since the condition we're generating is stronger
          if (originalFilterAxisItemIndex !== -1) {
            originalFilterAxisItems.splice(originalFilterAxisItemIndex, 1);
          }
            
          if (first){
            columnItems.push(queryAxisItem);
            var tupleField = tupleFields[j];
            fields.push(tupleField);
          }
          var tupleValue = tupleValues[j];
          filterTupleValues.push(tupleValue);
        }
      }
      
      if (first) {
        first = false;
        if (!columnItems.length) {
          break;
        }
        tuplesFilterItem = {
          queryAxisItems: columnItems,
          fields: fields,
          filter: {
            filterType: FilterDialog.filterTypes.INCLUDE,
            values: []
          }
        }
      }
      tuplesFilterItem.filter.values.push(filterTupleValues)
    }
    
    if (tuplesFilterItem) {
      originalFilterAxisItems.unshift(tuplesFilterItem);
    }
    */
    
    return originalFilterAxisItems;
  }

  #getSqlQueryForCells(
    // object keyed by cellindex, with an array of tuples as value.
    tuplesToQuery,
    // fields describing the values of the tuples.
    tuplesFields,
    // the cell axis items for which to generate aggregates
    cellsAxisItemsToFetch
  ){
    const queryModel = this.getQueryModel();
    const datasource = queryModel.getDatasource();

    const rowsAxisItems = queryModel.getRowsAxis().getItems();
    const columnsAxisItems = queryModel.getColumnsAxis().getItems();
    const axisItems = [].concat(rowsAxisItems, columnsAxisItems);
    const allItems = [].concat(axisItems, cellsAxisItemsToFetch || []);
    const filterAxisItems = this.#getFilterAxisItemsForCells(
      tuplesToQuery,
      tuplesFields,
      cellsAxisItemsToFetch
    );
    
    const samplingConfig = queryModel.getSampling(QueryModel.AXIS_CELLS);
    let sql = SqlQueryGenerator.getSqlSelectStatementForAxisItems({
      datasource: datasource, 
      queryAxisItems: allItems, 
      filterAxisItems: filterAxisItems,
      includeOrderBy: false,
      finalStateAsCte: true,
      cteName: '__huey_cells',
      samplingConfig: samplingConfig
    });

    const totalsItems = allItems.filter((queryAxisItem) =>{
      return queryAxisItem.includeTotals === true;
    });
    const hasTotalsItems = Boolean(totalsItems.length);
    const tuples = this.#getTuplesCte(tuplesToQuery, tuplesFields, hasTotalsItems);
    
    sql += `, ${tuples}`;
    
    const select = cellsAxisItemsToFetch.map((axisItem) =>{
      const expression = QueryAxisItem.getCaptionForQueryAxisItem(axisItem);
      const qualifiedIdentifier = getQualifiedIdentifier('__huey_cells', expression);
      const alias = QueryAxisItem.getSqlForQueryAxisItem(axisItem, CellSet.datasetRelationName);
      return `${qualifiedIdentifier} AS ${quoteIdentifierWhenRequired(alias)}`;
    });
    select.unshift(
      getQualifiedIdentifier(
        CellSet.#tupleDataRelationName, 
        CellSet.#cellIndexColumnName
      )
    );
    let from = `FROM ${quoteIdentifierWhenRequired(CellSet.#tupleDataRelationName)}`;
    let joinSql, onCondition;
    if (axisItems.length) {
      joinSql = `LEFT JOIN`;
      onCondition = axisItems.map((axisItem) =>{
        const axisExpression = QueryAxisItem.getCaptionForQueryAxisItem(axisItem)
        const leftExpression = getQualifiedIdentifier(CellSet.#tupleDataRelationName, axisExpression);
        const rightExpression = getQualifiedIdentifier('__huey_cells', axisExpression);
        return `${leftExpression} is not distinct from ${rightExpression}`;
      });
    }
    else {
      joinSql = `CROSS JOIN`;
      onCondition = '';
    }
    joinSql += ` ${quoteIdentifierWhenRequired('__huey_cells')}`;
    from += `\n${joinSql}`;

    if (hasTotalsItems) {
      select.push(
        getQualifiedIdentifier(
          CellSet.#tupleDataRelationName,
          TupleSet.groupingIdAlias
        )
      );
      const leftExpression = getQualifiedIdentifier(CellSet.#tupleDataRelationName, TupleSet.groupingIdAlias);
      const rightExpression = getQualifiedIdentifier('__huey_cells', TupleSet.groupingIdAlias);
      onCondition.push(`${leftExpression} = ${rightExpression}`);
    }

    if (onCondition.length) {
      from += `\nON  ${onCondition.join(`\nAND `)}`;
    }
    
    sql += `\nSELECT ${select.join('\n, ')}`;
    sql += `\n${from}`;

    return sql;
    
  }

  #buildRemoteCellsQuery(tuplesToQuery, tuplesFields, cellsAxisItemsToFetch){
    const queryModel = this.getQueryModel();
    let rowCount = 0, colCount = 0;
    const tupleSets = this.#tupleSets;
    if (tupleSets[0]) rowCount = Math.max(1, tupleSets[0].getTupleCountSync() || 0);
    if (tupleSets[1]) colCount = Math.max(1, tupleSets[1].getTupleCountSync() || 0);
    return RemoteQueryAdapter.createRemoteCellsQuery(queryModel, rowCount, colCount, cellsAxisItemsToFetch);
  }

  /** Map measure columnType to Arrow typeId so number formatter receives field.type (remote path). */
  static #measureColumnTypeToArrowTypeId(columnType) {
    const t = (columnType || '').toUpperCase();
    if (/INT|BIGINT|INT64|INTEGER/.test(t)) return -5;
    if (/FLOAT|DOUBLE|FLOAT64/.test(t)) return -12;
    if (/DECIMAL/.test(t)) return 7;
    return -12;
  }

  #remoteCellsResponseToResultSet(apiResponse, cellsAxisItemsToFetch, columnCount, measureAliases, measureValueOffset){
    const cells = apiResponse.cells || [];
    const colCount = columnCount || 1;
    const items = cellsAxisItemsToFetch || [];
    const aliases = measureAliases || [];
    const offset = measureValueOffset !== null ? measureValueOffset : 0;
    // Backend returns cell.values keyed by column index: row dims, then column dims, then measures.
    const fields = [{ name: CellSet.#cellIndexColumnName }].concat(items.map((item) => {
      const typeId = CellSet.#measureColumnTypeToArrowTypeId(item.columnType);
      return {
        name: QueryAxisItem.getSqlForQueryAxisItem(item, CellSet.datasetRelationName),
        type: { typeId: typeId }
      };
    }));
    const numRows = cells.length;
    const get = function(i) {
      const c = cells[i];
      if (!c) return {};
      const row = {};
      row[CellSet.#cellIndexColumnName] = (c.row_index || 0) * colCount + (c.column_index || 0);
      const vals = c.values || {};
      items.forEach((item, index) => {
        const sqlExpression = QueryAxisItem.getSqlForQueryAxisItem(item, CellSet.datasetRelationName);
        const alias = aliases[index];
        const keyedByPosition = vals[String(offset + index)];
        const keyedByMeasureIndex = vals[String(index)];
        row[sqlExpression] = keyedByPosition !== undefined ? keyedByPosition : (
          keyedByMeasureIndex !== undefined ? keyedByMeasureIndex : vals[alias]
        );
      });
      return row;
    };
    return { numRows: numRows, schema: { fields: fields }, get: get };
  }

  async #executeCellsQuery(
    tuplesToQuery,
    tuplesFields,
    cellsAxisItemsToFetch
  ) {
    const queryModel = this.getQueryModel();
    const datasource = queryModel.getDatasource();
    const isRemote = datasource && datasource.getType && datasource.getType() === 'remote';

    if (isRemote && datasource.getManagedConnection().fetchCells) {
      const query = this.#buildRemoteCellsQuery(tuplesToQuery, tuplesFields, cellsAxisItemsToFetch);
      const colCount = query.columns && query.columns.count ? query.columns.count : 1;
      const axes = query.axes || {};
      const rowDimCount = (axes.rows && axes.rows.length) || 0;
      const colDimCount = (axes.columns && axes.columns.length) || 0;
      const measureValueOffset = rowDimCount + colDimCount;
      const measureAliases = query.axes && query.axes.measures ? query.axes.measures.map((measure) => { return measure.alias; }) : [];
      const dateRange = RemoteQueryAdapter.getDateRange(queryModel);
      const connection = await this.getManagedConnection();
      const startTime = performance.now();
      const apiResponse = await connection.fetchCells(dateRange, query);
      this.#recordQueryTime(startTime);
      const resultSet = this.#remoteCellsResponseToResultSet(apiResponse, cellsAxisItemsToFetch, colCount, measureAliases, measureValueOffset);
      return resultSet;
    }

    const sql = this.#getSqlQueryForCells(
      tuplesToQuery,
      tuplesFields,
      cellsAxisItemsToFetch
    );
    const connection = await this.getManagedConnection();
    const startTime = performance.now();
    const resultSet = await connection.query(sql);
    this.#recordQueryTime(startTime);
    return resultSet;
  }

  #extractCellsFromResultset(resultSet){
    const cells = {};
    const fields = resultSet.schema.fields;
    for (let i = 0; i < resultSet.numRows; i++){
      const row = resultSet.get(i);
      let cellIndex, cell;
      for (let j = 0; j < fields.length; j++){
        const field = fields[j];
        const fieldName = field.name;
        if (this.#cellValueFields[fieldName] === undefined) {
          this.#cellValueFields[fieldName] = field;
        }
        const value = row[fieldName];

        if (j === 0) {
          cellIndex = value;
          // check if we already cached the cell,
          // because if it already exists then we will update it with the newly fetched metrics
          cell = this.#cells[cellIndex];
          if (cell === undefined){
            // cell didn't exist! So lets add it.
            this.#cells[cellIndex] = cell = {values: {}};
          }
          this.#touchCell(cellIndex);
        }
        else {
          cell.values[fieldName] = value;
        }
      }
      cells[cellIndex] = cell;
      this.#updateCellCacheSize(cellIndex);
    }
    this.#enforceCacheLimits();
    return cells;
  }

  // ranges is aa list of tuple index pairs
  async getCells(ranges){
    const queryModel = this.getQueryModel();
    const cellsAxis = queryModel.getCellsAxis();
    const cellsAxisItems = cellsAxis.getItems();

    if (cellsAxisItems.length === 0){
      return undefined;
    }

    const tupleIndices = this.getTupleRanges(ranges);
    const tupleSets = this.#tupleSets;
    const cells = this.#cells;

    // this is where we collect the cells, keyed by cellIndex,
    const availableCells = {};

    // this is where we keep  the collection of values of the tuples
    // for which we currently don't have all required cell values
    // along with the tuple values, we store the cellIndex
    const tuplesToQuery = {};
    const tuplesFields = [];
    // this is where we store the cell axis items that need to be fetched.
    // If there are cells missing, or cells present that still didn't have a value for a required cell axis item,
    // this will contain all cell axis items that need to be queried.
    const cellsAxisItemsToFetch = [];

    // combine values from tuples of different axes into one 'supertuple'
    let tupleIndicesItem;
    _combinedTuples: for (let i = 0; i < tupleIndices.length; i++){
      tupleIndicesItem = tupleIndices[i];
      const cellIndex = this.getCellIndex(...tupleIndicesItem);
      let cell = cells[cellIndex];

      for (let j = 0; j < cellsAxisItems.length; j++){
        const cellsAxisItem = cellsAxisItems[j];
        // we get the sql expression for the cells axis item just as a key to store the cell value.
        // it might be conceptually cleaner to use the caption for the item but captions are always unique, whereas the resulting SQL might not be.
        // not however we don't use it here to generate SQL queries - that is the job of #getSqlQueryForCells
        const sqlExpression = QueryAxisItem.getSqlForQueryAxisItem(cellsAxisItem, CellSet.datasetRelationName);
        if (!cell || cell.values[sqlExpression] === undefined ){
          // we have a cell, but the cell doesn't have a value for this axis item.
          // this means the cell is not complete so we must fetch it.
          // so, we mark the cell as undefined
          cell = undefined;

          // if we aren't already querying this aggregate, then we add it too.
          if (cellsAxisItemsToFetch.indexOf(cellsAxisItem) === -1) {
            cellsAxisItemsToFetch.push(cellsAxisItem);
          }
        }
      }

      if (cell) {
        // If we arrive here, and we still have the cell,
        // it means the cell was not only already cached, but also contains values for all currently reqyested cells axis items.
        // We can serve the cell from the cache and we don't need to include it in our SQL.
        availableCells[cellIndex] = cell;
        continue;
      }

      // If we arrive here, the cell is either not cached, or incomplete,
      // i.e. it lacks one or more values corresponding to the requested cells axis items.
      // If even one cells axis item value is missing, we have to include the cell in our query.
      const tuplesForCell = [];

      // get the actual tuples and store them along with the cell index.
      // we need this to construct a query to fetch only the cells we're missing
      _tuplesetIndices: for (let j = 0; j < tupleIndicesItem.length; j++){

        // ...get the tuple,...
        const tupleIndex = tupleIndicesItem[j];
        const tupleSet = tupleSets[j];

        const tuple = tupleSet.getTupleSync(tupleIndex);
        if (!tuple) {
          // this shouldn't happen!
          // if we arrive here it means we messed up while calculating the tuple ranges.
          continue;
        }
        tuplesForCell[j] = tuple;
      }

      if (tuplesForCell.length) {
        tuplesToQuery[cellIndex] = tuplesForCell;
      }
    }

    if (cellsAxisItemsToFetch.length){
      for (let i = 0; i < tupleIndicesItem.length; i++){
        const tupleset = this.#tupleSets[i];
        const fields = tupleset.getTupleValueFields();
        tuplesFields[i] = fields;
      }
      const resultset = await this.#executeCellsQuery(
        tuplesToQuery,
        tuplesFields,
        cellsAxisItemsToFetch
      );
      const newCells = this.#extractCellsFromResultset(resultset);
      Object.assign(availableCells, newCells);
    }

    return availableCells;
  }

}
