import Decimal from "decimal.js";
import {
  ProtocolLabels,
  StatusLabels,
  StrategyLabels,
  getIdMap,
  maxRetries,
} from "./constants";
import { BotConfig, StrategyParams } from "./types";

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const serialize = (object: any) => {
  return JSON.stringify(object, (key, value) =>
    value instanceof Decimal ? value.toString() : value
  );
};

/**
 * Fetches data from a URL with retry logic
 * @param url The URL to fetch data from
 * @param options Optional fetch options
 * @returns The parsed JSON response
 */
export async function fetchWithRetry<T>(
  url: string,
  options?: RequestInit,
  log: any = console.log
): Promise<T> {
  let retryCount = 0;

  while (true) {
    try {
      const response = await fetch(url, options);

      if (response.status === 429) {
        log(`${url} rate limited. Retrying in ${2 ** retryCount}s`);
        await sleep(2 ** retryCount * 1000);
        retryCount++;
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `Request failed with status ${response.status}: ${response.statusText}`
        );
      }

      return (await response.json()) as T;
    } catch (error: any) {
      if (retryCount < maxRetries) {
        log(
          `Error for ${url}: ${
            error?.message ?? "Unknown error"
          }, retrying in ${2 ** retryCount}s (attempt ${
            retryCount + 1
          }/${maxRetries})`
        );

        await sleep(2 ** retryCount * 1000);
        retryCount++;
        continue;
      }

      throw error;
    }
  }
}

export function convertBotConfig(config: any): BotConfig {
  const params: StrategyParams = config.params;

  if (params?.coinA) {
    params.coinA = {
      ...params.coinA,
      amount: new Decimal(params.coinA.amount),
    };
  }

  if (params?.coinB) {
    params.coinB = {
      ...params.coinB,
      amount: new Decimal(params.coinB.amount),
    };
  }

  return {
    botId: config.botId,
    sender: config.sender,
    protocol: getIdMap(ProtocolLabels)[config.protocol as string],
    strategy: getIdMap(StrategyLabels)[config.strategy as string],
    poolId: config.poolId,
    slippage: config.slippage,
    params,
    continue: config.continue || false,
    status: getIdMap(StatusLabels)[config.status as string],
    instanceId: config.instanceId,
  };
}
