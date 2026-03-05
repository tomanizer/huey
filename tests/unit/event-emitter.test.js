import { EventEmitter } from '../../src/util/event/EventEmitter.js';

describe('EventEmitter', () => {
  test('addEventListener registers listener and fireEvent invokes it', () => {
    const emitter = new EventEmitter(['change']);
    const listener = vi.fn();

    emitter.addEventListener('change', listener);
    emitter.fireEvent('change', { value: 1 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].eventData.value).toBe(1);
  });

  test('removeEventListener removes listener', () => {
    const emitter = new EventEmitter(['change']);
    const listener = vi.fn();

    emitter.addEventListener('change', listener);
    expect(emitter.removeEventListener('change', listener)).toBe(1);

    emitter.fireEvent('change', { value: 2 });
    expect(listener).not.toHaveBeenCalled();
  });

  test('multiple listeners for same event are all called', () => {
    const emitter = new EventEmitter(['change']);
    const first = vi.fn();
    const second = vi.fn();

    emitter.addEventListener('change', first);
    emitter.addEventListener('change', second);
    emitter.fireEvent('change', { value: 3 });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('emitEvents(false) queues events and emitEvents(true) flushes queue', () => {
    const emitter = new EventEmitter(['change']);
    const listener = vi.fn();

    emitter.addEventListener('change', listener);
    emitter.emitEvents(false);
    emitter.fireEvent('change', { value: 'queued' });

    expect(listener).not.toHaveBeenCalled();

    emitter.emitEvents(true);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].eventData.value).toBe('queued');
  });

  test('invalid event type throws', () => {
    const emitter = new EventEmitter(['change']);

    expect(() => emitter.addEventListener('invalid', () => {})).toThrow(
      'Unrecognized event type invalid'
    );
  });

  test('invalid listener type throws', () => {
    const emitter = new EventEmitter(['change']);

    expect(() => emitter.addEventListener('change', 'not-a-function')).toThrow(
      "Listener should be of type 'function', not 'string'"
    );
  });
});
