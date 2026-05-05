import { Service } from "node-windows";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const svc = new Service({
  name: "NDI P21 Bridge Agent",
  description: "Polls the NDI Ops Hub for P21 SQL jobs and runs them through the local VPN.",
  script: join(__dirname, "agent.js"),
  nodeOptions: [],
  env: [
    { name: "NODE_ENV", value: "production" },
  ],
});

svc.on("install", () => {
  console.log("Service installed. Starting…");
  svc.start();
});
svc.on("alreadyinstalled", () => console.log("Service is already installed."));
svc.on("start", () => console.log("Service started."));
svc.on("error", (e) => console.error("Service error:", e));

svc.install();
