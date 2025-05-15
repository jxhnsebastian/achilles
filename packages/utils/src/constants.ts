export const HUD_DATA_ALERTS_CHANNEL = "C08F9TM8UJW";
export const checkFrequency = 10000;
export const maxRetries = 5;
export const wait = 2;

export const ProtocolLabels: {
  [key: number]: "BLUEFIN" | "CETUS" | "ORCA" | "RAYDIUM";
} = {
  0: "BLUEFIN",
  1: "CETUS",
  2: "ORCA",
  3: "RAYDIUM",
};

export const StrategyLabels: { [key: number]: "CHASER" | "INRANGE" } = {
  0: "CHASER",
  1: "INRANGE",
};

export const StatusLabels: {
  [key: number]: "START" | "RUN" | "REBALANCE" | "UPDATE" | "STOP";
} = {
  0: "START",
  1: "RUN",
  2: "REBALANCE",
  3: "UPDATE",
  4: "STOP",
};

export const PollerStatusLabels: {
    [key: number]: "START" | "RUN" | "RESTART" | "STOP";
  } = {
    0: "START",
    1: "RUN",
    2: "RESTART",
    3: "STOP",
  };

export function getIdMap<U extends string>(
  forwardMap: Record<number, U>
): Record<string, number> {
  const reverseMap = Object.entries(forwardMap).reduce((acc, [key, value]) => {
    acc[value] = Number(key);
    return acc;
  }, {} as Record<string, number>);

  return reverseMap;
}
