import {
  byId,
  createEl,
  escapeHtmlText,
  instantiateTemplate,
  setClass,
} from '../../src/util/dom/dom.js';

describe('dom utilities', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('createEl creates element with content, class and attributes', () => {
    const el = createEl('div', {
      id: 'greeting',
      class: ['a', 'b'],
      style: { display: 'none', opacity: '0.5' },
      'data-test': 'ok',
    }, '<span>Hello</span>');

    expect(el.id).toBe('greeting');
    expect(el.className).toBe('a b');
    expect(el.innerHTML).toBe('<span>Hello</span>');
    expect(el.getAttribute('data-test')).toBe('ok');
    expect(el.getAttribute('style')).toContain('opacity: 0.5;');
  });

  test('byId returns element by id', () => {
    const el = createEl('div', { id: 'lookup' }, 'x');
    document.body.appendChild(el);

    expect(byId('lookup')).toBe(el);
  });

  test('escapeHtmlText escapes &, <, >', () => {
    expect(escapeHtmlText('& < > "\''))
      .toBe('&amp; &lt; &gt; "\'');
  });

  test('setClass sets and clears css classes', () => {
    const el = createEl('div');

    setClass(el, ['x', 'y']);
    expect(el.className).toBe('x y');

    setClass(el, 'single');
    expect(el.className).toBe('single');

    setClass(el, null);
    expect(el.className).toBe('');
  });

  test('instantiateTemplate returns cloned content and sets attributes', () => {
    document.body.innerHTML = `
      <template id="itemTemplate"><div class="item">Item</div></template>
    `;

    const nodeWithId = instantiateTemplate('itemTemplate', 'node-id');
    expect(nodeWithId.id).toBe('node-id');
    expect(nodeWithId.textContent).toBe('Item');

    const nodeWithAttributes = instantiateTemplate('itemTemplate', {
      id: 'node-attributes',
      class: ['item', 'active'],
    });
    expect(nodeWithAttributes.id).toBe('node-attributes');
    expect(nodeWithAttributes.className).toBe('item active');
  });
});
