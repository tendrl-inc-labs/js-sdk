// src/utils/TendrlClient.js
// API-only client using native fetch

import IndexedDBStorage from './IndexedDBStorage.js';

class TendrlClient {
    constructor({
        apiBaseUrl = 'https://app.tendrl.com/api',
        apiKey,
        debug = false,
        // Batching configuration
        minBatchSize = 10,
        maxBatchSize = 100,
        minBatchInterval = 100, // in ms
        maxBatchInterval = 1000, // in ms
        // Common configuration
        callback = null,
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
        if (this.callback) {
            this.startMessageChecking();
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
        const message = {
            msg_type: checkMsg.msg_type || "command",
            data: checkMsg.data || {},
            source: checkMsg.source || "",
            timestamp: checkMsg.timestamp || new Date().toISOString(),
        };

        // Move tags to context if they exist
        if (checkMsg.tags && Array.isArray(checkMsg.tags) && checkMsg.tags.length > 0) {
            message.context = {
                tags: checkMsg.tags,
            };
        }

        // Add optional fields
        if (checkMsg.dest) message.dest = checkMsg.dest;
        if (checkMsg.request_id) message.request_id = checkMsg.request_id;

        return message;
    }

    // Handle incoming messages from checkMessages response
    handleCheckMessagesResponse(messages) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return;
        }

        if (this.debug) {
            console.log(`Received ${messages.length} message(s) from server`);
        }

        if (!this.callback) {
            if (this.debug) {
                console.warn(`Received ${messages.length} message(s) but no callback is set`);
            }
            return;
        }

        // Transform and process each message
        for (const checkMsg of messages) {
            try {
                const message = this.transformCheckMessage(checkMsg);
                
                try {
                    const result = this.callback(message);
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

        if (this.callback && this.checkMsgRate > 0) {
            this.messageCheckInterval = setInterval(() => {
                this.checkMessages(this.checkMsgLimit);
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

    // Set message check rate
    setMessageCheckRate(rateMs) {
        this.checkMsgRate = rateMs;
        // Restart with new rate if already running
        if (this._isRunning && this.callback) {
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
