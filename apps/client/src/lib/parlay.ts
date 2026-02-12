import OpenAI from "openai";
import {
  AnalyzeThreadConfig,
  AnalyzeThreadResult,
  ApprovedParlay,
  GenerateParlaysConfig,
  GenerateParlaysResult,
  NormalizedMarket,
  ParlayCandidate,
  RejectedParlay,
  Stage1Output,
  Stage2Output,
  Stage3Output,
  TweetThread,
} from "./parlay-types";
import {
  deduplicateByEvent,
  fetchMarketObjects,
  fetchTweetThread,
  normalizeMarket,
  safeJSON,
  saveParlayResults,
  saveRequestMarkets,
  searchMarketsFromThread,
  withRetry,
} from "./parlay-utils";
import { Pinecone } from "@pinecone-database/pinecone";

export async function stage1MarketFilter(
  openai: OpenAI,
  thread: TweetThread,
  markets: NormalizedMarket[],
): Promise<Stage1Output> {
  console.log("\n=== STAGE 1: Market Relevance Filter ===");
  console.log(`Filtering ${markets.length} markets to top 20`);

  // Group markets by event title first
  const eventGroups = new Map<string, NormalizedMarket[]>();
  markets.forEach((m) => {
    const eventTitle = m.events[0]?.title || "Unknown Event";
    if (!eventGroups.has(eventTitle)) {
      eventGroups.set(eventTitle, []);
    }
    eventGroups.get(eventTitle)!.push(m);
  });

  const prompt = `You are selecting 20 markets for YES-betting parlays.
  
  CRITICAL CONSTRAINT: We will bet YES on every market in our parlays, so we MUST select markets from DIFFERENT events.
  
  UNDERSTANDING MULTIVARIATE EVENTS:
  Many betting platforms create multiple markets for the SAME underlying event with different candidates/outcomes:
  
  Example:
  Event: "Next Arizona Cardinals Head Coach?"
  ├─ Market 1: "Will John Harbaugh be the next Cardinals coach?" 
  ├─ Market 2: "Will Mike McDaniel be the next Cardinals coach?"
  └─ Market 3: "Will Chris Shula be the next Cardinals coach?"
  
  These markets share the SAME event title and are MUTUALLY EXCLUSIVE - only ONE can resolve to YES.
  Since we're betting YES on all parlay legs, we can NEVER combine markets from the same event.
  
  THREAD CONTEXT:
  Author: ${thread.author} (@${thread.authorHandle})
  
  THREAD TEXT:
  ${thread.text}
  
  AVAILABLE EVENT GROUPS:
  ${Array.from(eventGroups.entries())
    .map(
      ([eventTitle, markets], i) => `
  Event Group ${i + 1}: "${eventTitle}"
  Number of markets: ${markets.length}
  Sample markets:
  ${markets
    .slice(0, 3)
    .map((m) => `  - ${m.question}`)
    .join("\n")}
  ${markets.length > 3 ? `  ... and ${markets.length - 3} more` : ""}
  `,
    )
    .join("\n")}
  
  ALL MARKETS (for reference):
  ${markets
    .map(
      (m, i) => `
  ${i + 1}. ID: ${m.id}
     Question: ${m.question}
     Event: ${m.events[0]?.title || "N/A"}
     Tags: ${m.tags.join(", ")}
  `,
    )
    .join("\n")}
  
  YOUR TASK:
  Select EXACTLY 20 markets following this process:
  
  STEP 1: Identify event groups (already shown above)
  STEP 2: Select AT MOST 1 market from each event group
  STEP 3: Prioritize events relevant to the thread
  STEP 4: Fill remaining slots with diverse events
  
  VALIDATION CHECKLIST (before outputting):
  □ Do I have exactly 20 market IDs?
  □ Does each market have a DIFFERENT event title?
  □ Are the markets relevant to the thread topic?
  
  OUTPUT FORMAT (strict JSON only):
  {
    "reasoning": {
      "step1_eventGroups": "I identified X unique event groups",
      "step2_selection": "I selected 1 market from each of these events: ...",
      "step3_validation": "I verified no duplicate event titles"
    },
    "selectedMarketIds": ["id1", "id2", ..., "id20"]
  }`;

  const response = await withRetry(
    async () =>
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a sports betting analyst. You MUST select markets from different events. Show your reasoning step-by-step. Return only valid JSON.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1, // Lower temperature for more consistent logic
        response_format: { type: "json_object" },
      }),
    { maxRetries: 3, initialDelay: 2000 },
    "Stage 1 - Market Filter",
  );

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("Stage 1: Empty response from OpenAI");
  }

  const parsed = safeJSON<Stage1Output & { reasoning?: any }>(content);

  // Validation: Check for duplicate event titles
  if (parsed?.selectedMarketIds) {
    parsed.selectedMarketIds = parsed.selectedMarketIds.map(String);
    console.log("sasi", parsed.selectedMarketIds);
    const selectedMarkets = markets.filter((m) => parsed.selectedMarketIds.includes(m.id));

    const eventTitles = selectedMarkets.map((m) => m.events[0]?.title);
    const uniqueEventTitles = new Set(eventTitles);

    if (uniqueEventTitles.size !== selectedMarkets.length) {
      console.warn(
        `⚠️  Stage 1 violation: Selected ${selectedMarkets.length} markets but only ${uniqueEventTitles.size} unique events`,
      );
      console.warn(
        "Duplicate events found:",
        eventTitles.filter((title, i) => eventTitles.indexOf(title) !== i),
      );

      // Fallback: Manually deduplicate
      const deduped: string[] = [];
      const seenEvents = new Set<string>();

      for (const market of markets) {
        const eventTitle = market.events[0]?.title || "Unknown";
        if (!seenEvents.has(eventTitle) && deduped.length < 20) {
          seenEvents.add(eventTitle);
          deduped.push(market.id);
        }
      }

      console.log(`✓ Fallback applied: Selected ${deduped.length} markets from unique events`);
      return { selectedMarketIds: deduped };
    }
  }

  console.log(
    `✓ Stage 1 complete: Selected ${
      parsed?.selectedMarketIds?.length || 0
    } markets from unique events`,
  );

  return { selectedMarketIds: parsed?.selectedMarketIds || [] };
}

export async function stage2ParlayGenerator(
  openai: OpenAI,
  thread: TweetThread,
  markets: NormalizedMarket[],
): Promise<Stage2Output> {
  console.log("\n=== STAGE 2: Parlay Generator ===");
  console.log(`Generating parlays from ${markets.length} markets`);

  // Pre-group markets by event
  const eventGroups = new Map<string, NormalizedMarket[]>();
  markets.forEach((m) => {
    const eventTitle = m.events[0]?.title || `standalone_${m.id}`;
    if (!eventGroups.has(eventTitle)) {
      eventGroups.set(eventTitle, []);
    }
    eventGroups.get(eventTitle)!.push(m);
  });

  const prompt = `You are generating 2-leg and 3-leg parlays where we bet YES on all legs.
  
  CORE VALIDITY PRINCIPLE:
  A parlay is valid if and only if ALL possible outcome combinations are logically possible.
  
  For a 2-leg parlay (Leg A, Leg B):
  - A=YES, B=YES → Must be possible ✓
  - A=YES, B=NO  → Must be possible ✓
  - A=NO,  B=YES → Must be possible ✓
  - A=NO,  B=NO  → Must be possible ✓
  
  For a 3-leg parlay, all 8 combinations must be possible.
  
  MULTIVARIATE MARKETS EXPLAINED:
  Some events have multiple markets representing different outcomes:
  
  Event: "NBA MVP 2025-26"
  ├─ Market A: "Will SGA win MVP?" 
  ├─ Market B: "Will Ant-man win MVP?"
  └─ Market C: "Will Jokic win MVP?"
  
  These are MUTUALLY EXCLUSIVE - only ONE player can win MVP.
  
  CRITICAL RULE:
  ❌ NEVER combine markets from the SAME multivariate event when betting YES on both
     Example: "SGA wins MVP (YES)" + "Ant-man wins MVP (YES)" 
     → Violates truth table: Both YES is IMPOSSIBLE
  
  ✅ ALWAYS combine markets from DIFFERENT events
     Example: "SGA wins MVP (YES)" + "Ant-man wins scoring title (YES)"
     → All 4 outcomes possible
  
  THREAD CONTEXT:
  Author: ${thread.author} (@${thread.authorHandle})
  
  THREAD TEXT:
  ${thread.text}
  
  EVENT GROUPS (markets from same event are mutually exclusive):
  ${Array.from(eventGroups.entries())
    .map(
      ([eventTitle, eventMarkets], i) => `
  Event ${i + 1}: "${eventTitle}"
  Markets in this event:
  ${eventMarkets.map((m) => `  - ${m.id}: ${m.question}`).join("\n")}
  `,
    )
    .join("\n")}
  
  ALL MARKETS:
  ${markets
    .map(
      (m, i) => `
  Market ${i + 1}:
  ID: ${m.id}
  Question: ${m.question}
  Description: ${m.description}
  Event: ${m.events[0]?.title || "N/A"}
  Tags: ${m.tags.join(", ")}
  End Date: ${m.endDate}
  `,
    )
    .join("\n---\n")}
  
  YOUR TASK:
  Generate 5-10 parlays (mix of 2-leg and 3-leg) following these rules:
  
  STEP 1: For each potential parlay, identify the event title of each market
  STEP 2: Verify ALL markets have DIFFERENT event titles
  STEP 3: Verify the truth table (all outcome combinations are possible)
  STEP 4: Ensure narrative coherence with the thread
  
  SELECTION STRATEGY:
  ✓ Pick markets from different events
  ✓ Prefer clear YES outcomes (avoid excessive draws/ties)
  ✓ Match temporal windows (don't mix this week + 6 months)
  ✓ Tell a coherent betting story
  
  BEFORE INCLUDING A PARLAY, ASK:
  1. "Do any markets share the same event title?" → If YES, reject
  2. "Can all markets resolve to YES simultaneously?" → If NO, reject
  3. "Does this make narrative sense?" → If NO, consider rejecting
  
  OUTPUT FORMAT (strict JSON, no markdown):
  {
    "parlays": [
      {
        "marketIds": ["id1", "id2"],
        "reasoning": {
          "eventTitles": ["Event A", "Event B"],
          "truthTableCheck": "All 4 outcomes possible: both win, A wins only, B wins only, neither wins",
          "narrative": "Thread mentions both topics, timing aligns"
        },
        "reason": "One-sentence summary"
      }
    ]
  }`;

  const response = await withRetry(
    async () =>
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a sports betting parlay expert. Generate ONLY valid parlays where all markets are from different events. Return only valid JSON.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
        response_format: { type: "json_object" },
      }),
    { maxRetries: 3, initialDelay: 2000 },
    "Stage 2 - Parlay Generator",
  );

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("Stage 2: Empty response from OpenAI");
  }

  const parsed = safeJSON<Stage2Output>(content);
  if (!parsed || !parsed.parlays || !Array.isArray(parsed.parlays)) {
    console.error("Stage 2: Invalid output format, returning empty array");
    return { parlays: [] };
  }

  // Validate parlay structure and check for same-event violations
  const marketEventMap = new Map<string, string>();
  markets.forEach((m) => {
    marketEventMap.set(m.id, m.events[0]?.title || `standalone_${m.id}`);
  });

  const validParlays = parsed.parlays.filter((p) => {
    // Basic structure check
    const hasValidStructure =
      Array.isArray(p.marketIds) &&
      p.marketIds.length >= 2 &&
      p.marketIds.length <= 3 &&
      typeof p.reason === "string";

    if (!hasValidStructure) {
      console.warn("Stage 2: Invalid parlay structure:", p);
      return false;
    }

    // Check for same-event violations
    const eventTitles = p.marketIds.map((id) => marketEventMap.get(id) || "unknown");
    const uniqueEvents = new Set(eventTitles);

    if (uniqueEvents.size !== p.marketIds.length) {
      console.warn(`Stage 2: Rejected parlay with markets from same event:`, {
        marketIds: p.marketIds,
        eventTitles,
        reason: p.reason,
      });
      return false;
    }

    return true;
  });

  console.log(
    `✓ Stage 2 complete: Generated ${validParlays.length} valid parlays (filtered ${
      parsed.parlays.length - validParlays.length
    } invalid)`,
  );
  return { parlays: validParlays };
}

export async function stage3ParlayValidator(
  openai: OpenAI,
  thread: TweetThread,
  markets: NormalizedMarket[],
  parlays: ParlayCandidate[],
): Promise<Stage3Output> {
  console.log("\n=== STAGE 3: Parlay Validator ===");
  console.log(`Validating ${parlays.length} parlays`);

  if (parlays.length === 0) {
    return { approvedParlays: [], rejectedParlays: [] };
  }

  const marketMap = new Map(markets.map((m) => [m.id, m]));

  // Pre-compute event titles
  const marketEventMap = new Map<string, string>();
  markets.forEach((m) => {
    marketEventMap.set(m.id, m.events[0]?.title || `standalone_${m.id}`);
  });

  const prompt = `You are validating parlays using the truth table principle.
  
  VALIDATION PRINCIPLE:
  A parlay is valid if ALL possible outcome combinations are logically possible.
  
  For 2-leg parlay betting YES on both:
  ✓ Both YES → Must be possible
  ✓ A=YES, B=NO → Must be possible
  ✓ A=NO, B=YES → Must be possible
  ✓ Both NO → Must be possible
  
  For 3-leg parlay, all 8 combinations must be possible.
  
  AUTOMATIC REJECTION CRITERIA:
  
  1. **SAME EVENT VIOLATION**
     If ANY two markets share the same event title → REJECT immediately
     
     Example:
     Event: "Next Arizona Cardinals Head Coach?"
     - Market A: "Will John Harbaugh be next Cardinals coach?"
     - Market B: "Will Mike McDaniel be next Cardinals coach?"
     → REJECT: Same event, mutually exclusive
     
  2. **TRUTH TABLE VIOLATION**
     If betting YES on all legs creates an impossible outcome → REJECT
     
     Example:
     - "SGA wins MVP (YES)" + "Jokic wins MVP (YES)"
     → Truth table has impossible case: both can't win MVP
     → REJECT
  
  3. **TEMPORAL INCOHERENCE**
     If markets have vastly different time horizons → Flag for review
     
  4. **WEAK NARRATIVE**
     If markets have no logical connection → Flag for review
  
  THREAD CONTEXT:
  Author: ${thread.author}
  
  THREAD TEXT:
  ${thread.text}
  
  MARKETS:
  ${markets
    .map(
      (m, i) => `
  Market ${i + 1}:
  ID: ${m.id}
  Question: ${m.question}
  Event: ${m.events[0]?.title || "N/A"}
  End Date: ${m.endDate}
  Tags: ${m.tags.join(", ")}
  `,
    )
    .join("\n---\n")}
  
  PARLAYS TO VALIDATE:
  ${parlays
    .map((p, i) => {
      const marketDetails = p.marketIds
        .map((id) => {
          const market = marketMap.get(id);
          return market
            ? `${market.question} (Event: "${market.events[0]?.title || "N/A"}")`
            : "Unknown market";
        })
        .join("\n    ");

      return `
  Parlay ${i + 1}:
  ${marketDetails}
  Market IDs: ${p.marketIds.join(", ")}
  Reason Given: ${p.reason}
  `;
    })
    .join("\n---\n")}
  
  VALIDATION PROCESS FOR EACH PARLAY:
  
  STEP 1: Check event titles
  - Extract event title for each market
  - If ANY two markets share the same event → REJECT
  
  STEP 2: Truth table check
  - List all 2^N possible outcomes (N = number of legs)
  - Verify EACH outcome is logically possible
  - If ANY outcome is impossible → REJECT
  
  STEP 3: Quality checks
  - Temporal coherence: Do time windows align?
  - Narrative strength: Does this tell a coherent story?
  - If weak but valid → APPROVE with note
  
  OUTPUT FORMAT (strict JSON only):
  {
    "approvedParlays": [
      {
        "marketIds": ["id1", "id2"],
        "verdict": "approved",
        "validation": {
          "eventTitles": ["Event A", "Event B"],
          "sameEventCheck": "PASS - all different events",
          "truthTable": "PASS - all 4 outcomes possible",
          "temporal": "PASS - both resolve within 2 weeks",
          "narrative": "STRONG - both related to thread topic"
        },
        "reason": "Valid parlay: different events, all outcomes possible, strong narrative"
      }
    ],
    "rejectedParlays": [
      {
        "marketIds": ["id3", "id4"],
        "verdict": "rejected",
        "validation": {
          "eventTitles": ["Event X", "Event X"],
          "sameEventCheck": "FAIL - both from same event",
          "truthTable": "FAIL - both YES is impossible",
          "reason": "Markets from same multivariate event"
        },
        "reason": "Same event violation: both markets ask who wins Event X"
      }
    ]
  }`;

  const response = await withRetry(
    async () =>
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a parlay validation expert. Use the truth table principle. Reject any parlay with markets from the same event. Return only valid JSON.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1, // Very low for strict validation
        response_format: { type: "json_object" },
      }),
    { maxRetries: 3, initialDelay: 2000 },
    "Stage 3 - Parlay Validator",
  );

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("Stage 3: Empty response from OpenAI");
  }

  const parsed = safeJSON<Stage3Output>(content);
  if (!parsed || !Array.isArray(parsed.approvedParlays) || !Array.isArray(parsed.rejectedParlays)) {
    console.error("Stage 3: Invalid output format, returning empty arrays");
    return { approvedParlays: [], rejectedParlays: [] };
  }

  // Double-check: post-validation for same-event violations
  const finalApproved: ApprovedParlay[] = [];
  const additionalRejected: RejectedParlay[] = [];

  for (const parlay of parsed.approvedParlays) {
    const eventTitles = parlay.marketIds.map((id) => marketEventMap.get(id) || "unknown");
    const uniqueEvents = new Set(eventTitles);

    if (uniqueEvents.size !== parlay.marketIds.length) {
      console.warn(`⚠️  Stage 3 post-validation: Caught same-event violation that LLM missed:`, {
        marketIds: parlay.marketIds,
        eventTitles,
      });

      additionalRejected.push({
        marketIds: parlay.marketIds,
        verdict: "rejected",
        reason: `Post-validation rejection: Markets from same event (${Array.from(
          new Set(eventTitles),
        ).join(", ")})`,
      });
    } else {
      finalApproved.push(parlay);
    }
  }

  const allRejected = [...parsed.rejectedParlays, ...additionalRejected];

  console.log(
    `✓ Stage 3 complete: ${finalApproved.length} approved, ${allRejected.length} rejected (${additionalRejected.length} caught in post-validation)`,
  );

  return {
    approvedParlays: finalApproved,
    rejectedParlays: allRejected,
  };
}

export async function analyzeTweetThread(
  config: AnalyzeThreadConfig,
): Promise<AnalyzeThreadResult> {
  const { requestId, tweetId, topK = 50 } = config;

  const twitterApiKey = process.env.TWITTER_API_KEY!;
  const openaiApiKey = process.env.OPENAI_API_KEY!;
  const pineconeApiKey = process.env.PINECONE_API_KEY!;
  const pineconeIndexName = process.env.PINECONE_INDEX_NAME!;

  try {
    if (!twitterApiKey) {
      throw new Error("Twitter API key not provided and TWITTER_API_KEY env var not set");
    }
    if (!openaiApiKey) {
      throw new Error("OpenAI API key not provided and OPENAI_API_KEY env var not set");
    }
    if (!pineconeApiKey) {
      throw new Error("Pinecone API key not provided and PINECONE_API_KEY env var not set");
    }
    if (!pineconeIndexName) {
      throw new Error("Pinecone index not provided and PINECONE_INDEX env var not set");
    }

    // Initialize clients
    const openai = new OpenAI({
      apiKey: openaiApiKey,
      maxRetries: 2,
      timeout: 60000,
    });

    const pinecone = new Pinecone({
      apiKey: pineconeApiKey,
    });

    const pineconeIndex = pinecone.index(pineconeIndexName);

    const tweets = await fetchTweetThread(tweetId, twitterApiKey);

    // Extract metadata
    const author = tweets[0].author;

    const { pineconeMatches, queryText } = await searchMarketsFromThread(
      pineconeIndex,
      openai,
      tweets,
      topK,
    );

    console.log(`Found ${pineconeMatches.length} relevant markets from Pinecone`);

    const enrichedMatches = await fetchMarketObjects(pineconeMatches);
    const marketsWithData = deduplicateByEvent(
      enrichedMatches.filter((m) => m.fullMarketData !== null),
      2,
    );
    console.log(
      `Enriched ${marketsWithData.length}/${enrichedMatches.length} markets with full data`,
    );

    const marketIds = marketsWithData.map((m) => `${m.platform}:${m.market_id}`);

    await saveRequestMarkets(requestId, marketIds);

    return {
      threadContext: {
        author: author.name,
        authorHandle: author.userName,
        tweetCount: tweets.length,
        text: queryText,
      },
      markets: marketsWithData,
      message:
        pineconeMatches.length === 0
          ? "No relevant markets found"
          : `Found ${marketsWithData.length} relevant markets`,
    };
  } catch (error: any) {
    console.error("Fatal error in analyzeTweetThread:", error);

    return {
      threadContext: {
        author: "unknown",
        authorHandle: "unknown",
        tweetCount: 0,
        text: "",
      },
      markets: [],
      error: error.message || "An unexpected error occurred",
      message: `Failed to analyze thread: ${error.message}`,
    };
  }
}

export async function generateParlays(
  config: GenerateParlaysConfig,
): Promise<GenerateParlaysResult> {
  const { requestId, tweetId } = config;

  console.log(`\n${"=".repeat(80)}`);
  console.log(`🎯 Starting Parlay Generation Pipeline`);
  console.log(`Request ID: ${requestId}`);
  console.log(`Tweet ID: ${tweetId}`);
  console.log(`${"=".repeat(80)}\n`);

  try {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new Error("OPENAI_API_KEY environment variable not set");
    }

    const openai = new OpenAI({
      apiKey: openaiApiKey,
      maxRetries: 2,
      timeout: 60000,
    });

    // Step 0: Fetch initial markets using existing function
    console.log("📥 Fetching tweet thread and initial markets...");
    const initialResult = await analyzeTweetThread({
      requestId,
      tweetId,
      topK: 50,
    });

    if (initialResult.error || initialResult.markets.length === 0) {
      return {
        requestId,
        threadContext: initialResult.threadContext,
        approvedParlays: [],
        rejectedParlays: [],
        error: initialResult.error || "No markets found",
        message: initialResult.message,
      };
    }

    console.log("Normalizing markets: ", initialResult.markets.length);
    const candidateMarkets: NormalizedMarket[] = initialResult.markets
      .map((m) => normalizeMarket(m.fullMarketData!))
      .slice(0, 50);

    console.log(`✓ Fetched ${candidateMarkets.length} enriched markets\n`);

    if (candidateMarkets.length === 0) {
      return {
        requestId,
        threadContext: initialResult.threadContext,
        approvedParlays: [],
        rejectedParlays: [],
        error: "No markets with full data available",
        message: "Failed to enrich markets with full data",
      };
    }

    // Stage 1: Filter to top 20 markets
    const stage1Result = await stage1MarketFilter(
      openai,
      initialResult.threadContext,
      candidateMarkets,
    );

    console.log(candidateMarkets.map((m) => m.id));
    console.log(stage1Result.selectedMarketIds);

    // Get the 20 selected markets
    const selectedMarkets = candidateMarkets.filter((m) =>
      stage1Result.selectedMarketIds.includes(m.id),
    );

    if (selectedMarkets.length === 0) {
      console.log("No markets selected in Stage 1");
      return {
        requestId,
        threadContext: initialResult.threadContext,
        approvedParlays: [],
        rejectedParlays: [],
        error: "No markets selected in Stage 1",
        message: "Market filtering failed",
      };
    }

    // Stage 2: Generate parlays
    const stage2Result = await stage2ParlayGenerator(
      openai,
      initialResult.threadContext,
      selectedMarkets,
    );

    if (stage2Result.parlays.length === 0) {
      return {
        requestId,
        threadContext: initialResult.threadContext,
        approvedParlays: [],
        rejectedParlays: [],
        message: "No valid parlays could be generated",
      };
    }

    // Stage 3: Validate parlays
    const stage3Result = await stage3ParlayValidator(
      openai,
      initialResult.threadContext,
      selectedMarkets,
      stage2Result.parlays,
    );

    // Save results to database
    await saveParlayResults(requestId, stage3Result.approvedParlays, stage3Result.rejectedParlays);

    console.log(`\n${"=".repeat(80)}`);
    console.log(`✅ Pipeline Complete`);
    console.log(`Approved Parlays: ${stage3Result.approvedParlays.length}`);
    console.log(`Rejected Parlays: ${stage3Result.rejectedParlays.length}`);
    console.log(`${"=".repeat(80)}\n`);

    return {
      requestId,
      threadContext: initialResult.threadContext,
      approvedParlays: stage3Result.approvedParlays,
      rejectedParlays: stage3Result.rejectedParlays,
      message: `Successfully generated ${stage3Result.approvedParlays.length} approved parlays`,
    };
  } catch (error: any) {
    console.error("Fatal error in generateParlays:", error);

    return {
      requestId,
      threadContext: {
        author: "unknown",
        authorHandle: "unknown",
        tweetCount: 0,
      },
      approvedParlays: [],
      rejectedParlays: [],
      error: error.message || "An unexpected error occurred",
      message: `Failed to generate parlays: ${error.message}`,
    };
  }
}
