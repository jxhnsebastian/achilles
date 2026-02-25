"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Loader2, Twitter } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ApprovedParlay,
  PolymarketMarket,
  RejectedParlay,
  RequestStatusResponse,
} from "@/lib/parlay-types";
import {
  ParlayPricingResponse,
  PricingLegInput,
} from "@/lib/polymarketPricing";
import { motion } from "framer-motion";
import { cardDropIn, listContainer, listItem } from "./motion";
import { Loader } from "lucide-react";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";

type Phase = "idle" | "starting" | "polling" | "markets_ready" | "results_ready" | "error";

export default function ParlayAnalyzerPage() {
  const [tweetId, setTweetId] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [isTweet, setIsTweet] = useState(true);

  const [marketIds, setMarketIds] = useState<string[]>([]);
  const [markets, setMarkets] = useState<Record<string, PolymarketMarket>>({});
  const [parlays, setParlays] = useState<ApprovedParlay[]>([]);
  const [rejectedParlays, setRejectedParlays] = useState<RejectedParlay[]>([]);

  // ---------------- submit ----------------
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setRequestId(null);
    setPhase("starting");
    setMarketIds([]);
    setParlays([]);
    setRejectedParlays([]);

    const res = await fetch("/api/parlay/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: tweetId, tweet: isTweet }),
    });

    const data = await res.json();
    setRequestId(data.requestId);
    setPhase("polling");
  }

  // ---------------- polling ----------------
  useEffect(() => {
    if (!requestId) return;

    const interval = setInterval(async () => {
      const res = await fetch(`/api/parlay/status/${requestId}`);
      const data: RequestStatusResponse = await res.json();

      if (data.markets?.length && marketIds.length === 0) {
        setMarketIds(data.markets);
        setPhase("markets_ready");
      }

      if (data.approvedParlays?.length || data.rejectedParlays?.length) {
        setParlays(data?.approvedParlays || []);
        setRejectedParlays(data?.rejectedParlays || []);
        setPhase("results_ready");
        clearInterval(interval);
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [requestId, marketIds.length]);

  // ---------------- fetch markets ----------------
  useEffect(() => {
    if (!marketIds.length) return;

    fetch("/api/parlay/markets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ marketIds }),
    })
      .then((r) => r.json())
      .then(({ markets }: { markets: PolymarketMarket[] }) => {
        const map: Record<string, PolymarketMarket> = {};
        markets.forEach((m) => (map[m.id] = m));
        setMarkets(map);
      });
  }, [marketIds]);

  const marketList = useMemo(() => Object.values(markets), [markets]);

  // ---------------- UI ----------------
  return (
    <div className="flex flex-col px-10 space-y-10">
      {/* header */}
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Polymarket Parlay Analyzer</h1>
        <p className="text-sm text-muted-foreground">
          Generate correlated parlays from tweet narratives
        </p>
      </div>

      {/* input */}
      <form onSubmit={handleSubmit} className="flex justify-center">
        <div className="flex gap-3 w-full">
          <Input
            value={tweetId}
            onChange={(e) => setTweetId(e.target.value)}
            placeholder="Enter Tweet ID"
          />
          <div className="flex items-center gap-2 px-3 py-2 border rounded-md">
            <Twitter className="h-4 w-4 text-muted-foreground" />

            <Checkbox
              id="tweet-mode"
              checked={isTweet}
              onCheckedChange={(checked) => setIsTweet(!!checked)}
            />

            <Label htmlFor="tweet-mode" className="text-xs text-muted-foreground cursor-pointer">
              Tweet
            </Label>
          </div>
          <Button disabled={!tweetId}>
            {(phase === "starting" || phase === "polling" || phase === "markets_ready") && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Analyze
          </Button>
        </div>
      </form>

      {(phase === "starting" || phase === "polling") && (
        <div className="flex items-center gap-2">
          <Loader size={15} className="animate-spin" />
          <CardDescription className="text-xs leading-relaxed mt-0.5">
            Fetching tweets and relevant markets
          </CardDescription>
        </div>
      )}

      {/* markets */}
      {(phase === "markets_ready" || phase === "results_ready") && (
        <motion.div variants={cardDropIn} initial="hidden" animate="visible">
          <Card className="animate-fade-drop">
            <CardHeader className="">
              <CardTitle className="text-sm">Candidate Markets</CardTitle>
              <CardDescription>Markets extracted from the tweet context</CardDescription>
            </CardHeader>

            {marketList.length === 0 && (
              <div className="flex items-center gap-2 ml-4">
                <Loader size={15} className="animate-spin" />
                <CardDescription className="text-xs leading-relaxed mt-0.5">
                  Loading markets
                </CardDescription>
              </div>
            )}

            {marketList.length > 0 && (
              <CardContent>
                <motion.div
                  variants={listContainer}
                  initial="hidden"
                  animate="visible"
                  className="w-full flex flex-col items-start gap-3 max-h-[15rem] overflow-y-auto"
                >
                  {marketList.map((m) => (
                    <motion.div
                      key={m.id}
                      variants={listItem}
                      className="rounded-md border border-l-0 gap-2 pr-2 flex items-center"
                    >
                      {m.icon ? (
                        <Image
                          className="rounded-full size-8"
                          src={m.icon}
                          alt=""
                          width={24}
                          height={24}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">PM</span>
                      )}
                      <span className="text-xs text-muted-foreground">{m.question}</span>
                    </motion.div>
                  ))}
                </motion.div>
              </CardContent>
            )}
          </Card>
        </motion.div>
      )}

      {phase === "markets_ready" && marketList.length > 0 && (
        <div className="flex items-center gap-2">
          <Loader size={15} className="animate-spin" />
          <CardDescription className="text-xs leading-relaxed mt-0.5">
            Generating Parlays
          </CardDescription>
        </div>
      )}

      {/* parlays */}
      {phase === "results_ready" && (
        <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-3 duration-700">
          {parlays.length > 0 && (
            <motion.div variants={cardDropIn} initial="hidden" animate="visible">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Approved Parlays</CardTitle>
                  <CardDescription>
                    High-confidence parlay combinations generated from the tweet narrative
                  </CardDescription>
                </CardHeader>
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mt-2">
                {parlays.map((p, i) => (
                  <motion.div
                    key={i}
                    variants={cardDropIn}
                    initial="hidden"
                    animate="visible"
                    transition={{ delay: i * 0.05 }}
                  >
                    <ParlayCard key={i} parlay={p} markets={markets} />
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
          {rejectedParlays.length > 0 && (
            <motion.div variants={cardDropIn} initial="hidden" animate="visible">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Rejected Parlays</CardTitle>
                  <CardDescription>
                    {rejectedParlays.length} combinations were filtered out
                  </CardDescription>
                </CardHeader>
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mt-2">
                {rejectedParlays.map((p, i) => (
                  <motion.div
                    key={i}
                    variants={cardDropIn}
                    initial="hidden"
                    animate="visible"
                    transition={{ delay: i * 0.05 }}
                  >
                    <ParlayCard key={i} parlay={p} markets={markets} />
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </div>
      )}
    </div>
  );
}

function ParlayCard({
  parlay,
  markets,
}: {
  parlay: ApprovedParlay | RejectedParlay;
  markets: Record<string, PolymarketMarket>;
}) {
  const isApproved = parlay.verdict === "approved";
  const { pricing, loading, error } = useParlayPricing(parlay, markets);

  const legByMarketId = useMemo(() => {
    const map = new Map<string, NonNullable<ParlayPricingResponse["legs"][number]>>();
    pricing?.legs.forEach((leg) => map.set(leg.marketId, leg));
    return map;
  }, [pricing]);

  return (
    <Card className={isApproved ? "border-border" : "border-dashed bg-muted/30 opacity-80"}>
      <CardHeader className="space-y-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">
            {parlay.marketIds.length}-Leg Parlay
          </CardTitle>

          <Badge variant={isApproved ? "secondary" : "outline"}>
            {isApproved ? "Approved" : "Rejected"}
          </Badge>
        </div>

        <CardDescription className="text-xs leading-relaxed">{parlay.reason}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        <Separator />

        <ul className="space-y-1 text-sm">
          {parlay.marketIds.map((id) => {
            const market = markets[id];
            if (!market) return null;
            const legPricing = legByMarketId.get(id);

            return (
              <li key={id} className="leading-snug rounded-md border p-2">
                <div>• {market.question}</div>
                <div className="mt-1 text-xs text-muted-foreground flex flex-wrap gap-3">
                  <span>Side: YES</span>
                  <span>
                    Implied Prob: {formatPercent(legPricing?.impliedProbability)}
                  </span>
                  <span>Decimal: {formatDecimalOdds(legPricing?.decimalOdds)}</span>
                  <span>American: {formatAmericanOdds(legPricing?.americanOdds)}</span>
                </div>
                {legPricing?.error && (
                  <div className="mt-1 text-xs text-amber-500">{legPricing.error}</div>
                )}
              </li>
            );
          })}
        </ul>

        <Separator />

        <div className="rounded-md border p-3 bg-muted/30 space-y-1">
          <div className="text-xs font-medium">Combined Parlay Odds (Estimated)</div>

          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Fetching live Polymarket prices...
            </div>
          )}

          {!loading && error && <div className="text-xs text-red-500">{error}</div>}

          {!loading && !error && pricing && (
            <>
              {pricing.combined ? (
                <div className="text-xs text-muted-foreground flex flex-wrap gap-3">
                  <span>
                    Probability: {formatPercent(pricing.combined.combinedProbability)}
                  </span>
                  <span>Decimal: {formatDecimalOdds(pricing.combined.combinedDecimalOdds)}</span>
                  <span>
                    American: {formatAmericanOdds(pricing.combined.combinedAmericanOdds)}
                  </span>
                </div>
              ) : (
                <div className="text-xs text-amber-500">
                  Unable to compute combined odds: no valid priced legs available.
                </div>
              )}

              {pricing.hasStaleData && (
                <div className="text-xs text-amber-500">
                  Some price data may be stale (older than 15 minutes).
                </div>
              )}

              <div className="text-[11px] text-muted-foreground">{pricing.note}</div>
              <div className="text-[11px] text-muted-foreground">
                Last updated: {pricing.lastUpdated ? new Date(pricing.lastUpdated).toLocaleString() : "N/A"}
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function useParlayPricing(
  parlay: ApprovedParlay | RejectedParlay,
  markets: Record<string, PolymarketMarket>,
) {
  const [pricing, setPricing] = useState<ParlayPricingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const legs = useMemo<PricingLegInput[]>(() => {
    const resolvedLegs: PricingLegInput[] = [];

    parlay.marketIds.forEach((marketId) => {
      const market = markets[marketId];
      if (!market) return;

      resolvedLegs.push({
        marketId,
        question: market.question,
        // Current backend parlay generation bets YES on all legs.
        selectedSide: "YES",
        market,
      });
    });

    return resolvedLegs;
  }, [parlay.marketIds, markets]);

  useEffect(() => {
    if (!legs.length) {
      setPricing(null);
      setError(null);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    fetch("/api/parlay/pricing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ legs }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || "Failed to fetch pricing");
        }
        return res.json();
      })
      .then((data: ParlayPricingResponse) => {
        if (!active) return;
        setPricing(data);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to fetch pricing");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [legs]);

  return { pricing, loading, error };
}

function formatPercent(probability?: number | null) {
  if (probability === null || probability === undefined || Number.isNaN(probability)) return "N/A";
  return `${(probability * 100).toFixed(1)}%`;
}

function formatDecimalOdds(odds?: number | null) {
  if (odds === null || odds === undefined || Number.isNaN(odds)) return "N/A";
  return odds.toFixed(2);
}

function formatAmericanOdds(odds?: number | null) {
  if (odds === null || odds === undefined || Number.isNaN(odds)) return "N/A";
  return odds > 0 ? `+${Math.round(odds)}` : `${Math.round(odds)}`;
}
