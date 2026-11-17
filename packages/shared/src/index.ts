/**
 * @ma-browser/shared
 * 共享类型和工具函数
 */

export {
  type ActionType,
  type BrowserInfo,
  type BrowserModeInfo,
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
  ACTION_TIMEOUTS,
  CLIENT_TIMEOUT_GRACE_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MIN_COMMAND_TIMEOUT_MS,
  type CommandTimeoutInfo,
  type CommandTimeoutKind,
  actionTimeoutEnvName,
  clientCommandTimeoutMs,
  commandTimeoutMs,
} from "./command-timeouts.js";

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
  DaemonTimeoutError,
  describeDaemonTimeout,
  sessionHeaders,
  isWsl,
  parseDefaultGatewayHex,
  parseNameserver,
} from "./daemon-client.js";

export {
  DEFAULT_CDP_PORT,
  MANAGED_BROWSER_DIR,
  MANAGED_PID_FILE,
  MANAGED_PORT_FILE,
  MANAGED_USER_DATA_DIR,
  type LaunchManagedBrowserOptions,
  currentManagedBrowserDir,
  findBrowserExecutable,
  launchManagedBrowser,
  probeCdp,
  readManagedPid,
  readManagedPort,
} from "./browser-launcher.js";

export {
  type CdpAddress,
  type CdpEndpoint,
  type ResolvedCdp,
  browserIdFor,
  cdpDiscoveryMode,
  defaultScanPorts,
  discoverCdpEndpoints,
  envCdpAddresses,
  explainCdpFailure,
  inspectCdp,
  isLoopbackHost,
  parseCdpAddress,
  resolveCdpEndpoint,
} from "./cdp-discovery.js";

export {
  type AdapterCatalog,
  type AdapterCatalogResult,
  type AdapterNotFound,
  type AdapterSource,
  type CatalogDiagnostic,
  type CatalogFs,
  type CatalogQuery,
  type CatalogSource,
  type CatalogStatus,
  type SiteAdapter,
  type SourceStatus,
  type UpdateResult,
  CATALOG_STATUSES,
  COMMUNITY_REPO,
  COMMUNITY_SITES_DIR,
  LOCAL_SITES_DIR,
  MAX_CATALOG_DIAGNOSTICS,
  SITE_UPDATE_ACTION,
  adapterNotFound,
  buildAdapterScript,
  catalogBaseStatus,
  filterAdapters,
  isAdapterCatalogResult,
  loadAdapterCatalog,
  loadAdapters,
  queryAdapterCatalog,
  matchTabOrigin,
  parseSiteMeta,
  scanSites,
  updateCommunityAdapters,
} from "./site-adapters.js";

export {
  browserMode,
  type BrowserModeAction,
  type BrowserModeOptions,
  type BrowserModeStatus,
} from "./browser-mode.js";

export {
  WindowsWindowController,
  managedModeFilePath,
  readPersistedBrowserMode,
  resolveInitialBrowserMode,
  windowsStealth,
  writePersistedBrowserMode,
  type BrowserDisplayMode,
  type PersistedBrowserMode,
  type WindowModeApplyResult,
  type WindowModeDriver,
  type WindowModeStatusResult,
} from "./windows-stealth.js";

export {
  type Fetcher,
  type GenerateResult,
  type HealResult,
  type NewsManifest,
  type NewsScore,
  type OriginEvaluator,
  type ProbeTabs,
  BROWSER_PROBE_TIMEOUT_MS,
  NEWS_KNOWLEDGE,
  browserFetcher,
  createTabProbe,
  matchTabBase,
  generateNewsPackage,
  healNewsPackage,
  readNewsManifest,
  runAdapterSource,
} from "./news-generator.js";
