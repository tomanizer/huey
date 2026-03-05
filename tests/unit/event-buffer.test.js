import { EventEmitter } from '../../src/util/event/EventEmitter.js';
import { bufferEvents } from '../../src/util/event/EventBuffer.js';

describe('bufferEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('fires final buffered call after timeout', () => {
    const emitter = new EventEmitter(['change']);
    const handler = vi.fn();

    bufferEvents(emitter, 'change', handler, 50);
    emitter.fireEvent('change', { id: 1 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toBe(0);

    vi.advanceTimersByTime(50);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][1]).toBeUndefined();
  });

  test('multiple events within timeout window are coalesced', () => {
    const emitter = new EventEmitter(['change']);
    const handler = vi.fn();

    bufferEvents(emitter, 'change', handler, 100);
    emitter.fireEvent('change', { id: 1 });
    emitter.fireEvent('change', { id: 2 });
    emitter.fireEvent('change', { id: 3 });

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[0][1]).toBe(0);
    expect(handler.mock.calls[1][1]).toBe(1);
    expect(handler.mock.calls[2][1]).toBe(2);

    vi.advanceTimersByTime(100);

    expect(handler).toHaveBeenCalledTimes(4);
    expect(handler.mock.calls[3][1]).toBeUndefined();
  });

  test('handler receives event count argument', () => {
    const emitter = new EventEmitter(['change']);
    const counts = [];

    bufferEvents(emitter, 'change', (event, count) => {
      counts.push(count);
    }, 30);

    emitter.fireEvent('change', { id: 1 });
    emitter.fireEvent('change', { id: 2 });
    vi.advanceTimersByTime(30);

    expect(counts).toEqual([0, 1, undefined]);
  });

  test('timeout can be a function', () => {
    const emitter = new EventEmitter(['change']);
    const timeoutGetter = vi.fn(() => 75);
    const handler = vi.fn();

    bufferEvents(emitter, 'change', handler, null, timeoutGetter);
    emitter.fireEvent('change', { id: 1 });

    expect(timeoutGetter).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(75);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('respects scope parameter', () => {
    const emitter = new EventEmitter(['change']);
    const scope = { handled: 0 };

    function handler() {
      this.handled += 1;
    }

    bufferEvents(emitter, 'change', handler, scope, 25);
    emitter.fireEvent('change', { id: 1 });
    vi.advanceTimersByTime(25);

    expect(scope.handled).toBe(2);
  });
});
