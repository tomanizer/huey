import { byId } from '../util/dom/dom.js';

export class ContextMenu {
  
  #menuId = undefined;
  #targetElement = undefined;
  #focusOrigin = undefined;
  
  constructor(menuHost, menuId){
    this.#menuId = menuId;
    this.#initEvents(menuHost);
  }
  
  #initEvents(menuHost){
    // add a handler to the menuHost's dom so the context menu can be opened when the user askes for it
    menuHost.getDom().addEventListener('contextmenu', (event) =>{
      // check of the host has a beforeShowContextMenu handler.
      // if it has one, call it, and pass the event and the context menu object (this)
      // this allows the menuHost to tweak the context menu before its actually presented to the user.
      // if the host returns false, it means the context menu should not be shown.
      // in that case, we just return and let the native default contextmenu do its work.
      if (
        typeof menuHost.beforeShowContextMenu === 'function' && 
        menuHost.beforeShowContextMenu(event, this) === false
      ) {
        return;
      }
      // if the host does not indicate the context menu should not be shown, 
      // then prevent the default context menu from showing
      // instead, show our context menu.
      event.preventDefault();
      this.#showPopover(event);
    });
    
    // initialize the items in the context menu so the context menu is closed when an item is activated.
    const dom = this.getDom();
    this.#initMenuItems(dom, menuHost);
    dom.addEventListener('keydown', this.#handleMenuKeyDown.bind(this));
    dom.addEventListener('beforetoggle', (event) =>{
      if (event.newState !== 'closed') {
        return;
      }
      this.#restoreFocus();
    });
  }
  
  #initMenuItems(dom, menuHost){
    const menuItems = dom.querySelectorAll('li[role=menuitem] > label > button');
    for (let i = 0; i < menuItems.length; i++){
      const menuItem = menuItems.item(i);
      const popoverTarget = menuItem.getAttribute('popovertarget');
      if (popoverTarget){
        this.#initNestedMenuitem(menuItem, dom, menuHost);
      }
      else {
        this.#initActionMenuitem(menuItem, dom, menuHost);
      }
    }
  }
  
  #initNestedMenuitem(menuItem, _dom, _menuHost){
    const popoverTarget = menuItem.getAttribute('popovertarget');
    menuItem.setAttribute('aria-haspopup', 'menu');
    menuItem.setAttribute('aria-expanded', 'false');
    const label = menuItem.parentNode;
    const item = label.parentNode;
    const popoverTargetDom = byId(popoverTarget);
    if (popoverTargetDom) {
      popoverTargetDom.addEventListener('beforetoggle', (event) =>{
        menuItem.setAttribute('aria-expanded', String(event.newState === 'open'));
      });
    }
    menuItem.addEventListener('click', (event) =>{
      event.preventDefault();
      if (!popoverTargetDom) {
        return;
      }
      const itemBoundingRect = item.getBoundingClientRect();
      if (popoverTargetDom.matches(':popover-open')) {
        popoverTargetDom.hidePopover();
        menuItem.setAttribute('aria-expanded', 'false');
        return;
      }
      popoverTargetDom.showPopover();
      popoverTargetDom.style.left = (itemBoundingRect.x + itemBoundingRect.width) + 'px';
      popoverTargetDom.style.top = itemBoundingRect.y + 'px';
      menuItem.setAttribute('aria-expanded', 'true');
    });
  }
  
  #initActionMenuitem(menuItem, dom, menuHost){
    menuItem.setAttribute('popovertarget', this.#menuId);
    menuItem.setAttribute('popoveraction', 'hide');
    this.#createMenuitemClickHandler(menuItem, dom, menuHost);
  }
  
  #createMenuitemClickHandler(menuItem, dom, menuHost){
    menuItem.addEventListener('click', (event) =>{
      event.preventDefault();
      dom.hidePopover();
      menuHost.contextMenuItemClicked.call(menuHost, event);
    });
  }

  #getMenuItems(){
    const dom = this.getDom();
    const menuItems = dom.querySelectorAll(':scope > li[role=menuitem] > label > button');
    return Array.from(menuItems).filter((menuItem) =>{
      return menuItem.disabled !== true;
    });
  }

  #focusMenuItem(index){
    const menuItems = this.#getMenuItems();
    if (!menuItems.length) {
      return;
    }
    const correctedIndex = ((index % menuItems.length) + menuItems.length) % menuItems.length;
    menuItems[correctedIndex].focus();
  }

  #focusMenuItemFromList(menuItems, index){
    if (!menuItems.length) {
      return;
    }
    const correctedIndex = ((index % menuItems.length) + menuItems.length) % menuItems.length;
    menuItems[correctedIndex].focus();
  }

  #focusFirstMenuItem(){
    this.#focusMenuItem(0);
  }

  #restoreFocus(){
    const focusOrigin = this.#focusOrigin;
    this.#focusOrigin = undefined;
    if (!focusOrigin) {
      return;
    }
    if (typeof focusOrigin.focus === 'function') {
      focusOrigin.focus();
    }
  }

  #handleMenuKeyDown(event){
    const dom = this.getDom();
    if (!dom.matches(':popover-open')) {
      return;
    }

    let menuItems = this.#getMenuItems();
    const activeElement = document.activeElement;
    if (activeElement) {
      const nestedMenu = activeElement.closest('menu[role=menu]');
      if (nestedMenu && nestedMenu !== dom) {
        menuItems = Array.from(nestedMenu.querySelectorAll(':scope > li[role=menuitem] > label > button')).filter((menuItem) => {
          return menuItem.disabled !== true;
        });
      }
    }
    if (!menuItems.length) {
      return;
    }

    const activeIndex = menuItems.indexOf(activeElement);
    switch (event.key){
      case 'ArrowDown':
        event.preventDefault();
        this.#focusMenuItemFromList(menuItems, activeIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.#focusMenuItemFromList(menuItems, activeIndex <= 0 ? menuItems.length - 1 : activeIndex - 1);
        break;
      case 'Enter':
      case ' ':
        if (activeIndex === -1) {
          return;
        }
        event.preventDefault();
        menuItems[activeIndex].click();
        break;
      case 'Escape':
        event.preventDefault();
        dom.hidePopover();
        this.#restoreFocus();
        break;
    }
  }

  #focusFirstNestedMenuItem(menuItem){
    const popoverTarget = menuItem.getAttribute('popovertarget');
    if (!popoverTarget) {
      return false;
    }
    const popoverTargetDom = byId(popoverTarget);
    if (!popoverTargetDom) {
      return false;
    }
    if (!popoverTargetDom.matches(':popover-open')) {
      popoverTargetDom.showPopover();
    }
    menuItem.setAttribute('aria-expanded', 'true');
    const nestedItems = popoverTargetDom.querySelectorAll(':scope > li[role=menuitem] > label > button');
    if (!nestedItems.length) {
      return false;
    }
    nestedItems.item(0).focus();
    return true;
  }

  // show the popover at the coordinates of the initiating contextmenu event.
  #showPopover(event){
    const body = document.body;
    const dom = this.getDom();
        
    const targetElement = event.target instanceof HTMLElement ? event.target : undefined;
    this.#targetElement = targetElement;
    this.#focusOrigin = this.#targetElement;
    if (this.#focusOrigin && !this.#focusOrigin.hasAttribute('tabindex')) {
      this.#focusOrigin.setAttribute('tabindex', '-1');
    }

    dom.showPopover();

    const width = dom.clientWidth;
    let left = event.pageX;
    const right = left + width;
    const correctionX = right - body.clientWidth;
    if (correctionX > 0){
      left -= correctionX;
      if (left < 0) {
        left = 0;
      }
    }
    
    dom.style.left = left + 'px';
    
    const height = dom.clientHeight;
    let top = event.pageY;
    const bottom = top + height;
    const correctionY = bottom - body.clientHeight;
    if (correctionY > 0){
      top -= correctionY;
      if (top < 0){
        top = 0;
      }
    }
    dom.style.top = top  + 'px';
    const menuItems = this.#getMenuItems();
    if (menuItems.length && this.#focusFirstNestedMenuItem(menuItems[0])) {
      return;
    }
    this.#focusFirstMenuItem();
  }
  
  //
  getTargetElement(){
    return this.#targetElement;
  }
  
  getDom(){
    return byId(this.#menuId);
  }
  
}
