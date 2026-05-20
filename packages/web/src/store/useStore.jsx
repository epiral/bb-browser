/**
 * Trace Studio 状态管理
 * 使用 React Context + useReducer 替代 zustand
 */

import { createContext, useContext, useReducer, useCallback } from 'react';

const initialState = {
  connected: false,
  connecting: false,
  connectionError: null,

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
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_CONNECTED':
      return { ...state, connected: action.payload };
    case 'SET_CONNECTING':
      return { ...state, connecting: action.payload };
    case 'SET_CONNECTION_ERROR':
      return { ...state, connectionError: action.payload };
    case 'SET_TABS':
      return { ...state, tabs: action.payload };
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.payload.tab, activeTabId: action.payload.tabId };
    case 'SET_TRACE_RECORDING':
      return { ...state, traceRecording: action.payload };
    case 'SET_TRACE_EVENTS': {
      // Used by handleStop to replace the in-memory event list with the
      // authoritative one from the daemon. Sync realTimeStats too so the
      // monitor count doesn't stay stuck at a previous (possibly inflated)
      // value once recording stops.
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
      // Dedup by seq: defends against double-add caused by StrictMode
      // re-mount, polling effect re-mount (cursor reset), or any retry path.
      // Every event from the daemon carries a monotonically increasing seq.
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
    case 'SET_SELECTED_EVENT_INDEX':
      return { ...state, selectedEventIndex: action.payload };
    case 'SET_SHOW_EXPORTER':
      return { ...state, showExporter: action.payload };
    default:
      return state;
  }
}

const StoreContext = createContext(null);

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const value = {
    state,
    setConnected: useCallback((val) => dispatch({ type: 'SET_CONNECTED', payload: val }), []),
    setConnecting: useCallback((val) => dispatch({ type: 'SET_CONNECTING', payload: val }), []),
    setConnectionError: useCallback((val) => dispatch({ type: 'SET_CONNECTION_ERROR', payload: val }), []),
    setTabs: useCallback((val) => dispatch({ type: 'SET_TABS', payload: val }), []),
    setActiveTab: useCallback((tab, tabId) => dispatch({ type: 'SET_ACTIVE_TAB', payload: { tab, tabId } }), []),
    setTraceRecording: useCallback((val) => dispatch({ type: 'SET_TRACE_RECORDING', payload: val }), []),
    setTraceEvents: useCallback((val) => dispatch({ type: 'SET_TRACE_EVENTS', payload: val }), []),
    addTraceEvent: useCallback((event) => dispatch({ type: 'ADD_TRACE_EVENT', payload: event }), []),
    clearTraceEvents: useCallback(() => dispatch({ type: 'CLEAR_TRACE_EVENTS' }), []),
    setSelectedEventIndex: useCallback((val) => dispatch({ type: 'SET_SELECTED_EVENT_INDEX', payload: val }), []),
    setShowExporter: useCallback((val) => dispatch({ type: 'SET_SHOW_EXPORTER', payload: val }), []),
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const context = useContext(StoreContext);
  if (!context) {
    throw new Error('useStore must be used within a StoreProvider');
  }
  // 返回与 zustand 兼容的 API
  const { state, ...actions } = context;
  return {
    ...state,
    ...actions,
  };
}
