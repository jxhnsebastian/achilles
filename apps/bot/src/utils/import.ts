import { Decimal } from "decimal.js";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "@achilles/db";
import { memory } from "./utils";

/**
 * Imports bot memories from JSONL files into the Prisma database
 * @param filePathOrName Path to a single JSONL file or directory containing JSONL files
 * @param options Configuration options for the import process
 * @returns Promise resolving to the number of records successfully imported
 */
export async function importBotMemoriesFromFiles(
  filePathOrName: string,
  options: {
    // If true, import all .json and .jsonl files in the directory
    recursive?: boolean;
    // If provided, only import files for this specific bot ID
    specificBotId?: string;
  } = {}
): Promise<number> {
  let importCount = 0;

  try {
    const stats = fs.statSync(filePathOrName);

    if (stats.isDirectory()) {
      // Process all files in directory
      const files = fs
        .readdirSync(filePathOrName)
        .filter(
          (file) =>
            (file.endsWith("-memories.json") || file.endsWith(".jsonl")) &&
            (!options.specificBotId || file.includes(options.specificBotId))
        );
      console.log("Files: ", files?.length);

      for (const file of files) {
        const filePath = path.join(filePathOrName, file);
        const count = await processFile(filePath);
        importCount += count;
        console.log(`Imported ${count} records from ${file}`);
      }

      // If recursive option is enabled, process subdirectories
      if (options.recursive) {
        const subdirs = fs
          .readdirSync(filePathOrName, { withFileTypes: true })
          .filter((dirent) => dirent.isDirectory())
          .map((dirent) => dirent.name);

        for (const subdir of subdirs) {
          const subdirPath = path.join(filePathOrName, subdir);
          const count = await importBotMemoriesFromFiles(subdirPath, options);
          importCount += count;
        }
      }
    } else {
      // Process single file
      const count = await processFile(filePathOrName);
      importCount += count;
      console.log(
        `Imported ${count} records from ${path.basename(filePathOrName)}`
      );
    }
  } catch (error) {
    console.error(`Error importing bot memories: ${error}`);
  } finally {
    await prisma.$disconnect();
  }

  return importCount;
}

/**
 * Processes a single JSONL file and imports its records
 * @param filePath Path to the JSONL file
 * @param prisma PrismaClient instance
 * @returns Number of records successfully imported
 */
async function processFile(filePath: string): Promise<number> {
  let importCount = 0;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    // Extract botId from filename if possible (format: {botId}-memories.json)
    let filenameBotId: string | undefined;
    const fileName = path.basename(filePath);
    const match = fileName.match(/^(.+)-memories\.json/);
    if (match) {
      filenameBotId = match[1];
    }

    for (const line of lines) {
      try {
        // Parse the JSON line
        const entry = JSON.parse(line);

        // Use botId from the entry or from the filename as fallback
        const botId = entry.botId || filenameBotId;

        if (!botId) {
          console.warn(
            `Skipping entry without botId: ${line.substring(0, 100)}...`
          );
          continue;
        }

        // Convert any string decimals to Decimal objects
        const memoryEntry = {
          ...entry,
          botId,
          coinA: memory.validateDecimal(
            entry.coinA instanceof Decimal
              ? entry.coinA
              : new Decimal(entry.coinA)
          ),
          coinB: memory.validateDecimal(
            entry.coinB instanceof Decimal
              ? entry.coinB
              : new Decimal(entry.coinB)
          ),
          price: memory.validateDecimal(
            entry.price instanceof Decimal
              ? entry.price
              : new Decimal(entry.price)
          ),
          l_coefficient: memory.validateDecimal(
            entry.l_coefficient instanceof Decimal
              ? entry.l_coefficient
              : new Decimal(entry.l_coefficient)
          ),
          value: memory.validateDecimal(
            entry.value instanceof Decimal
              ? entry.value
              : new Decimal(entry.value)
          ),
          // Ensure timestamp is a number
          timestamp:
            typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
          // Ensure action is valid
          action: ["open", "close", "swap", "collect"].includes(entry.action)
            ? entry.action
            : "open",
        };

        // Add memory entry to database
        await memory.addMemory(memoryEntry);
        importCount++;
      } catch (err) {
        console.error(`Error processing line: ${err}`);
      }
    }
  } catch (error) {
    console.error(`Error reading file ${filePath}: ${error}`);
  }

  return importCount;
}

/**
 * Usage example:
 *
 * // Import all files from a directory
 * importBotMemoriesFromFiles('./memories').then(count => {
 *   console.log(`Imported ${count} total records`);
 * });
 *
 * // Import a specific file
 * importBotMemoriesFromFiles('./memories/bot123-memories.json').then(count => {
 *   console.log(`Imported ${count} records for bot123`);
 * });
 *
 * // Import all files for a specific bot
 * importBotMemoriesFromFiles('./memories', { specificBotId: 'bot123' }).then(count => {
 *   console.log(`Imported ${count} records for bot123`);
 * });
 */

await importBotMemoriesFromFiles("./memories").then((count) => {
  console.log(`Successfully imported ${count} bot memory records`);
});
