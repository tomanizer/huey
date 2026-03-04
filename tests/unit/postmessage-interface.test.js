vi.mock('../../src/SettingsDialog/SettingsDialog.js', () => ({
  settings: {
    getSettings() { return {}; },
    assignSettings() {},
    addEventListener() {},
    removeEventListener() {},
  },
}));

vi.mock('../../src/ErrorDialog/ErrorDialog.js', () => ({
  showErrorDialog: vi.fn(),
  getDataFromError: vi.fn((e) => ({ title: String(e), description: String(e) })),
  initErrorDialog: vi.fn(),
}));

vi.mock('../../src/PageStateManager/PageStateManager.js', () => ({
  pageStateManager: { setPageState: vi.fn() },
  initPageStateManager: vi.fn(),
}));

vi.mock('../../src/PromptUi/PromptUi.js', () => ({
  PromptUi: { show: vi.fn() },
}));

import { PostMessageInterface, initPostMessageInterface } from '../../src/PostMessageInterface/PostMessageInterface.js';

describe('PostMessageInterface security hardening', () => {
  beforeAll(() => {
    initPostMessageInterface(true);
  });

  beforeEach(() => {
    vi.spyOn(PostMessageInterface, 'getTrustedOrigins').mockReturnValue([
      'http://localhost',
      'http://trusted.test',
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('responds to ping for trusted origin and uses origin as targetOrigin', async () => {
    const source = { postMessage: vi.fn() };
    const event = new MessageEvent('message', {
      origin: 'http://trusted.test',
      source,
      data: { messageType: 'ping', requestId: 'req-1' },
    });

    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(source.postMessage).toHaveBeenCalledTimes(1);
    const [response, options] = source.postMessage.mock.calls[0];
    expect(response.status.code).toBe('Ok');
    expect(response.status.message).toBe('pong');
    expect(options).toEqual({ targetOrigin: 'http://trusted.test' });
  });

  test('ignores messages from untrusted origin', async () => {
    const source = { postMessage: vi.fn() };
    const event = new MessageEvent('message', {
      origin: 'http://evil.test',
      source,
      data: { messageType: 'ping', requestId: 'req-2' },
    });

    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(source.postMessage).not.toHaveBeenCalled();
  });

  test('returns bad request for malformed envelope without messageType', async () => {
    const source = { postMessage: vi.fn() };
    const event = new MessageEvent('message', {
      origin: 'http://trusted.test',
      source,
      data: { requestId: 'req-3' },
    });

    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(source.postMessage).toHaveBeenCalledTimes(1);
    const [response, options] = source.postMessage.mock.calls[0];
    expect(response.status.code).toBe('Bad Request');
    expect(response.status.message).toBe('Malformed request envelope.');
    expect(options).toEqual({ targetOrigin: 'http://trusted.test' });
  });

  test('bad request response omits stack details', async () => {
    const source = { postMessage: vi.fn() };
    const event = new MessageEvent('message', {
      origin: 'http://trusted.test',
      source,
      data: { messageType: 'createDatasource', requestId: 'req-4', body: null },
    });

    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(source.postMessage).toHaveBeenCalledTimes(1);
    const [response] = source.postMessage.mock.calls[0];
    expect(response.status.code).toBe('Bad Request');
    expect(response.body.error.stack).toBeUndefined();
  });

  test('sendReadyMessage uses trusted target origin and never wildcard', () => {
    const opener = { postMessage: vi.fn() };
    vi.stubGlobal('opener', opener);
    vi.spyOn(PostMessageInterface, 'getTargetOriginForHostingWindow').mockReturnValue('http://trusted.test');

    window.postMessageInterface.sendReadyMessage();

    expect(opener.postMessage).toHaveBeenCalledTimes(1);
    const [, options] = opener.postMessage.mock.calls[0];
    expect(options.targetOrigin).toBe('http://trusted.test');
    expect(options.targetOrigin).not.toBe('*');
  });
});
