/**
 * @bb-browser/shared
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
  type ResponseError,
  type SnapshotData,
  type TabInfo,
  type TraceEntry,
  type TraceAction,
  type TraceRequest,
  type TraceResponse,
  type TraceNavigation,
  type TraceStatus,
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
  type ParamDef,
  COMMANDS,
  commandToJsonSchema,
  getCommand,
  getCommandsByGroup,
} from "./commands.js";

export {
  type DaemonInfo,
  DAEMON_DIR,
  DAEMON_JSON,
  readDaemonJson,
  isProcessAlive,
  httpJson,
} from "./daemon-client.js";
