import express from "express";
import { Poller } from "./poller";
import { getIdMap, PollerStatusLabels, ProtocolLabels } from "@achilles/utils";
import { prisma } from "@achilles/db";
import { sleep } from "@achilles/utils";
import logger from "../logger";
import cors from "cors";
import { convertFeesToTargetToken } from "../convertFees";

const port = process.env.POLLER_PORT || 5000;
const app = express();
export const pollers = new Map<string, Poller>();

app.use(express.json());

app.use((req, res, next) => {
  logger.log("API", `${req.method} ${req.path}`);
  next();
});

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

async function monitorPollers() {
  try {
    while (true) {
      try {
        const pollersToUpdate = await prisma.pollers.findMany();

        for (const pollerData of pollersToUpdate) {
          const existingPoller = pollers.get(pollerData.poolId);

          switch (pollerData.status) {
            case "RUN":
              if (!existingPoller) {
                try {
                  const distinctBots = await prisma.botConfig.findMany({
                    where: {
                      poolId: pollerData.poolId,
                      status: {
                        not: "STOP",
                      },
                    },
                    distinct: ["botId"],
                    select: {
                      botId: true,
                    },
                  });

                  if (distinctBots.length <= 0) {
                    logger.log(
                      "poller_manager",
                      `No live bots for ${pollerData.pollerId}`
                    );
                    await prisma.pollers.update({
                      where: { id: pollerData.id },
                      data: { status: "STOP" },
                    });
                    break;
                  }
                } catch (error: any) {
                  await logger.slack(
                    "poller_manager",
                    `Failed to run poller ${pollerData.pollerId}: ${
                      error?.message ?? "Unknown error!"
                    }`,
                    undefined,
                    undefined,
                    error
                  );
                  break;
                }
              }

            case "START":
              if (!existingPoller) {
                try {
                  const poller = new Poller(
                    getIdMap(ProtocolLabels)[pollerData.protocol as string],
                    pollerData.poolId,
                    pollerData.pollerId
                  );

                  pollers.set(pollerData.poolId, poller);
                  await poller.initialize();
                  await poller.startPolling();
                  while (!poller.isRunning) {
                    logger.log(
                      "poller_manager",
                      `Waiting for poller ${pollerData.pollerId} to start.`
                    );
                    await sleep(500);
                  }

                  await prisma.pollers.update({
                    where: { id: pollerData.id },
                    data: { status: "RUN" },
                  });

                  await logger.slack(
                    "poller_manager",
                    `Started poller ${pollerData.pollerId}`
                  );
                } catch (error: any) {
                  await logger.slack(
                    "poller_manager",
                    `Failed to start poller ${pollerData.pollerId}: ${
                      error?.message ?? "Unknown error!"
                    }`,
                    undefined,
                    undefined,
                    error
                  );
                }
              }
              break;

            case "STOP":
              if (existingPoller && existingPoller.isRunning) {
                try {
                  await existingPoller.stopPolling();
                  pollers.delete(pollerData.poolId);
                  await logger.slack(
                    "poller_manager",
                    `Stopped poller ${pollerData.pollerId}`
                  );
                } catch (error: any) {
                  await logger.slack(
                    "poller_manager",
                    `Failed to stop poller ${pollerData.pollerId}: ${
                      error?.message ?? "Unknown error!"
                    }`,
                    undefined,
                    undefined,
                    error
                  );
                }
              }
              break;

            case "RESTART":
              if (existingPoller) {
                try {
                  const success = await existingPoller.restart();
                  if (success) {
                    logger.log(
                      "poller_manager",
                      `Restarted poller ${pollerData.pollerId}`
                    );
                  }
                } catch (error: any) {
                  await logger.slack(
                    "poller_manager",
                    `Failed to restart poller ${pollerData.pollerId}: ${
                      error?.message ?? "Unknown error!"
                    }`,
                    undefined,
                    undefined,
                    error
                  );
                }
              }
              break;
          }
        }
      } catch (error: any) {
        await logger.slack(
          "poller_manager",
          `Error monitoring poller changes: ${
            error?.message ?? "Unknown error!"
          }`,
          undefined,
          undefined,
          error
        );
      }

      await sleep(10000);
    }
  } catch (error: any) {
    await logger.slack(
      "poller_manager",
      `Fatal error in poller monitoring loop: ${
        error?.message ?? "Unknown error!"
      }`
    );
    process.exit(1);
  }
}

// API Endpoints

// Get all pollers and their status
app.get("/api/pollers", async (req, res) => {
  try {
    const dbPollers = await prisma.pollers.findMany();

    const response = dbPollers.map((pollerData) => {
      const existingPoller = pollers.get(pollerData.poolId);
      return {
        ...pollerData,
        protocol: getIdMap(ProtocolLabels)[pollerData.protocol],
        status: getIdMap(PollerStatusLabels)[pollerData.status],
        runtimeStatus: existingPoller
          ? existingPoller.isRunning
            ? "RUNNING"
            : existingPoller.isRestarting
            ? "RESTARTING"
            : "STOPPED"
          : "NOT_INITIALIZED",
      };
    });

    res.json(response);
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Unknown error" });
  }
});

// Get specific poller status
app.get("/api/pollers/:poolId", async (req, res) => {
  try {
    const pollerData = await prisma.pollers.findFirst({
      where: {
        poolId: req.params.poolId,
      },
    });

    if (!pollerData) {
      res.status(404).json({ error: "Poller not found" });
      return;
    }

    const poller = pollers.get(pollerData.poolId);

    const response = {
      ...pollerData,
      protocol: getIdMap(ProtocolLabels)[pollerData.protocol],
      status: getIdMap(PollerStatusLabels)[pollerData.status],
      runtimeStatus: poller
        ? poller.isRunning
          ? "RUNNING"
          : poller.isRestarting
          ? "RESTARTING"
          : "STOPPED"
        : "NOT_INITIALIZED",
    };

    res.json(response);
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Unknown error" });
  }
});

// Get latest data from poller
app.get("/api/pollers/:poolId/snapshot", async (req, res) => {
  try {
    const pollerData = await prisma.pollers.findFirst({
      where: { poolId: req.params.poolId },
    });

    if (!pollerData) {
      res.status(404).json({ error: "Poller not found" });
      return;
    }

    const poller = pollers.get(pollerData.poolId);
    if (!poller) {
      res.status(404).json({ error: "Poller not running" });
      return;
    }

    const latestData = poller.getLatestData();
    res.json({
      price: latestData.price,
      timestamp: latestData.timestamp,
      isLive: poller
        ? poller.isRunning || poller.isRestarting
          ? true
          : false
        : false,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Unknown error" });
  }
});

// Get latest data from poller
app.get("/api/pollers/:poolId/data", async (req, res) => {
  try {
    const pollerData = await prisma.pollers.findFirst({
      where: { poolId: req.params.poolId },
    });

    if (!pollerData) {
      res.status(404).json({ error: "Poller not found" });
      return;
    }

    const poller = pollers.get(pollerData.poolId);
    if (!poller) {
      res.status(404).json({ error: "Poller not running" });
      return;
    }

    const latestData = poller.getLatestData();
    res.json(latestData);
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Unknown error" });
  }
});

// Start a poller
app.post("/api/pollers/:poolId/start", async (req, res) => {
  try {
    const pollerData = await prisma.pollers.findFirst({
      where: { poolId: req.params.poolId },
    });

    if (!pollerData) {
      res.status(404).json({ error: "Poller not found" });
      return;
    }

    await prisma.pollers.update({
      where: { id: pollerData.id },
      data: { status: "START" },
    });

    res.json({ message: `Poller ${pollerData.pollerId} set to start` });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Unknown error" });
  }
});

// Stop a poller
app.post("/api/pollers/:poolId/stop", async (req, res) => {
  try {
    const pollerData = await prisma.pollers.findFirst({
      where: { poolId: req.params.poolId },
    });

    if (!pollerData) {
      res.status(404).json({ error: "Poller not found" });
      return;
    }

    const distinctBots = await prisma.botConfig.findMany({
      where: {
        poolId: req.params.poolId,
        status: {
          not: "STOP",
        },
      },
      distinct: ["botId"],
      select: {
        botId: true,
      },
    });

    if (distinctBots.length > 0) {
      res.json({ message: `Poller ${pollerData.pollerId} has active bots!` });
      return;
    }

    await prisma.pollers.update({
      where: { id: pollerData.id },
      data: { status: "STOP" },
    });

    res.json({ message: `Poller ${pollerData.pollerId} set to stop` });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Unknown error" });
  }
});

// Restart a poller
app.post("/api/pollers/:poolId/restart", async (req, res) => {
  try {
    const pollerData = await prisma.pollers.findFirst({
      where: { poolId: req.params.poolId },
    });

    if (!pollerData) {
      res.status(404).json({ error: "Poller not found" });
      return;
    }

    const poller = pollers.get(pollerData.poolId);
    if (!poller) {
      res.status(404).json({ error: "Poller not running" });
      return;
    }

    await prisma.pollers.update({
      where: { poolId: pollerData.poolId },
      data: { status: "RESTART" },
    });
    const run = await poller.restart();

    if (run)
      await prisma.pollers.update({
        where: { poolId: pollerData.poolId },
        data: { status: "RUN" },
      });

    res.json({ message: `Poller ${pollerData.pollerId} set to restart` });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Unknown error" });
  }
});

// Start a poller
app.post("/api/bots/:botId/sweep", async (req, res) => {
  try {
    const botData = await prisma.botConfig.findFirst({
      where: { botId: req.params.botId },
    });

    if (!botData) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }

    convertFeesToTargetToken(req.params.botId);

    res.json({ message: `Sweeping started for ${req.params.botId}` });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Unknown error" });
  }
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");

  for (const poller of pollers.values()) {
    await poller.stopPolling();
  }

  await prisma.$disconnect();
  logger.close();

  console.log("Shutdown complete");
  process.exit(0);
});

export { port, app, monitorPollers };
