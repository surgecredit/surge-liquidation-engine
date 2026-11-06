import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { createDashboard, MultiDashboard, type Dashboard } from "./ui.js";
import { WebDashboard } from "./webui.js";
import { Engine } from "./engine.js";

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    // Config errors happen before the UI exists, so print plainly and exit.
    // eslint-disable-next-line no-console
    console.error(`\nConfiguration error: ${(e as Error).message}\n`);
    process.exit(1);
    return;
  }

  const logger = new Logger(cfg.logFile);
  const base = createDashboard(!cfg.noUi);
  let dashboard: Dashboard = base;
  if (cfg.webUi) {
    const web = new WebDashboard(
      cfg.webPort,
      cfg.webHost,
      (url) => logger.info(`Web dashboard on ${url}`),
      (msg) => logger.error(msg),
    );
    dashboard = new MultiDashboard([base, web]);
  }
  logger.addSink((e) => dashboard.logEntry(e));

  const engine = new Engine(cfg, logger, dashboard);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    engine.stop();
    logger.info("Shutting down.");
    logger.close();
    dashboard.destroy();
    process.exit(0);
  };

  dashboard.onQuit(shutdown);
  process.on("SIGTERM", shutdown);

  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection: ${String(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
  });

  await engine.start();
}

void main();
