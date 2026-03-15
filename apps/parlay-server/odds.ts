import { withRetry } from "./utils";

const POLYMARKET_GAMMA_BASE = "https://gamma-api.polymarket.com";
const POLYMARKET_CLOB_BASE = "https://clob.polymarket.com";
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

/** 15% total fee: 10% market maker + 5% competition */
const FEE_BIPS = 1500;
const FEE_DENOMINATOR = 10000;

/** Min/max bet amounts in USD */
const MIN_BET_AMOUNT = 0.01;
const MAX_BET_AMOUNT = 1_000_000;

/** Parlay leg limits */
const MIN_LEGS = 2;
const MAX_LEGS = 10;

export type LegSource = "polymarket" | "kalshi";
const VALID_SOURCES: LegSource[] = ["polymarket", "kalshi"];

interface ValidationError {
  field: string;
  message: string;
}

interface ValidatedInput {
  legs: ParlayLegInput[];
  betAmount: number;
}

export interface ParlayLegInput {
  source: LegSource;
  /** Polymarket: market slug (e.g. "will-btc-hit-100k").
   *  Kalshi: market ticker (e.g. "BTCZ-24NOV1-T100000"). */
  marketSlug: string;
  /** Polymarket: one of the outcome labels (case-insensitive, e.g. "Yes", "No", "Trump").
   *  Kalshi: must be "yes" or "no" (case-insensitive). */
  outcome: string;
}

export interface ParlayInput {
  legs: ParlayLegInput[];
  betAmount: number;
}

export type InvalidReason =
  | "OUTCOME_NOT_FOUND"
  | "INVALID_KALSHI_OUTCOME"
  | "MARKET_FETCH_FAILED"
  | "PRICE_FETCH_FAILED"
  | "EMPTY_ORDERBOOK";

export interface ResolvedLeg {
  /** clobTokenId for Polymarket, ticker for Kalshi */
  marketId: string;
  title: string;
  source: LegSource;
  outcome: string;
  yesPrice: number | null;
  impliedProb: number | null;
  /** Populated when the leg could not be fully resolved */
  invalidReason?: InvalidReason;
  invalidDetail?: string;
}

export interface ParlayResult {
  legs: ResolvedLeg[];
  combinedProb?: number;
  combinedDecimalOdds?: number;
  betAmount: number;
  /** betAmount × (10000 − 1500) / 10000  (15% fee deducted) */
  netAmount?: number;
  /** netAmount × combinedDecimalOdds */
  potentialPayout?: number;
}

interface PolymarketMarketResolved {
  source: "polymarket";
  slug: string;
  title: string;
  tokenId: string;
  outcome: string;
  invalidReason?: InvalidReason;
  invalidDetail?: string;
}

interface KalshiMarketResolved {
  source: "kalshi";
  ticker: string;
  title: string;
  outcome: "yes" | "no";
  invalidReason?: InvalidReason;
  invalidDetail?: string;
}

type MarketResolved = PolymarketMarketResolved | KalshiMarketResolved;

interface PolymarketMarketResponse {
  id: string;
  question: string | null;
  slug: string | null;
  outcomes: string | null;
  clobTokenIds: string | null;
  active: boolean | null;
  closed: boolean | null;
  acceptingOrders: boolean | null;
}

type PolymarketPricesResponse = Record<string, Partial<Record<"BUY" | "SELL", number>>>;

interface KalshiMarketResponse {
  market: {
    ticker: string;
    title: string;
    status: string;
  };
}

type KalshiOrderbookLevel = [string, number | string];

interface KalshiOrderbookResponse {
  orderbook: {
    yes?: KalshiOrderbookLevel[];
    no?: KalshiOrderbookLevel[];
    yes_dollars?: KalshiOrderbookLevel[];
    no_dollars?: KalshiOrderbookLevel[];
  };
  orderbook_fp?: {
    yes_dollars?: KalshiOrderbookLevel[];
    no_dollars?: KalshiOrderbookLevel[];
  };
}

async function fetchPolymarketMarket(leg: ParlayLegInput): Promise<PolymarketMarketResolved> {
  let marketData: PolymarketMarketResponse;

  try {
    marketData = await withRetry(
      async () => {
        const res = await fetch(
          `${POLYMARKET_GAMMA_BASE}/markets/slug/${encodeURIComponent(leg.marketSlug)}`,
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return res.json() as Promise<PolymarketMarketResponse>;
      },
      { maxRetries: 2, initialDelay: 1000 },
      `Polymarket market fetch for slug "${leg.marketSlug}"`,
    );
  } catch (err) {
    return {
      source: "polymarket",
      slug: leg.marketSlug,
      title: "Unknown",
      tokenId: "",
      outcome: leg.outcome,
      invalidReason: "MARKET_FETCH_FAILED",
      invalidDetail: err instanceof Error ? err.message : String(err),
    };
  }

  let outcomes: string[] = [];
  let tokenIds: string[] = [];

  try {
    outcomes = JSON.parse(marketData.outcomes ?? "[]") as string[];
    tokenIds = JSON.parse(marketData.clobTokenIds ?? "[]") as string[];
  } catch {
    return {
      source: "polymarket",
      slug: leg.marketSlug,
      title: marketData.question ?? leg.marketSlug,
      tokenId: "",
      outcome: leg.outcome,
      invalidReason: "MARKET_FETCH_FAILED",
      invalidDetail: "Failed to parse outcomes or clobTokenIds from market response",
    };
  }

  // Match the requested outcome (case-insensitive)
  const outcomeIndex = outcomes.findIndex((o) => o.toLowerCase() === leg.outcome.toLowerCase());

  if (outcomeIndex === -1) {
    return {
      source: "polymarket",
      slug: leg.marketSlug,
      title: marketData.question ?? leg.marketSlug,
      tokenId: "",
      outcome: leg.outcome,
      invalidReason: "OUTCOME_NOT_FOUND",
      invalidDetail: `Outcome "${leg.outcome}" not found. Available: [${outcomes.join(", ")}]`,
    };
  }

  const tokenId = tokenIds[outcomeIndex];
  if (!tokenId) {
    return {
      source: "polymarket",
      slug: leg.marketSlug,
      title: marketData.question ?? leg.marketSlug,
      tokenId: "",
      outcome: leg.outcome,
      invalidReason: "OUTCOME_NOT_FOUND",
      invalidDetail: `No token ID found at index ${outcomeIndex} for outcome "${leg.outcome}"`,
    };
  }

  return {
    source: "polymarket",
    slug: leg.marketSlug,
    title: marketData.question ?? leg.marketSlug,
    tokenId,
    outcome: outcomes[outcomeIndex],
  };
}

async function fetchKalshiMarket(leg: ParlayLegInput): Promise<KalshiMarketResolved> {
  const normalisedOutcome = leg.outcome.toLowerCase();
  if (normalisedOutcome !== "yes" && normalisedOutcome !== "no") {
    return {
      source: "kalshi",
      ticker: leg.marketSlug,
      title: "Unknown",
      outcome: "yes",
      invalidReason: "INVALID_KALSHI_OUTCOME",
      invalidDetail: `Kalshi outcome must be "yes" or "no", got "${leg.outcome}"`,
    };
  }

  let marketData: KalshiMarketResponse;

  try {
    marketData = await withRetry(
      async () => {
        const res = await fetch(`${KALSHI_BASE}/markets/${encodeURIComponent(leg.marketSlug)}`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return res.json() as Promise<KalshiMarketResponse>;
      },
      { maxRetries: 2, initialDelay: 1000 },
      `Kalshi market fetch for ticker "${leg.marketSlug}"`,
    );
  } catch (err) {
    return {
      source: "kalshi",
      ticker: leg.marketSlug,
      title: "Unknown",
      outcome: normalisedOutcome as "yes" | "no",
      invalidReason: "MARKET_FETCH_FAILED",
      invalidDetail: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    source: "kalshi",
    ticker: marketData.market.ticker,
    title: marketData.market.title,
    outcome: normalisedOutcome as "yes" | "no",
  };
}

async function fetchPolymarketPrices(tokenIds: string[]): Promise<Map<string, number | null>> {
  const priceMap = new Map<string, number | null>(tokenIds.map((id) => [id, null]));

  if (tokenIds.length === 0) return priceMap;

  const body = tokenIds.map((token_id) => ({ token_id, side: "SELL" as const }));

  let response: PolymarketPricesResponse;

  try {
    response = await withRetry(
      async () => {
        const res = await fetch(`${POLYMARKET_CLOB_BASE}/prices`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return res.json() as Promise<PolymarketPricesResponse>;
      },
      { maxRetries: 2, initialDelay: 1000 },
      `Polymarket batch price fetch for ${tokenIds.length} token(s)`,
    );
  } catch (e) {
    console.error("Polymarket price fetch failed:", e);
    return priceMap;
  }

  for (const tokenId of tokenIds) {
    const tokenPrices = response[tokenId];
    if (tokenPrices?.SELL !== undefined) {
      priceMap.set(tokenId, tokenPrices.SELL);
    }
  }

  return priceMap;
}

async function fetchKalshiPrice(
  ticker: string,
  outcome: "yes" | "no",
): Promise<{ price: number | null; invalidReason?: InvalidReason; invalidDetail?: string }> {
  let orderbookData: KalshiOrderbookResponse;

  try {
    orderbookData = await withRetry(
      async () => {
        const res = await fetch(`${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}/orderbook`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return res.json() as Promise<KalshiOrderbookResponse>;
      },
      { maxRetries: 2, initialDelay: 1000 },
      `Kalshi orderbook fetch for ticker "${ticker}"`,
    );
  } catch (err) {
    return {
      price: null,
      invalidReason: "PRICE_FETCH_FAILED",
      invalidDetail: err instanceof Error ? err.message : String(err),
    };
  }

  const noDollars = orderbookData.orderbook_fp?.no_dollars;
  const yesDollars = orderbookData.orderbook_fp?.yes_dollars;

  if (!noDollars || noDollars.length === 0 || !yesDollars || yesDollars.length === 0) {
    return {
      price: null,
      invalidReason: "EMPTY_ORDERBOOK",
      invalidDetail: `orderbook is empty for ticker "${ticker}"`,
    };
  }

  const priceArray = (outcome == "yes" ? noDollars : yesDollars) ?? [];
  const lastBid = priceArray[priceArray.length - 1];
  const outcomePriceDollars = parseFloat(String(lastBid[0]));

  if (isNaN(outcomePriceDollars)) {
    return {
      price: null,
      invalidReason: "PRICE_FETCH_FAILED",
      invalidDetail: `Could not parse price "${lastBid[0]}" for ticker "${ticker}"`,
    };
  }

  const usePrice = 1 - outcomePriceDollars;

  return { price: usePrice };
}

export async function calculateParlayOdds(input: ParlayInput): Promise<ParlayResult> {
  const { legs: legInputs, betAmount } = input;

  const marketDetails: MarketResolved[] = await Promise.all(
    legInputs.map((leg) =>
      leg.source === "polymarket" ? fetchPolymarketMarket(leg) : fetchKalshiMarket(leg),
    ),
  );
  console.log(marketDetails);
  const polyLegs = marketDetails.filter(
    (m): m is PolymarketMarketResolved =>
      m.source === "polymarket" && !m.invalidReason && m.tokenId !== "",
  );

  console.log(
    "Polymarket legs:",
    polyLegs.map((m) => m.title),
  );

  const polyTokenIds = polyLegs.map((m) => m.tokenId);
  const polyPriceMap = await fetchPolymarketPrices(polyTokenIds);

  console.log("Polymarket price map:", Array.from(polyPriceMap.entries()));

  const kalshiLegs = marketDetails.filter(
    (m): m is KalshiMarketResolved => m.source === "kalshi" && !m.invalidReason,
  );

  console.log(
    "Kalshi legs:",
    kalshiLegs.map((m) => m.title),
  );

  const kalshiPriceResults = await Promise.all(
    kalshiLegs.map(async (m) => ({
      ticker: m.ticker,
      ...(await fetchKalshiPrice(m.ticker, m.outcome)),
    })),
  );

  const kalshiPriceMap = new Map<
    string,
    { price: number | null; invalidReason?: InvalidReason; invalidDetail?: string }
  >(kalshiPriceResults.map((r) => [r.ticker, r]));

  console.log("Kalshi price map:", Array.from(kalshiPriceMap.entries()));

  let allLegsValid = true;
  const resolvedLegs: ResolvedLeg[] = marketDetails.map((market) => {
    // Market-level error (fetch failed, bad slug, bad outcome, etc.)
    if (market.invalidReason) {
      allLegsValid = false;

      const marketId = market.source === "polymarket" ? market.slug : market.ticker;

      return {
        marketId,
        title: market.title,
        source: market.source,
        outcome: market.outcome,
        yesPrice: null,
        impliedProb: null,
        invalidReason: market.invalidReason,
        invalidDetail: market.invalidDetail,
      };
    }

    if (market.source === "polymarket") {
      const price = polyPriceMap.get(market.tokenId) ?? null;
      const priceValid = price !== null;

      if (!priceValid) allLegsValid = false;

      return {
        marketId: market.tokenId,
        title: market.title,
        source: "polymarket",
        outcome: market.outcome,
        yesPrice: price,
        impliedProb: price,
        ...(priceValid
          ? {}
          : {
              invalidReason: "PRICE_FETCH_FAILED" as InvalidReason,
              invalidDetail: `No SELL price returned for token "${market.tokenId}"`,
            }),
      };
    }

    // Kalshi
    const kalshiResult = kalshiPriceMap.get(market.ticker);
    const price = kalshiResult?.price ?? null;
    const priceValid = price !== null;

    if (!priceValid) allLegsValid = false;

    return {
      marketId: market.ticker,
      title: market.title,
      source: "kalshi",
      outcome: market.outcome,
      yesPrice: price,
      impliedProb: price,
      ...(priceValid
        ? {}
        : {
            invalidReason: kalshiResult?.invalidReason ?? ("PRICE_FETCH_FAILED" as InvalidReason),
            invalidDetail:
              kalshiResult?.invalidDetail ?? `No price returned for ticker "${market.ticker}"`,
          }),
    };
  });

  let combinedProb: number | undefined;
  let combinedDecimalOdds: number | undefined;

  if (allLegsValid && resolvedLegs.every((leg) => leg.impliedProb !== null)) {
    combinedProb = resolvedLegs.reduce((acc, leg) => acc * (leg.impliedProb as number), 1);
    combinedDecimalOdds = combinedProb > 0 ? 1 / combinedProb : undefined;
  }

  let netAmount: number | undefined;
  let potentialPayout: number | undefined;

  if (combinedDecimalOdds !== undefined) {
    // 15% fee deducted: betAmount × (10000 − 1500) / 10000
    netAmount = (betAmount * (FEE_DENOMINATOR - FEE_BIPS)) / FEE_DENOMINATOR;
    // Round to 3 decimal places
    potentialPayout = Math.round(netAmount * combinedDecimalOdds * 1000) / 1000;
  }

  console.log({
    legs: resolvedLegs,
    combinedProb,
    combinedDecimalOdds,
    betAmount,
    netAmount,
    potentialPayout,
  });

  return {
    legs: resolvedLegs,
    combinedProb,
    combinedDecimalOdds,
    betAmount,
    netAmount,
    potentialPayout,
  };
}

export function validateParlayInput(body: unknown): {
  data: ValidatedInput | null;
  errors: ValidationError[];
} {
  const errors: ValidationError[] = [];

  // Must be a plain object
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      data: null,
      errors: [{ field: "body", message: "Request body must be a JSON object" }],
    };
  }

  const raw = body as Record<string, unknown>;

  // ── betAmount ──────────────────────────────────────────────────────────────
  if (!("betAmount" in raw)) {
    errors.push({ field: "betAmount", message: "betAmount is required" });
  } else if (typeof raw.betAmount !== "number" || isNaN(raw.betAmount)) {
    errors.push({ field: "betAmount", message: "betAmount must be a number" });
  } else if (!isFinite(raw.betAmount)) {
    errors.push({ field: "betAmount", message: "betAmount must be a finite number" });
  } else if (raw.betAmount < MIN_BET_AMOUNT) {
    errors.push({
      field: "betAmount",
      message: `betAmount must be at least ${MIN_BET_AMOUNT}`,
    });
  } else if (raw.betAmount > MAX_BET_AMOUNT) {
    errors.push({
      field: "betAmount",
      message: `betAmount must not exceed ${MAX_BET_AMOUNT}`,
    });
  }

  // ── legs ───────────────────────────────────────────────────────────────────
  if (!("legs" in raw)) {
    errors.push({ field: "legs", message: "legs is required" });
  } else if (!Array.isArray(raw.legs)) {
    errors.push({ field: "legs", message: "legs must be an array" });
  } else if (raw.legs.length < MIN_LEGS) {
    errors.push({
      field: "legs",
      message: `A parlay requires at least ${MIN_LEGS} legs`,
    });
  } else if (raw.legs.length > MAX_LEGS) {
    errors.push({
      field: "legs",
      message: `A parlay may have at most ${MAX_LEGS} legs`,
    });
  } else {
    // Validate each leg
    (raw.legs as unknown[]).forEach((leg, i) => {
      const prefix = `legs[${i}]`;

      if (typeof leg !== "object" || leg === null || Array.isArray(leg)) {
        errors.push({ field: prefix, message: "Each leg must be a JSON object" });
        return;
      }

      const l = leg as Record<string, unknown>;

      // source
      if (!("source" in l)) {
        errors.push({ field: `${prefix}.source`, message: "source is required" });
      } else if (!VALID_SOURCES.includes(l.source as LegSource)) {
        errors.push({
          field: `${prefix}.source`,
          message: `source must be one of: ${VALID_SOURCES.join(", ")}`,
        });
      }

      // marketSlug
      if (!("marketSlug" in l)) {
        errors.push({
          field: `${prefix}.marketSlug`,
          message: "marketSlug is required",
        });
      } else if (typeof l.marketSlug !== "string") {
        errors.push({
          field: `${prefix}.marketSlug`,
          message: "marketSlug must be a string",
        });
      } else if (l.marketSlug.trim() === "") {
        errors.push({
          field: `${prefix}.marketSlug`,
          message: "marketSlug must not be empty",
        });
      }

      // outcome
      if (!("outcome" in l)) {
        errors.push({ field: `${prefix}.outcome`, message: "outcome is required" });
      } else if (typeof l.outcome !== "string") {
        errors.push({
          field: `${prefix}.outcome`,
          message: "outcome must be a string",
        });
      } else if (l.outcome.trim() === "") {
        errors.push({
          field: `${prefix}.outcome`,
          message: "outcome must not be empty",
        });
      }
    });

    // Check for duplicate legs (same source + marketSlug + outcome)
    const seen = new Set<string>();
    (raw.legs as unknown[]).forEach((leg, i) => {
      if (typeof leg !== "object" || leg === null) return;
      const l = leg as Record<string, unknown>;
      const key = `${l.source}::${String(l.marketSlug).toLowerCase()}::${String(l.outcome).toLowerCase()}`;
      if (seen.has(key)) {
        errors.push({
          field: `legs[${i}]`,
          message: `Duplicate leg: source="${l.source}", marketSlug="${l.marketSlug}", outcome="${l.outcome}"`,
        });
      }
      seen.add(key);
    });
  }

  if (errors.length > 0) {
    return { data: null, errors };
  }

  // Safe to cast — all fields validated above
  const validLegs = (raw.legs as Record<string, unknown>[]).map((l) => ({
    source: l.source as LegSource,
    marketSlug: (l.marketSlug as string).trim(),
    outcome: (l.outcome as string).trim(),
  }));

  return {
    data: {
      legs: validLegs,
      betAmount: raw.betAmount as number,
    },
    errors: [],
  };
}
