// Side-effect module: performs the packetcode:* -> packetade:* localStorage
// migration at module-evaluation time. Import this FIRST in main.tsx —
// before App — so it runs before any store module reads localStorage at
// init time. (A bare function call in main.tsx's body does NOT work: ESM
// hoists static imports, so App's whole graph evaluates before the body.)
import { migrateIssuesMissionToFlight, migrateLegacyStorage } from "@/lib/storage-migration";

migrateLegacyStorage();
// Then canonicalize the legacy `missionId` flight link on persisted issues
// (runs after the prefix copy above so `packetade:issues` is in place).
migrateIssuesMissionToFlight();
