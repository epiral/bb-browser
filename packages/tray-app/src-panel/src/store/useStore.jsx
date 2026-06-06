/**
 * 控制面板全局状态
 *
 * 在原 TraceStudio store 基础上新增：
 *   overview  — /api/overview 返回的 daemon 状态摘要
 *   commands  — /api/commands 返回的最近命令列表
 *   logs      — /api/logs 返回的日志条目列表
 */

import { createContext, useContext, useReducer, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const initialState = {
  // ── Connection ──
  connected: false,
  connecting: false,
  connectionError: null,

  // ── Tabs / trace (TraceStudio state) ──
  tabs: [],
  activeTab: null,
  activeTabId: null,
  traceRecording: false,
  traceEvents: [],
  traceEventCount: 0,
  lastUpdated: null,
  realTimeStats: {
    status: 'idle',
    eventCount: 0,
    currentUrl: '',
    lastEventType: null,
    lastEventTime: null,
  },
  selectedEventIndex: null,
  showExporter: false,

  // ── Overview (MVP 2 new) ──
  overview: null,       // { uptime, daemonPort, cdpPort, cdpConnected, tabCount, chromeVersion }

  // ── Commands history (MVP 2 new) ──
  commands: [],         // CommandRecord[]

  // ── Logs (MVP 2 new) ──
  logs: [],             // LogEntry[]
  logsLevel: '',        // active level filter
  logsSearch: '',       // active keyword search
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reducer(state, action) {
  switch (action.type) {
    // Connection
    case 'SET_CONNECTED':       return { ...state, connected: action.payload };
    case 'SET_CONNECTING':      return { ...state, connecting: action.payload };
    case 'SET_CONNECTION_ERROR':return { ...state, connectionError: action.payload };

    // Tabs / trace
    case 'SET_TABS':            return { ...state, tabs: action.payload };
    case 'SET_ACTIVE_TAB':      return { ...state, activeTab: action.payload.tab, activeTabId: action.payload.tabId };
    case 'SET_TRACE_RECORDING': return { ...state, traceRecording: action.payload };
    case 'SET_TRACE_EVENTS': {
      const list = action.payload;
      const last = list[list.length - 1];
      return {
        ...state,
        traceEvents: list,
        traceEventCount: list.length,
        realTimeStats: {
          ...state.realTimeStats,
          eventCount: list.length,
          lastEventType: last?.type ?? null,
          currentUrl: last?.url ?? state.realTimeStats.currentUrl,
        },
      };
    }
    case 'ADD_TRACE_EVENT': {
      const incoming = action.payload;
      if (incoming?.seq !== undefined && state.traceEvents.some((e) => e.seq === incoming.seq)) {
        return state;
      }
      return {
        ...state,
        traceEvents: [...state.traceEvents, incoming],
        traceEventCount: state.traceEventCount + 1,
        lastUpdated: Date.now(),
        realTimeStats: {
          ...state.realTimeStats,
          eventCount: state.realTimeStats.eventCount + 1,
          lastEventType: incoming.type,
          lastEventTime: Date.now(),
          currentUrl: incoming.url,
        },
      };
    }
    case 'CLEAR_TRACE_EVENTS':
      return {
        ...state,
        traceEvents: [],
        traceEventCount: 0,
        lastUpdated: null,
        realTimeStats: {
          status: 'idle',
          eventCount: 0,
          currentUrl: '',
          lastEventType: null,
          lastEventTime: null,
        },
      };
    case 'SET_SELECTED_EVENT_INDEX': return { ...state, selectedEventIndex: action.payload };
    case 'SET_SHOW_EXPORTER':        return { ...state, showExporter: action.payload };

    // Overview
    case 'SET_OVERVIEW': return { ...state, overview: action.payload };

    // Commands
    case 'SET_COMMANDS': return { ...state, commands: action.payload };

    // Logs
    case 'SET_LOGS':         return { ...state, logs: action.payload };
    case 'SET_LOGS_LEVEL':   return { ...state, logsLevel: action.payload };
    case 'SET_LOGS_SEARCH':  return { ...state, logsSearch: action.payload };

    default: return state;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const StoreContext = createContext(null);

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const value = {
    state,
    // Connection
    setConnected:       useCallback((v) => dispatch({ type: 'SET_CONNECTED', payload: v }), []),
    setConnecting:      useCallback((v) => dispatch({ type: 'SET_CONNECTING', payload: v }), []),
    setConnectionError: useCallback((v) => dispatch({ type: 'SET_CONNECTION_ERROR', payload: v }), []),
    // Tabs / trace
    setTabs:            useCallback((v) => dispatch({ type: 'SET_TABS', payload: v }), []),
    setActiveTab:       useCallback((tab, tabId) => dispatch({ type: 'SET_ACTIVE_TAB', payload: { tab, tabId } }), []),
    setTraceRecording:  useCallback((v) => dispatch({ type: 'SET_TRACE_RECORDING', payload: v }), []),
    setTraceEvents:     useCallback((v) => dispatch({ type: 'SET_TRACE_EVENTS', payload: v }), []),
    addTraceEvent:      useCallback((e) => dispatch({ type: 'ADD_TRACE_EVENT', payload: e }), []),
    clearTraceEvents:   useCallback(() => dispatch({ type: 'CLEAR_TRACE_EVENTS' }), []),
    setSelectedEventIndex: useCallback((v) => dispatch({ type: 'SET_SELECTED_EVENT_INDEX', payload: v }), []),
    setShowExporter:    useCallback((v) => dispatch({ type: 'SET_SHOW_EXPORTER', payload: v }), []),
    // Overview
    setOverview:        useCallback((v) => dispatch({ type: 'SET_OVERVIEW', payload: v }), []),
    // Commands
    setCommands:        useCallback((v) => dispatch({ type: 'SET_COMMANDS', payload: v }), []),
    // Logs
    setLogs:            useCallback((v) => dispatch({ type: 'SET_LOGS', payload: v }), []),
    setLogsLevel:       useCallback((v) => dispatch({ type: 'SET_LOGS_LEVEL', payload: v }), []),
    setLogsSearch:      useCallback((v) => dispatch({ type: 'SET_LOGS_SEARCH', payload: v }), []),
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within a StoreProvider');
  const { state, ...actions } = ctx;
  return { ...state, ...actions };
}
