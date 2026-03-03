"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Loader2, Twitter, Send, CheckCircle2 } from "lucide-react";

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
import { motion } from "framer-motion";
import { cardDropIn, listContainer, listItem } from "./motion";
import { Loader } from "lucide-react";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { toast } from "sonner";

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
      
      console.log('📊 Status poll response:', {
        hasMarkets: data.markets?.length,
        hasApproved: data.approvedParlays?.length,
        hasRejected: data.rejectedParlays?.length,
        currentPhase: phase
      });

      if (data.markets?.length && marketIds.length === 0) {
        setMarketIds(data.markets);
        setPhase("markets_ready");
      }

      if (data.approvedParlays?.length || data.rejectedParlays?.length) {
        console.log('✅ Received parlays:', data.approvedParlays, data.rejectedParlays);
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
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSendToWebApp() {
    setSending(true);
    try {
      const res = await fetch("/api/parlay/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parlay, markets }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send");
      setSent(true);
      const webAppUrl = process.env.NEXT_PUBLIC_PARLAY_WEBAPP_URL || "";
      toast.success("Parlay sent to Parlay Web App!", {
        description: data.parlayName,
        action: webAppUrl ? {
          label: "View ↗",
          onClick: () => window.open(`${webAppUrl}/admin/parlays`, "_blank"),
        } : undefined,
      });
    } catch (err: any) {
      toast.error("Failed to send parlay", { description: err.message });
    } finally {
      setSending(false);
    }
  }

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

        <ul className="space-y-2 text-sm">
          {parlay.marketIds.map((id) => {
            const market = markets[id];
            if (!market) return null;

            // Find pricing info if available (only for approved parlays)
            const approvedParlay = isApproved ? (parlay as ApprovedParlay) : null;
            const leg = approvedParlay?.legs?.find((l) => l.marketId === id);
            const yesPrice = leg?.yesPrice;

            return (
              <li key={id} className="leading-snug">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex-1">• {market.question}</span>
                  {yesPrice != null && (
                    <Badge variant="outline" className="text-xs font-mono shrink-0">
                      {(yesPrice * 100).toFixed(1)}%
                    </Badge>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {isApproved && (parlay as ApprovedParlay).combinedDecimalOdds && (
          <>
            <Separator />
            <div className="flex items-center justify-between text-sm">
              <div className="space-y-1">
                <div className="text-muted-foreground text-xs">Combined Probability</div>
                <div className="font-mono font-semibold">
                  {(((parlay as ApprovedParlay).combinedProb || 0) * 100).toFixed(2)}%
                </div>
              </div>
              <div className="space-y-1 text-right">
                <div className="text-muted-foreground text-xs">Decimal Odds</div>
                <div className="font-mono font-semibold text-lg">
                  {((parlay as ApprovedParlay).combinedDecimalOdds || 0).toFixed(2)}x
                </div>
              </div>
            </div>
          </>
        )}

        {isApproved && (
          <>
            <Separator />
            <Button
              size="sm"
              variant={sent ? "secondary" : "outline"}
              className="w-full gap-2 text-xs"
              disabled={sending || sent}
              onClick={handleSendToWebApp}
            >
              {sending && <Loader2 className="h-3 w-3 animate-spin" />}
              {sent && <CheckCircle2 className="h-3 w-3 text-green-500" />}
              {!sending && !sent && <Send className="h-3 w-3" />}
              {sent ? "Sent to Parlay Web App" : "Send to Parlay Web App"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
