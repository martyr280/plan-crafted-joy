import { Service } from "node-windows";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const svc = new Service({
  name: "NDI P21 Bridge Agent",
  script: join(__dirname, "agent.js"),
});

svc.on("uninstall", () => console.log("Service uninstalled."));
svc.uninstall();
