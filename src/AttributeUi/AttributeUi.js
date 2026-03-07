import { QueryAxisItem, QueryModel, queryModel } from '../QueryModel/QueryModel.js';
import { Internationalization } from '../Internationalization/Internationalization.js';
import { DragAndDropHelper } from '../DragAndDrop/DragAndDropHelper.js';
import { byId, createEl, instantiateTemplate, setAttributes, getAncestorWithTagName, getClassNames, registerTemplates } from '../util/dom/dom.js';
import attributeTemplatesHtml from './templates.html?raw';
import { showErrorDialog } from '../ErrorDialog/ErrorDialog.js';
import {
  getDataTypeInfo,
  getDataTypeNameFromColumnType,
  extrapolateColumnExpression,
  quoteIdentifierWhenRequired,
  isStructType,
  isMapType,
  isArrayType,
} from '../util/sql/SQLHelper.js';
import {
  aggregators,
  arrayStatisticsDerivations,
  tupleNumberDerivations,
  dateFields,
  timeFields,
  hashDerivations,
  textDerivations,
  uuidDerivations,
  arrayDerivations,
  mapDerivations,
  getApplicableDerivations,
  getDerivationInfo,
  getAggregatorInfo,
  getApplicableAggregators,
  getArrayDerivations,
  getMapDerivations,
} from './AttributeRegistry.js';

export class AttributeUi {

  #id = undefined;
  #queryModel = undefined;

  // ─── Registry data — delegated to AttributeRegistry.js ──────────────────────
  static aggregators = aggregators;
  static arrayStatisticsDerivations = arrayStatisticsDerivations;
  static tupleNumberDerivations = tupleNumberDerivations;
  static dateFields = dateFields;
  static timeFields = timeFields;
  static hashDerivations = hashDerivations;
  static textDerivations = textDerivations;
  static uuidDerivations = uuidDerivations;
  static arrayDerivations = arrayDerivations;
  static mapDerivations = mapDerivations;

  static getApplicableDerivations(typeName){ return getApplicableDerivations(typeName); }
  static getDerivationInfo(derivationName){ return getDerivationInfo(derivationName); }
  static getAggregatorInfo(aggregatorName){ return getAggregatorInfo(aggregatorName); }
  static getApplicableAggregators(typeName){ return getApplicableAggregators(typeName); }
  static getArrayDerivations(typeName){ return getArrayDerivations(typeName); }
  static getMapDerivations(typeName){ return getMapDerivations(typeName); }

  static #getUiNodeCaption(config){
    const nodeType = config.type; 
    let caption;
    switch ( nodeType ){
      case 'column':
        caption = config.profile.column_name;
        break;
      case 'member':
        const memberExpressionPath = config.profile.memberExpressionPath;
        const tmp = [].concat(memberExpressionPath);
        caption = tmp.pop();
        break;
      case 'derived':
        caption = config.derivation;
        break;
      case 'aggregate':
        caption = config.aggregator;
        break;
      default:
        console.warn(`Don't know how to create caption for node of type ${nodeType}`)
    }
    return caption;
  }
  
  static #getUiNodeColumnExpression(config){
    let columnExpression = config.profile.column_name;
    columnExpression = quoteIdentifierWhenRequired(columnExpression);
    const memberExpressionPath = config.profile.memberExpressionPath;
    if (memberExpressionPath){
      columnExpression = `${columnExpression}.${memberExpressionPath.join('.')}`;
    }
    return columnExpression;
  }
  
  static #getUiNodeTitle(config){
    const columnExpression = AttributeUi.#getUiNodeColumnExpression(config);
    
    let title = config.title;
    if (title){
      return title;
    }
    
    switch (config.type) {
      case 'column':
        title = `${config.profile.column_type}`;
        break;
      case 'member':
        title = `${config.columnType} ${columnExpression}`;
        break;
      case 'aggregate':
      case 'derived':
        title = columnExpression;
        let expressionTemplate;
        const derivation = config.derivation;
        if (derivation) {
          const derivationInfo = AttributeUi.getDerivationInfo(derivation);
          expressionTemplate = derivationInfo.expressionTemplate;
          title = extrapolateColumnExpression(expressionTemplate, title);
        }
        const aggregator = config.aggregator;
        if (aggregator){
          const aggregatorInfo = AttributeUi.getAggregatorInfo(aggregator);
          expressionTemplate = aggregatorInfo.expressionTemplate;
          title = extrapolateColumnExpression(expressionTemplate, title);
        }
        break;
    }
    return title;
  }
  
  static #getAttributeCaptionForAxisButton(config, aggregator){
    if (aggregator && !config.aggregator) {
      const aggregatorInfo = AttributeUi.aggregators[aggregator];
      config = Object.assign({}, config);
      config.aggregator = aggregator;
      config.expressionTemplate = aggregatorInfo.expressionTemplate;
      config.type = 'aggregate';
    }
    let caption;
    switch (config.type) {
      case 'column':
      case 'member':
        caption = AttributeUi.#getUiNodeColumnExpression(config);
        break;
      default:
        caption = AttributeUi.#getUiNodeTitle(config);
    }
    return caption;
  }

  /**
   * Map QueryService/tech-spec type names to UI type names (getDataTypeInfo keys).
   */
  static remoteSchemaTypeToUiType(backendType) {
    if (!backendType) return 'VARCHAR';
    const t = String(backendType).toLowerCase();
    const map = {
      string: 'VARCHAR',
      int64: 'BIGINT',
      int32: 'INTEGER',
      float64: 'DOUBLE',
      float32: 'REAL',
      bool: 'BOOLEAN',
      boolean: 'BOOLEAN',
      date: 'DATE',
      timestamp: 'TIMESTAMP'
    };
    return map[t] || backendType;
  }

  /**
   * Convert QueryService schema response to columnSummary shape for render().
   * schema: { dataset_id, fields: [{ name, type, is_dimension?, is_measure? }] }
   */
  static schemaToColumnSummary(schema){
    const fields = (schema && schema.fields) ? schema.fields : [];
    return {
      numRows: fields.length,
      get: function(i) {
        const f = fields[i];
        return {
          toJSON: function() {
            const uiType = f ? AttributeUi.remoteSchemaTypeToUiType(f.type) : 'VARCHAR';
            return {
              column_name: f ? f.name : '',
              column_type: uiType
            };
          }
        };
      }
    };
  }

  constructor(id, queryModel){
    registerTemplates(attributeTemplatesHtml);
    this.#id = id;
    this.#queryModel = queryModel;

    const dom = this.getDom();
    dom.addEventListener('click', this.#clickHandler.bind(this));
    dom.addEventListener('dragstart', this.#dragStartHandler.bind(this));
    this.#queryModel.addEventListener('change', this.#queryModelChangeHandler.bind(this));
  }

  async #queryModelChangeHandler(event){
    try {
      const eventData = event.eventData;
      const propertiesChanged = eventData.propertiesChanged;
      if (!propertiesChanged) {
        return;
      }
      const datasourceChanged = eventData.propertiesChanged.datasource;
      if (!datasourceChanged){
        return;
      }
      const newDatasource = eventData.propertiesChanged.datasource.newValue;
      if (newDatasource) {
        this.clear(true);
        let columnMetadata;
        if (newDatasource.getType && newDatasource.getType() === 'remote') {
          const schema = await newDatasource.getSchema();
          columnMetadata = AttributeUi.schemaToColumnSummary(schema);
        } else {
          columnMetadata = await newDatasource.getColumnMetadata();
        }
        this.render(columnMetadata);
      }
      else {
        this.clear(false);
      }
    }
    catch(e){
      showErrorDialog(e);
      this.clear();
    }
    finally {
      this.#updateState();
    }
  }

  #clickHandler(event){
    event.stopPropagation();
    const target = event.target;
    const node = getAncestorWithTagName(target, 'details');
    if (!node) {
      return;
    }

    const classNames = getClassNames(target);
    if (!classNames) {
      return;
    }
    if (classNames.indexOf('attributeUiAxisButton') === -1){
      return;
    }
    const input = target.getElementsByTagName('input').item(0);
    const axisId = target.getAttribute('data-axis');
    setTimeout(() =>{
      this.#axisButtonClicked(node, axisId, input.checked);
    }, 0);
  }
  
  #createQueryAxisItemForAttributeUiNode(node){
    const columnName = node.getAttribute('data-column_name');
    const columnType = node.getAttribute('data-column_type');

    let memberExpressionPath = node.getAttribute('data-member_expression_path');
    if (memberExpressionPath) {
      memberExpressionPath = JSON.parse(memberExpressionPath);
    }

    const derivation = node.getAttribute('data-derivation');
    const aggregator = node.getAttribute('data-aggregator');

    const itemConfig = {
      columnName: columnName,
      columnType: columnType,
      derivation: derivation,
      aggregator: aggregator,
      memberExpressionPath: memberExpressionPath
    };
    return itemConfig;
  }

  #updateAxisButtonTitle(input){
    const label = input.parentNode;
    const title = label.getAttribute(`data-title-${input.checked ? '' : 'un'}checked`);
    label.setAttribute('title', title);
  }

  async #axisButtonClicked(node, axis, checked){
    const head = node.querySelector('summary');
    const inputs = head.querySelectorAll('input');
    let aggregator;
    switch (axis){
      case QueryModel.AXIS_ROWS:
      case QueryModel.AXIS_COLUMNS:
      case QueryModel.AXIS_CELLS:
        // implement mutual exclusive axes (either rows or columns, not both)
        for (let i = 0; i < inputs.length; i++){
          const input = inputs.item(i);
          const inputAxis = input.getAttribute('data-axis');
          if (input.checked && inputAxis !== axis) {
            input.checked = false;
          }
  
          this.#updateAxisButtonTitle(input);
  
          if (axis === QueryModel.AXIS_CELLS && inputAxis === QueryModel.AXIS_CELLS) {
            aggregator = input.getAttribute('data-aggregator');
          }
        }
        break;
    }

    const itemConfig = this.#createQueryAxisItemForAttributeUiNode(node);
    itemConfig.axis = axis;

    if (aggregator) {
      itemConfig.aggregator = aggregator;
    }

    const queryModel = this.#queryModel;
    if (checked) {
      await queryModel.addItem(itemConfig);
    }
    else {
      queryModel.removeItem(itemConfig);
    }
  }

  #renderAttributeUiNodeAxisButton(config, head, axisId){
    let columnExpression = config.profile.column_name;
    const memberExpressionPath = config.profile.memberExpressionPath;
    if (memberExpressionPath){
      columnExpression = `${columnExpression}.${memberExpressionPath.join('.')}`;
    }

    const name = `${config.type}_${columnExpression}`;
    let id = `${name}`;

    const derivation = config.derivation;
    if (derivation){
      id += `_${derivation}`;
    }
    let aggregator = config.aggregator;
    if (aggregator){
      id += `_${aggregator}`;
    }

    let analyticalRole = 'attribute';

    const dummyButtonTemplate = 'attribute-node-axis-dummybutton';
    let axisButtonTemplate = dummyButtonTemplate;
    switch (config.type) {
      case 'column':
      case 'member':
        const _profile = config.profile;
        const columnType = config.columnType || config.profile.column_type;
        const dataTypeInfo = getDataTypeInfo(columnType);
        analyticalRole = dataTypeInfo && dataTypeInfo.defaultAnalyticalRole ? dataTypeInfo.defaultAnalyticalRole : analyticalRole;
      case 'derived':
        switch (axisId){
          case QueryModel.AXIS_FILTERS:
          case QueryModel.AXIS_COLUMNS:
          case QueryModel.AXIS_ROWS:
            id += `_${axisId}`;
            axisButtonTemplate = 'attribute-node-axis-checkbox';
            break;
          default:
        }
        if (analyticalRole === 'attribute'){
          break;
        }
        else
        if (analyticalRole === 'measure' && config.type === 'column'){
          aggregator = aggregator || 'sum';
        }
      case 'aggregate':
        switch (axisId){
          case QueryModel.AXIS_CELLS:
            axisButtonTemplate = 'attribute-node-axis-checkbox';
            break;
          default:
        }
        break;
      default:
    }

    const axisButton = instantiateTemplate(axisButtonTemplate);
    axisButton.setAttribute('data-axis', axisId);
    if (axisButtonTemplate === dummyButtonTemplate){
      return axisButton;
    }

    const attributeCaption = AttributeUi.#getAttributeCaptionForAxisButton(config, aggregator);
    
    const translatedAttributeCaption = Internationalization.getText(attributeCaption) || attributeCaption;
    
    const checkedTitleKey = `Click to remove {1} from the ${axisId}-axis`;
    const checkedTitle = Internationalization.getText(checkedTitleKey, translatedAttributeCaption);
    axisButton.setAttribute('data-title-checked', checkedTitle);
    
    const uncheckedTitleKey = `Click to add {1} to the ${axisId}-axis`;
    const uncheckedTitle = Internationalization.getText(uncheckedTitleKey, translatedAttributeCaption);
    axisButton.setAttribute('data-title-unchecked', uncheckedTitle);
    
    axisButton.setAttribute('title', uncheckedTitle);

    axisButton.setAttribute('for', id);
    const axisButtonInput = axisButton.querySelector('input');
    axisButtonInput.setAttribute('id', id);
    axisButtonInput.setAttribute('data-axis', axisId);

    if (aggregator && axisId === QueryModel.AXIS_CELLS) {
      axisButtonInput.setAttribute('data-aggregator', aggregator);
    }

    if (config.derivation){
      axisButtonInput.setAttribute('data-derivation', config.derivation);
    }
    return axisButton;
  }

  #renderAttributeUiNodeAxisButtons(config, head){
    const rowButton = this.#renderAttributeUiNodeAxisButton(config, head, 'rows');
    head.appendChild(rowButton);

    const columnButton = this.#renderAttributeUiNodeAxisButton(config, head, 'columns');
    head.appendChild(columnButton);

    const cellsButton = this.#renderAttributeUiNodeAxisButton(config, head, 'cells');
    head.appendChild(cellsButton);

    const filterButton = this.#renderAttributeUiNodeAxisButton(config, head, 'filters');
    head.appendChild(filterButton);
  }

  #renderAttributeUiNodeHead(node, config) {
    const head = node.querySelector('summary');

    let caption = AttributeUi.#getUiNodeCaption(config);
    const title = AttributeUi.#getUiNodeTitle(config);
    
    const label = head.querySelector('span');
    switch (config.type) {
      case 'derived':
      case 'aggregate':
        Internationalization.setTextContent(label, caption);
        caption = Internationalization.getText(caption) || caption;
        break;
      default:
        label.textContent = caption;
    }
    setAttributes(label, {
      "class": 'label',
      "title": `${caption}: ${title}`,
      "draggable": true
    });

    this.#renderAttributeUiNodeAxisButtons(config, head);
    head.setAttribute('aria-label', `Toggle ${caption} details`);

    return head;
  }

  #dragStartHandler(event){
    const dataTransfer = event.dataTransfer;
    const data = {};
    
    const element = event.target;
    const summary = element.parentNode;
    const details = summary.parentNode;
    const queryAxisItem = this.#createQueryAxisItemForAttributeUiNode(details);
        
    let itemId = QueryAxisItem.getIdForQueryAxisItem(queryAxisItem);
    // if this is an aggregat item, mark that
    if (queryAxisItem.aggregator) {
      data.aggregator = {key: queryAxisItem.aggregator, value: queryAxisItem.aggregator};
    }
    else {
      // if this is not an aggregate item, then this attribute ui item could have a default aggregator
      const defaultAggregatorInput = summary.querySelector('label[data-axis=cells] > input[type=checkbox]');
      if (defaultAggregatorInput) {
        const defaultAggregator = defaultAggregatorInput.getAttribute('data-aggregator');
        // since this item could be dropped on the cells axis,
        // we should check if the cells axis already contains an item that would result from applying the default aggregator
        const copyOfQueryAxisItem = Object.assign({}, queryAxisItem);
        copyOfQueryAxisItem.axis = QueryModel.AXIS_CELLS;
        copyOfQueryAxisItem.aggregator = defaultAggregator;
        const cellsAxisItem = this.#queryModel.findItem(copyOfQueryAxisItem);
        itemId = cellsAxisItem ? QueryAxisItem.getIdForQueryAxisItem(cellsAxisItem) : '';
        data.defaultaggregator = {key: itemId, value: defaultAggregator};
      }
    }
     
    // see if this item is already part of the query model
    const queryModelItem = this.#queryModel.findItem(queryAxisItem);
    if (queryModelItem) {
      queryAxisItem.axis = queryModelItem.axis;
      data.axis = {key: queryAxisItem.axis, value: queryAxisItem.axis};
      queryAxisItem.index = queryModelItem.index;
      data.index = {key: queryAxisItem.index, value: queryAxisItem.index};
      data.id = {key: itemId, value: itemId};
    }
    
    const filtersAxis = this.#queryModel.getFiltersAxis();
    const filtersAxisItem = filtersAxis.findItem(queryAxisItem);
    if (filtersAxisItem){
      data.filters = {key: filtersAxisItem.index, value: filtersAxisItem.index};
      if (!queryModelItem) {
        itemId = QueryAxisItem.getIdForQueryAxisItem(queryAxisItem);
        data.id = {key: itemId, value: itemId};
      }
    }
    data['application/json'] = queryAxisItem;
    DragAndDropHelper.addTextDataForQueryItem(queryAxisItem, data);
    
    DragAndDropHelper.setData(event, data);
    dataTransfer.dropEffect = dataTransfer.effectAllowed = queryModelItem ? 'move' : 'all';
    dataTransfer.setDragImage(element, -20, 0);
  }

  #renderAttributeUiNode(config){
    const columnType = config.profile.column_type;
    const attributes = {
      role: 'treeitem',
      'data-nodetype': config.type,
      'data-column_name': config.profile.column_name,
      'data-column_type': columnType
    };
    const memberExpressionPath = config.profile.memberExpressionPath;
    if (memberExpressionPath) {
      attributes['data-member_expression_path'] = JSON.stringify(memberExpressionPath);
      attributes['data-member_expression_type'] = config.profile.memberExpressionType;
    }
    const node = instantiateTemplate('attribute-node', attributes);

    const derivation = config.derivation;
    switch (config.type){
      case 'column':
      case 'member':
        node.addEventListener('toggle', this.#toggleNodeState.bind(this) );
        break;
      case 'aggregate':
        node.setAttribute('data-aggregator', config.aggregator);
        if (derivation){
          node.setAttribute('data-derivation', derivation);
        }
        break;
      case 'derived':
        node.setAttribute('data-derivation', derivation);
        node.addEventListener('toggle', this.#toggleNodeState.bind(this) );
        break;
      default:
        throw new Error(`Invalid node type "${config.type}".`);
    }

    this.#renderAttributeUiNodeHead(node, config);

    // for STRUCT columns and members, preload the child nodes (instead of lazy load)
    // this is necessary so that a search will always find all applicable attributes
    // with lazy load it would only find whatever happens to be visited/browsed already.
    let typeToCheckIfChildnodesAreNeeded;
    switch (config.type){
      case 'derived':
        if (['elements'].indexOf(derivation) === -1) {
          break;
        }
        typeToCheckIfChildnodesAreNeeded = config.profile.memberExpressionType;
        break;
      case 'column':
        typeToCheckIfChildnodesAreNeeded = columnType;
        break;
      case 'member':
        typeToCheckIfChildnodesAreNeeded = config.profile.memberExpressionType;
        break;
    }
    if (
      typeToCheckIfChildnodesAreNeeded && (
        isStructType(typeToCheckIfChildnodesAreNeeded) || 
        isMapType(typeToCheckIfChildnodesAreNeeded) ||
        isArrayType(typeToCheckIfChildnodesAreNeeded)
      )
    ) {
      this.#loadChildNodes(node);
    }
    return node;
  }

  clear(showBusy){
    const attributesUi = this.getDom();
    attributesUi.replaceChildren();
    if (showBusy) {
      attributesUi.appendChild(createEl('div', {
        "class": 'loader loader-medium'
      }));
    }
  }

  render(columnSummary){
    this.clear();
    const attributesUi = this.getDom();

    // generic count(*) node
    const countAllNode = this.#renderAttributeUiNode({
      type: 'aggregate',
      aggregator: 'count',
      title: 'Generic rowcount',
      profile: {
        column_name: '*',
        column_type: 'INTEGER'
      }
    });
    attributesUi.appendChild(countAllNode);
    
    // generic rownum
    const rownumNode = this.#renderAttributeUiNode({
      type: 'derived',
      title: 'row number',
      derivation: 'row number',
      profile: {
        column_name: '',
        column_type: 'INTEGER'
      }
    });
    attributesUi.appendChild(rownumNode);
    
    // nodes for each column
    for (let i = 0; i < columnSummary.numRows; i++){
      const row = columnSummary.get(i);
      const node = this.#renderAttributeUiNode({
        type: 'column',
        profile: row.toJSON()
      });
      attributesUi.appendChild(node);
    }
  }

  #renderFolderNode(config){
    const node = instantiateTemplate('attribute-node', {
      'data-nodetype': 'folder'
    });
    const label = node.querySelector('span.label');
    Internationalization.setTextContent(label, config.caption);

    const filler = instantiateTemplate('attribute-node-axis-dummybutton', {
      'data-axis': 'none'
    });
    node.querySelector('summary').appendChild(filler);

    return node;
  }

  #createFolders(itemsObject, node){
    const folders = Object.keys(itemsObject).reduce((acc, curr) =>{
      const object = itemsObject[curr];
      const folder = object.folder;
      if (!folder) {
        return acc;
      }

      if (acc[folder]) {
        return acc;
      }

      const folderNode = this.#renderFolderNode({caption: folder});
      acc[folder] = folderNode;

      const afterLastFolder = node.querySelector(':scope > [data-nodetype=folder] + *:not( [data-nodetype=folder] )');
      if (afterLastFolder){
        node.insertBefore(folderNode, afterLastFolder);
      }
      else {
        node.appendChild(folderNode);
      }
      return acc;
    }, {});
    return folders;
  }

  #loadMemberChildNodes(node, typeName, profile, noFolder){
    const folderNode = noFolder ? undefined : this.#renderFolderNode({caption: 'structure'});
    const columnType = profile.memberExpressionType || profile.column_type;
    const memberExpressionPath = profile.memberExpressionPath || [];
    const structure = getStructTypeDescriptor(columnType);
    const _columnName = profile.column_name
    for (const memberName in  structure){
      const memberType = structure[memberName];
      const config = {
        type: 'member',
        columnType: memberType,
        profile: {
          column_name: profile.column_name,
          column_type: profile.column_type,
          memberExpressionPath: memberExpressionPath.concat([memberName]),
          memberExpressionType: memberType
        }
      }
      const memberNode = this.#renderAttributeUiNode(config);
      (folderNode || node).appendChild(memberNode);
    }
    if (folderNode) {
      node.appendChild(folderNode);
    }
  }

  #loadDerivationChildNodes(node, typeName, profile){
    const applicableDerivations = AttributeUi.getApplicableDerivations(typeName);
    const folders = this.#createFolders(applicableDerivations, node);
    for (const derivationName in applicableDerivations) {
      const derivation = applicableDerivations[derivationName];
      const config = {
        type: 'derived',
        derivation: derivationName,
        title: derivation.title,
        profile: profile
      };
      const childNode = this.#renderAttributeUiNode(config);
      if (derivation.folder) {
        folders[derivation.folder].appendChild(childNode);
      }
      else {
        node.appendChild(childNode);
      }
    }
  }

  #loadArrayChildNodes(node, typeName, profile){
    const arrayDerivations = AttributeUi.getArrayDerivations(typeName);
    const folders = this.#createFolders(arrayDerivations, node);
    const _memberExpressionPath = profile.memberExpressionPath || [];
    for (const derivationName in arrayDerivations) {
      const derivation = arrayDerivations[derivationName];
      let nodeProfile;
      if (derivation.unnestingFunction) {
        nodeProfile = JSON.parse(JSON.stringify(profile));
        const memberExpressionPath = nodeProfile.memberExpressionPath || [];
        memberExpressionPath.push(derivation.unnestingFunction + '()');
        nodeProfile.memberExpressionPath = memberExpressionPath;
        let memberExpressionType = derivation.columnType;
        if (!memberExpressionType){
          memberExpressionType = profile.memberExpressionType || profile.column_type;
          memberExpressionType = getArrayElementType(memberExpressionType);
        }
        nodeProfile.column_type = profile.column_type;
        nodeProfile.memberExpressionType = memberExpressionType;
      }
      else {
        nodeProfile = profile;
      }
      const config = {
        type: 'derived',
        derivation: derivationName,
        title: derivation.title,
        profile: nodeProfile
      };
      const childNode = this.#renderAttributeUiNode(config);
      if (derivation.folder) {
        folders[derivation.folder].appendChild(childNode);
      }
      else {
        node.appendChild(childNode);
      }
    }
  }

  #loadMapChildNodes(node, typeName, profile){
    const mapDerivations = AttributeUi.getMapDerivations(typeName);
    const folders = this.#createFolders(mapDerivations, node);
    for (const derivationName in mapDerivations) {
      const derivation = mapDerivations[derivationName];
      let nodeProfile; 
      const memberExpressionType = profile.memberExpressionType || profile.column_type;
      switch (derivationName) {
        case 'entries':
        case 'entry keys':
        case 'keyset':
        case 'entry values':
          nodeProfile = JSON.parse(JSON.stringify(profile));
          if (!nodeProfile.memberExpressionPath) {
            nodeProfile.memberExpressionPath = [];
          }
          break;
        default:
          nodeProfile = profile;
      }

      switch (derivationName) {
        case 'entries':
          nodeProfile.memberExpressionType = getArrayElementType(getMapEntriesType(memberExpressionType));
          nodeProfile.memberExpressionPath.push('map_entries()');
          nodeProfile.memberExpressionPath.push(derivation.unnestingFunction + '()');
          break;
        case 'entry keys':
          nodeProfile.memberExpressionType = getMemberExpressionType(memberExpressionType, 'key');
          nodeProfile.memberExpressionPath.push('map_keys()');
          nodeProfile.memberExpressionPath.push(derivation.unnestingFunction + '()');
          break;
        case 'entry values':
          nodeProfile.memberExpressionType = getMemberExpressionType(memberExpressionType, 'value');
          nodeProfile.memberExpressionPath.push('map_values()');
          nodeProfile.memberExpressionPath.push(derivation.unnestingFunction  + '()');
          break;
        case 'keyset':
          nodeProfile.memberExpressionType = getMemberExpressionType(memberExpressionType, 'key') + '[]';
          break;
        case 'valuelist':
          nodeProfile.memberExpressionType = getMemberExpressionType(memberExpressionType, 'value') + '[]';
          break;
      }

      const config = {
        type: 'derived',
        derivation: derivationName,
        title: derivation.title,
        profile: nodeProfile
      };
      const childNode = this.#renderAttributeUiNode(config);
      if (derivationName === 'entries'){
        this.#loadMemberChildNodes(childNode, nodeProfile.memberExpressionType, nodeProfile, true);
      }
      if (derivation.folder) {
        folders[derivation.folder].appendChild(childNode);
      }
      else {
        node.appendChild(childNode);
      }
      
    }
  }

  #loadAggregatorChildNodes(node, typeName, profile) {
    const applicableAggregators = AttributeUi.getApplicableAggregators(typeName);
    const folders = this.#createFolders(applicableAggregators, node);
    for (const aggregationName in applicableAggregators) {
      const aggregator = applicableAggregators[aggregationName];
      const config = {
        type: 'aggregate',
        aggregator: aggregationName,
        derivation: profile.derivation,
        title: aggregator.title,
        profile: profile
      };
      const childNode = this.#renderAttributeUiNode(config);
      if (aggregator.folder) {
        folders[aggregator.folder].appendChild(childNode);
      }
      else {
        node.appendChild(childNode);
      }
    }
  }

  #loadChildNodes(node){
    const columnName = node.getAttribute('data-column_name');
    const columnType = node.getAttribute('data-column_type');

    let memberExpressionPath;
    const memberExpressionType = node.getAttribute('data-member_expression_type');
    if (memberExpressionType) {
      memberExpressionPath = node.getAttribute('data-member_expression_path');
      memberExpressionPath = JSON.parse(memberExpressionPath);
    }

    const _elementType = node.getAttribute('data-element_type');

    const profile = {
      column_name: columnName,
      column_type: columnType,
      memberExpressionType: memberExpressionType,
      memberExpressionPath: memberExpressionPath
    };

    const nodeType = node.getAttribute('data-nodetype');
    let derivation;
    if (nodeType === 'derived'){
      derivation = node.getAttribute('data-derivation');
      profile.derivation = derivation;
    }

    const expressionType = memberExpressionType || columnType;
    const typeName = getDataTypeNameFromColumnType(expressionType);

    if (
      nodeType !== 'derived' ||
      ['elements'].indexOf(derivation) !== -1
    ){
      // only load these derivations if we're not ourself a derived node.
      if (isArrayType(expressionType)){
        this.#loadArrayChildNodes(node, typeName, profile);
      }
      else
      if (isMapType(expressionType)){ 
        this.#loadMapChildNodes(node, typeName, profile);
      }
      else
      if (isStructType(expressionType)){
        this.#loadMemberChildNodes(node, typeName, profile);
      }
    }

    switch (nodeType){
      case 'derived':
        if (['elements'].indexOf(derivation) === -1){
          break;
        }
      case 'column':
      case 'member':
        this.#loadDerivationChildNodes(node, typeName, profile);
    }

    switch (nodeType) {
      case 'derived':
      case 'column':
      case 'member':
        this.#loadAggregatorChildNodes(node, typeName, profile);
    }
    
  }

  #toggleNodeState(event){
    const node = event.target;
    node.setAttribute('aria-expanded', String(node.open));
    if (event.newState !== 'open'){
      return;
    }
    if (node.querySelector('details') !== null){
      return;
    }
    this.#loadChildNodes(node);
    this.#updateState();
  }

  #updateState(){
    const queryModel = this.#queryModel;

    // to satisfy https://github.com/rpbouman/huey/issues/220, 
    // we need to ensure derivations and aggregates are loaded.
    
    // First we get the column names of those query items that have a derivation or aggregator
    const referencedColumns = {};
    const axisIds = queryModel.getAxisIds();
    for (let i = 0; i < axisIds.length; i++) {
      const axisId = axisIds[i];
      const queryAxis = queryModel.getQueryAxis(axisId);
      const items = queryAxis.getItems();
      for (let j = 0; j < items.length; j++){
        const item = items[j];
        if (!item.columnName) {
          continue;
        }
        if (!item.derivation && !item.aggregator){
          continue;
        }
        referencedColumns[item.columnName] = true;
      }
    }
    
    // then, check all top-level attribute nodes that don't have child nodes
    // if the associated column name is referenced in the query, then load its childnodes.
    const attributeNodes = this.getDom().childNodes;
    for (let i = 0; i < attributeNodes.length; i++){
      const attributeNode = attributeNodes.item(i);
      if (attributeNode.nodeType !== 1 || attributeNode.nodeName !== 'DETAILS') {
        continue;
      }
      const columnName = attributeNode.getAttribute('data-column_name');
      if (referencedColumns[columnName] === undefined) {
        continue;
      }
      const descendants = attributeNode.querySelectorAll('details');
      if (descendants.length > 0) {
        continue;
      }
      this.#loadChildNodes(attributeNode);
    }
    
    // make sure all the selectors checkboxes are (un)checked according to the query state.
    const inputs = this.getDom().getElementsByTagName('input');
    for (let i = 0; i < inputs.length; i++){
      const input = inputs.item(i);
      const axisId = input.getAttribute('data-axis');

      const node = getAncestorWithTagName(input, 'details')
      const columnName = node.getAttribute('data-column_name');
      const aggregator = input.getAttribute('data-aggregator');
      const derivation = node.getAttribute('data-derivation');
      const memberExpressionPath = node.getAttribute('data-member_expression_path');

      const item = queryModel.findItem({
        columnName: columnName,
        axis: axisId,
        aggregator: aggregator,
        derivation: derivation,
        memberExpressionPath: memberExpressionPath
      });

      input.checked = Boolean(item);
      this.#updateAxisButtonTitle(input);
    }
  }

  revealAllQueryAttributes() {
    // TODO: ensure all query attributes are rendered
    const _dom = this.getDom();
    const detailsList = document.querySelectorAll('.attributeUi details:has( details > summary > label > input[type=checkbox]:checked )');
    for (let i = 0; i < detailsList.length; i++){
      const details = detailsList.item(i);
      details.setAttribute('open', 'true');
      details.setAttribute('aria-expanded', 'true');
    }
  }

  getDom(){
    return byId(this.#id);
  }

}

export let attributeUi;
export function initAttributeUi(){
  attributeUi = new AttributeUi('attributeUi', queryModel);
}
