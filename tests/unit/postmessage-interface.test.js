vi.mock('../../src/SettingsDialog/SettingsDialog.js');

vi.mock('../../src/ErrorDialog/ErrorDialog.js');

vi.mock('../../src/PageStateManager/PageStateManager.js', () => ({
  pageStateManager: { setPageState: vi.fn() },
  initPageStateManager: vi.fn(),
}));

vi.mock('../../src/PromptUi/PromptUi.js', () => ({
  PromptUi: { show: vi.fn() },
}));

vi.mock('../../src/DataSource/DataSourcesUi.js', () => ({
  datasourcesUi: { addDatasources: vi.fn().mockResolvedValue(undefined) },
  initDataSourcesUi: vi.fn(),
}));

vi.mock('../../src/DataSource/duckdb/database.js', () => ({
  getDuckDbModule: vi.fn().mockReturnValue({}),
  getDatabase: vi.fn().mockReturnValue({}),
  initDatabase: vi.fn(),
}));

vi.mock('../../src/DataSource/duckdb/DuckDbDataSource.js', () => ({
  DuckDbDataSource: vi.fn().mockImplementation(() => ({
    getId: vi.fn().mockReturnValue('test-ds-id'),
    getType: vi.fn().mockReturnValue('file'),
  })),
}));

vi.mock('../../src/App/analyzeDatasource.js', () => ({
  analyzeDatasource: vi.fn(),
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

  test('registers postMessage globals explicitly for external API integration', () => {
    expect(window.RemoteDatasource).toBeTypeOf('function');
    expect(window.RemoteQueryAdapter).toBeTypeOf('function');
    expect(window.postMessageInterface).toBeDefined();
  });

  test('createDatasource with selectForAnalysis true returns Ok and calls analyzeDatasource', async () => {
    const { DuckDbDataSource } = await import('../../src/DataSource/duckdb/DuckDbDataSource.js');
    const { datasourcesUi } = await import('../../src/DataSource/DataSourcesUi.js');
    const { analyzeDatasource } = await import('../../src/App/analyzeDatasource.js');

    const mockInstance = { getId: vi.fn().mockReturnValue('test-ds-id'), getType: vi.fn().mockReturnValue('file') };
    vi.mocked(DuckDbDataSource).mockImplementation(() => mockInstance);
    vi.mocked(datasourcesUi.addDatasources).mockResolvedValue(undefined);
    vi.mocked(analyzeDatasource).mockImplementation(() => {});

    const source = { postMessage: vi.fn() };
    const event = new MessageEvent('message', {
      origin: 'http://trusted.test',
      source,
      data: {
        messageType: 'createDatasource',
        requestId: 'req-analyze',
        body: {
          datasourceConfig: { type: 'file' },
          selectForAnalysis: true,
        },
      },
    });

    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(source.postMessage).toHaveBeenCalledTimes(1);
    const [response] = source.postMessage.mock.calls[0];
    expect(response.status.code).toBe('Ok');
    expect(analyzeDatasource).toHaveBeenCalledTimes(1);
  });

  test('setRoute request forwards route into the page state manager', async () => {
    const { pageStateManager } = await import('../../src/PageStateManager/PageStateManager.js');
    const source = { postMessage: vi.fn() };

    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://trusted.test',
      source,
      data: {
        messageType: 'setRoute',
        requestId: 'req-route',
        body: {
          route: '#/datasource/sales',
        },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pageStateManager.setPageState).toHaveBeenCalledWith('#/datasource/sales');
    expect(source.postMessage.mock.calls[0][0].status.code).toBe('Ok');
  });

  test('createDatasource without selectForAnalysis skips analyzeDatasource and returns datasource metadata', async () => {
    const { DuckDbDataSource } = await import('../../src/DataSource/duckdb/DuckDbDataSource.js');
    const { datasourcesUi } = await import('../../src/DataSource/DataSourcesUi.js');
    const { analyzeDatasource } = await import('../../src/App/analyzeDatasource.js');

    const mockInstance = { getId: vi.fn().mockReturnValue('test-ds-id'), getType: vi.fn().mockReturnValue('file') };
    vi.mocked(DuckDbDataSource).mockImplementation(() => mockInstance);
    vi.mocked(datasourcesUi.addDatasources).mockResolvedValue(undefined);
    vi.mocked(analyzeDatasource).mockImplementation(() => {});

    const source = { postMessage: vi.fn() };
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://trusted.test',
      source,
      data: {
        messageType: 'createDatasource',
        requestId: 'req-create',
        body: {
          datasourceConfig: { type: 'file' },
          selectForAnalysis: false,
        },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));


    const [response] = source.postMessage.mock.calls[0];
    expect(response.status.code).toBe('Ok');
    expect(response.body.datasource).toEqual({ id: 'test-ds-id', type: 'file' });
    expect(analyzeDatasource).not.toHaveBeenCalled();
  });
});
