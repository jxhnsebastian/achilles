import { WebClient } from "@slack/web-api";
import fs from "fs";
import path from "path";
import { HUD_DATA_ALERTS_CHANNEL } from "./helpers";

export class SlackBot {
  private client: WebClient;
  private defaultChannel: string;

  constructor() {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error("SLACK_BOT_TOKEN is not set in environment variables");
    }

    this.client = new WebClient(token);
    this.defaultChannel = process.env.DEFAULT_CHANNEL_ID || "";
  }

  /**
   * Send a simple text message to a Slack channel or thread
   * @param message Text message to send
   * @param channelId Channel ID to send to (optional - uses default if not provided)
   * @param threadTs Thread timestamp to reply to (optional - if provided, sends to thread)
   * @returns The timestamp of the sent message
   */
  async sendMessage(
    message: string,
    channelId?: string,
    threadTs?: string
  ): Promise<string | undefined> {
    const channel = channelId || this.defaultChannel;
    if (!channel) {
      throw new Error("No channel ID provided and no default channel set");
    }

    try {
      const messageParams: any = {
        channel,
        text: message,
      };

      // If threadTs is provided, add it to send to a thread
      if (threadTs) {
        messageParams.thread_ts = threadTs;
      }

      const result = await this.client.chat.postMessage(messageParams);

      console.info(
        `Message sent to ${threadTs ? "thread in " : ""}channel ${channel}`
      );

      // Return the timestamp so it can be used for replies
      return result.ts;
    } catch (error) {
      console.error("Error sending message: ", error);
      throw error;
    }
  }

  /**
   * Send a formatted message using Slack Block Kit
   * @param blocks Array of Block Kit blocks
   * @param fallbackText Fallback text for notifications
   * @param channelId Channel ID to send to (optional - uses default if not provided)
   */
  async sendFormattedMessage(
    blocks: any[],
    fallbackText: string,
    channelId?: string
  ): Promise<string | undefined> {
    const channel = channelId || this.defaultChannel;
    if (!channel) {
      throw new Error("No channel ID provided and no default channel set");
    }

    try {
      const result = await this.client.chat.postMessage({
        channel,
        text: fallbackText,
        blocks,
      });

      console.info(`Formatted message sent to channel ${channel}`);
      return result.ts;
    } catch (error) {
      console.error("Error sending formatted message: ", error);
      throw error;
    }
  }

  /**
   * Send a file to a Slack channel
   * @param filePath Path to the file to upload
   * @param comment Optional comment to add with the file
   * @param channelId Channel ID to send to (optional - uses default if not provided)
   */
  async sendFile(
    filePath: string,
    comment?: string,
    channelId?: string
  ): Promise<void> {
    const channel = channelId || this.defaultChannel;
    if (!channel) {
      throw new Error("No channel ID provided and no default channel set");
    }

    try {
      // Read the file
      const fileName = path.basename(filePath);
      const fileContent = fs.readFileSync(filePath);

      // Upload the file
      await this.client.files.upload({
        channels: channel,
        filename: fileName,
        file: fileContent,
        initial_comment: comment,
      });

      console.info(`File ${fileName} uploaded to channel ${channel}`);
    } catch (error) {
      console.error("Error uploading file: ", error);
      throw error;
    }
  }
}

export async function sendAlert(
  message: string,
  channel?: string
): Promise<string | undefined> {
  const bot = new SlackBot();

  try {
    const ts = await bot.sendMessage(
      message,
      channel ?? HUD_DATA_ALERTS_CHANNEL
    );
    return ts;
  } catch (error) {
    console.error("Failed to send alerts:", error);
  }
}