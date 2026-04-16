import {
  ApprovedParlay,
  EnrichedPineconeMarketHit,
  NormalizedMarket,
  PineconeMarketHit,
  PolymarketMarket,
  RejectedParlay,
  RetryConfig,
  TwitterAPITweet,
} from "./types";
import connectDatabase from "./db";
import { Request as RequestModel } from "./models/Request";
import { Market } from "./models/Market";
import OpenAI from "openai";
import { Index, RecordMetadata } from "@pinecone-database/pinecone";

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  context: string = "operation",
): Promise<T> {
  const { maxRetries = 3, initialDelay = 1000, maxDelay = 10000, backoffMultiplier = 2 } = config;

  let lastError: Error | null = null;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log("Attempt ", attempt);
      return await fn();
    } catch (error: any) {
      lastError = error;

      if (attempt === maxRetries) {
        console.error(`${context} failed after ${maxRetries + 1} attempts:`, error);
        break;
      }

      // Don't retry on 4xx errors (except 429)
      if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
        console.error(`${context} failed with ${error.status}, not retrying`);
        throw error;
      }

      console.warn(
        `${context} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`,
        error.message,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError || new Error(`${context} failed after retries`);
}

export function safeJSON<T>(content: string): T | null {
  try {
    const cleaned = content.replace(/```json\n?|\n?```/g, "").trim();
    return JSON.parse(cleaned) as T;
  } catch (error) {
    console.error("JSON parse error:", error);
    return null;
  }
}

export function parseDateSafely(dateStr: string): Date {
  try {
    return new Date(dateStr);
  } catch {
    return new Date();
  }
}

export async function saveRequestMarkets(requestId: string, marketIds: string[]): Promise<void> {
  try {
    await connectDatabase();

    await RequestModel.findOneAndUpdate(
      { requestId },
      {
        $set: { markets: marketIds, updatedAt: new Date() },
        $setOnInsert: { status: "pending", createdAt: new Date() },
      },
      { upsert: true, new: true },
    );

    console.log(`Saved ${marketIds.length} markets for request ${requestId}`);
    console.log("Db ingestion done");
  } catch (error) {
    console.error("Failed to save request to database:", error);
  }
}

/**
 * Fetch current YES prices from Polymarket Gamma API for given market IDs.
 * Returns a map of marketId -> yesPrice (0-1 probability)
 */
/**
 * Parse a field that may be a JSON string or already an array/object.
 */
function parseJsonField(x: any): any {
  if (!x) return null;
  if (Array.isArray(x) || typeof x === "object") return x;
  try {
    return JSON.parse(x);
  } catch {
    return null;
  }
}

/**
 * Extract the YES outcome's CLOB token ID and fallback price from a Gamma market object.
 * Gamma returns outcomes/outcomePrices/clobTokenIds as JSON strings or arrays.
 */
function extractYesData(market: any): { yesTokenId: string | null; yesFallback: number | null } {
  const outs: any[] | null = parseJsonField(market.outcomes);
  const prices: any[] | null = parseJsonField(market.outcomePrices);
  const tokenIds: any[] | null = parseJsonField(market.clobTokenIds);

  if (!Array.isArray(outs)) return { yesTokenId: null, yesFallback: null };

  const iYes = outs.findIndex((o: any) => String(o).toLowerCase() === "yes");
  if (iYes === -1) return { yesTokenId: null, yesFallback: null };

  const yesTokenId = Array.isArray(tokenIds) && tokenIds[iYes] ? String(tokenIds[iYes]) : null;
  const yesFallback = Array.isArray(prices) && prices[iYes] != null ? Number(prices[iYes]) : null;

  return { yesTokenId, yesFallback };
}

/**
 * Fetch live YES price from the Polymarket CLOB for a given token ID.
 */
async function fetchClobPrice(tokenId: string): Promise<number | null> {
  try {
    const url = `https://clob.polymarket.com/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    const p = Number(j.price);
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Score how well a market question matches a search query (token overlap).
 */
function scoreQuestion(query: string, title: string): number {
  const stop = new Set(["will", "be", "the", "a", "an", "to", "of", "in", "on", "by", "for"]);
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const tok = (s: string) =>
    norm(s)
      .split(" ")
      .filter(Boolean)
      .filter((w) => !stop.has(w));
  const a = tok(query);
  const b = new Set(tok(title));
  if (!a.length) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.length;
}

/**
 * Search Gamma public-search endpoint by question text and return top market candidates.
 */
async function searchGammaByQuestion(question: string): Promise<any[]> {
  const url =
    `https://gamma-api.polymarket.com/public-search` +
    `?q=${encodeURIComponent(question)}` +
    `&events_status=active` +
    `&keep_closed_markets=0` +
    `&limit_per_type=20` +
    `&sort=volume24hr` +
    `&ascending=false`;

  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`public-search failed: ${r.status}`);
  const res = (await r.json()) as any;

  // Flatten markets from events
  const markets: any[] = [];
  for (const ev of res.events || []) {
    for (const m of ev.markets || []) markets.push(m);
  }
  return markets;
}

export async function fetchPolymarketPrices(
  markets: { id: string; question: string }[],
): Promise<Map<string, { yesPrice: number; title: string }>> {
  const priceMap = new Map<string, { yesPrice: number; title: string }>();

  // Process each market individually — search by question text (same as test script)
  await Promise.all(
    markets.map(async ({ id, question }) => {
      try {
        console.log(`  🔍 Searching: ${question}`);
        const candidates = await searchGammaByQuestion(question);

        if (!candidates.length) {
          console.warn(`  ✗ ${id}: no Gamma results for "${question}"`);
          return;
        }

        // Pick best match by token overlap (same scoring as test script)
        const scored = candidates
          .map((m: any) => ({ m, s: scoreQuestion(question, m.question || m.title || "") }))
          .sort((a: any, b: any) => b.s - a.s);

        const best = scored[0];
        if (!best || best.s < 0.2) {
          console.warn(`  ✗ ${id}: best match score ${best?.s.toFixed(3) ?? "n/a"} too low`);
          return;
        }

        const gammaMarket = best.m;
        console.log(
          `  → matched: ${gammaMarket.question || gammaMarket.title} (score=${best.s.toFixed(3)})`,
        );

        // Extract YES token + fallback price
        const { yesTokenId, yesFallback } = extractYesData(gammaMarket);

        let yesPrice: number | null = null;

        // Try live CLOB price first
        if (yesTokenId) {
          yesPrice = await fetchClobPrice(yesTokenId);
        }

        // Fall back to Gamma outcomePrices
        if (yesPrice === null && yesFallback !== null) {
          yesPrice = yesFallback;
        }

        if (yesPrice !== null && yesPrice > 0) {
          priceMap.set(id, {
            yesPrice,
            title: gammaMarket.question || gammaMarket.title || question,
          });
          console.log(
            `  ✓ ${id} → YES=${(yesPrice * 100).toFixed(1)}% (${yesTokenId && yesPrice !== yesFallback ? "CLOB" : "fallback"})`,
          );
        } else {
          console.warn(`  ✗ ${id}: no valid YES price`);
        }
      } catch (err: any) {
        console.error(`  ✗ ${id}: error – ${err.message}`);
      }
    }),
  );

  return priceMap;
}

export async function saveParlayResults(
  requestId: string,
  approvedParlays: ApprovedParlay[],
  rejectedParlays: RejectedParlay[],
): Promise<void> {
  try {
    await connectDatabase();

    await RequestModel.findOneAndUpdate(
      { requestId },
      {
        $set: {
          result: {
            approvedParlays,
            rejectedParlays,
            timestamp: new Date().toISOString(),
          },
          updatedAt: new Date(),
        },
      },
    );

    console.log(
      `\n✓ Saved ${approvedParlays.length} approved parlays to database for request ${requestId}`,
    );
  } catch (error) {
    console.error("Failed to save parlay results to database:", error);
    throw error;
  }
}

export async function fetchMarketObjects(
  marketHits: PineconeMarketHit[],
): Promise<EnrichedPineconeMarketHit[]> {
  if (marketHits.length === 0) return [];

  try {
    await connectDatabase();

    // Group market IDs by platform
    const marketsByPlatform = marketHits.reduce(
      (acc, hit) => {
        if (!acc[hit.platform]) acc[hit.platform] = [];
        acc[hit.platform].push(hit.market_id);
        return acc;
      },
      {} as Record<string, string[]>,
    );

    // Fetch all platforms in parallel
    const allMarkets: Record<string, PolymarketMarket> = {};

    await Promise.all(
      Object.entries(marketsByPlatform).map(async ([platform, ids]) => {
        const rows = await Market.find(
          { platform, id: { $in: ids } },
          { platform: 1, id: 1, raw: 1, _id: 0 },
        ).lean();

        rows.forEach((row) => {
          allMarkets[`${row.platform}:${row.id}`] = row.raw as PolymarketMarket;
        });
      }),
    );

    console.log(`Fetched ${Object.keys(allMarkets).length} market objects from database`);

    return marketHits.map((hit) => ({
      ...hit,
      fullMarketData: allMarkets[`${hit.platform}:${hit.market_id}`] ?? null,
    }));
  } catch (error) {
    console.error("Failed to fetch market objects from database:", error);
    return marketHits.map((hit) => ({ ...hit, fullMarketData: null }));
  }
}

/**
 * Hardcoded fallback: searches the markets DB table using ILIKE patterns for
 * specific entity pairs that may be missed by Pinecone embedding similarity.
 * Detected entity pairs (hardcoded for now):
 *   - Arsenal + Premier League
 *   - Bayern + Champions League
 */
// TODO: this function s very brittle and only catches a couple specific cases.
export async function fetchForcedFallbackMarkets(
  query: string,
): Promise<EnrichedPineconeMarketHit[]> {
  const q = query.toLowerCase();

  // Build up $or clauses for each entity match
  const orClauses: Record<string, unknown>[] = [];

  // Arsenal + Premier League
  if (
    q.includes("arsenal") &&
    (q.includes("premier league") || q.includes("epl") || q.includes("english premier league"))
  ) {
    orClauses.push({
      "raw.question": /Arsenal/i,
      $and: [
        { "raw.question": /Premier League|EPL|English Premier League/i },
        { "raw.question": /win/i },
      ],
    });
  }

  // Bayern + Champions League
  if (
    q.includes("bayern") &&
    (q.includes("champions league") || q.includes("ucl") || q.includes("uefa champions league"))
  ) {
    orClauses.push({
      "raw.question": /Bayern/i,
      $and: [
        { "raw.question": /Champions League|UCL|UEFA Champions League/i },
        { "raw.question": /win/i },
      ],
    });
  }

  if (orClauses.length === 0) return [];

  try {
    await connectDatabase();

    const rows = await Market.find(
      {
        platform: "polymarket",
        "raw.active": true,
        "raw.closed": false,
        $or: orClauses,
      },
      { platform: 1, id: 1, raw: 1, _id: 0 },
    )
      .limit(20)
      .lean();

    console.log(`[FORCED FALLBACK] DB matched ${rows.length} market(s) for: "${query}"`);

    return rows.map((row) => {
      const raw = row.raw as PolymarketMarket;
      return {
        market_id: String(row.id),
        platform: row.platform as "polymarket" | "kalshi",
        score: 0.99,
        metadata: {
          market_id: String(row.id),
          platform: row.platform,
          title: (raw?.question as string) || "",
          resolution_time: null,
          status: "active",
          liquidity: null,
          volume: null,
          tags: null,
        },
        fullMarketData: raw,
      };
    });
  } catch (err) {
    console.error("[FORCED FALLBACK] DB error:", err);
    return [];
  }
}

export function normalizeMarket(market: PolymarketMarket): NormalizedMarket {
  const tags = market?.tags?.map((tag) => tag.label) || [];

  const events =
    market?.events?.map((event) => ({
      title: event?.title || "",
      series: event?.series?.map((s: any) => s.title) || undefined,
      description: event?.description || "",
    })) || [];

  return {
    id: market.id,
    question: market.question,
    endDate: market.endDate,
    startDate: market.startDate,
    description: market.description || "",
    tags,
    events,
    marketType: market.sportsMarketType || "",
  };
}

export async function fetchTweetThread(
  tweetId: string,
  apiKey: string,
): Promise<TwitterAPITweet[]> {
  const allTweets: TwitterAPITweet[] = [];
  let cursor = "";
  let hasNextPage = true;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  console.log(`Fetching thread for tweet ID: ${tweetId}`);

  while (hasNextPage) {
    try {
      const params = new URLSearchParams({ tweetId });
      if (cursor) {
        params.append("cursor", cursor);
      }

      const response: any = await withRetry(
        async () => {
          const res = await fetch(
            `https://api.twitterapi.io/twitter/tweet/thread_context?${params}`,
            {
              headers: {
                "X-API-Key": apiKey,
              },
              signal: AbortSignal.timeout(30000), // 30s timeout
            },
          );

          if (!res.ok) {
            const error: any = new Error(`HTTP ${res.status}: ${res.statusText}`);
            error.status = res.status;
            throw error;
          }

          return res.json();
        },
        { maxRetries: 2, initialDelay: 2000 },
        `Twitter API (cursor: ${cursor || "initial"})`,
      );

      if (response.status === "error") {
        throw new Error(response.message || "Twitter API error");
      }

      const { tweets, has_next_page, next_cursor } = response;

      if (tweets && tweets.length > 0) {
        allTweets.push(...tweets);
        console.log(`Fetched ${tweets.length} tweets (total: ${allTweets.length})`);
        consecutiveErrors = 0;
      }

      hasNextPage = has_next_page && tweets && tweets.length > 0;
      if (allTweets.length >= 150) hasNextPage = false;
      cursor = next_cursor || "";

      if (hasNextPage) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (error: any) {
      consecutiveErrors++;

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error("Too many consecutive errors, stopping thread fetch");
        break;
      }

      if (allTweets.length > 0) {
        console.warn("Error fetching page, but continuing with existing tweets");
        break;
      } else {
        throw error;
      }
    }
  }

  if (allTweets.length === 0) {
    throw new Error("No tweets found in thread");
  }

  allTweets.sort((a, b) => {
    const engagementA = a.likeCount + a.retweetCount + a.replyCount + a.quoteCount;
    const engagementB = b.likeCount + b.retweetCount + b.replyCount + b.quoteCount;
    return engagementB - engagementA;
  });

  // Return top 100 most engaging tweets
  const topTweets = allTweets.slice(0, 100);

  console.log(`Total tweets in thread: ${allTweets.length}`);
  console.log(`Returning top ${topTweets.length} tweets by engagement`);

  return topTweets;
}

async function buildThreadQuery(openai: OpenAI, tweets: TwitterAPITweet[]): Promise<string> {
  const concatenated = tweets.map((t) => t.text).join("\n");

  // For very short threads, just return the text
  if (concatenated.length < 500 || tweets.length <= 3) {
    return concatenated;
  }

  const prompt = `You are analyzing a Twitter thread to extract key betting market topics.

THREAD (${tweets.length} tweets):
${tweets.map((t, i) => `${i + 1}. ${t.text}`).join("\n")}

YOUR TASK:
Extract the core topics, events, entities, and predictions discussed in this thread.
Focus on concrete, searchable terms that would match betting markets.

INCLUDE:
- Team names, player names, coach names
- Specific events (games, awards, drafts, trades)
- Predictions or opinions about outcomes
- Time frames mentioned (this week, playoffs, next season)
- League/sport context (NFL, NBA, etc.)

EXCLUDE:
- Generic commentary ("I think...", "IMO...")
- URLs, hashtags, mentions (@user)
- Filler words and casual language

OUTPUT FORMAT:
Return a concise search query (2-5 sentences) that captures the key topics.
Think: "What betting markets would this person be interested in?"

Example:
Thread about "Lamar Jackson's MVP chances and Ravens playoff run"
→ Query: "Lamar Jackson MVP award 2025-26 NFL season. Baltimore Ravens playoff performance and Super Bowl chances. AFC North standings and quarterback performance."

SEARCH QUERY:`;

  const response = await withRetry(
    async () =>
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a sports betting search expert. Extract key topics for market matching. Be concise and specific.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 200, // Keep it concise
      }),
    { maxRetries: 2, initialDelay: 1000 },
    "Thread query generation",
  );

  const queryText = response.choices[0].message.content?.trim() || concatenated;

  console.log("\n=== Generated Search Query ===");
  console.log(queryText);
  console.log("==============================\n");

  return queryText;
}

export async function embedQuery(openai: OpenAI, text: string): Promise<number[]> {
  const resp = await withRetry(
    () =>
      openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
      }),
    { maxRetries: 2, initialDelay: 1000 },
    "OpenAI embedding",
  );

  return resp.data[0].embedding;
}

export async function searchMarketsFromThread(
  pineconeIndex: Index<RecordMetadata>,
  openai: OpenAI,
  query: string,
  tweet: boolean,
  tweets: TwitterAPITweet[],
  topK: number = 50,
): Promise<{ pineconeMatches: PineconeMarketHit[]; queryText: string }> {
  const queryText = tweet && tweets.length > 0 ? await buildThreadQuery(openai, tweets) : query;
  console.log(queryText);
  const embedding = await embedQuery(openai, queryText);

  const nowUnix = Math.floor(Date.now() / 1000);
  console.log(nowUnix);
  const res = await withRetry(
    () =>
      pineconeIndex.query({
        vector: embedding,
        topK: topK * 3,
        includeMetadata: true,
        filter: {
          status: { $eq: "active" },
          platform: { $eq: "polymarket" },
          resolution_time: { $gt: nowUnix },
          liquidity: { $gt: 0 },
          volume: { $gt: 0 },
          is_mve: { $eq: false },
        },
      }),
    { maxRetries: 2, initialDelay: 1000 },
    "Pinecone search",
  );

  return {
    pineconeMatches: (res.matches || []).map((m: any) => ({
      market_id: m.metadata.market_id,
      platform: m.metadata.platform,
      score: m.score ?? 0,
      metadata: m.metadata,
    })),
    queryText,
  };
}

export function deduplicateByEvent(
  markets: EnrichedPineconeMarketHit[],
  maxPerEvent: number,
  query: string,
): EnrichedPineconeMarketHit[] {
  const eventGroups = new Map<string, PineconeMarketHit[]>();

  // Group by event title (assuming it's in metadata)
  for (const market of markets) {
    // Extract event identifier - adjust based on your metadata structure
    const eventKey = market.fullMarketData?.events?.[0]?.title || market.market_id; // Fallback to market_id if no event

    if (!eventGroups.has(eventKey)) {
      eventGroups.set(eventKey, []);
    }
    eventGroups.get(eventKey)!.push(market);
  }

  // For each event, keep top N by liquidity
  const results: EnrichedPineconeMarketHit[] = [];

  for (const eventMarkets of eventGroups.values()) {
    // Sort by liquidity (descending)
    const sorted = eventMarkets.sort(
      (a, b) => (b.metadata.liquidity || 0) - (a.metadata.liquidity || 0),
    );

    const queryTerms = query.toLowerCase().split(/\s+/);

    const relevantMissing = sorted.slice(maxPerEvent).filter((market) => {
      const marketText = (market.metadata.title || "").toLowerCase();
      const matchScore = queryTerms.filter(
        (term) => term.length > 3 && marketText.includes(term),
      ).length;
      return matchScore >= 3;
    });
    // console.log("relevant missing", relevantMissing.map(m => m.metadata.title));
    // Take top N
    results.push(...sorted.slice(0, maxPerEvent), ...relevantMissing);
  }

  // Re-sort by original relevance score
  return results.sort((a, b) => (b.score || 0) - (a.score || 0));
}
