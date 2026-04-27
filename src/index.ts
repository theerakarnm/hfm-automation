import { Hono } from "hono";
import webhook from "./routes/webhook";
import internal from "./routes/internal";
import { registerJobs } from "./jobs";

const app = new Hono();
app.route("/webhook", webhook);
app.route("/internal", internal);

registerJobs();

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
};
