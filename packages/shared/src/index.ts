/**
 * @ma-browser/shared
 * 共享类型和工具函数
 */

export {
  type ActionType,
  type ConsoleMessageInfo,
  type DaemonStatus,
  type JSErrorInfo,
  type NetworkRequestInfo,
  type RefInfo,
  type Request,
  type Response,
  type ResponseData,
  type SnapshotData,
  type TabInfo,
  type TraceEvent,
  type TraceStatus,
  generateId,
} from "./protocol.js";

export {
  COMMAND_TIMEOUT,
  DAEMON_HOST,
  DAEMON_PORT,
  SSE_HEARTBEAT_INTERVAL,
  SSE_MAX_RECONNECT_ATTEMPTS,
  SSE_RECONNECT_DELAY,
} from "./constants.js";

export {
  type CommandDef,
  COMMANDS,
  findCommand,
  getCommandsByCategory,
} from "./commands.js";

export {
  type DaemonInfo,
  DAEMON_DIR,
  DAEMON_JSON,
  readDaemonJson,
  isProcessAlive,
  httpJson,
  sessionHeaders,
  isWsl,
  parseDefaultGatewayHex,
  parseNameserver,
} from "./daemon-client.js";

export {
  DEFAULT_CDP_PORT,
  MANAGED_BROWSER_DIR,
  MANAGED_PORT_FILE,
  findBrowserExecutable,
  launchManagedBrowser,
  probeCdp,
} from "./browser-launcher.js";

export {
  type AdapterSource,
  type SiteAdapter,
  type UpdateResult,
  COMMUNITY_REPO,
  COMMUNITY_SITES_DIR,
  LOCAL_SITES_DIR,
  buildAdapterScript,
  loadAdapters,
  matchTabOrigin,
  parseSiteMeta,
  scanSites,
  updateCommunityAdapters,
} from "./site-adapters.js";

export {
  type Fetcher,
  type GenerateResult,
  type HealResult,
  type NewsManifest,
  type NewsScore,
  NEWS_KNOWLEDGE,
  generateNewsPackage,
  healNewsPackage,
  readNewsManifest,
  runAdapterSource,
} from "./news-generator.js";
