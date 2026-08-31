// Installs the agent as a Windows service so it starts automatically on boot.
// Must be run from an ELEVATED (Administrator) command prompt.
//
//   npm run install-service
//
// Logs are written to <agent>/daemon/ndi-p21-bridge-agent.{out,err,wrapper}.log
import { Service, EventLogger } from "node-windows";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_NAME = "NDI P21 Bridge Agent";
const ENV_PATH = join(__dirname, ".env");

if (!existsSync(ENV_PATH)) {
  console.error("ERROR: agent/.env is missing. Copy .env.example to .env and fill it in before installing the service.");
  process.exit(1);
}

/**
 * Reads BRIDGE_CA_PATH / NODE_EXTRA_CA_CERTS out of .env (or the current
 * environment) and returns node-windows env entries for it. Needed when the
 * host runs TLS deep inspection (e.g. FortiGate re-signing *.supabase.co).
 */
function caEnv() {
  let value = process.env.BRIDGE_CA_PATH || process.env.NODE_EXTRA_CA_CERTS || "";
  if (!value) {
    for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const m = /^\s*(BRIDGE_CA_PATH|NODE_EXTRA_CA_CERTS)\s*=\s*(.+?)\s*$/.exec(line);
      if (m) {
        value = m[2].replace(/^["']|["']$/g, "");
        break;
      }
    }
  }
  if (!value) return [];
  if (!existsSync(value)) {
    console.warn(`WARNING: CA file not found at "${value}" — skipping NODE_EXTRA_CA_CERTS.`);
    return [];
  }
  console.log(`Using corporate CA bundle: ${value}`);
  return [
    { name: "NODE_EXTRA_CA_CERTS", value },
    { name: "BRIDGE_CA_PATH", value },
  ];
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
  // Also promote the corporate CA path into the real process environment so
  // Node's TLS trust store picks it up BEFORE dotenv runs (dotenv is too late
  // for NODE_EXTRA_CA_CERTS).
  env: [{ name: "NODE_ENV", value: "production" }, ...caEnv()],
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
