import { generateParlays, analyzeQuery } from "./parlay";
import { normalizeMarket } from "./utils";
import { randomUUID } from "crypto";

async function testParlayGeneration() {
  const requestId = randomUUID();
  const query = "Arsenal will win the premier league and Bayern Munich will win the Champions league";
  const tweet = false;

  console.log("=".repeat(80));
  console.log("TESTING PARLAY GENERATION (parlay-server)");
  console.log("=".repeat(80));
  console.log(`Request ID: ${requestId}`);
  console.log(`Query: ${query}`);
  console.log(`Tweet mode: ${tweet}`);
  console.log("=".repeat(80));
  console.log("\n");

  try {
    // Step 1: Fetch and print candidate markets first
    console.log("=".repeat(80));
    console.log("CANDIDATE MARKETS (from Pinecone + DB enrichment + Thesis Filter):");
    console.log("=".repeat(80));

    const analysisResult = await analyzeQuery({ requestId, query, tweet, topK: 50 });

    if (analysisResult.markets.length === 0) {
      console.log("No markets found.");
    } else {
      const candidateMarkets = analysisResult.markets
        .filter((m) => m.fullMarketData)
        .slice(0, 50)
        .map((m) => normalizeMarket(m.fullMarketData!));

      candidateMarkets.forEach((m, i) => {
        console.log(`\n[${i + 1}] ID: ${m.id}`);
        console.log(`     Question : ${m.question}`);
        console.log(`     Event    : ${m.events[0]?.title ?? "N/A"}`);
        console.log(`     Tags     : ${m.tags.join(", ") || "none"}`);
        console.log(`     End Date : ${m.endDate}`);
      });
    }

    console.log("\n" + "=".repeat(80));
    console.log("RUNNING FULL PIPELINE...");
    console.log("=".repeat(80) + "\n");

    // Step 2: Run full parlay generation pipeline
    const result = await generateParlays({ requestId, query, tweet });

    console.log("\n");
    console.log("=".repeat(80));
    console.log("FINAL RESULT:");
    console.log("=".repeat(80));
    console.log(JSON.stringify(result, null, 2));
    console.log("=".repeat(80));
  } catch (error) {
    console.error("\n");
    console.error("=".repeat(80));
    console.error("ERROR:");
    console.error("=".repeat(80));
    console.error(error);
    console.error("=".repeat(80));
  }
}

testParlayGeneration();
