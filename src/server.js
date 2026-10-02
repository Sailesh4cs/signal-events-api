import { readConfig } from "./config.js";
import { createApp } from "./app.js";

let config;
try {
  config = readConfig();
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const { server, store } = await createApp(config).catch((err) => {
  console.error(`Startup failed: ${err.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const { port } = server.address();
  console.log(`signal-events-api listening on http://${config.host}:${port} (data: ${config.dataFile})`);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await store.flush();
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));