import { Hono } from "hono";
import webhook from "./routes/webhook";

const app = new Hono();
app.route("/webhook", webhook);

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
};
