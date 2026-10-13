import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaxoClient } from '../src/saxo/client.js';
import { assertPrecheckOk } from '../src/saxo/order-guards.js';
import { assertSafePathSegment, pathSegment } from '../src/saxo/path.js';
import { resetPolicyCache, type SaxoPolicy } from '../src/saxo/policy.js';
import { getOrder } from '../src/saxo/portfolio.js';
import { cancelMultiLegOrder, cancelOrder } from '../src/saxo/trading.js';
import { listExchanges } from '../src/saxo/reference.js';
import { registerSaxoTools } from '../src/tools/saxo.js';
import { assertAuthorized, constantTimeEquals, HttpRequestError } from '../src/transports/http-helpers.js';

const ENV_KEYS = [
  'SAXO_AUDIT_LOG',
  'SAXO_ENABLE_LIVE_ALERT_WRITES',
  'SAXO_ENABLE_LIVE_TRADING',
  'SAXO_POLICY_PATH',
  'SAXO_ENVIRONMENT',
  'MCP_HTTP_TOKEN',
];
const savedEnv: Record<string, string | undefined> = {};
let tempDir: string | undefined;

type Handler = (input: Record<string, unknown>) => Promise<unknown>;
type Route = (url: URL, init: RequestInit | undefined) => unknown;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockClient(environment: 'sim' | 'live', route: Route) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const result = route(url, init);
    return result instanceof Response ? result : jsonResponse(result ?? {});
  });
  const client = new SaxoClient({
    environment,
    accessToken: 'fake-token',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
  return { client, calls, fetchMock };
}

function tools(client: SaxoClient, options?: Parameters<typeof registerSaxoTools>[2]) {
  const registered: Record<string, { config: { inputSchema?: unknown }; handler: Handler }> = {};
  const stub = {
    registerTool: (name: string, config: { inputSchema?: unknown }, handler: unknown) => {
      registered[name] = { config, handler: handler as Handler };
    },
  } as unknown as Parameters<typeof registerSaxoTools>[0];
  registerSaxoTools(stub, client, options);
  return registered;
}

async function usePolicy(policy: Partial<SaxoPolicy>): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'saxo-sec-'));
  const path = join(tempDir, 'policy.json');
  await writeFile(path, JSON.stringify(policy), 'utf8');
  process.env.SAXO_POLICY_PATH = path;
  resetPolicyCache();
}

const writes = (calls: Array<{ method: string; path: string }>) =>
  calls.filter(call => call.method !== 'GET' && !call.path.endsWith('/precheck'));

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetPolicyCache();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetPolicyCache();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

const baseOrder = {
  AccountKey: 'acc',
  Uic: 211,
  AssetType: 'Stock',
  BuySell: 'Buy',
  OrderDuration: { DurationType: 'DayOrder' },
};

describe('max_notional on orders without a price', () => {
  it('prices market orders from a quote and refuses oversized ones', async () => {
    await usePolicy({ max_notional: 1000 });
    const { client, calls } = mockClient('sim', url =>
      url.pathname.endsWith('/trade/v1/infoprices') ? { Quote: { Ask: 50, Bid: 49, Mid: 49.5 } } : { OrderId: '1' },
    );
    const t = tools(client);

    await expect(
      t.saxo_place_order!.handler({ ...baseOrder, Amount: 100, OrderType: 'Market', OrderPrice: 0.01 }),
    ).rejects.toThrow(/max_notional/);
    expect(writes(calls)).toHaveLength(0);

    await t.saxo_place_order!.handler({ ...baseOrder, Amount: 10, OrderType: 'Market' });
    expect(writes(calls)).toHaveLength(1);
  });

  it('fails closed when no quote is available', async () => {
    await usePolicy({ max_notional: 1000 });
    const { client, calls } = mockClient('sim', url =>
      url.pathname.endsWith('/trade/v1/infoprices')
        ? { Quote: { PriceTypeAsk: 'NoAccess', PriceTypeBid: 'NoAccess' } }
        : { OrderId: '1' },
    );
    await expect(
      tools(client).saxo_place_order!.handler({ ...baseOrder, Amount: 1, OrderType: 'Market' }),
    ).rejects.toThrow(/no price is available/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('fails closed when the quote request errors', async () => {
    await usePolicy({ max_notional: 1000 });
    const { client, calls } = mockClient('sim', url =>
      url.pathname.endsWith('/trade/v1/infoprices') ? jsonResponse({ Message: 'nope' }, 500) : { OrderId: '1' },
    );
    await expect(
      tools(client).saxo_place_order!.handler({ ...baseOrder, Amount: 1, OrderType: 'Market' }),
    ).rejects.toThrow(/could not be obtained/);
    expect(writes(calls)).toHaveLength(0);
  });
});

describe('related orders', () => {
  it('runs policy on every related order', async () => {
    await usePolicy({ max_order_amount: { default: 10 } });
    const { client, calls } = mockClient('sim', () => ({ OrderId: '1' }));
    await expect(
      tools(client).saxo_place_order!.handler({
        ...baseOrder,
        Amount: 5,
        OrderType: 'Limit',
        OrderPrice: 10,
        Orders: [
          { AssetType: 'Stock', BuySell: 'Sell', Amount: 500, OrderType: 'Limit', OrderPrice: 11, OrderDuration: { DurationType: 'GoodTillCancel' } },
        ],
      }),
    ).rejects.toThrow(/Related order 0/);
    expect(calls).toHaveLength(0);
  });

  it('applies allowed_asset_types to related orders', async () => {
    await usePolicy({ allowed_asset_types: ['Stock'] });
    const { client, calls } = mockClient('sim', () => ({ OrderId: '1' }));
    await expect(
      tools(client).saxo_precheck_order!.handler({
        ...baseOrder,
        Amount: 5,
        OrderType: 'Limit',
        OrderPrice: 10,
        Orders: [
          { AssetType: 'CfdOnStock', BuySell: 'Sell', Amount: 5, OrderType: 'Limit', OrderPrice: 11, OrderDuration: { DurationType: 'GoodTillCancel' } },
        ],
      }),
    ).rejects.toThrow(/Related order 0/);
    expect(calls).toHaveLength(0);
  });
});

describe('modify_order evaluates the real order', () => {
  const existing = {
    OrderId: 'ORD1',
    AccountKey: 'acc',
    Uic: 999,
    AssetType: 'Stock',
    Amount: 5,
    BuySell: 'Buy',
    OpenOrderType: 'Limit',
    Price: 100,
    Duration: { DurationType: 'GoodTillCancel' },
  };
  const route: Route = url => {
    if (url.pathname.endsWith('/port/v1/users/me')) return { ClientKey: 'ck' };
    if (url.pathname.endsWith('/port/v1/orders/ORD1')) return existing;
    if (url.pathname.endsWith('/trade/v2/orders/precheck')) return { PreCheckResult: 'Ok' };
    return { OrderId: 'ORD1' };
  };

  it('refuses when caller-supplied identity fields do not match the real order', async () => {
    await usePolicy({ denied_uics: [999] });
    const { client, calls } = mockClient('sim', route);
    await expect(
      tools(client).saxo_modify_order!.handler({ OrderId: 'ORD1', AccountKey: 'acc', Uic: 211, AssetType: 'Stock', Amount: 1 }),
    ).rejects.toThrow(/does not match/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('applies denied_uics from the real order', async () => {
    await usePolicy({ denied_uics: [999] });
    const { client, calls } = mockClient('sim', route);
    await expect(
      tools(client).saxo_modify_order!.handler({ OrderId: 'ORD1', AccountKey: 'acc', Uic: 999, AssetType: 'Stock', Amount: 1 }),
    ).rejects.toThrow(/denied_uics/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('checks max_notional when only Amount is changed, using the existing price', async () => {
    await usePolicy({ max_notional: 1000 });
    const { client, calls } = mockClient('sim', route);
    const t = tools(client);
    await expect(
      t.saxo_modify_order!.handler({ OrderId: 'ORD1', AccountKey: 'acc', Uic: 999, AssetType: 'Stock', Amount: 50 }),
    ).rejects.toThrow(/max_notional/);
    expect(writes(calls)).toHaveLength(0);

    await t.saxo_modify_order!.handler({ OrderId: 'ORD1', AccountKey: 'acc', Uic: 999, AssetType: 'Stock', Amount: 5 });
    expect(writes(calls)).toHaveLength(1);
  });

  it('prechecks the merged order on LIVE and aborts on a failed precheck', async () => {
    await usePolicy({ allow_live_writes: true, require_precheck_on_live: true });
    process.env.SAXO_ENABLE_LIVE_TRADING = 'true';
    const { client, calls } = mockClient('live', url => {
      if (url.pathname.endsWith('/trade/v2/orders/precheck')) {
        return { PreCheckResult: 'Error', ErrorInfo: { ErrorCode: 'InsufficientMargin', Message: 'x' } };
      }
      return route(url, undefined);
    });
    await expect(
      tools(client).saxo_modify_order!.handler({ OrderId: 'ORD1', AccountKey: 'acc', Uic: 999, AssetType: 'Stock', Amount: 6 }),
    ).rejects.toThrow(/precheck did not pass/);
    expect(calls.some(call => call.path.endsWith('/trade/v2/orders/precheck'))).toBe(true);
    expect(writes(calls)).toHaveLength(0);
  });
});

describe('modify_multileg_order evaluates the real legs', () => {
  const legs = {
    Data: [
      { OrderId: 'L1', MultiLegOrderId: 'ML1', AccountKey: 'acc', Uic: 1, AssetType: 'StockOption', Amount: 1, BuySell: 'Buy', ToOpenClose: 'ToOpen', MultiLegOrderDetails: { MultiLegOrderId: 'ML1', Amount: 1, Price: 1.5 } },
      { OrderId: 'L2', MultiLegOrderId: 'ML1', AccountKey: 'acc', Uic: 2, AssetType: 'StockOption', Amount: 1, BuySell: 'Sell', ToOpenClose: 'ToOpen', MultiLegOrderDetails: { MultiLegOrderId: 'ML1', Amount: 1, Price: 1.5 } },
      { OrderId: 'X', MultiLegOrderId: 'OTHER', AccountKey: 'acc', Uic: 3, AssetType: 'StockOption', Amount: 99, BuySell: 'Buy' },
    ],
  };
  const route: Route = url => {
    if (url.pathname.endsWith('/port/v1/users/me')) return { ClientKey: 'ck' };
    if (url.pathname.endsWith('/port/v1/orders')) return legs;
    return { MultiLegOrderId: 'ML1' };
  };

  it('applies max_order_amount to scaled leg amounts', async () => {
    await usePolicy({ max_order_amount: { default: 10 } });
    const { client, calls } = mockClient('sim', route);
    await expect(
      tools(client).saxo_modify_multileg_order!.handler({ AccountKey: 'acc', MultiLegOrderId: 'ML1', Amount: 20 }),
    ).rejects.toThrow(/max_order_amount/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('applies max_notional using the existing price when only Amount changes', async () => {
    await usePolicy({ max_notional: 1000 });
    const { client, calls } = mockClient('sim', route);
    // 1.5 * 10 * 100 = 1500 > 1000
    await expect(
      tools(client).saxo_modify_multileg_order!.handler({ AccountKey: 'acc', MultiLegOrderId: 'ML1', Amount: 10 }),
    ).rejects.toThrow(/max_notional/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('applies denied_uics and short-leg rules to the real legs', async () => {
    await usePolicy({ allow_short_option_legs: false });
    const { client, calls } = mockClient('sim', route);
    await expect(
      tools(client).saxo_modify_multileg_order!.handler({ AccountKey: 'acc', MultiLegOrderId: 'ML1', OrderPrice: 1 }),
    ).rejects.toThrow(/short/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('refuses when the multi-leg order cannot be found', async () => {
    await usePolicy({});
    const { client, calls } = mockClient('sim', route);
    await expect(
      tools(client).saxo_modify_multileg_order!.handler({ AccountKey: 'acc', MultiLegOrderId: 'MISSING', OrderPrice: 1 }),
    ).rejects.toThrow(/Could not load/);
    expect(writes(calls)).toHaveLength(0);
  });
});

describe('require_precheck_on_live honours the precheck result', () => {
  async function liveSetup(precheck: unknown) {
    await usePolicy({ allow_live_writes: true, require_precheck_on_live: true });
    process.env.SAXO_ENABLE_LIVE_TRADING = 'true';
    return mockClient('live', url => (url.pathname.endsWith('/precheck') ? precheck : { OrderId: '1', MultiLegOrderId: 'M' }));
  }

  it('aborts place_order when precheck reports an error', async () => {
    const { client, calls } = await liveSetup({ PreCheckResult: 'Error', ErrorInfo: { ErrorCode: 'X', Message: 'bad' } });
    await expect(
      tools(client).saxo_place_order!.handler({ ...baseOrder, Amount: 1, OrderType: 'Limit', OrderPrice: 1 }),
    ).rejects.toThrow(/precheck did not pass/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('aborts place_order when PreCheckResult is Ok but ErrorInfo is present', async () => {
    const { client, calls } = await liveSetup({ PreCheckResult: 'Ok', ErrorInfo: { ErrorCode: 'X' } });
    await expect(
      tools(client).saxo_place_order!.handler({ ...baseOrder, Amount: 1, OrderType: 'Limit', OrderPrice: 1 }),
    ).rejects.toThrow(/precheck did not pass/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('places the order when precheck is Ok', async () => {
    const { client, calls } = await liveSetup({ PreCheckResult: 'Ok' });
    await tools(client).saxo_place_order!.handler({ ...baseOrder, Amount: 1, OrderType: 'Limit', OrderPrice: 1 });
    expect(writes(calls)).toHaveLength(1);
  });

  it('aborts place_multileg_order on a failed leg precheck', async () => {
    const { client, calls } = await liveSetup({
      PreCheckResult: 'Ok',
      Orders: [{ PreCheckResult: 'Ok' }, { PreCheckResult: 'Error', ErrorInfo: { ErrorCode: 'Y' } }],
    });
    await expect(
      tools(client).saxo_place_multileg_order!.handler({
        AccountKey: 'acc',
        OrderType: 'Limit',
        OrderPrice: 1,
        OrderDuration: { DurationType: 'DayOrder' },
        Legs: [
          { Uic: 1, AssetType: 'StockOption', BuySell: 'Buy', Amount: 1, ToOpenClose: 'ToOpen' },
          { Uic: 2, AssetType: 'StockOption', BuySell: 'Sell', Amount: 1, ToOpenClose: 'ToOpen' },
        ],
      }),
    ).rejects.toThrow(/leg 1/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('assertPrecheckOk rejects malformed responses', () => {
    expect(() => assertPrecheckOk(null, 't')).toThrow();
    expect(() => assertPrecheckOk({}, 't')).toThrow(/missing/);
    expect(() => assertPrecheckOk({ PreCheckResult: 'Ok' }, 't')).not.toThrow();
  });
});

describe('OAuth tools', () => {
  it('are not registered when disabled (HTTP transport)', () => {
    const { client } = mockClient('sim', () => ({}));
    const ids = Object.keys(tools(client, { enableOauthTools: false }));
    expect(ids.some(id => id.startsWith('saxo_oauth_'))).toBe(false);
    expect(ids).toContain('saxo_place_order');
  });

  it('do not accept a caller-controlled env file path', () => {
    const { client } = mockClient('sim', () => ({}));
    const t = tools(client);
    for (const id of ['saxo_oauth_login', 'saxo_oauth_complete']) {
      const schema = t[id]!.config.inputSchema as Record<string, unknown>;
      expect(schema).not.toHaveProperty('envFilePath');
    }
  });
});

describe('path parameter guard', () => {
  it('rejects traversal and separator shapes', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a?b', 'a#b', '%2e%2e', '%2F', 'x%2fy', '%5c']) {
      expect(() => assertSafePathSegment(bad)).toThrow();
    }
    expect(pathSegment('123')).toBe('123');
    expect(pathSegment(42)).toBe('42');
    expect(pathSegment('a b')).toBe('a%20b');
  });

  it('blocks unsafe ids before any request is sent', async () => {
    const { client, fetchMock } = mockClient('sim', () => ({ ClientKey: 'ck' }));
    await expect(getOrder(client, { orderId: '..', clientKey: 'ck' })).rejects.toThrow(/Invalid orderId/);
    await expect(Promise.resolve().then(() => cancelOrder(client, { orderIds: ['1', '../x'], accountKey: 'a' }))).rejects.toThrow();
    await expect(Promise.resolve().then(() => cancelMultiLegOrder(client, { multiLegOrderId: '%2e%2e', accountKey: 'a' }))).rejects.toThrow();
    await expect(Promise.resolve().then(() => listExchanges(client, { exchangeId: '../../port/v1/users/me' }))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('HTTP bearer token', () => {
  it('compares in constant time and still enforces the token', () => {
    process.env.MCP_HTTP_TOKEN = 'secret';
    expect(() => assertAuthorized({ headers: { authorization: 'Bearer secre' } } as never)).toThrow(HttpRequestError);
    expect(() => assertAuthorized({ headers: { authorization: 'Bearer secret' } } as never)).not.toThrow();
    expect(constantTimeEquals(undefined, 'x')).toBe(false);
    expect(constantTimeEquals(['x'], 'x')).toBe(false);
  });
});

describe('base URL normalisation', () => {
  it('trims trailing slashes in linear time', () => {
    const client = new SaxoClient({ environment: 'sim', accessToken: 't', baseUrl: 'https://example.test/api///' });
    expect(client.baseUrl).toBe('https://example.test/api');
    const started = Date.now();
    expect(() =>
      new SaxoClient({ environment: 'sim', accessToken: 't', baseUrl: `https://example.test/${'/'.repeat(100_000)}x` }),
    ).not.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
