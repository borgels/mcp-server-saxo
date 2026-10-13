import { SaxoPolicyDeniedError } from '../errors.js';
import type { SaxoClient } from './client.js';
import {
  checkMultiLegOrder,
  checkOrder,
  orderNeedsReferencePrice,
  type MultiLegPolicyLeg,
  type OrderPolicyInput,
  type SaxoPolicy,
} from './policy.js';
import { getOrder, listOrders } from './portfolio.js';
import { getInfoPrice } from './prices.js';
import {
  precheckMultiLegOrder,
  precheckOrder,
  type ModifyMultiLegOrderInput,
  type ModifyOrderInput,
  type MultiLegOrderLeg,
  type OrderDuration,
  type PlaceMultiLegOrderInput,
  type PlaceOrderInput,
} from './trading.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function buySell(value: unknown): 'Buy' | 'Sell' | undefined {
  return value === 'Buy' || value === 'Sell' ? value : undefined;
}

function toOpenClose(value: unknown): 'ToOpen' | 'ToClose' | undefined {
  return value === 'ToOpen' || value === 'ToClose' ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch a conservative market reference price for notional checks: the
 * highest usable of Ask/Bid/Mid. Returns undefined if no usable quote.
 */
export async function resolveReferencePrice(
  client: SaxoClient,
  input: { Uic?: number; AssetType?: string; AccountKey?: string; Amount?: number },
  tool: string,
): Promise<number | undefined> {
  if (input.Uic === undefined || !input.AssetType) {
    return undefined;
  }
  let response: Awaited<ReturnType<typeof getInfoPrice>>;
  try {
    response = await getInfoPrice(client, {
      uic: input.Uic,
      assetType: input.AssetType,
      accountKey: input.AccountKey,
      amount: input.Amount,
      fieldGroups: ['Quote'],
    });
  } catch (error) {
    throw new SaxoPolicyDeniedError(
      tool,
      `policy.max_notional is set but a market quote could not be obtained to compute notional (${errorMessage(error)}); refusing order.`,
    );
  }
  const quote = response.Quote;
  if (!quote) {
    return undefined;
  }
  const candidates: number[] = [];
  if (quote.PriceTypeAsk !== 'NoAccess') candidates.push(quote.Ask ?? NaN);
  if (quote.PriceTypeBid !== 'NoAccess') candidates.push(quote.Bid ?? NaN);
  if (quote.PriceTypeAsk !== 'NoAccess' && quote.PriceTypeBid !== 'NoAccess') {
    candidates.push(quote.Mid ?? NaN);
  }
  const usable = candidates.filter(value => Number.isFinite(value) && value > 0);
  return usable.length ? Math.max(...usable) : undefined;
}

/**
 * Evaluate a single order against the policy. Non-price rules are evaluated
 * first (no network); if max_notional is configured and the order has no
 * usable price, a market quote is fetched. If no price can be obtained the
 * order is refused (fail closed).
 */
export async function enforceOrderPolicy(
  client: SaxoClient,
  order: OrderPolicyInput,
  policy: SaxoPolicy,
  tool: string,
): Promise<void> {
  checkOrder(order, { ...policy, max_notional: undefined });
  if (typeof policy.max_notional !== 'number') {
    return;
  }
  let input = order;
  if (orderNeedsReferencePrice(order, policy)) {
    input = { ...order, ReferencePrice: await resolveReferencePrice(client, order, tool) };
  }
  checkOrder(input, policy);
}

/** Policy for saxo_place_order / saxo_precheck_order, including related orders. */
export async function enforcePlaceOrderPolicy(
  client: SaxoClient,
  order: PlaceOrderInput,
  policy: SaxoPolicy,
  tool: string,
): Promise<void> {
  await enforceOrderPolicy(
    client,
    {
      AccountKey: order.AccountKey,
      Uic: order.Uic,
      AssetType: order.AssetType,
      Amount: order.Amount,
      BuySell: order.BuySell,
      ToOpenClose: order.ToOpenClose,
      OrderType: order.OrderType,
      OrderPrice: order.OrderPrice,
      StopPrice: order.StopPrice,
    },
    policy,
    tool,
  );

  const related = order.Orders ?? [];
  for (let i = 0; i < related.length; i += 1) {
    const rel = related[i];
    if (!rel) continue;
    try {
      await enforceOrderPolicy(
        client,
        {
          AccountKey: order.AccountKey,
          Uic: order.Uic,
          AssetType: rel.AssetType,
          Amount: rel.Amount,
          BuySell: rel.BuySell,
          ToOpenClose: rel.ToOpenClose,
          OrderType: rel.OrderType,
          OrderPrice: rel.OrderPrice,
          StopPrice: rel.StopPrice,
        },
        policy,
        tool,
      );
    } catch (error) {
      if (error instanceof SaxoPolicyDeniedError) {
        throw new SaxoPolicyDeniedError(tool, `Related order ${i}: ${error.reason}`);
      }
      throw error;
    }
  }
}

/**
 * Throw unless a Saxo precheck response reports success. Missing or
 * non-"Ok" PreCheckResult, or any ErrorInfo (top-level or per-leg), aborts.
 */
export function assertPrecheckOk(result: unknown, tool: string): void {
  const fail = (detail: string): never => {
    throw new SaxoPolicyDeniedError(tool, `Saxo precheck did not pass (${detail}); order not sent.`);
  };
  if (!isRecord(result)) {
    fail('empty or malformed precheck response');
  }
  const record = result as JsonRecord;
  const describe = (info: unknown): string => {
    if (isRecord(info)) {
      return [str(info.ErrorCode), str(info.Message)].filter(Boolean).join(': ') || 'ErrorInfo present';
    }
    return 'ErrorInfo present';
  };
  if (record.ErrorInfo !== undefined && record.ErrorInfo !== null) {
    fail(describe(record.ErrorInfo));
  }
  const status = record.PreCheckResult;
  if (typeof status !== 'string' || status.toLowerCase() !== 'ok') {
    fail(`PreCheckResult=${typeof status === 'string' ? status : 'missing'}`);
  }
  if (Array.isArray(record.Orders)) {
    record.Orders.forEach((leg, i) => {
      if (!isRecord(leg)) return;
      if (leg.ErrorInfo !== undefined && leg.ErrorInfo !== null) {
        fail(`leg ${i}: ${describe(leg.ErrorInfo)}`);
      }
      const legStatus = leg.PreCheckResult;
      if (legStatus !== undefined && (typeof legStatus !== 'string' || legStatus.toLowerCase() !== 'ok')) {
        fail(`leg ${i}: PreCheckResult=${String(legStatus)}`);
      }
    });
  }
}

export async function runRequiredPrecheck(
  client: SaxoClient,
  order: PlaceOrderInput,
  policy: SaxoPolicy,
  tool: string,
): Promise<void> {
  if (!client.isLive() || !policy.require_precheck_on_live) {
    return;
  }
  assertPrecheckOk(await precheckOrder(client, order), tool);
}

export async function runRequiredMultiLegPrecheck(
  client: SaxoClient,
  order: PlaceMultiLegOrderInput,
  policy: SaxoPolicy,
  tool: string,
): Promise<void> {
  if (!client.isLive() || !policy.require_precheck_on_live) {
    return;
  }
  assertPrecheckOk(await precheckMultiLegOrder(client, order), tool);
}

async function loadExistingOrder(client: SaxoClient, orderId: string, tool: string): Promise<JsonRecord> {
  const response = await getOrder(client, { orderId });
  let order: unknown = response;
  if (isRecord(response) && Array.isArray(response.Data)) {
    order = response.Data.find(item => isRecord(item) && String(item.OrderId) === orderId);
  }
  if (!isRecord(order)) {
    throw new SaxoPolicyDeniedError(tool, `Could not load order ${orderId} to evaluate policy; refusing modify.`);
  }
  if (order.OrderId !== undefined && String(order.OrderId) !== orderId) {
    throw new SaxoPolicyDeniedError(tool, `Saxo returned a different order than ${orderId}; refusing modify.`);
  }
  return order;
}

function assertMatches(tool: string, field: string, actual: unknown, requested: unknown): void {
  if (actual !== undefined && requested !== undefined && actual !== requested) {
    throw new SaxoPolicyDeniedError(
      tool,
      `${field} in the request does not match the existing order; refusing modify.`,
    );
  }
}

function durationOf(value: unknown): OrderDuration | undefined {
  if (isRecord(value) && typeof value.DurationType === 'string') {
    return value as unknown as OrderDuration;
  }
  return undefined;
}

/**
 * Policy (and, on LIVE, precheck) for saxo_modify_order. The existing order
 * is fetched from Saxo and policy is evaluated against the real order merged
 * with the requested changes — never against caller-supplied identity fields.
 */
export async function enforceModifyOrderPolicy(
  client: SaxoClient,
  input: ModifyOrderInput,
  policy: SaxoPolicy,
  tool: string,
): Promise<void> {
  const existing = await loadExistingOrder(client, input.OrderId, tool);

  const realAccountKey = str(existing.AccountKey);
  const realUic = num(existing.Uic);
  const realAssetType = str(existing.AssetType);
  assertMatches(tool, 'AccountKey', realAccountKey, input.AccountKey);
  assertMatches(tool, 'Uic', realUic, input.Uic);
  assertMatches(tool, 'AssetType', realAssetType, input.AssetType);

  const merged: OrderPolicyInput = {
    AccountKey: realAccountKey ?? input.AccountKey,
    Uic: realUic ?? input.Uic,
    AssetType: realAssetType ?? input.AssetType,
    Amount: input.Amount ?? num(existing.Amount),
    BuySell: buySell(existing.BuySell),
    ToOpenClose: toOpenClose(existing.ToOpenClose),
    OrderType: input.OrderType ?? str(existing.OpenOrderType) ?? str(existing.OrderType),
    OrderPrice: input.OrderPrice ?? num(existing.Price) ?? num(existing.OrderPrice),
    StopPrice: input.StopPrice ?? num(existing.StopLimitPrice) ?? num(existing.StopPrice),
  };

  if (
    merged.Amount === undefined &&
    (typeof policy.max_notional === 'number' || policy.max_order_amount !== undefined)
  ) {
    throw new SaxoPolicyDeniedError(tool, 'Could not determine the order Amount to evaluate policy; refusing modify.');
  }

  await enforceOrderPolicy(client, merged, policy, tool);

  if (client.isLive() && policy.require_precheck_on_live) {
    if (!merged.BuySell || merged.Amount === undefined || !merged.OrderType || merged.Uic === undefined || !merged.AssetType || !merged.AccountKey) {
      throw new SaxoPolicyDeniedError(tool, 'Existing order is missing fields required for precheck; refusing modify.');
    }
    const precheckBody: PlaceOrderInput = {
      AccountKey: merged.AccountKey,
      Uic: merged.Uic,
      AssetType: merged.AssetType,
      BuySell: merged.BuySell,
      Amount: merged.Amount,
      OrderType: merged.OrderType,
      OrderDuration: input.OrderDuration ?? durationOf(existing.Duration) ?? { DurationType: 'DayOrder' },
      ...(merged.ToOpenClose ? { ToOpenClose: merged.ToOpenClose } : {}),
      ...(merged.OrderPrice !== undefined ? { OrderPrice: merged.OrderPrice } : {}),
    };
    assertPrecheckOk(await precheckOrder(client, precheckBody), tool);
  }
}

function multiLegIdOf(order: JsonRecord): string | undefined {
  const direct = order.MultiLegOrderId;
  if (typeof direct === 'string' || typeof direct === 'number') return String(direct);
  const details = order.MultiLegOrderDetails;
  if (isRecord(details)) {
    const nested = details.MultiLegOrderId;
    if (typeof nested === 'string' || typeof nested === 'number') return String(nested);
  }
  return undefined;
}

/**
 * Policy (and, on LIVE, precheck) for saxo_modify_multileg_order. The legs of
 * the existing strategy are loaded from Saxo, the requested Amount is scaled
 * across them, and the full multi-leg policy is evaluated.
 */
export async function enforceModifyMultiLegPolicy(
  client: SaxoClient,
  input: ModifyMultiLegOrderInput,
  policy: SaxoPolicy,
  tool: string,
): Promise<void> {
  const response = await listOrders(client, { accountKey: input.AccountKey, status: 'Working', top: 1000 });
  const data = isRecord(response) && Array.isArray(response.Data) ? response.Data : [];
  const legsRaw = data.filter(
    (item): item is JsonRecord => isRecord(item) && multiLegIdOf(item) === input.MultiLegOrderId,
  );
  if (!legsRaw.length) {
    throw new SaxoPolicyDeniedError(
      tool,
      `Could not load multi-leg order ${input.MultiLegOrderId} to evaluate policy; refusing modify.`,
    );
  }

  for (const leg of legsRaw) {
    assertMatches(tool, 'AccountKey', str(leg.AccountKey), input.AccountKey);
  }

  const details = legsRaw.map(leg => leg.MultiLegOrderDetails).find(isRecord);
  const strategyAmount = num(details?.Amount);
  const currentPrice = num(details?.Price) ?? num(details?.OrderPrice);
  const legAmounts = legsRaw.map(leg => num(leg.Amount)).filter((v): v is number => v !== undefined && v > 0);
  const minLegAmount = legAmounts.length ? Math.min(...legAmounts) : undefined;

  const legs: Array<MultiLegPolicyLeg & { Uic?: number }> = legsRaw.map(leg => {
    const current = num(leg.Amount);
    let amount = current;
    if (typeof input.Amount === 'number') {
      if (current === undefined) {
        amount = undefined;
      } else if (strategyAmount && strategyAmount > 0) {
        amount = (current * input.Amount) / strategyAmount;
      } else if (minLegAmount) {
        amount = (current / minLegAmount) * input.Amount;
      } else {
        amount = undefined;
      }
    }
    return {
      Uic: num(leg.Uic),
      AssetType: str(leg.AssetType),
      Amount: amount,
      BuySell: buySell(leg.BuySell),
      ToOpenClose: toOpenClose(leg.ToOpenClose),
    };
  });

  if (
    legs.some(leg => leg.Amount === undefined) &&
    (typeof policy.max_notional === 'number' || policy.max_order_amount !== undefined)
  ) {
    throw new SaxoPolicyDeniedError(tool, 'Could not determine leg Amounts to evaluate policy; refusing modify.');
  }

  const orderPrice = input.OrderPrice ?? currentPrice;
  try {
    checkMultiLegOrder({ AccountKey: input.AccountKey, OrderPrice: orderPrice, Legs: legs }, policy);
  } catch (error) {
    if (error instanceof SaxoPolicyDeniedError) {
      throw new SaxoPolicyDeniedError(tool, error.reason);
    }
    throw error;
  }

  if (client.isLive() && policy.require_precheck_on_live) {
    const precheckLegs: MultiLegOrderLeg[] = [];
    for (const leg of legs) {
      if (leg.Uic === undefined || !leg.AssetType || !leg.BuySell || leg.Amount === undefined) {
        throw new SaxoPolicyDeniedError(tool, 'Existing multi-leg order is missing fields required for precheck; refusing modify.');
      }
      precheckLegs.push({
        Uic: leg.Uic,
        AssetType: leg.AssetType,
        BuySell: leg.BuySell,
        Amount: leg.Amount,
        ToOpenClose: leg.ToOpenClose ?? 'ToOpen',
      });
    }
    const precheckBody: PlaceMultiLegOrderInput = {
      AccountKey: input.AccountKey,
      OrderType: 'Limit',
      OrderDuration: legsRaw.map(leg => durationOf(leg.Duration)).find(Boolean) ?? { DurationType: 'DayOrder' },
      Legs: precheckLegs,
      ...(orderPrice !== undefined ? { OrderPrice: orderPrice } : {}),
    };
    assertPrecheckOk(await precheckMultiLegOrder(client, precheckBody), tool);
  }
}
