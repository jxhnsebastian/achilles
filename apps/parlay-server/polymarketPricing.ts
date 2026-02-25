import { PolymarketMarket } from "./types";

export type LegSide = "YES" | "NO";

export interface PricingLegInput {
  marketId: string;
  question: string;
  selectedSide: LegSide;
  yesTokenId?: string;
  noTokenId?: string;
  market?: Partial<PolymarketMarket>;
}

export interface NormalizedLegPricing {
  marketId: string;
  question: string;
  selectedSide: LegSide;
  yesPrice: number | null;
  noPrice: number | null;
  impliedProbability: number | null;
  decimalOdds: number | null;
  americanOdds: number | null;
  yesTokenId: string | null;
  noTokenId: string | null;
  sourceTimestamp: string | null;
  isClosed: boolean;
  isSuspended: boolean;
  isStale: boolean;
  error?: string;
}

export interface CombinedParlayPricing {
  includedLegCount: number;
  excludedLegCount: number;
  combinedProbability: number;
  combinedDecimalOdds: number;
  combinedAmericanOdds: number;
}

export interface ParlayPricingResponse {
  legs: NormalizedLegPricing[];
  combined: CombinedParlayPricing | null;
  note: string;
  lastUpdated: string | null;
  hasStaleData: boolean;
}

interface PolymarketMarketSnapshot {
  id: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
  closed?: boolean;
  acceptingOrders?: boolean;
  updatedAt?: string;
}

function parseArrayString(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item));
      }
    } catch {
      return [];
    }
  }

  return [];
}

function clampProbability(probability: unknown): number | null {
  if (probability === null || probability === undefined) return null;

  const value = Number(probability);
  if (!Number.isFinite(value)) return null;
  if (value <= 0 || value >= 1) return null;

  return Math.min(0.9999, Math.max(0.0001, value));
}

export function probabilityToDecimalOdds(probability: number | null): number | null {
  const safeProbability = clampProbability(probability);
  if (!safeProbability) return null;
  return Number((1 / safeProbability).toFixed(4));
}

export function decimalOddsToProbability(decimalOdds: number | null): number | null {
  if (decimalOdds === null || decimalOdds === undefined) return null;
  const odds = Number(decimalOdds);
  if (!Number.isFinite(odds) || odds <= 1) return null;
  return clampProbability(1 / odds);
}

export function probabilityToAmericanOdds(probability: number | null): number | null {
  const safeProbability = clampProbability(probability);
  if (!safeProbability) return null;

  if (safeProbability >= 0.5) {
    const value = -Math.round((safeProbability / (1 - safeProbability)) * 100);
    return Number.isFinite(value) ? value : null;
  }

  const value = Math.round(((1 - safeProbability) / safeProbability) * 100);
  return Number.isFinite(value) ? value : null;
}

function resolveTokenIds(
  leg: PricingLegInput,
  snapshot?: PolymarketMarketSnapshot,
): { yesTokenId: string | null; noTokenId: string | null } {
  if (leg.yesTokenId || leg.noTokenId) {
    return {
      yesTokenId: leg.yesTokenId ?? null,
      noTokenId: leg.noTokenId ?? null,
    };
  }

  const tokenIds = parseArrayString(snapshot?.clobTokenIds ?? leg.market?.clobTokenIds);
  const outcomes = parseArrayString(snapshot?.outcomes ?? leg.market?.outcomes).map((outcome) =>
    outcome.trim().toLowerCase(),
  );

  if (!tokenIds.length) {
    return { yesTokenId: null, noTokenId: null };
  }

  const yesIndex = outcomes.findIndex((outcome) => outcome === "yes");
  const noIndex = outcomes.findIndex((outcome) => outcome === "no");

  if (yesIndex >= 0 && noIndex >= 0) {
    return {
      yesTokenId: tokenIds[yesIndex] ?? null,
      noTokenId: tokenIds[noIndex] ?? null,
    };
  }

  return {
    yesTokenId: tokenIds[0] ?? null,
    noTokenId: tokenIds[1] ?? null,
  };
}

function resolveYesNoPrices(
  leg: PricingLegInput,
  snapshot?: PolymarketMarketSnapshot,
): { yesPrice: number | null; noPrice: number | null } {
  const outcomes = parseArrayString(snapshot?.outcomes ?? leg.market?.outcomes).map((outcome) =>
    outcome.trim().toLowerCase(),
  );
  const prices = parseArrayString(snapshot?.outcomePrices ?? leg.market?.outcomePrices).map((price) =>
    Number(price),
  );

  if (!prices.length) {
    return { yesPrice: null, noPrice: null };
  }

  const normalizedPrices = prices.map((price) => {
    if (!Number.isFinite(price)) return null;
    return Math.min(1, Math.max(0, price));
  });

  const yesIndex = outcomes.findIndex((outcome) => outcome === "yes");
  const noIndex = outcomes.findIndex((outcome) => outcome === "no");

  const yesPrice =
    yesIndex >= 0
      ? normalizedPrices[yesIndex]
      : normalizedPrices.length > 0
        ? normalizedPrices[0]
        : null;
  const noPrice =
    noIndex >= 0
      ? normalizedPrices[noIndex]
      : normalizedPrices.length > 1
        ? normalizedPrices[1]
        : yesPrice !== null
          ? 1 - yesPrice
          : null;

  return {
    yesPrice: yesPrice ?? null,
    noPrice: noPrice ?? null,
  };
}

function isStaleTimestamp(timestamp: string | null): boolean {
  if (!timestamp) return true;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return true;
  return Date.now() - parsed > 15 * 60 * 1000;
}

async function fetchMarketSnapshots(
  marketIds: string[],
): Promise<Record<string, PolymarketMarketSnapshot>> {
  const uniqueIds = Array.from(new Set(marketIds.filter(Boolean)));
  if (!uniqueIds.length) return {};

  const query = uniqueIds.map((id) => `id=${encodeURIComponent(id)}`).join("&");
  const response = await fetch(`https://gamma-api.polymarket.com/markets?${query}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Polymarket batched market fetch failed with ${response.status}`);
  }

  const markets = (await response.json()) as PolymarketMarketSnapshot[];
  const map: Record<string, PolymarketMarketSnapshot> = {};
  markets.forEach((market) => {
    if (market?.id) {
      map[String(market.id)] = market;
    }
  });

  return map;
}

async function fetchLegPricing(
  leg: PricingLegInput,
  snapshot?: PolymarketMarketSnapshot,
): Promise<NormalizedLegPricing> {
  try {
    const tokenIds = resolveTokenIds(leg, snapshot);
    const { yesPrice, noPrice } = resolveYesNoPrices(leg, snapshot);
    const impliedProbability = clampProbability(leg.selectedSide === "YES" ? yesPrice : noPrice);
    const decimalOdds = probabilityToDecimalOdds(impliedProbability);
    const americanOdds = probabilityToAmericanOdds(impliedProbability);
    const sourceTimestamp = snapshot?.updatedAt ?? null;

    const isClosed = Boolean(snapshot?.closed || leg.market?.closed);
    const isSuspended = Boolean(snapshot && snapshot.acceptingOrders === false);

    if (yesPrice === null || noPrice === null) {
      return {
        marketId: leg.marketId,
        question: leg.question,
        selectedSide: leg.selectedSide,
        yesPrice,
        noPrice,
        impliedProbability,
        decimalOdds,
        americanOdds,
        yesTokenId: tokenIds.yesTokenId,
        noTokenId: tokenIds.noTokenId,
        sourceTimestamp,
        isClosed,
        isSuspended,
        isStale: isStaleTimestamp(sourceTimestamp),
        error: "Price unavailable from Polymarket for this market.",
      };
    }

    return {
      marketId: leg.marketId,
      question: leg.question,
      selectedSide: leg.selectedSide,
      yesPrice,
      noPrice,
      impliedProbability,
      decimalOdds,
      americanOdds,
      yesTokenId: tokenIds.yesTokenId,
      noTokenId: tokenIds.noTokenId,
      sourceTimestamp,
      isClosed,
      isSuspended,
      isStale: isStaleTimestamp(sourceTimestamp),
      error: impliedProbability === null ? "Invalid selected-side probability." : undefined,
    };
  } catch (error: any) {
    return {
      marketId: leg.marketId,
      question: leg.question,
      selectedSide: leg.selectedSide,
      yesPrice: null,
      noPrice: null,
      impliedProbability: null,
      decimalOdds: null,
      americanOdds: null,
      yesTokenId: leg.yesTokenId ?? null,
      noTokenId: leg.noTokenId ?? null,
      sourceTimestamp: null,
      isClosed: Boolean(leg.market?.closed),
      isSuspended: false,
      isStale: true,
      error: error?.message ?? "Failed to fetch market pricing.",
    };
  }
}

function combineLegs(legs: NormalizedLegPricing[]): CombinedParlayPricing | null {
  // Initial version: assumes legs are independent.
  const includedLegs = legs.filter(
    (leg) =>
      leg.impliedProbability !== null &&
      leg.impliedProbability > 0 &&
      leg.impliedProbability < 1 &&
      !leg.isClosed,
  );

  if (!includedLegs.length) return null;

  const combinedProbability = includedLegs.reduce((acc, leg) => {
    return acc * (leg.impliedProbability ?? 1);
  }, 1);

  const safeCombinedProbability = clampProbability(combinedProbability);
  if (!safeCombinedProbability) return null;

  const combinedDecimalOdds = probabilityToDecimalOdds(safeCombinedProbability);
  const combinedAmericanOdds = probabilityToAmericanOdds(safeCombinedProbability);

  if (!combinedDecimalOdds || combinedAmericanOdds === null) {
    return null;
  }

  return {
    includedLegCount: includedLegs.length,
    excludedLegCount: legs.length - includedLegs.length,
    combinedProbability: safeCombinedProbability,
    combinedDecimalOdds,
    combinedAmericanOdds,
  };
}

export async function getParlayPricing(legsInput: PricingLegInput[]): Promise<ParlayPricingResponse> {
  let snapshots: Record<string, PolymarketMarketSnapshot> = {};

  try {
    snapshots = await fetchMarketSnapshots(legsInput.map((leg) => leg.marketId));
  } catch {
    snapshots = {};
  }

  const legs = await Promise.all(
    legsInput.map((leg) => fetchLegPricing(leg, snapshots[leg.marketId])),
  );

  const combined = combineLegs(legs);

  const timestamps = legs
    .map((leg) => leg.sourceTimestamp)
    .filter((timestamp): timestamp is string => Boolean(timestamp))
    .sort();

  return {
    legs,
    combined,
    note: "Estimated using independent leg probabilities (no correlation adjustment). Legs without valid live prices are excluded from combined odds.",
    lastUpdated: timestamps.length ? timestamps[timestamps.length - 1] : null,
    hasStaleData: legs.some((leg) => leg.isStale),
  };
}
