// Vitest setup file - runs before each test file in jsdom environment

// Stub ResizeObserver (not available in jsdom)
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Stub CSS.highlights (used in Search.js)
if (typeof CSS === 'undefined' || !CSS.highlights) {
  global.CSS = { highlights: new Map() };
}

// Ensure navigator.languages has a value
if (!navigator.languages || !navigator.languages.length) {
  Object.defineProperty(navigator, 'languages', {
    value: ['en-US'],
    configurable: true,
  });
}
