import { Hono } from "hono";
import webhook from "./routes/webhook";
import internal from "./routes/internal";

const app = new Hono();
app.route("/webhook", webhook);
app.route("/internal", internal);

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
};
