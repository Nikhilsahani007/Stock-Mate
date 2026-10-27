import { createApp } from "./app.js";
import { prisma } from "./db.js";
import { env } from "./env.js";

const server = createApp().listen(env.PORT, () => {
  console.log(`StockPilot API listening on http://localhost:${env.PORT}`);
});

const shutdown = () => {
  server.close(() => void prisma.$disconnect().then(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
