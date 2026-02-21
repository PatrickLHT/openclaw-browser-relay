const DEFAULT_PORT = 18792

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

const KEEPALIVE_ALARM = 'openclaw-keepalive'
const RECONNECT_ALARM = 'openclaw-reconnect'

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null

let debuggerListenersInstalled = false

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

let reconnectAttempts = 0

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const raw = stored.relayPort
  const n = Number.parseInt(String(raw || ''), 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

// --- State Persistence (survives service worker restarts) ---

async function persistState() {
  const tabData = {}
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
      tabData[String(tabId)] = { sessionId: tab.sessionId, targetId: tab.targetId }
    }
  }
  await chrome.storage.session.set({ attachedTabs: tabData }).catch(() => {})
}

async function loadPersistedState() {
  try {
    const stored = await chrome.storage.session.get(['attachedTabs'])
    return stored?.attachedTabs || {}
  } catch {
    return {}
  }
}

// --- Keepalive (prevents service worker termination while tabs are attached) ---

async function updateKeepalive() {
  if (tabs.size > 0) {
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.45 }).catch(() => {})
  } else {
    await chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {})
  }
}

// --- Reconnection with exponential backoff ---

function getReconnectDelay() {
  const base = 1000
  const delay = Math.min(base * Math.pow(2, reconnectAttempts), 30000)
  return Math.round(delay * (0.8 + Math.random() * 0.4))
}

function scheduleReconnect() {
  const delay = getReconnectDelay()
  reconnectAttempts++
  console.log(`[OpenClaw Relay] Reconnect attempt ${reconnectAttempts} in ${delay}ms`)
  setTimeout(() => void attemptReconnect(), delay)
  // Backup alarm in case SW is killed before setTimeout fires
  chrome.alarms.create(RECONNECT_ALARM, {
    delayInMinutes: Math.max(delay / 60000, 0.5),
  }).catch(() => {})
}

async function attemptReconnect() {
  await chrome.alarms.clear(RECONNECT_ALARM).catch(() => {})
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return

  // Restore tabs from persisted state if needed (e.g., after SW restart)
  if (tabs.size === 0) {
    const persisted = await loadPersistedState()
    for (const [tabIdStr, data] of Object.entries(persisted)) {
      const tabId = Number(tabIdStr)
      if (!isNaN(tabId) && data.sessionId && data.targetId) {
        tabs.set(tabId, { state: 'connected', sessionId: data.sessionId, targetId: data.targetId })
        tabBySession.set(data.sessionId, tabId)
      }
    }
  }

  if (tabs.size === 0) return

  try {
    await ensureRelayConnection()
    console.log('[OpenClaw Relay] Reconnected successfully')
    reconnectAttempts = 0
    await reannounceAttachedTabs()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[OpenClaw Relay] Reconnect failed: ${msg}`)
    if (tabs.size > 0) scheduleReconnect()
  }
}

async function reannounceAttachedTabs() {
  const toRemove = []

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== 'connected' || !tab.sessionId || !tab.targetId) continue

    try {
      // Verify tab still exists and debugger is still attached
      const info = /** @type {any} */ (
        await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      )
      const targetInfo = info?.targetInfo

      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: tab.sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })

      setBadge(tabId, 'on')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: attached (click to detach)',
      })
    } catch {
      // Tab or debugger session is gone
      toRemove.push(tabId)
    }
  }

  for (const tabId of toRemove) {
    const tab = tabs.get(tabId)
    if (tab?.sessionId) tabBySession.delete(tab.sessionId)
    tabs.delete(tabId)
    setBadge(tabId, 'off')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay (click to attach/detach)',
    })
  }

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (!tabs.has(parentTabId)) childSessionToTab.delete(childSessionId)
  }

  await persistState()
  await updateKeepalive()
}

// --- Core Connection ---

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const port = await getRelayPort()
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = `ws://127.0.0.1:${port}/extension`

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
    ws.onclose = () => onRelayClosed('closed')
    ws.onerror = () => {} // onclose always follows onerror; avoid double-fire

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }

    reconnectAttempts = 0
  })()

  try {
    await relayConnectPromise
  } finally {
    relayConnectPromise = null
  }
}

function onRelayClosed(reason) {
  const wasConnected = relayWs !== null
  relayWs = null

  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  if (!wasConnected) return

  // Keep debuggers attached — update badges to show reconnecting
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: reconnecting…',
      })
    }
  }

  // Auto-reconnect if we have attached tabs
  if (tabs.size > 0) {
    scheduleReconnect()
  }
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch {
    // ignore
  }
}

function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      sendToRelay(command)
    } catch (err) {
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }

  const sessionId = `cb-tab-${tabId}-${Date.now()}`

  tabs.set(tabId, { state: 'connected', sessionId, targetId })
  tabBySession.set(sessionId, tabId)
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: attached (click to detach)',
  })

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    })
  }

  setBadge(tabId, 'on')
  await persistState()
  await updateKeepalive()
  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // ignore
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // ignore
  }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay (click to attach/detach)',
  })
  await persistState()
  await updateKeepalive()
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  const existing = tabs.get(tabId)
  if (existing?.state === 'connected') {
    await detachTab(tabId, 'toggle')
    return
  }

  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: connecting to local relay…',
  })

  try {
    await ensureRelayConnection()
    await attachTab(tabId)
  } catch (err) {
    tabs.delete(tabId)
    setBadge(tabId, 'error')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: relay not running (open options for setup)',
    })
    void maybeOpenHelpOnce()
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[OpenClaw Relay] Attach failed:', message, nowStack())
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  // Map command to tab
  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      // No sessionId: pick the first connected tab (stable-ish).
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })()

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try {
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // ignore — relay will reconnect
  }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return

  // If the detach was caused by navigation (target_closed but tab still exists),
  // try to re-attach automatically instead of giving up.
  if (reason === 'target_closed') {
    void reattachAfterNavigation(tabId)
    return
  }

  // canceled_by_user or replaced_with_devtools — respect the user's intent
  void detachTab(tabId, reason)
}

async function reattachAfterNavigation(tabId) {
  const oldState = tabs.get(tabId)

  // Check if the tab still exists (navigation vs. actual close)
  const tabInfo = await chrome.tabs.get(tabId).catch(() => null)
  if (!tabInfo) {
    // Tab was actually closed
    void detachTab(tabId, 'target_closed')
    return
  }

  console.log(`[OpenClaw Relay] Debugger detached on tab ${tabId} — re-attaching after navigation`)
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: re-attaching after navigation…',
  })

  // Wait for the new page to begin loading in the new renderer process
  await new Promise((r) => setTimeout(r, 500))

  // Retry re-attach up to 3 times (page may not be ready immediately)
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3')
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {})

      const info = /** @type {any} */ (
        await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      )
      const targetInfo = info?.targetInfo
      const targetId = String(targetInfo?.targetId || '').trim()
      if (!targetId) throw new Error('No targetId after re-attach')

      // Notify relay that the old session is gone
      if (oldState?.sessionId) {
        tabBySession.delete(oldState.sessionId)
        try {
          sendToRelay({
            method: 'forwardCDPEvent',
            params: {
              method: 'Target.detachedFromTarget',
              params: {
                sessionId: oldState.sessionId,
                targetId: oldState.targetId || targetId,
                reason: 'navigation',
              },
            },
          })
        } catch {
          // relay may be disconnected — that's fine, reconnect handles it
        }
      }

      // Set up new session for the re-attached tab
      const sessionId = `cb-tab-${tabId}-${Date.now()}`
      tabs.set(tabId, { state: 'connected', sessionId, targetId })
      tabBySession.set(sessionId, tabId)

      // Clean up orphaned child sessions from the old page
      for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
        if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
      }

      // Announce the new session to the relay
      try {
        sendToRelay({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            params: {
              sessionId,
              targetInfo: { ...targetInfo, attached: true },
              waitingForDebugger: false,
            },
          },
        })
      } catch {
        // relay may be disconnected
      }

      setBadge(tabId, 'on')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: attached (click to detach)',
      })
      await persistState()

      console.log(`[OpenClaw Relay] Re-attached to tab ${tabId} after navigation (attempt ${attempt + 1})`)
      return
    } catch (err) {
      lastErr = err
      // Wait before retrying — page may still be loading
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
    }
  }

  // All retries failed — clean up
  console.warn('[OpenClaw Relay] Re-attach failed after 3 attempts:', lastErr instanceof Error ? lastErr.message : String(lastErr))
  void detachTab(tabId, 'target_closed')
}

// --- Event Listeners ---

chrome.action.onClicked.addListener(() => void connectOrToggleForActiveTab())

chrome.runtime.onInstalled.addListener(() => {
  // Useful: first-time instructions.
  void chrome.runtime.openOptionsPage()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Check if WebSocket is healthy; reconnect if not
    if (tabs.size > 0 && (!relayWs || relayWs.readyState !== WebSocket.OPEN)) {
      void attemptReconnect()
    }
    // Send a ping to keep the WS alive and detect dead connections
    if (relayWs && relayWs.readyState === WebSocket.OPEN) {
      try {
        sendToRelay({ method: 'ping' })
      } catch {
        // ignore
      }
    }
  }
  if (alarm.name === RECONNECT_ALARM) {
    void attemptReconnect()
  }
})

// --- Service Worker Startup: restore state and reconnect ---

async function onServiceWorkerStart() {
  const persisted = await loadPersistedState()
  const tabIds = Object.keys(persisted).map(Number).filter((n) => !isNaN(n))

  if (tabIds.length === 0) return

  for (const tabId of tabIds) {
    const data = persisted[String(tabId)]
    if (data?.sessionId && data?.targetId) {
      tabs.set(tabId, { state: 'connected', sessionId: data.sessionId, targetId: data.targetId })
      tabBySession.set(data.sessionId, tabId)
    }
  }

  if (!debuggerListenersInstalled) {
    debuggerListenersInstalled = true
    chrome.debugger.onEvent.addListener(onDebuggerEvent)
    chrome.debugger.onDetach.addListener(onDebuggerDetach)
  }

  await updateKeepalive()
  void attemptReconnect()
}

void onServiceWorkerStart()
