import { ping } from "./ping.js";
import { salesQuery } from "./sales-query.js";
import { arAging } from "./ar-aging.js";
import { submitOrder } from "./submit-order.js";

// Allowlist of job kinds the agent will execute. The app cannot ask for
// anything not listed here — keeps SQL safe and predictable.
export const handlers = {
  ping,
  "sales.query": salesQuery,
  "ar.aging": arAging,
  "order.submit": submitOrder,
};
