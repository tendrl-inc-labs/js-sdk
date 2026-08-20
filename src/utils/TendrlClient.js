// src/utils/TendrlClient.js
// API-only client using native fetch

import IndexedDBStorage from './IndexedDBStorage.js';

const VERSION = "0.1.0";

const DEFAULT_ORIGIN = 'https://app.tendrl.com';

// Resolve the API base from TENDRL_APP_URL when nothing is passed in, matching
// the Python and Go SDKs: the env var is an ORIGIN ("http://localhost:8000") and
// the SDK appends /api itself. Without this the base was hardcoded to production
// and there was no way to point the client at a local stack except by passing
// apiBaseUrl at every call site.
//
// `process` does not exist in a browser, so this is guarded — bundlers that
// inline process.env still work, and a plain browser falls back to production.
function defaultApiBaseUrl() {
    let value = DEFAULT_ORIGIN;
    try {
        if (typeof process !== 'undefined' && process.env && process.env.TENDRL_APP_URL) {
            value = process.env.TENDRL_APP_URL;
        }
    } catch (_) { /* no process in this environment — keep the default */ }
    const trimmed = value.replace(/\/+$/, '');
    // Accept either a bare origin ("http://192.168.1.50" — append /api) or a full
    // base URL already ending in /api (nano-agent style), matching how the Go and
    // Python SDKs read the same variable. One TENDRL_APP_URL works for all of them.
    return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

class TendrlClient {
    constructor({
        apiBaseUrl = defaultApiBaseUrl(),
        apiKey,
        debug = false,
        // Batching configuration
        minBatchSize = 10,
        maxBatchSize = 100,
        minBatchInterval = 100, // in ms
        maxBatchInterval = 1000, // in ms
        // Common configuration
        callback = null,
        stateCallback = null,
        maxQueueSize = 1000,
        checkMsgRate = 3000, // Message check frequency in ms (default: 3 seconds)
        checkMsgLimit = 1, // Maximum messages to retrieve per check
        offlineStorage = false, // Enable offline storage
        dbName = 'tendrl_offline', // IndexedDB database name
    }) {
        this.apiBaseUrl = apiBaseUrl.replace(/\/$/, ''); // Remove trailing slash
        this.apiKey = apiKey;
        this.debug = debug;
        this.queue = [];
        this.maxQueueSize = maxQueueSize;
        this.callback = callback;
        this.stateCallback = stateCallback;
        this._routes = [];
        this._defaultHandler = null;
        this._stateHandler = null;
        this._lastState = null;
        this._lastStateInitialized = false;
        this.minBatchSize = minBatchSize;
        this.maxBatchSize = maxBatchSize;
        this.minBatchInterval = minBatchInterval;
        this.maxBatchInterval = maxBatchInterval;
        this.senderInterval = null;
        this.messageCheckInterval = null;
        this.checkMsgRate = checkMsgRate;
        this.checkMsgLimit = checkMsgLimit;
        this._lastMsgCheck = 0;
        this._connectionState = true; // Assume connected initially
        this._lastConnectionCheck = 0;
        this._lastCleanup = 0;
        this._isRunning = false;

        // Offline storage
        this.storage = null;
        if (offlineStorage) {
            if (this.debug) {
                console.log(`Initializing offline storage: ${dbName}`);
            }
            this.storage = new IndexedDBStorage(dbName);
            // Initialize storage asynchronously
            this.storage.init().catch((error) => {
                if (this.debug) {
                    console.error(`Failed to initialize offline storage: ${error}`);
                }
            });
        }
    }

    // ==================== Connection Management ====================

    // Start the client
    start() {
        if (this._isRunning) {
            if (this.debug) console.warn("Client is already running");
            return;
        }

        this._isRunning = true;

        // Update entity status to online
        this._updateEntityStatus(true);

        // Start message sender
        this.startSender();

        // Start automatic message checking if callback is set
        if (this._hasInboundHandlers()) {
            this.startMessageChecking();
        }

        // Drain anything buffered from a previous run. The 30s connectivity
        // recheck only flushes on a false->true *transition*, which never fires
        // on a fresh start — so without this, messages stored during an outage
        // before a page reload would sit in IndexedDB until the next
        // disconnect/reconnect cycle. Best-effort, fire-and-forget.
        if (this.storage) {
            this.storage.getMessageCount()
                .then((count) => {
                    if (count > 0) {
                        if (this.debug) console.log(`Startup: draining ${count} buffered offline messages`);
                        return this.processOfflineMessages();
                    }
                })
                .catch((error) => {
                    if (this.debug) console.error(`Startup offline drain failed: ${error}`);
                });
        }

        if (this.debug) console.log("TendrlClient started");
    }

    // Stop the client
    stop() {
        if (!this._isRunning) {
            return;
        }

        this._isRunning = false;
        
        // Update entity status to offline
        this._updateEntityStatus(false);
        
        // Stop intervals
        this.stopSender();
        this.stopMessageChecking();

        if (this.debug) console.log("TendrlClient stopped");
    }

    // ==================== Message Publishing ====================

    // Send a heartbeat message with system resource information
    // Parameters are optional - backend will validate required fields
    async sendHeartbeat({
        mem_free,
        mem_total,
        disk_free,
        disk_size
    } = {}) {
        // Build data object with only provided fields
        const heartbeatData = {};
        if (mem_free !== undefined) {
            if (mem_free < 0) {
                throw new Error("mem_free must be non-negative");
            }
            heartbeatData.mem_free = mem_free;
        }
        if (mem_total !== undefined) {
            if (mem_total < 0) {
                throw new Error("mem_total must be non-negative");
            }
            heartbeatData.mem_total = mem_total;
        }
        if (disk_free !== undefined) {
            if (disk_free < 0) {
                throw new Error("disk_free must be non-negative");
            }
            heartbeatData.disk_free = disk_free;
        }
        if (disk_size !== undefined) {
            if (disk_size < 0) {
                throw new Error("disk_size must be non-negative");
            }
            heartbeatData.disk_size = disk_size;
        }

        // Create heartbeat message
        const heartbeatMessage = {
            msg_type: "heartbeat",
            data: heartbeatData,
            timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), // Ensure Z suffix for UTC
        };

        if (this.debug) {
            console.log("📤 Sending heartbeat:", heartbeatMessage);
        }

        // Always send immediately and wait for response (matching Python SDK behavior)
        // Backend will validate required fields and return appropriate errors
        return await this._publishMessage(heartbeatMessage);
    }

    // Publish a message
    publish(msg, tags = [], entity = "", waitResponse = false) {
        // Accept both string and object (matching Python SDK behavior)
        if (msg === null || msg === undefined) {
            throw new Error("Message cannot be null or undefined");
        }

        // If msg is a string, wrap it in an object (matching Python SDK's make_message behavior)
        let data = msg;
        if (typeof msg === "string") {
            data = { data: msg };
        } else if (typeof msg !== "object") {
            throw new Error(`Invalid message type: ${typeof msg}. Expected string or object.`);
        }

        // Create message
        const message = {
            msg_type: "publish",
            data: data,
            timestamp: new Date().toISOString(),
        };

        // Add context if needed
        if (tags.length > 0 || waitResponse || entity) {
            message.context = {};
            if (tags.length > 0) {
                message.context.tags = tags;
            }
            if (waitResponse) {
                message.context.wait = true;
            }
        }

        if (entity) {
            message.dest = entity;
        }

        // If waitResponse, send immediately and return response
        if (waitResponse) {
            return this._publishMessage(message);
        }

        // Otherwise, queue for batch sending
        if (this.queue.length < this.maxQueueSize) {
            this.queue.push(message);
        } else {
            // Queue is full - try to store offline if storage is enabled
            if (this.storage) {
                try {
                    const msgId = `offline_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    const context = message.context || {};
                    this.storage.store(
                        msgId,
                        message.data,
                        context.tags || null,
                        3600 // 1 hour TTL
                    ).then(() => {
                        if (this.debug) {
                            console.log(`💾 Queue full, stored message offline: ${msgId}`);
                        }
                    }).catch((error) => {
                        if (this.debug) {
                            console.error(`Failed to store message offline: ${error}`);
                        }
                    });
                } catch (error) {
                    if (this.debug) {
                        console.error(`Failed to store message offline: ${error}`);
                    }
                }
            } else if (this.debug) {
                console.warn("⚠️ Queue is full. Message discarded.");
            }
        }
    }

    // Publish a single message immediately (used for waitResponse)
    async _publishMessage(message, timeout = 5000) {
        try {
            // Create abort controller for timeout (browser compatibility)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(`${this.apiBaseUrl}/entities/message`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': `tendrl-js-sdk/${VERSION}`,
                },
                body: JSON.stringify(message),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (response.status === 200) {
                const result = await response.json();
                return result.content || result; // Return message ID
            } else {
                const errorText = await response.text();
                if (this.debug) {
                    console.error(`Message publish failed: ${response.status} - ${errorText}`);
                }
                return null;
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                if (this.debug) {
                    console.error(`Message publish timeout after ${timeout}ms`);
                }
            } else if (this.debug) {
                console.error(`Error publishing message: ${error.message}`);
            }
            return null;
        }
    }

    // Publish a batch of messages
    async _publishMessages(messages) {
        if (!messages || messages.length === 0) {
            return;
        }

        try {
            // Create abort controller for timeout (browser compatibility)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout for batches

            const response = await fetch(`${this.apiBaseUrl}/entities/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': `tendrl-js-sdk/${VERSION}`,
                },
                body: JSON.stringify(messages),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (response.status === 201 || response.status === 200) {
                if (this.debug) {
                    console.log(`Sent batch of ${messages.length} messages`);
                }
                return true;
            } else {
                const errorText = await response.text();
                if (this.debug) {
                    console.error(`Batch publish failed: ${response.status} - ${errorText}`);
                }
                return false;
            }
        } catch (error) {
            if (this.debug) {
                console.error(`Error publishing batch: ${error.message}`);
            }
            return false;
        }
    }

    // ==================== Message Checking ====================

    // Check for messages from the server
    async checkMessages(limit = null) {
        const checkLimit = limit !== null ? limit : this.checkMsgLimit;
        await this.checkMessagesAPI(checkLimit);
    }

    // Check messages via API
    async checkMessagesAPI(limit = 1) {
        try {
            // Create abort controller for timeout (browser compatibility)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(
                `${this.apiBaseUrl}/entities/check_messages?limit=${limit}`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                        'User-Agent': `tendrl-js-sdk/${VERSION}`,
                    },
                    signal: controller.signal,
                }
            );

            clearTimeout(timeoutId);

            if (response.status === 204) {
                // No messages available
                return;
            }

            if (response.status !== 200) {
                if (this.debug) {
                    console.error(`check_messages failed with status ${response.status}`);
                }
                return;
            }

            const responseData = await response.json();
            const messages = responseData.messages;

            if (messages && Array.isArray(messages) && messages.length > 0) {
                this.handleCheckMessagesResponse(messages);
            }

            this._lastMsgCheck = Date.now();
            this._connectionState = true;
        } catch (error) {
            if (this.debug) {
                console.error(`API error checking messages: ${error.message}`);
            }
            this._connectionState = false;
        }
    }

    // Transform CheckMessage format to Message format (matching Python SDK)
    transformCheckMessage(checkMsg) {
        // Required fields per IncomingMessage Structure
        const message = {
            msg_type: checkMsg.msg_type || "command",
            source: checkMsg.source || "",
            timestamp: checkMsg.timestamp || new Date().toISOString(),
            data: checkMsg.data || {},
        };

        // Tags at top level (optional per IncomingMessage Structure)
        // Handle tags from top level or context (for backward compatibility)
        const tags = checkMsg.tags || (checkMsg.context && checkMsg.context.tags);
        if (tags && Array.isArray(tags) && tags.length > 0) {
            message.tags = tags;
        }

        // Add optional fields
        if (checkMsg.dest) message.dest = checkMsg.dest;
        if (checkMsg.request_id) message.request_id = checkMsg.request_id;

        return message;
    }

    on({ msgType = null, tag = null, tags = null, tagsAll = null } = {}, handler) {
        if (typeof handler !== "function") {
            throw new TypeError("handler must be a function");
        }
        this._routes.push({ msgType, tag, tags, tagsAll, handler });
        if (this._isRunning) {
            this.startMessageChecking();
        }
        return handler;
    }

    onDefault(handler) {
        if (typeof handler !== "function") {
            throw new TypeError("handler must be a function");
        }
        this._defaultHandler = handler;
        if (this._isRunning) {
            this.startMessageChecking();
        }
        return handler;
    }

    onState(handler) {
        if (typeof handler !== "function") {
            throw new TypeError("handler must be a function");
        }
        this._stateHandler = handler;
        if (this._isRunning) {
            this.startMessageChecking();
        }
        return handler;
    }

    _hasStateHandlers() {
        return this._stateHandler || this.stateCallback;
    }

    _hasInboundHandlers() {
        return this._hasMessageHandlers() || this._hasStateHandlers();
    }

    _stateSnapshot(state) {
        return JSON.stringify(state);
    }

    _dispatchState(state) {
        if (this._stateHandler) {
            return this._stateHandler(state);
        }
        if (this.stateCallback) {
            return this.stateCallback(state);
        }
    }

    async _fetchStatusTable() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
            const response = await fetch(`${this.apiBaseUrl}/entities/status-table`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': `tendrl-js-sdk/${VERSION}`,
                },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (response.status === 200) {
                const result = await response.json();
                return result.statusTable ?? {};
            }
            if (this.debug) {
                const errorText = await response.text();
                console.warn(`Failed to get state table: ${response.status} - ${errorText}`);
            }
            return null;
        } catch (error) {
            clearTimeout(timeoutId);
            if (this.debug) {
                console.error(`Error getting state table: ${error.message}`);
            }
            return null;
        }
    }

    async checkState() {
        if (!this._hasStateHandlers()) {
            return;
        }

        const state = await this._fetchStatusTable();
        if (state === null) {
            return;
        }

        if (this._lastStateInitialized) {
            if (this._stateSnapshot(state) !== this._stateSnapshot(this._lastState)) {
                try {
                    this._dispatchState(state);
                } catch (error) {
                    if (this.debug) {
                        console.error("Error in state handler:", error);
                    }
                }
            }
        }

        this._lastState = state;
        this._lastStateInitialized = true;
    }

    _extractMessageTags(message) {
        if (message.tags && message.tags.length) {
            return message.tags;
        }
        return (message.context && message.context.tags) || [];
    }

    _routeMatches(route, message) {
        if (route.msgType && message.msg_type !== route.msgType) {
            return false;
        }
        const msgTags = this._extractMessageTags(message);
        if (route.tag && !msgTags.includes(route.tag)) {
            return false;
        }
        if (route.tags && !route.tags.some((t) => msgTags.includes(t))) {
            return false;
        }
        if (route.tagsAll && !route.tagsAll.every((t) => msgTags.includes(t))) {
            return false;
        }
        return true;
    }

    _hasMessageHandlers() {
        return this._routes.length > 0 || this._defaultHandler || this.callback;
    }

    _dispatchMessage(message) {
        for (const route of this._routes) {
            if (this._routeMatches(route, message)) {
                return route.handler(message);
            }
        }
        if (this._defaultHandler) {
            return this._defaultHandler(message);
        }
        if (this.callback) {
            return this.callback(message);
        }
    }

    // Handle incoming messages from checkMessages response
    handleCheckMessagesResponse(messages) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return;
        }

        if (this.debug) {
            console.log(`Received ${messages.length} message(s) from server`);
        }

        if (!this._hasMessageHandlers()) {
            if (this.debug) {
                console.warn(`Received ${messages.length} message(s) but no handler is set`);
            }
            return;
        }

        for (const checkMsg of messages) {
            try {
                const message = this.transformCheckMessage(checkMsg);

                try {
                    const result = this._dispatchMessage(message);
                    if (result === false && this.debug) {
                        console.warn("Callback returned false for message:", message);
                    }
                } catch (error) {
                    if (this.debug) {
                        console.error("Error in callback processing message:", error);
                    }
                }
            } catch (error) {
                if (this.debug) {
                    console.error("Error transforming message:", error, checkMsg);
                }
            }
        }
    }

    // Start automatic message checking
    startMessageChecking() {
        if (this.messageCheckInterval) {
            clearInterval(this.messageCheckInterval);
        }

        if (this._hasInboundHandlers() && this.checkMsgRate > 0) {
            this.messageCheckInterval = setInterval(async () => {
                if (this._hasMessageHandlers()) {
                    await this.checkMessages(this.checkMsgLimit);
                }
                if (this._hasStateHandlers()) {
                    await this.checkState();
                }
            }, this.checkMsgRate);

            if (this.debug) {
                console.log(`Started automatic message checking (every ${this.checkMsgRate}ms)`);
            }
        }
    }

    // Stop automatic message checking
    stopMessageChecking() {
        if (this.messageCheckInterval) {
            clearInterval(this.messageCheckInterval);
            this.messageCheckInterval = null;
        }
    }

    // Set message callback
    setMessageCallback(callback) {
        if (callback && typeof callback !== "function") {
            throw new TypeError("callback must be a function");
        }
        this.callback = callback;
        // Restart message checking if callback was just set and client is running
        if (this._isRunning && callback) {
            this.startMessageChecking();
        }
    }

    setStateCallback(callback) {
        if (callback && typeof callback !== "function") {
            throw new TypeError("callback must be a function");
        }
        this.stateCallback = callback;
        if (this._isRunning && callback) {
            this.startMessageChecking();
        }
    }

    // Set message check rate
    setMessageCheckRate(rateMs) {
        this.checkMsgRate = rateMs;
        // Restart with new rate if already running
        if (this._isRunning && this._hasInboundHandlers()) {
            this.startMessageChecking();
        }
    }

    // Set message check limit
    setMessageCheckLimit(limit) {
        this.checkMsgLimit = limit;
    }

    // ==================== Connection State ====================

    // Check connection state
    async checkConnectionState() {
        const currentTime = Date.now();
        
        // Only check every 30 seconds to avoid excessive checks
        if (currentTime < this._lastConnectionCheck + 30000) {
            return this._connectionState;
        }

        this._lastConnectionCheck = currentTime;
        
        // Check if we can reach the API
        try {
            // Create abort controller for timeout (browser compatibility)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);

            const response = await fetch(`${this.apiBaseUrl}/entities/status`, {
                method: 'HEAD',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'User-Agent': `tendrl-js-sdk/${VERSION}`,
                },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);
            
            this._connectionState = response.status < 500;
        } catch (error) {
            this._connectionState = false;
        }

        return this._connectionState;
    }

    // Update entity status (online/offline)
    async _updateEntityStatus(online) {
        try {
            // Create abort controller for timeout (browser compatibility)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(`${this.apiBaseUrl}/entities/status`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': `tendrl-js-sdk/${VERSION}`,
                },
                body: JSON.stringify({ online }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (response.status === 200) {
                if (this.debug) {
                    const status = online ? "online" : "offline";
                    console.log(`Entity status updated to ${status}`);
                }
            } else if (this.debug) {
                const errorText = await response.text();
                console.warn(`Failed to update entity status: ${response.status} - ${errorText}`);
            }
        } catch (error) {
            if (this.debug) {
                console.warn(`Error updating entity status: ${error.message}`);
            }
        }
    }

    // ==================== State Table ====================

    // Get the entity's state table
    async getState() {
        return this._fetchStatusTable();
    }

    // Merge data into the entity's state table
    async updateState(data, tags = null) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const body = (tags && Array.isArray(tags) && tags.length > 0)
                ? { data: data, tags: tags }
                : data;

            const response = await fetch(`${this.apiBaseUrl}/entities/status-table`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': `tendrl-js-sdk/${VERSION}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (response.status === 200) {
                if (this.debug) {
                    console.log("State table updated successfully");
                }
                return true;
            } else {
                if (this.debug) {
                    const errorText = await response.text();
                    console.warn(`Failed to update state table: ${response.status} - ${errorText}`);
                }
                return false;
            }
        } catch (error) {
            if (this.debug) {
                console.error(`Error updating state table: ${error.message}`);
            }
            return false;
        }
    }

    // Replace the entity's state table
    async replaceState(data, tags = null) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const body = (tags && Array.isArray(tags) && tags.length > 0)
                ? { data: data, tags: tags }
                : data;

            const response = await fetch(`${this.apiBaseUrl}/entities/status-table`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': `tendrl-js-sdk/${VERSION}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (response.status === 200) {
                if (this.debug) {
                    console.log("State table replaced successfully");
                }
                return true;
            } else {
                if (this.debug) {
                    const errorText = await response.text();
                    console.warn(`Failed to replace state table: ${response.status} - ${errorText}`);
                }
                return false;
            }
        } catch (error) {
            if (this.debug) {
                console.error(`Error replacing state table: ${error.message}`);
            }
            return false;
        }
    }

    // ==================== File Transfer ====================

    /**
     * Upload a file and route it by dest or tags. The file is scanned by Surface
     * before it becomes downloadable; this resolves with the terminal result.
     * Pass exactly one of dest / tags:
     *   - dest: a bare entity name or full "account:region:entity:name" path. A
     *     same-account entity is a direct transfer; an entity-group dest broadcasts
     *     to its members; a different-account dest is a cross-account transfer (the
     *     recipient must have opted in and allowlisted this account).
     *   - tags: hands the file to matching Strand automations.
     *
     * @param {Blob|File|ArrayBuffer|Uint8Array} file - the file bytes
     * @param {Object} [opts]
     * @param {string} [opts.filename] - name to use (required for Blob/ArrayBuffer)
     * @param {string} [opts.dest] - recipient entity / group / cross-account path
     * @param {string[]} [opts.tags] - routing tags (alternative to dest)
     * @returns {Promise<Object|null>} {transfer_id, status, mode, ...} or null
     */
    async sendFile(file, { filename = '', dest = '', tags = [] } = {}) {
        try {
            const form = new FormData();
            let blob;
            if (typeof Blob !== 'undefined' && file instanceof Blob) {
                blob = file;
                if (!filename && typeof File !== 'undefined' && file instanceof File) {
                    filename = file.name;
                }
            } else {
                blob = new Blob([file]);
            }
            form.append('file', blob, filename || 'file.bin');
            if (dest) form.append('dest', dest);
            if (tags && tags.length > 0) form.append('tags', tags.join(','));

            // NOTE: do not set Content-Type — the runtime sets the multipart boundary.
            const response = await fetch(`${this.apiBaseUrl}/entities/files`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'User-Agent': `tendrl-js-sdk/${VERSION}`,
                },
                body: form,
            });

            if (response.status === 200 || response.status === 201) {
                return await response.json();
            }
            if (this.debug) {
                const errorText = await response.text();
                console.warn(`sendFile failed: ${response.status} - ${errorText}`);
            }
            return null;
        } catch (error) {
            if (this.debug) {
                console.error(`Error sending file: ${error.message}`);
            }
            return null;
        }
    }

    /**
     * List clean files available to this entity (the receiver inbox).
     * @param {number} [limit=50]
     * @returns {Promise<Array>} array of file metadata dicts (empty on failure)
     */
    async checkFiles(limit = 50) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/entities/files?limit=${limit}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': `tendrl-js-sdk/${VERSION}`,
                },
            });
            if (response.status === 200) {
                const result = await response.json();
                return result.files || [];
            }
            return [];
        } catch (error) {
            if (this.debug) {
                console.error(`Error checking files: ${error.message}`);
            }
            return [];
        }
    }

    /**
     * Download a clean file's bytes by transferId. For delete_on_download files
     * (the default) a successful download consumes the file server-side.
     * @param {string} transferId
     * @returns {Promise<Blob|null>}
     */
    async downloadFile(transferId) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/entities/files/download/${transferId}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'User-Agent': `tendrl-js-sdk/${VERSION}`,
                },
            });
            if (response.status === 200) {
                return await response.blob();
            }
            if (this.debug) {
                const errorText = await response.text();
                console.warn(`downloadFile failed: ${response.status} - ${errorText}`);
            }
            return null;
        } catch (error) {
            if (this.debug) {
                console.error(`Error downloading file: ${error.message}`);
            }
            return null;
        }
    }

    /**
     * Re-scan a received cross-account file with this account's own Surface profile,
     * billed to this (the recipient's) credits. Only the recipient may call it.
     * @param {string} transferId
     * @returns {Promise<Object|null>} {recipient_threat_level, blocked, ...} or null
     */
    async rescanFile(transferId) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/entities/files/${transferId}/rescan`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'User-Agent': `tendrl-js-sdk/${VERSION}`,
                },
            });
            if (response.status === 200) {
                return await response.json();
            }
            if (this.debug) {
                const errorText = await response.text();
                console.warn(`rescanFile failed: ${response.status} - ${errorText}`);
            }
            return null;
        } catch (error) {
            if (this.debug) {
                console.error(`Error rescanning file: ${error.message}`);
            }
            return null;
        }
    }

    // Get connection state (synchronous)
    get isConnected() {
        return this._connectionState && this._isRunning;
    }

    // ==================== Batch Processing ====================

    // Start the sender routine
    startSender() {
        if (this.senderInterval) {
            clearInterval(this.senderInterval);
        }

        this.senderInterval = setInterval(async () => {
            // Check connection state periodically (every 30 seconds)
            const currentTime = Date.now();
            if (currentTime >= (this._lastConnectionCheck + 30000)) {
                const previousState = this._connectionState;
                await this.checkConnectionState();
                this._lastConnectionCheck = currentTime;

                // If connection was restored, process offline messages
                if (!previousState && this._connectionState && this.storage) {
                    if (this.debug) {
                        console.log("Connection restored, processing offline messages");
                    }
                    await this.processOfflineMessages();
                }
            }

            if (this.queue.length > 0) {
                const batch = this.getBatch();
                if (batch.length > 0) {
                    if (this.debug) {
                        console.log(`Sending batch of ${batch.length} messages. Queue size: ${this.queue.length}`);
                    }
                    
                    // Only send if we have connection
                    if (this._connectionState) {
                        const success = await this._publishMessages(batch);
                        if (!success && this.storage) {
                            // If publish failed and we're offline, store messages
                            await this._storeBatchOffline(batch);
                        }
                    } else {
                        // Store messages offline if storage is enabled
                        if (this.storage) {
                            await this._storeBatchOffline(batch);
                        }
                    }
                }
            }

            // Cleanup expired messages every minute
            if (this.storage && currentTime >= (this._lastCleanup + 60000)) {
                try {
                    const deletedCount = await this.storage.cleanupExpired();
                    if (this.debug && deletedCount > 0) {
                        console.log(`🧹 Cleaned up ${deletedCount} expired offline messages`);
                    }
                    this._lastCleanup = currentTime;
                } catch (error) {
                    if (this.debug) {
                        console.error(`Failed to cleanup expired messages: ${error}`);
                    }
                }
            }
        }, this.calculateBatchInterval());
    }

    // Store a batch of messages offline
    async _storeBatchOffline(messages) {
        if (!this.storage || !messages || messages.length === 0) {
            return;
        }

        for (const message of messages) {
            try {
                const msgId = `offline_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                const context = message.context || {};
                await this.storage.store(
                    msgId,
                    message.data,
                    context.tags || null,
                    3600 // 1 hour TTL
                );
                if (this.debug) {
                    console.log(`Stored message offline: ${msgId}`);
                }
            } catch (error) {
                if (this.debug) {
                    console.error(`Failed to store message offline: ${error}`);
                }
            }
        }
    }

    // Stop the sender routine
    stopSender() {
        if (this.senderInterval) {
            clearInterval(this.senderInterval);
            this.senderInterval = null;
        }
    }

    // Get a batch of messages to send
    getBatch() {
        const batchSize = Math.min(this.queue.length, this.maxBatchSize);
        return this.queue.splice(0, batchSize);
    }

    // Calculate dynamic batch interval based on queue load
    calculateBatchInterval() {
        const queueLoad = (this.queue.length / this.maxQueueSize) * 100;

        if (queueLoad < 25) return this.minBatchInterval;
        if (queueLoad > 75) return this.maxBatchInterval;

        return (
            this.minBatchInterval +
            ((this.maxBatchInterval - this.minBatchInterval) * queueLoad) / 100
        );
    }

    // ==================== Offline Storage ====================

    // Process stored offline messages when connection is restored
    async processOfflineMessages() {
        if (!this.storage) {
            return;
        }

        try {
            // Check how many messages we have
            const totalCount = await this.storage.getMessageCount();
            if (totalCount === 0) {
                return;
            }

            if (this.debug) {
                console.log(`Processing ${totalCount} offline messages in batches`);
            }

            // Process in batches to avoid memory/performance issues
            const batchSize = 50; // Reasonable batch size
            let processed = 0;

            while (processed < totalCount) {
                // Get a batch of messages
                const storedMessages = await this.storage.getAllMessages(batchSize);
                if (!storedMessages || storedMessages.length === 0) {
                    break; // No more messages
                }

                // Convert stored messages back to publishable format
                const messagesToSend = [];
                const messageIdsToDelete = [];

                for (const storedMsg of storedMessages) {
                    try {
                        // Parse the stored data back to dict
                        const data = JSON.parse(storedMsg.data);
                        const tags = storedMsg.tags ? JSON.parse(storedMsg.tags) : null;

                        // Create message in the expected format
                        const message = {
                            msg_type: "publish",
                            data: data,
                            timestamp: new Date().toISOString(),
                        };

                        if (tags && tags.length > 0) {
                            message.context = { tags: tags };
                        }

                        messagesToSend.push(message);
                        messageIdsToDelete.push(storedMsg.id);
                    } catch (error) {
                        if (this.debug) {
                            console.error(`Error processing stored message ${storedMsg.id}: ${error}`);
                        }
                        // Delete corrupted message
                        messageIdsToDelete.push(storedMsg.id);
                    }
                }

                // Send the batch
                if (messagesToSend.length > 0) {
                    try {
                        const success = await this._publishMessages(messagesToSend);

                        if (success) {
                            // Only delete messages if they were sent successfully
                            await this.storage.deleteMessages(messageIdsToDelete);
                            processed += messagesToSend.length;
                            if (this.debug) {
                                console.log(`Sent batch of ${messagesToSend.length} messages (${processed}/${totalCount})`);
                            }
                        } else {
                            if (this.debug) {
                                console.log(`Failed to send batch, keeping messages for retry`);
                            }
                            break; // Stop processing if sending fails
                        }
                    } catch (error) {
                        if (this.debug) {
                            console.error(`Failed to send offline message batch: ${error}`);
                        }
                        break; // Stop processing if sending fails
                    }
                } else {
                    // Delete any corrupted messages and continue
                    if (messageIdsToDelete.length > 0) {
                        await this.storage.deleteMessages(messageIdsToDelete);
                        processed += messageIdsToDelete.length;
                    }
                    break;
                }
            }

            if (this.debug && processed > 0) {
                console.log(`Finished processing offline messages: ${processed} total`);
            }
        } catch (error) {
            if (this.debug) {
                console.error(`Error processing offline messages: ${error}`);
            }
        }
    }
}

export default TendrlClient;
