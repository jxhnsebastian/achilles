import OpenAI from "openai";
import {
  AnalyzeThreadConfig,
  AnalyzeThreadResult,
  ApprovedParlay,
  EnrichedPineconeMarketHit,
  GenerateParlaysConfig,
  GenerateParlaysResult,
  NormalizedMarket,
  ParlayCandidate,
  RejectedParlay,
  Stage1Output,
  Stage2Output,
  Stage3Output,
  TweetThread,
  TwitterAPITweet,
} from "./types";
import {
  deduplicateByEvent,
  fetchForcedFallbackMarkets,
  fetchMarketObjects,
  fetchTweetThread,
  normalizeMarket,
  safeJSON,
  saveParlayResults,
  saveRequestMarkets,
  searchMarketsFromThread,
  withRetry,
} from "./utils";
import { Pinecone } from "@pinecone-database/pinecone";

/**
 * Reformulate an assertion-style sub-query into a market question format.
 * "Arsenal will win the Premier League" → "Will Arsenal win the Premier League?"
 * This improves cosine similarity against Polymarket titles in Pinecone.
 */
function reformulateAsQuestion(subQuery: string): string {
  // Pattern: "<Subject> will <predicate>"
  const m = subQuery.match(/^(.+?)\s+will\s+(.+)$/i);
  if (m) {
    const subject = m[1].trim();
    const predicate = m[2].trim().replace(/\?$/, "");
    return `Will ${subject} ${predicate}?`;
  }
  return subQuery;
}

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

  const prompt = `You are selecting 20 markets for YES-betting parlays for the given parlay topic.
  
  CRITICAL CONSTRAINT: We will bet YES on every market in our parlays, so we MUST select markets from DIFFERENT events.
  
  UNDERSTANDING MULTIVARIATE EVENTS:
  Many betting platforms create multiple markets for the SAME underlying event with different candidates/outcomes:
  
  Example:
  Event: "Next Arizona Cardinals Head Coach?"
  ├─ Market 1: "Will John Harbaugh be the next Cardinals coach?" 
  ├─ Market 2: "Will Mike McDaniel be the next Cardinals coach?"
  └─ Market 3: "Will Chris Shula be the next Cardinals coach?"
  
  These markets share the SAME event title and are MUTUALLY EXCLUSIVE - only ONE can resolve to YES.
  Since we're betting YES on all parlay legs, we can NEVER combine markets from the same event
  
  PARLAY TOPIC:
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
  subQueryGroups?: Map<string, number>,
): Promise<Stage2Output> {
  console.log("\n=== STAGE 2: Parlay Generator ===");
  console.log(`Generating parlays from ${markets.length} markets`);
  if (subQueryGroups && subQueryGroups.size > 0) {
    const numGroups = new Set(subQueryGroups.values()).size;
    console.log(`Sub-query groups detected: ${numGroups} groups`);
  }

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
  ${subQueryGroups && subQueryGroups.size > 0 ? `
  SUB-QUERY GROUPS:
  The query contains multiple distinct claims. Each market below is tagged [Group N].
  
  MANDATORY CROSS-GROUP RULE:
  ❌ NEVER put two legs from the SAME Group number in the same parlay
  ✅ ALWAYS ensure each parlay leg comes from a DIFFERENT Group number
  
  This guarantees each parlay covers multiple independent claims.
  ` : ""}
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
    .map((m, i) => {
      const group = subQueryGroups?.get(m.id);
      const groupLabel = group !== undefined ? ` [Group ${group}]` : "";
      return `
  Market ${i + 1}:
  ID: ${m.id}${groupLabel}
  Question: ${m.question}
  Description: ${m.description}
  Event: ${m.events[0]?.title || "N/A"}
  Tags: ${m.tags.join(", ")}
  End Date: ${m.endDate}
  `;
    })
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

    // Cross-group constraint: no two legs from the same sub-query group
    if (subQueryGroups && subQueryGroups.size > 0) {
      const groups = p.marketIds.map((id) => subQueryGroups.get(id));
      const definedGroups = groups.filter((g) => g !== undefined) as number[];
      const uniqueGroups = new Set(definedGroups);
      if (definedGroups.length >= 2 && uniqueGroups.size !== definedGroups.length) {
        console.warn(`Stage 2: Rejected same-group parlay:`, {
          marketIds: p.marketIds,
          groups,
          reason: p.reason,
        });
        return false;
      }
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
  - You have to approve or reject all the input parlays and return them as approved or rejected.
  
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

async function filterMarketsByThesis(
  openai: OpenAI,
  thesis: string,
  markets: EnrichedPineconeMarketHit[],
): Promise<EnrichedPineconeMarketHit[]> {
  console.log(`\n=== THESIS FILTER: Scoring ${markets.length} markets for relevance ===`);

  const marketList = markets
    .map((m, i) => {
      const q = m.fullMarketData?.question ?? m.metadata.title ?? "Unknown";
      const event = m.fullMarketData?.events?.[0]?.title ?? "";
      return `${i + 1}. ID: ${m.market_id} | Question: ${q}${event ? ` | Event: ${event}` : ""}`;
    })
    .join("\n");

  const prompt = `You are a prediction market relevance filter. Your job is to score how relevant each market is to the user's betting thesis, balancing precision and recall — include all genuinely useful markets, not just exact matches.

THESIS:
"${thesis}"

AVAILABLE MARKETS:
${marketList}

TASK:
For a multi-part thesis (e.g. "Arsenal will win the PL AND Bayern will win the UCL"), cover EACH leg — select relevant markets for every team/competition mentioned.

RELEVANCE PRIORITY (in order, but not too strict):
1) exact — same team + same competition + same outcome type
2) near_exact — same team + same competition + closely related outcome
3) same_comp_related — same team + same competition + related outcome (e.g. top 4, trophy, winner)
4) season_proxy — same team + season-level outcome (top 4 finish, trophy, relegation inverse, title winner)
5) player_proxy — player award/scoring market clearly tied to a thesis team's season success
6) match_proxy — single match win/draw market for a thesis team (include if relevant and no redundancy)
7) competition_context — competition-level market (e.g. UCL winner, PL winner) that directly supports/contrasts thesis

EXCLUDE OR HEAVILY PENALIZE:
- Unrelated teams or competitions not mentioned in the thesis
- Markets sharing only the same sport with no connection to thesis teams/competitions
- Very weak player props (e.g. individual stat lines unconnected to team success)
- Near-duplicate markets — keep only the strongest version per outcome
- Random spreads/totals/BTTS for teams not in the thesis

MULTI-PART THESIS BEHAVIOR:
- If thesis mentions multiple teams, include relevant markets for EACH team
- Aim to cover all thesis legs with at least some markets
- If no exact match exists for a leg, include best proxies and note it

SCORING GUIDANCE:
- 0.95–1.00 = exact match (same team, same competition, same outcome)
- 0.88–0.94 = near-exact / same competition strong relation
- 0.78–0.87 = strong same-team proxy (season-level, trophy, top 4)
- 0.65–0.77 = useful related market (include if it keeps list quality high)
- Below 0.65 = exclude

Include markets scoring >= 0.65. Return more markets if they are genuinely relevant.

RETURN valid JSON only, no markdown:
{
  "thesis": "${thesis}",
  "exact_match_found": true | false,
  "notes": "<brief note if exact markets are missing for any leg>",
  "selected_markets": [
    {
      "id": "<market id from list>",
      "question": "<market question>",
      "relevance_type": "exact | near_exact | same_comp_related | season_proxy | player_proxy | match_proxy | competition_context",
      "correlation_direction": "positive | negative | unclear",
      "short_reason": "<one concise line>",
      "score": 0.0
    }
  ]
}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You are a precise prediction market relevance filter. Return only valid JSON with no markdown or extra text.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0,
  });

  const raw = response.choices[0]?.message?.content ?? "";
  const parsed = safeJSON<{
    thesis: string;
    exact_match_found: boolean;
    notes?: string;
    selected_markets: Array<{
      id: string;
      question: string;
      relevance_type: string;
      correlation_direction: string;
      short_reason: string;
      score: number;
    }>;
  }>(raw);

  if (!parsed || !parsed.selected_markets) {
    console.warn("Thesis filter: failed to parse response, returning all markets");
    return markets;
  }

  console.log(`Thesis filter: exact_match_found=${parsed.exact_match_found}`);
  if (parsed.notes) console.log(`Thesis filter notes: ${parsed.notes}`);
  console.log(`Thesis filter: ${parsed.selected_markets.length} markets passed (score >= 0.65)`);

  const marketById = new Map(markets.map((m) => [m.market_id, m]));

  // Extract keywords from thesis for deterministic boost
  const thesisLower = thesis.toLowerCase();
  const winnerKeywords = ["win", "winner", "outright", "champions"];
  
  // Extract team names (simple heuristic: capitalize words likely to be teams)
  const teamPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+will\s+win/g;
  const teamMatches = [...thesis.matchAll(teamPattern)].map((m) => m[1].toLowerCase());
  
  // Extract competition names (common patterns)
  const competitions = [
    "premier league",
    "champions league",
    "ucl",
    "epl",
    "la liga",
    "serie a",
    "bundesliga",
    "world cup",
    "euros",
    "copa america",
    "nba",
    "nfl",
    "mlb",
    "nhl",
  ];
  const foundCompetitions = competitions.filter((comp) => thesisLower.includes(comp));

  const filtered: EnrichedPineconeMarketHit[] = [];
  for (const sel of parsed.selected_markets) {
    const match = marketById.get(sel.id);
    if (match) {
      let adjustedScore = sel.score;
      const questionLower = (match.fullMarketData?.question ?? "").toLowerCase();
      const descriptionLower = (match.fullMarketData?.description ?? "").toLowerCase();
      const combinedText = `${questionLower} ${descriptionLower}`;

      // Check for exact intent: team + competition + winner
      const hasTeam = teamMatches.some((team) => combinedText.includes(team));
      const hasCompetition = foundCompetitions.some((comp) => combinedText.includes(comp));
      const hasWinner = winnerKeywords.some((w) => combinedText.includes(w));

      if (hasTeam && hasCompetition && hasWinner) {
        // Strong boost: exact team + competition + winner match
        adjustedScore = Math.min(1.0, adjustedScore * 1.35);
      } else if (hasCompetition && !hasTeam && hasWinner) {
        // Penalty: competition winner but wrong/no team
        adjustedScore = adjustedScore * 0.65;
      }

      console.log(
        `  [${sel.relevance_type} | ${adjustedScore.toFixed(2)} | ${sel.correlation_direction}] ${sel.question} — ${sel.short_reason}`,
      );
      filtered.push({ ...match, score: adjustedScore });
    }
  }

  // Force-include exact matches the LLM may have scored below threshold.
  // Scan the full input pool (not just LLM-selected) for deterministic exact matches.
  const filteredIds = new Set(filtered.map((m) => m.market_id));
  for (const market of markets) {
    if (filteredIds.has(market.market_id)) continue; // already included
    if (!market.fullMarketData) continue;
    const qLower = market.fullMarketData.question.toLowerCase();
    const dLower = (market.fullMarketData.description || "").toLowerCase();
    const combined = `${qLower} ${dLower}`;
    const hasTeam = teamMatches.length > 0 && teamMatches.some((t) => combined.includes(t));
    const hasCompetition = foundCompetitions.length > 0 && foundCompetitions.some((c) => combined.includes(c));
    const hasWinner = winnerKeywords.some((w) => combined.includes(w));
    if (hasTeam && hasCompetition && hasWinner) {
      const forceScore = 0.88;
      console.log(
        `  [FORCE-INCLUDE | ${forceScore} | exact_match] ${market.fullMarketData.question} — deterministic exact match bypasses LLM threshold`,
      );
      filtered.push({ ...market, score: forceScore });
      filteredIds.add(market.market_id);
    }
  }

  filtered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  console.log(`✓ Thesis filter complete: ${filtered.length} markets kept\n`);
  return filtered;
}

export async function analyzeQuery(config: AnalyzeThreadConfig): Promise<AnalyzeThreadResult> {
  const { requestId, query, tweet, topK = 50 } = config;

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

    let tweets: TwitterAPITweet[] = [];
    let author: any = null;

    if (tweet) {
      tweets = await fetchTweetThread(query, twitterApiKey);
      author = tweets[0].author;
    }

    // Sub-query splitting: split non-tweet plain-text queries on " and "
    if (!tweet) {
      const subQueries = query
        .split(/ and /i)
        .map((s) => s.trim())
        .filter(Boolean);
      if (subQueries.length > 1) {
        console.log(`\n=== SUB-QUERY SPLITTING: ${subQueries.length} sub-queries ===`);
        subQueries.forEach((sq, i) => console.log(`  [${i}] ${sq}`));

        const allGroupMarkets: EnrichedPineconeMarketHit[][] = [];

        for (let gi = 0; gi < subQueries.length; gi++) {
          const subQuery = subQueries[gi];
          // Reformulate as question for better Pinecone cosine similarity
          const embeddingQuery = reformulateAsQuestion(subQuery);
          console.log(`\n--- Sub-query [${gi}]: "${subQuery}" ---`);
          console.log(`    Embedding as: "${embeddingQuery}"`);

          const { pineconeMatches: subMatches } = await searchMarketsFromThread(
            pineconeIndex,
            openai,
            embeddingQuery,
            false,
            [],
            topK,
          );
          const subEnriched = await fetchMarketObjects(subMatches);
          const subDeduped = deduplicateByEvent(
            subEnriched.filter((m) => m.fullMarketData !== null),
            2,
          );

          // Hardcoded DB fallback: inject AFTER dedup so it can't be evicted by liquidity sorting
          const subForced = await fetchForcedFallbackMarkets(subQuery);
          const subDedupedIds = new Set(subDeduped.map((m) => `${m.platform}:${m.market_id}`));
          for (const fm of subForced) {
            if (!subDedupedIds.has(`${fm.platform}:${fm.market_id}`)) {
              console.log(`[FORCED FALLBACK] Injecting into group [${gi}]: "${fm.fullMarketData?.question}"`);
              subDeduped.unshift(fm);
              subDedupedIds.add(`${fm.platform}:${fm.market_id}`);
            }
          }

          const subFiltered = await filterMarketsByThesis(openai, subQuery, subDeduped);
          subFiltered.forEach((m) => {
            m.subQueryGroup = gi;
          });
          allGroupMarkets.push(subFiltered);
        }

        // Merge: take top results from each group, deduplicated by market_id
        const maxPerGroup = Math.ceil(topK / subQueries.length);
        const merged: EnrichedPineconeMarketHit[] = [];
        const seenIds = new Set<string>();

        for (const groupMarkets of allGroupMarkets) {
          let count = 0;
          for (const m of groupMarkets) {
            if (!seenIds.has(m.market_id) && count < maxPerGroup) {
              seenIds.add(m.market_id);
              merged.push(m);
              count++;
            }
          }
        }

        const mergedMarketIds = merged.map((m) => `${m.platform}:${m.market_id}`);
        await saveRequestMarkets(requestId, mergedMarketIds);
        console.log(
          `✓ Sub-query merge: ${merged.length} markets across ${subQueries.length} groups`,
        );
        return {
          threadContext: { author: "", authorHandle: "", tweetCount: 0, text: query },
          markets: merged,
          message: `Found ${merged.length} relevant markets across ${subQueries.length} sub-queries`,
        };
      }
    }

    const { pineconeMatches, queryText } = await searchMarketsFromThread(
      pineconeIndex,
      openai,
      query,
      tweet,
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

    // Hardcoded DB fallback: inject AFTER dedup so it can't be evicted by liquidity sorting
    const forcedMatches = await fetchForcedFallbackMarkets(queryText);
    const marketsWithDataIds = new Set(marketsWithData.map((m) => `${m.platform}:${m.market_id}`));
    for (const fm of forcedMatches) {
      if (!marketsWithDataIds.has(`${fm.platform}:${fm.market_id}`)) {
        console.log(`[FORCED FALLBACK] Injecting: "${fm.fullMarketData?.question}"`);
        marketsWithData.unshift(fm);
        marketsWithDataIds.add(`${fm.platform}:${fm.market_id}`);
      }
    }

    // LLM-based thesis relevance filter
    const filteredMarkets = await filterMarketsByThesis(openai, queryText, marketsWithData);

    const marketIds = filteredMarkets.map((m) => `${m.platform}:${m.market_id}`);

    await saveRequestMarkets(requestId, marketIds);

    return {
      threadContext: {
        author: author?.name ?? "",
        authorHandle: author?.userName ?? "",
        tweetCount: tweets.length,
        text: queryText,
      },
      markets: filteredMarkets,
      message:
        pineconeMatches.length === 0
          ? "No relevant markets found"
          : `Found ${filteredMarkets.length} relevant markets (filtered from ${marketsWithData.length})`,
    };
  } catch (error: any) {
    console.error("Fatal error in analyzeQuery:", error);

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
  const { requestId, query, tweet } = config;

  console.log(`\n${"=".repeat(80)}`);
  console.log(`🎯 Starting Parlay Generation Pipeline`);
  console.log(`Request ID: ${requestId}`);
  console.log(`Query: ${query}`);
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
    const initialResult = await analyzeQuery({
      requestId,
      query,
      tweet,
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

    // Build sub-query group map (market_id → group index), populated when sub-query splitting ran
    const subQueryGroupMap = new Map<string, number>();
    for (const m of initialResult.markets) {
      if (m.subQueryGroup !== undefined) {
        subQueryGroupMap.set(m.market_id, m.subQueryGroup);
      }
    }
    if (subQueryGroupMap.size > 0) {
      console.log(`Sub-query groups: ${new Set(subQueryGroupMap.values()).size} groups across ${subQueryGroupMap.size} markets`);
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
      subQueryGroupMap.size > 0 ? subQueryGroupMap : undefined,
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
