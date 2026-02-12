import {
  ApprovedParlay,
  EnrichedPineconeMarketHit,
  NormalizedMarket,
  PineconeMarketHit,
  PolymarketMarket,
  RejectedParlay,
  RetryConfig,
  TwitterAPITweet,
} from "./parlay-types";
import { Pool } from "pg";
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

export function getDbPool(): Pool {
  const dbUrl = process.env.PARLAY_DATABASE_URL;

  if (!dbUrl) {
    throw new Error("PARLAY_DATABASE_URL not set");
  }

  let connectionString = dbUrl;

  if (dbUrl.includes("#") || (dbUrl.includes("@") && !dbUrl.startsWith("postgres://"))) {
    try {
      const match = dbUrl.match(/postgresql:\/\/([^:]+):([^@]+)@(.+)/);
      if (match) {
        const [, user, password, rest] = match;
        const encodedPassword = encodeURIComponent(password);
        connectionString = `postgresql://${user}:${encodedPassword}@${rest}`;
      }
    } catch (e) {
      console.warn("Failed to parse PARLAY_DATABASE_URL, using as-is:", e);
    }
  }

  return new Pool({
    connectionString,
    ssl: {
      rejectUnauthorized: false,
    },
  });
}

export async function saveRequestMarkets(requestId: string, marketIds: string[]): Promise<void> {
  try {
    const pool = getDbPool();

    await withRetry(
      async () => {
        const client = await pool.connect();
        try {
          await client.query(
            `
              INSERT INTO requests (request_id, markets, created_at, updated_at)
              VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
              ON CONFLICT (request_id) 
              DO UPDATE SET 
                markets = EXCLUDED.markets,
                updated_at = CURRENT_TIMESTAMP
              `,
            [requestId, marketIds],
          );
          console.log(`Saved ${marketIds.length} markets for request ${requestId}`);
        } finally {
          client.release();
        }
      },
      { maxRetries: 2, initialDelay: 1000 },
      `Database save for request ${requestId}`,
    );
    console.log("Db ingestion done");
    await pool.end();
  } catch (error) {
    console.error("Failed to save request to database:", error);
  }
}

export async function saveParlayResults(
  requestId: string,
  approvedParlays: ApprovedParlay[],
  rejectedParlays: RejectedParlay[],
): Promise<void> {
  const pool = getDbPool();

  try {
    await withRetry(
      async () => {
        const client = await pool.connect();
        try {
          await client.query(
            `
              UPDATE requests
              SET result = $1, updated_at = CURRENT_TIMESTAMP
              WHERE request_id = $2
              `,
            [
              JSON.stringify({
                approvedParlays,
                rejectedParlays,
                timestamp: new Date().toISOString(),
              }),
              requestId,
            ],
          );
          console.log(
            `\n✓ Saved ${approvedParlays.length} approved parlays to database for request ${requestId}`,
          );
        } finally {
          client.release();
        }
      },
      { maxRetries: 2, initialDelay: 1000 },
      `Database save for parlay results ${requestId}`,
    );
  } catch (error) {
    console.error("Failed to save parlay results to database:", error);
    throw error;
  } finally {
    await pool.end();
  }
}

export async function fetchMarketObjects(
  marketHits: PineconeMarketHit[],
): Promise<EnrichedPineconeMarketHit[]> {
  if (marketHits.length === 0) {
    return [];
  }

  try {
    const pool = getDbPool();

    const enrichedMarkets = await withRetry(
      async () => {
        const client = await pool.connect();
        try {
          // Group markets by platform for efficient querying
          const marketsByPlatform = marketHits.reduce(
            (acc, hit) => {
              if (!acc[hit.platform]) {
                acc[hit.platform] = [];
              }
              acc[hit.platform].push(hit.market_id);
              return acc;
            },
            {} as Record<string, string[]>,
          );

          // Fetch all markets in parallel
          const allMarkets: Record<string, PolymarketMarket> = {};

          await Promise.all(
            Object.entries(marketsByPlatform).map(async ([platform, ids]) => {
              const result = await client.query(
                `SELECT platform, id, raw 
                   FROM markets 
                   WHERE platform = $1 AND id = ANY($2)`,
                [platform, ids],
              );

              result.rows.forEach((row) => {
                const key = `${row.platform}:${row.id}`;
                allMarkets[key] = row.raw as PolymarketMarket;
              });
            }),
          );

          console.log(`Fetched ${Object.keys(allMarkets).length} market objects from database`);

          // Enrich the hits with full market data
          return marketHits.map((hit) => {
            const key = `${hit.platform}:${hit.market_id}`;
            return {
              ...hit,
              fullMarketData: allMarkets[key] || null,
            };
          });
        } finally {
          client.release();
        }
      },
      { maxRetries: 2, initialDelay: 1000 },
      "Database fetch for market objects",
    );

    await pool.end();
    return enrichedMarkets;
  } catch (error) {
    console.error("Failed to fetch market objects from database:", error);
    // Return original hits without enrichment on error
    return marketHits.map((hit) => ({ ...hit, fullMarketData: null }));
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

      const response = await withRetry(
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
  tweets: TwitterAPITweet[],
  topK: number = 50,
): Promise<{ pineconeMatches: PineconeMarketHit[]; queryText: string }> {
  const queryText = await buildThreadQuery(openai, tweets);
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
          resolution_time: { $gt: nowUnix },
          liquidity: { $gt: 0 },
          volume: { $gt: 0 },
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

    // Take top N
    results.push(...sorted.slice(0, maxPerEvent));
  }

  // Re-sort by original relevance score
  return results.sort((a, b) => (b.score || 0) - (a.score || 0));
}
