import type { NextApiRequest, NextApiResponse } from "next";

const PARLAY_WEBAPP_URL = process.env.PARLAY_WEBAPP_URL!;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!PARLAY_WEBAPP_URL) {
    return res.status(500).json({ error: "PARLAY_WEBAPP_URL not configured" });
  }

  const { parlay, markets = {} } = req.body;

  if (!parlay || !parlay.marketIds?.length) {
    return res.status(400).json({ error: "Invalid parlay data" });
  }

  // Transform LP-Tools legs → Parlay-Web-App legs
  const legs = parlay.marketIds.map((marketId: string, idx: number) => {
    const legData = parlay.legs?.find((l: any) => l.marketId === marketId);
    const yesPrice: number | null = legData?.yesPrice ?? null;

    // Convert probability → decimal odds. Fall back to 1.0 if price unavailable.
    const decimalOdds = yesPrice && yesPrice > 0 ? parseFloat((1 / yesPrice).toFixed(4)) : 1.0;

    // marketIds are "polymarket:12345" but markets map is keyed by plain "12345"
    const plainId = marketId.includes(":") ? marketId.split(":")[1] : marketId;
    const marketData = markets[plainId] || markets[marketId];

    // Prefer the market question from the full markets map, fall back to ParlayLeg.title
    const marketQuestion =
      marketData?.question ||
      legData?.title ||
      `Market ${idx + 1}`;

    // Pass resolution date so stardust can display it per leg
    const endDate = marketData?.endDateIso || marketData?.endDate || null;

    return {
      marketId,
      selection: "Yes",
      odds: decimalOdds,
      marketQuestion,
      ...(endDate ? { endDate } : {}),
    };
  });

  // Build parlay name from the actual leg market questions
  const shortQuestion = (q: string, maxLen = 30) => {
    if (q.length <= maxLen) return q;
    const cut = q.slice(0, maxLen).lastIndexOf(" ");
    return (cut > 12 ? q.slice(0, cut) : q.slice(0, maxLen)) + "…";
  };
  const parlayName = legs.map((l: any) => shortQuestion(l.marketQuestion)).join(" + ");

  const combinedOdds = parlay.combinedDecimalOdds
    ? parlay.combinedDecimalOdds.toFixed(2)
    : legs.reduce((acc: number, l: any) => acc * l.odds, 1).toFixed(2);

  const payload = {
    name: parlayName,
    description: parlay.reason || "",
    legs,
    combinedOdds,
  };

  try {
    const response = await fetch(`${PARLAY_WEBAPP_URL}/api/parlays/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Parlay Web App import failed:", data);
      return res.status(502).json({ error: data.error || "Failed to import parlay" });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("Error calling Parlay Web App:", err);
    return res.status(500).json({ error: "Failed to reach Parlay Web App" });
  }
}