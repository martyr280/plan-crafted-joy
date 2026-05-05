// Installs the agent as a Windows service so it starts automatically on boot.
// Must be run from an ELEVATED (Administrator) command prompt.
//
//   npm run install-service
//
// Logs are written to <agent>/daemon/ndi-p21-bridge-agent.{out,err,wrapper}.log
import { Service, EventLogger } from "node-windows";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_NAME = "NDI P21 Bridge Agent";

if (!existsSync(join(__dirname, ".env"))) {
  console.error("ERROR: agent/.env is missing. Copy .env.example to .env and fill it in before installing the service.");
  process.exit(1);
}

const log = new EventLogger(SERVICE_NAME);

const svc = new Service({
  name: SERVICE_NAME,
  description:
    "Polls NDI Ops Hub for P21 SQL jobs and runs them against your P21 SQL Server through the local FortiClient VPN.",
  script: join(__dirname, "agent.js"),
  // Restart policy — Windows SCM will relaunch if the process exits.
  wait: 2,
  grow: 0.25,
  maxRestarts: 10,
  // Run from the agent folder so relative paths and dotenv resolve correctly.
  workingDirectory: __dirname,
  // Inherit env from .env (loaded by dotenv inside agent.js); add NODE_ENV.
  env: [{ name: "NODE_ENV", value: "production" }],
});

svc.on("install", () => {
  console.log(`✓ Installed "${SERVICE_NAME}". Starting…`);
  svc.start();
});
svc.on("alreadyinstalled", () => {
  console.log(`"${SERVICE_NAME}" is already installed. To reinstall, run: npm run uninstall-service`);
});
svc.on("invalidinstallation", () => {
  console.error("Service installation appears broken. Run: npm run uninstall-service, then try again.");
});
svc.on("start", () => {
  console.log(`✓ "${SERVICE_NAME}" started. It will now run on boot.`);
  console.log(`   Logs: ${join(__dirname, "daemon")}`);
  console.log(`   Manage: services.msc  (or)  sc query "${SERVICE_NAME}"`);
});
svc.on("error", (err) => {
  console.error("Service error:", err);
  log.error(String(err));
});

console.log(`Installing Windows service "${SERVICE_NAME}"…`);
console.log("If you see 'Access is denied', re-run this command from an Administrator command prompt.");
svc.install();
