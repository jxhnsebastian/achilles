import { monitorPollers, app, port } from "./utils/poller/server";
import logger from "./utils/logger";

if (require.main === module) {
  try {
    monitorPollers();

    app.listen(port, () => {
      logger.log("API", `API server running on port ${port}`);
    });

    logger.log("poller_manager", "Poller server started!");
  } catch (error: any) {
    logger.log("poller_manager", `Failed to start server: ${error.message}`);
    process.exit(1);
  }
}
