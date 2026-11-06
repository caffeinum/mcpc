/**
 * Unit tests for MCP transports
 */

import type { Mock } from 'vitest';
import { createTransportFromConfig } from '../../../src/core/transports.js';
import { StreamableHTTPClientTransport } from '../../../src/core/transports.js';
import { ClientError } from '../../../src/lib/errors.js';
import { proxyFetch } from '../../../src/lib/proxy.js';

vi.mock('../../../src/lib/proxy.js', () => ({
  proxyFetch: vi.fn(async () => new Response('ok')),
}));

// Mock the SDK transports
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
  getDefaultEnvironment: vi.fn().mockReturnValue({}),
}));

vi.mock('@modelcontextprotocol/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/client')>();
  return {
    ...actual,
    StreamableHTTPClientTransport: vi.fn(function () {
      return {
        start: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

describe('createTransportFromConfig', () => {
  it('should create stdio transport from config', () => {
    const transport = createTransportFromConfig({
      command: 'node',
      args: ['server.js'],
    });

    expect(transport).toBeDefined();
  });

  it('should create http transport from config', () => {
    const transport = createTransportFromConfig({
      url: 'https://mcp.example.com',
    });

    expect(transport).toBeDefined();
  });

  it('should throw error for config without url or command', () => {
    expect(() => createTransportFromConfig({} as any)).toThrow(ClientError);
  });

  it('should pass headers to http transport', () => {
    const transport = createTransportFromConfig({
      url: 'https://mcp.example.com',
      headers: {
        Authorization: 'Bearer token',
      },
    });

    expect(transport).toBeDefined();
  });

  it('should pass environment variables to stdio transport', () => {
    const transport = createTransportFromConfig({
      command: 'node',
      args: ['server.js'],
      env: {
        DEBUG: '1',
      },
    });

    expect(transport).toBeDefined();
  });

  it('should inject proxyFetch into HTTP transport when no custom fetch is provided', async () => {
    const mock = StreamableHTTPClientTransport as Mock;
    mock.mockClear();
    createTransportFromConfig({
      url: 'https://mcp.example.com',
    });

    expect(mock).toHaveBeenCalledTimes(1);
    const [, options] = mock.mock.calls[0];
    const init = { method: 'POST', body: '{"method":"tools/list"}' };
    await options.fetch('https://mcp.example.com', init);
    expect(proxyFetch).toHaveBeenCalledWith('https://mcp.example.com', init);
  });

  it('should preserve custom fetch when provided (e.g. x402 middleware)', async () => {
    const mock = StreamableHTTPClientTransport as Mock;
    mock.mockClear();
    const customFetch = vi.fn();
    createTransportFromConfig(
      { url: 'https://mcp.example.com' },
      { customFetch: customFetch as any }
    );

    expect(mock).toHaveBeenCalledTimes(1);
    const [, options] = mock.mock.calls[0];
    const init = { method: 'POST', body: '{"method":"tools/list"}' };
    await options.fetch('https://mcp.example.com', init);
    expect(customFetch).toHaveBeenCalledWith('https://mcp.example.com', init);
  });

  it('sets the Mcp-Name routing header on events requests (SEP-3415)', async () => {
    const mock = StreamableHTTPClientTransport as Mock;
    mock.mockClear();
    const customFetch = vi.fn(async () => new Response('ok'));
    createTransportFromConfig(
      { url: 'https://mcp.example.com' },
      { customFetch: customFetch as any }
    );
    const [, options] = mock.mock.calls[0];
    const body = (name: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'events/poll',
        params: { name, cursor: null },
      });

    await options.fetch('https://mcp.example.com', {
      method: 'POST',
      body: body('email.received'),
    });
    await options.fetch('https://mcp.example.com', { method: 'POST', body: body('épisode') });
    await options.fetch('https://mcp.example.com', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'events/list' }),
    });

    const header = (call: number) =>
      new Headers(
        (customFetch.mock.calls[call] as unknown as [string, RequestInit])[1].headers
      ).get('mcp-name');
    expect(header(0)).toBe('email.received');
    expect(header(1)).toBe(`=?base64?${Buffer.from('épisode').toString('base64')}?=`);
    expect(header(2)).toBeNull();
  });
});
