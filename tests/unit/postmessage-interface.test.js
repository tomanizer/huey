const fs = require('fs');
const path = require('path');
const { TextEncoder, TextDecoder } = require('util');

if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = TextDecoder;
}

const { JSDOM } = require('jsdom');

describe('PostMessageInterface security hardening', () => {
  function createWindow(allowedOrigins) {
    var queryString = '';
    if (allowedOrigins) {
      queryString = '?postMessageOrigins=' + encodeURIComponent(allowedOrigins);
    }
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: `http://localhost/${queryString}`,
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });

    const scriptPaths = [
      'src/PostMessageInterface/PostMessageProtocol.js',
      'src/PostMessageInterface/PostMessageInterface.js',
    ];

    scriptPaths.forEach((scriptPath) => {
      const code = fs.readFileSync(path.resolve(__dirname, '../../', scriptPath), 'utf-8');
      const scriptElement = dom.window.document.createElement('script');
      scriptElement.textContent = code;
      dom.window.document.body.appendChild(scriptElement);
    });

    dom.window.pageStateManager = {
      setPageState: jest.fn(),
    };
    dom.window.datasourcesUi = {
      addDatasources: jest.fn(async () => {}),
    };
    dom.window.analyzeDatasource = jest.fn();
    dom.window.DuckDbDataSource = function () {
      this.getId = () => 'dummy';
      this.getType = () => 'duckdb';
    };
    dom.window.hueyDb = {
      duckdb: {},
      instance: {},
    };

    dom.window.initPostMessageInterface(true);

    return dom.window;
  }

  test('responds to ping for trusted origin and uses origin as targetOrigin', () => {
    const window = createWindow('http://trusted.test');
    const source = { postMessage: jest.fn() };

    const event = new window.MessageEvent('message', {
      origin: 'http://trusted.test',
      source,
      data: {
        messageType: 'ping',
        requestId: 'req-1',
      },
    });

    window.dispatchEvent(event);

    expect(source.postMessage).toHaveBeenCalledTimes(1);
    const [response, options] = source.postMessage.mock.calls[0];
    expect(response.status.code).toBe('Ok');
    expect(response.status.message).toBe('pong');
    expect(options).toEqual({ targetOrigin: 'http://trusted.test' });
  });

  test('ignores messages from untrusted origin', () => {
    const window = createWindow('http://trusted.test');
    const source = { postMessage: jest.fn() };

    const event = new window.MessageEvent('message', {
      origin: 'http://evil.test',
      source,
      data: {
        messageType: 'ping',
        requestId: 'req-2',
      },
    });

    window.dispatchEvent(event);

    expect(source.postMessage).not.toHaveBeenCalled();
  });

  test('returns bad request for malformed envelope without messageType', () => {
    const window = createWindow('http://trusted.test');
    const source = { postMessage: jest.fn() };

    const event = new window.MessageEvent('message', {
      origin: 'http://trusted.test',
      source,
      data: {
        requestId: 'req-3',
      },
    });

    window.dispatchEvent(event);

    expect(source.postMessage).toHaveBeenCalledTimes(1);
    const [response, options] = source.postMessage.mock.calls[0];
    expect(response.status.code).toBe('Bad Request');
    expect(response.status.message).toBe('Malformed request envelope.');
    expect(options).toEqual({ targetOrigin: 'http://trusted.test' });
  });

  test('bad request response omits stack details', async () => {
    const window = createWindow('http://trusted.test');
    const source = { postMessage: jest.fn() };

    const event = new window.MessageEvent('message', {
      origin: 'http://trusted.test',
      source,
      data: {
        messageType: 'createDatasource',
        requestId: 'req-4',
        body: null,
      },
    });

    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(source.postMessage).toHaveBeenCalledTimes(1);
    const [response] = source.postMessage.mock.calls[0];
    expect(response.status.code).toBe('Bad Request');
    expect(response.body.error.stack).toBeUndefined();
  });

  test('sendReadyMessage uses trusted target origin and never wildcard', () => {
    const window = createWindow('http://trusted.test');
    const opener = { postMessage: jest.fn() };
    window.opener = opener;

    window.postMessageInterface.sendReadyMessage();

    expect(opener.postMessage).toHaveBeenCalledTimes(1);
    const [, options] = opener.postMessage.mock.calls[0];
    expect(options.targetOrigin).toBe('http://trusted.test');
    expect(options.targetOrigin).not.toBe('*');
  });
});
