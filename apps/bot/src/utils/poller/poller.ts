import Decimal from "decimal.js";
import { BluefinClient } from "../sui/bluefin";
import { Protocol, type PoolTick } from "@achilles/utils";
import { CetusClient } from "../sui/cetus";
import { checkFrequency, sleep } from "@achilles/utils";
import { EventEmitter } from "events";
import logger from "../logger";
import { Orca } from "../solana/orca";
import { Raydium } from "../solana/raydium";
Decimal.set({ precision: 9 });

export class Poller extends EventEmitter {
  private protocolSDK: BluefinClient | CetusClient | Orca | Raydium =
    new BluefinClient();
  public isRunning: boolean = false;
  public isRestarting: boolean = false;
  private protocol: Protocol;
  private ticks: PoolTick[] = [];
  private price: Decimal = new Decimal(0);
  private lastUpdated: number = Date.now();
  private updateInterval = checkFrequency;
  private poolId: string;
  public pollerId: string = "poller";
  private pollingPromise: Promise<void> | null = null;

  constructor(
    protocol: Protocol,
    poolId: string,
    pollerId: string = "poller",
    updateInterval?: number
  ) {
    super();
    if (protocol === undefined || protocol == null)
      throw new Error(`Protocol required!`);
    if (!poolId) throw new Error(`Pool id required`);

    this.protocol = protocol;
    this.poolId = poolId;
    updateInterval ? (this.updateInterval = updateInterval) : null;
    this.pollerId = pollerId;
  }

  async initialize() {
    let poolName = "";
    let protocol = "";

    switch (this.protocol) {
      case Protocol.BLUEFIN:
        this.protocolSDK = new BluefinClient();
        await this.protocolSDK.setPoolInfo(this.poolId);
        poolName = this.protocolSDK.poolInfo.name;
        protocol = "Bluefin";
        break;
      case Protocol.CETUS:
        this.protocolSDK = new CetusClient("");
        await this.protocolSDK.setPoolInfo(this.poolId);
        poolName = this.protocolSDK.poolInfo.name;
        protocol = "Cetus";
        break;
      case Protocol.ORCA:
        this.protocolSDK = new Orca();
        await this.protocolSDK.setPoolInfo(this.poolId);
        poolName = `ORCA ${this.protocolSDK.poolInfo.tokenMintA} | ${this.protocolSDK.poolInfo.tokenMintB}`;
        protocol = "ORCA";
        break;
      case Protocol.RAYDIUM:
        this.protocolSDK = new Raydium();
        await this.protocolSDK.setPoolInfo(this.poolId);
        poolName = `Raydium ${this.protocolSDK.poolInfo.mintA.address} | ${this.protocolSDK.poolInfo.mintB.address}`;
        protocol = "Raydium";
        break;
      default:
        throw new Error("Unknown protocol");
    }

    logger.log(
      this.pollerId,
      `Initializing ${protocol} poller (id: ${this.pollerId}) for ${poolName} pool..`
    );
    this.price = await this.getPoolPrice();
    this.ticks = await this.getPoolTicks();
    this.lastUpdated = Date.now();
  }

  private async getPoolTicks(): Promise<PoolTick[]> {
    return this.protocolSDK.getPoolTicks();
  }

  private async getPoolPrice() {
    return this.protocolSDK.getPoolPrice();
  }

  private isInitialized(): boolean {
    switch (this.protocol) {
      case Protocol.BLUEFIN:
        return !!(this.protocolSDK as BluefinClient).poolInfo.id;
      case Protocol.CETUS:
        return !!(this.protocolSDK as CetusClient).poolInfo.poolAddress;
      case Protocol.ORCA:
        return !!(this.protocolSDK as Orca).poolInfo.address;
      case Protocol.RAYDIUM:
        return !!(this.protocolSDK as Raydium).poolInfo.id;
      default:
        throw new Error("Unknown protocol");
    }
  }

  getLatestData() {
    return {
      price: this.price,
      ticks: this.ticks,
      timestamp: this.lastUpdated,
    };
  }

  async stopPolling() {
    if (!this.isRunning) {
      logger.log(this.pollerId, "Poller is already stopped");
      return;
    }

    logger.log(this.pollerId, "Stopping Poller");
    this.isRunning = false;

    const maxWaitTime = 10000;
    const startTime = Date.now();

    while (this.pollingPromise !== null) {
      if (Date.now() - startTime > maxWaitTime) {
        logger.log(this.pollerId, "Force stopping poller after timeout");
        this.pollingPromise = null;
        break;
      }
      await sleep(1000);
    }

    logger.log(this.pollerId, "Poller stopped");
    return;
  }

  async restart() {
    if (this.isRestarting) {
      logger.log(
        this.pollerId,
        "Poller already in a restart process. Ignoring this call."
      );
      return false;
    }

    this.isRestarting = true;
    try {
      await this.stopPolling();

      logger.log(this.pollerId, "Restarting Poller");

      if (!this.isInitialized()) {
        await this.initialize();
      }

      await this.startPolling();
      return true;
    } catch (error) {
      logger.log(this.pollerId, `Error during restart: ${error}`);
      throw error;
    } finally {
      this.isRestarting = false;
    }
  }

  async startPolling() {
    if (this.isRunning) {
      logger.log(this.pollerId, "Polling already running. Ignoring this call.");
      return;
    }

    if (!this.isInitialized()) throw new Error("Poller is not initialized!");

    this.isRunning = true;
    logger.log(this.pollerId, "Starting Poller");

    this.pollingPromise = this.poll();

    this.pollingPromise
      .catch((error) => {
        logger.log(
          this.pollerId,
          `Polling loop terminated with error: ${error}`
        );
        this.isRunning = false;
        this.pollingPromise = null;
      })
      .finally(() => {
        // Ensure cleanup if polling ends for any reason
        if (this.isRunning) {
          this.isRunning = false;
          logger.log(this.pollerId, "Polling loop terminated unexpectedly.");
        }
        this.pollingPromise = null;
      });
  }

  private async poll() {
    const MAX_FAILS = 5;
    const wait = 2;
    let fails = 0;

    while (this.isRunning) {
      try {
        this.price = await this.getPoolPrice();
        this.ticks = await this.getPoolTicks();
        this.lastUpdated = Date.now();

        fails = 0;
        await sleep(this.updateInterval);
      } catch (error: any) {
        fails++;

        if (error?.message?.includes("401")) {
          await logger.slack(
            this.pollerId,
            `ALERT: RPC issue for ${this.pollerId}! <@U08D7607G65>`
          );
        }

        if (fails <= MAX_FAILS) {
          logger.log(
            this.pollerId,
            `Critical poller error: ${
              error.message
            }. Retry ${fails}/${MAX_FAILS}. Sleeping for ${wait * fails}s...`
          );
          await sleep(wait ** fails * 1000);
          continue;
        }

        await logger.slack(
          this.pollerId,
          `Critical poller error: ${error.message} <@U08D7607G65>`
        );

        this.isRunning = false;
        throw error;
      }
    }
  }
}
