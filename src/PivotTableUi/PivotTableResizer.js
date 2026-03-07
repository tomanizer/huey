import { hasClass } from '../util/dom/dom.js';
import { pivotTableUiDefaults } from './PivotTableUiUtils.js';

export class PivotTableResizer {

  #pivotTableUi = undefined;
  #resizeObserver = undefined;
  #resizeTimeout = pivotTableUiDefaults.resizeTimeout;
  #resizeTimeoutId = undefined;
  #columnHeaderResizeTimeout = pivotTableUiDefaults.columnHeaderResizeTimeout;
  #columnHeaderResizeTimeoutId = undefined;

  constructor(pivotTableUi, config = {}) {
    this.#pivotTableUi = pivotTableUi;
    this.#resizeTimeout = config.resizeTimeout ?? this.#resizeTimeout;
    this.#columnHeaderResizeTimeout = config.columnHeaderResizeTimeout ?? this.#columnHeaderResizeTimeout;
    this.initResizeObserver();
  }

  initResizeObserver(){
    const dom = this.#pivotTableUi.getDom();
    this.#resizeObserver = new ResizeObserver((entries) =>{
      for (const entry of entries){
        const target = entry.target;
        if (target === dom) {
          this.handleDomResized();
        }
        else if (hasClass(target, 'pivotTableUiHeaderCell')) {
          this.handleColumnHeaderResized(entry);
        }
      }
    });
    this.#resizeObserver.observe(dom);
  }

  toggleObserveColumnsResizing(onOff){
    const headerRows = this.#pivotTableUi.getTableHeaderDom().childNodes;
    if (!headerRows.length){
      return;
    }

    const methodName = onOff === false ? 'unobserve' : 'observe';
    const headerRow = headerRows.item(0);
    for (let i = 0; i < headerRow.childNodes.length; i++){
      const column = headerRow.childNodes.item(i);
      if (!hasClass(column, 'pivotTableUiHeaderCell') || hasClass(column, 'pivotTableUiStufferCell')) {
        continue;
      }
      this.#resizeObserver[methodName](column);
    }
  }

  handleDomResized(){
    if (this.#resizeTimeoutId !== undefined) {
      clearTimeout(this.#resizeTimeoutId);
      this.#resizeTimeoutId = undefined;
    }
    this.#resizeTimeoutId = setTimeout(async () =>{
      try {
        if (!this.#pivotTableUi.getBusy() && this.#pivotTableUi.getAutoUpdate()) {
          await this.#pivotTableUi.updatePivotTableUi();
        }
        else {
          this.#pivotTableUi.setNeedsUpdate(true);
        }
      }
      finally {
        clearTimeout(this.#resizeTimeoutId);
        this.#resizeTimeoutId = undefined;
      }
    }, this.#resizeTimeout);
  }

  handleColumnHeaderResized(resizeEntry) {
    if (this.#columnHeaderResizeTimeoutId !== undefined) {
      clearTimeout(this.#columnHeaderResizeTimeoutId);
      this.#columnHeaderResizeTimeoutId = undefined;
    }
    this.#columnHeaderResizeTimeoutId = setTimeout(() =>{
      const width = resizeEntry.target.style.width;
      if (width.endsWith('px')) {
        // Placeholder for future width persistence; existing behavior is to detect but not persist.
      }
      clearTimeout(this.#columnHeaderResizeTimeoutId);
      this.#columnHeaderResizeTimeoutId = undefined;
    }, this.#columnHeaderResizeTimeout);
  }

  destroy(){
    this.#resizeObserver?.disconnect();
  }
}
