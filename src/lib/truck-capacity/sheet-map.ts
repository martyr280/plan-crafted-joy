// Single source of truth for workbook sheet-name → route.code mapping.
// Imported by src/lib/truck-capacity.server.ts and scripts/tc-seed.ts so the
// two paths can't drift.

export const SHEET_TO_ROUTE_CODE: Record<string, string> = {
  "dallas special runs": "DAL-SPECIAL",
  "dallas-local": "DAL-LOCAL", "dallas local": "DAL-LOCAL",
  "moar": "MOAR", "east tx": "ETX",
  "okl": "OKL", "hou": "HOU", "kan": "KAN", "ark": "ARK",
  "bham transfer": "BHM-XFER-DAL", "bham transfer (dallas)": "BHM-XFER-DAL", "birmingham transfer": "BHM-XFER-DAL",
  "birmingham special runs": "BHM-SPECIAL",
  "mislou": "MISLOU", "sw miss": "SWMISS", "north al": "NAL", "north miss.": "NMISS", "north miss": "NMISS",
  "central al": "CAL", "mid tn": "MTN", "east tn": "ETN",
  "west tn - long": "WTN-LONG", "west tn long": "WTN-LONG",
  "west tn - short": "WTN-SHORT", "west tn short": "WTN-SHORT",
  "dallas transfer": "DAL-XFER-BHM", "dallas transfer (bham)": "DAL-XFER-BHM", "dallas transfer(bham)": "DAL-XFER-BHM",
  "ocala transfer": "OCA-XFER-BHM", "ocala transfer (bham)": "OCA-XFER-BHM", "ocala transfer(bham)": "OCA-XFER-BHM",
  "north ga": "NGA", "south ga": "SGA",
  "east carolina": "ECAR", "west carolina": "WCAR",
  "south al": "SAL", "gulf coast": "GULF",
  "ocala special runs": "OCA-SPECIAL",
  "jax": "JAX", "sefl": "SEFL", "mia": "MIA", "orl": "ORL", "swfl": "SWFL", "tampa": "TAMPA",
  // hidden legacy sheet — explicit skip
  "carolinas": "__SKIP__",
};
