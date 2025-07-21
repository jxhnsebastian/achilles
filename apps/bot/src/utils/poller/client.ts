import { fetchWithRetry, type PoolTick } from "@achilles/utils";
import Decimal from "decimal.js";

interface PriceData {
  price: number;
  timestamp: number;
  isLive: boolean;
}

export class PollerClient {
  private readonly poolId: string;
  private readonly baseUrl: string;

  /**
   * Creates a new PollerClient
   * @param poolId The poolID of the poller
   * @param baseUrl The base URL for the API (defaults to '')
   */
  constructor(poolId: string, baseUrl: string = "") {
    this.poolId = poolId;
    this.baseUrl = baseUrl;
  }

  /**
   * Gets the latest data from the poller
   * @returns The latest data
   */
  async getLatestData(): Promise<{
    price: Decimal;
    ticks: PoolTick[];
    timestamp: number;
  }> {
    const url = `${this.baseUrl}/api/pollers/${this.poolId}/data`;
    const poolData = await fetchWithRetry<{
      price: number;
      ticks: PoolTick[];
      timestamp: number;
    }>(url);
    return { ...poolData, price: new Decimal(poolData.price) };
  }

  /**
   * Gets the latest price data from the poller
   * @returns The latest price data
   */
  async getLatestPrice(): Promise<Decimal> {
    const url = `${this.baseUrl}/api/pollers/${this.poolId}/snapshot`;
    const priceData = await fetchWithRetry<PriceData>(url);
    return new Decimal(priceData.price);
  }

  /**
   * Gets the latest update timestamp from the poller
   * @returns The latest update timestamp
   */
  async getLatestUpdate(): Promise<number> {
    const url = `${this.baseUrl}/api/pollers/${this.poolId}/snapshot`;
    const priceData = await fetchWithRetry<PriceData>(url);
    return priceData.timestamp;
  }

  /**
   * Gets the status from the poller
   * @returns The status of a poller
   */
  async isLive(): Promise<boolean> {
    const url = `${this.baseUrl}/api/pollers/${this.poolId}`;
    const status = await fetchWithRetry<{ runtimeStatus: string }>(url);
    return status.runtimeStatus === "RUNNING" ||
      status.runtimeStatus === "RESTARTING"
      ? true
      : false;
  }

  /**
   * Gets the price and status snapshot from the poller
   * @returns The price and status of a poller
   */
  async getSnapshot(): Promise<{
    price: Decimal;
    timestamp: number;
    isLive: boolean;
  }> {
    const url = `${this.baseUrl}/api/pollers/${this.poolId}/snapshot`;
    const snapshot = await fetchWithRetry<PriceData>(url);
    return {
      ...snapshot,
      price: new Decimal(snapshot.price),
      isLive: snapshot?.isLive ?? false,
    };
  }

  /**
   * Restarts the poller
   * @returns A message confirming the poller was set to restart
   */
  async restartPoller(): Promise<{ message: string }> {
    const url = `${this.baseUrl}/api/pollers/${this.poolId}/restart`;
    return await fetchWithRetry<{ message: string }>(url, {
      method: "POST",
    });
  }
}
