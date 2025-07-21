import os from "os";

import { Kafka, CompressionTypes, Producer, ProducerRecord, logLevel } from "kafkajs";

export type SASLMechanism = "plain" | "scram-sha-256" | "scram-sha-512";
export type SASLOptions =
  | {
      mechanism: "plain";
      username: string;
      password: string;
    }
  | {
      mechanism: "scram-sha-256";
      username: string;
      password: string;
    }
  | {
      mechanism: "scram-sha-512";
      username: string;
      password: string;
    };

export interface RedpandaConfig {
  brokers: string[];
  ssl?: boolean;
  sasl?: SASLOptions;
  logLevel?: logLevel;
}

export interface MessageOptions {
  topic: string;
  key?: string;
  compression?: CompressionTypes;
}

export class RedpandaClient {
  private kafka: Kafka;
  private producer: Producer;
  private isConnected: boolean = false;

  constructor(config: RedpandaConfig) {
    this.kafka = new Kafka(config);
    this.producer = this.kafka.producer();
  }

  async connect(): Promise<void> {
    if (!this.isConnected) {
      try {
        console.log("Connecting to Redpanda");
        await this.producer.connect();
        this.isConnected = true;
        console.log("Connected to Redpanda");
      } catch (error) {
        console.error("Failed to connect to Redpanda:", error);
        throw error;
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.isConnected) {
      await this.producer.disconnect();
      this.isConnected = false;
    }
  }

  async sendMessage<T>(message: T, options: MessageOptions): Promise<void> {
    if (!this.isConnected) {
      throw new Error("Producer is not connected. Call connect() first.");
    }

    const record: ProducerRecord = {
      topic: options.topic,
      compression: options.compression || CompressionTypes.GZIP,
      messages: [
        {
          key: options.key || os.hostname(),
          value: JSON.stringify(message),
        },
      ],
    };

    try {
      await this.producer.send(record);
    } catch (error) {
      console.error("Failed to send message:", error);
      throw error;
    }
  }

  async sendBatch<T>(messages: T[], options: MessageOptions): Promise<void> {
    if (!this.isConnected) {
      throw new Error("Producer is not connected. Call connect() first.");
    }

    const record: ProducerRecord = {
      topic: options.topic,
      compression: options.compression || CompressionTypes.GZIP,
      messages: messages.map((message) => ({
        key: options.key || os.hostname(),
        value: JSON.stringify(message),
      })),
    };

    try {
      await this.producer.send(record);
    } catch (error) {
      console.error("Failed to send batch messages:", error);
      throw error;
    }
  }
}
