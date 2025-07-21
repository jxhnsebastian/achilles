import * as fs from "fs";
import * as path from "path";
import { HUD_DATA_ALERTS_CHANNEL } from "@achilles/utils";
import { SlackBot } from "@achilles/utils/server";

interface LoggerOptions {
  logDirectory?: string;
  enableFileLogging?: boolean;
  bufferSize?: number;
  maxLogSize?: number; // Maximum size of each log file in bytes
  maxLogFiles?: number; // Maximum number of rotated log files to keep
}

class TerminalLogger {
  private logFiles: Record<string, fs.WriteStream> = {};
  private logSizes: Record<string, number> = {};
  private logDirectory: string;
  private enableFileLogging: boolean;
  private bufferSize: number;
  private maxLogSize: number;
  private maxLogFiles: number;
  private bot = new SlackBot();

  constructor(options: LoggerOptions = {}) {
    this.logDirectory = options.logDirectory || "apps/bot/bot-logs";
    this.enableFileLogging = options.enableFileLogging !== false;
    this.bufferSize = options.bufferSize || 4096; // Default 4KB buffer
    this.maxLogSize = options.maxLogSize || 10 * 1024 * 1024; // Default 10MB per file
    this.maxLogFiles = options.maxLogFiles || 5; // Default keep 5 rotated files

    // Create log directory if it doesn't exist
    if (this.enableFileLogging) {
      if (!fs.existsSync(this.logDirectory)) {
        fs.mkdirSync(this.logDirectory, { recursive: true });
      }
    }
  }

  /**
   * Rotate log file if it exceeds the maximum size
   * @param sectionId - Section identifier
   * @private
   */
  private rotateLogIfNeeded(sectionId: string): void {
    const baseLogFilePath = path.join(this.logDirectory, `${sectionId}.log`);

    // Check if current log file exists and its size
    if (fs.existsSync(baseLogFilePath)) {
      const stats = fs.statSync(baseLogFilePath);

      // If file exceeds max size, rotate logs
      if (stats.size >= this.maxLogSize) {
        // Close current write stream if open
        if (this.logFiles[sectionId]) {
          this.logFiles[sectionId].end();
          delete this.logFiles[sectionId];
        }

        // Rotate existing backup logs
        for (let i = this.maxLogFiles - 1; i > 0; i--) {
          const oldFile = path.join(this.logDirectory, `${sectionId}.${i}.log`);
          const newFile = path.join(
            this.logDirectory,
            `${sectionId}.${i + 1}.log`
          );

          if (fs.existsSync(oldFile)) {
            if (i === this.maxLogFiles - 1) {
              // Delete the oldest log file if we've reached max
              fs.unlinkSync(oldFile);
            } else {
              // Rename to next number
              fs.renameSync(oldFile, newFile);
            }
          }
        }

        // Rename current log to .1.log
        fs.renameSync(
          baseLogFilePath,
          path.join(this.logDirectory, `${sectionId}.1.log`)
        );

        // Reset log size counter
        this.logSizes[sectionId] = 0;
      }
    }
  }

  /**
   * Log a message to a section, managing a scrolling log of messages
   * @param sectionId - Section identifier
   * @param message - Message to log
   * @param status - If true, updates only the first line (for status messages)
   */
  public log(sectionId: string = "bot", message: string, info?: any): void {
    let infoString = "";
    if (info !== undefined) {
      try {
        if (typeof info === "object") {
          infoString = JSON.stringify(info);
        } else {
          infoString = String(info);
        }
      } catch (error) {
        infoString = "[Object could not be converted to string]";
      }
    }

    const timestamp = new Date().toLocaleTimeString();
    const formattedMessage = `[${timestamp}] ${message}`;
    const logLine = `${new Date().toISOString()} - ${message} ${
      infoString.length > 0 ? infoString : ""
    }\n`;

    console.log(formattedMessage, info ? info : "");

    // Handle file logging if enabled
    if (this.enableFileLogging) {
      // Check if log rotation is needed
      this.rotateLogIfNeeded(sectionId);

      // Create or get existing write stream
      if (!this.logFiles[sectionId]) {
        const logFilePath = path.join(this.logDirectory, `${sectionId}.log`);
        this.logFiles[sectionId] = fs.createWriteStream(logFilePath, {
          flags: "a", // Append mode
          highWaterMark: this.bufferSize,
          autoClose: true,
        });

        // Initialize log size if needed
        if (!this.logSizes[sectionId]) {
          this.logSizes[sectionId] = fs.existsSync(logFilePath)
            ? fs.statSync(logFilePath).size
            : 0;
        }
      }

      // Write to log file and update size tracking
      this.logFiles[sectionId].write(logLine);
      this.logSizes[sectionId] += Buffer.byteLength(logLine);

      // Force flush to ensure real-time writing
      // this.logFiles[sectionId].flush();
    }
  }

  /**
   * Log a message to slack
   * @param sectionId - Section identifier
   * @param message - Message to log
   * @param ts - Optional thread
   * @param info - Optional info
   */
  public async slack(
    sectionId: string = "bot",
    message: string,
    channel?: string,
    ts?: string,
    info?: any
  ): Promise<string | undefined> {
    this.log(sectionId, message, info);
    const thread = await this.bot.sendMessage(
      message,
      channel ?? HUD_DATA_ALERTS_CHANNEL,
      ts
    );
    return thread;
  }

  /**
   * Close all log files when application terminates
   */
  public close(): void {
    if (this.enableFileLogging) {
      for (const sectionId in this.logFiles) {
        if (this.logFiles[sectionId]) {
          this.logFiles[sectionId].end();
        }
      }
    }
  }
}

export default new TerminalLogger({
  logDirectory: "apps/bot/bot-logs",
  enableFileLogging: true,
  maxLogSize: 5 * 1024 * 1024, // 5MB per log file
  maxLogFiles: 3, // Keep 3 rotated log files
});
