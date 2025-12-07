// src/utils/IndexedDBStorage.js
// IndexedDB-based offline storage for browser environments

class IndexedDBStorage {
    constructor(dbName = 'tendrl_offline', dbVersion = 1) {
        this.dbName = dbName;
        this.dbVersion = dbVersion;
        this.db = null;
        this.storeName = 'messages';
    }

    // Initialize the database
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => {
                reject(new Error(`Failed to open IndexedDB: ${request.error}`));
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Create object store if it doesn't exist
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const objectStore = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    // Create index for expires_at for efficient cleanup
                    objectStore.createIndex('expires_at', 'expires_at', { unique: false });
                }
            };
        });
    }

    // Store a message with TTL
    async store(msgId, data, tags = null, ttl = 3600) {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            
            const expiresAt = Date.now() + (ttl * 1000); // Convert seconds to milliseconds
            
            const message = {
                id: msgId,
                data: JSON.stringify(data),
                tags: tags ? JSON.stringify(tags) : null,
                expires_at: expiresAt,
            };

            const request = store.put(message);

            request.onsuccess = () => {
                resolve();
            };

            request.onerror = () => {
                reject(new Error(`Failed to store message: ${request.error}`));
            };
        });
    }

    // Get all non-expired messages
    async getAllMessages(limit = null) {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('expires_at');
            
            const currentTime = Date.now();
            // Get messages where expires_at >= currentTime (not expired)
            const range = IDBKeyRange.lowerBound(currentTime);
            const request = index.openCursor(range);
            
            const messages = [];

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                
                if (cursor && (!limit || messages.length < limit)) {
                    messages.push({
                        id: cursor.value.id,
                        data: cursor.value.data,
                        tags: cursor.value.tags,
                        expires_at: cursor.value.expires_at,
                    });
                    cursor.continue();
                } else {
                    resolve(messages);
                }
            };

            request.onerror = () => {
                reject(new Error(`Failed to retrieve messages: ${request.error}`));
            };
        });
    }

    // Delete messages by their IDs
    async deleteMessages(msgIds) {
        if (!msgIds || msgIds.length === 0) {
            return;
        }

        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            
            let completed = 0;
            let errors = 0;

            msgIds.forEach((id) => {
                const request = store.delete(id);
                
                request.onsuccess = () => {
                    completed++;
                    if (completed + errors === msgIds.length) {
                        if (errors > 0) {
                            reject(new Error(`Failed to delete ${errors} message(s)`));
                        } else {
                            resolve();
                        }
                    }
                };

                request.onerror = () => {
                    errors++;
                    if (completed + errors === msgIds.length) {
                        reject(new Error(`Failed to delete messages: ${request.error}`));
                    }
                };
            });
        });
    }

    // Get count of non-expired messages
    async getMessageCount() {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('expires_at');
            
            const currentTime = Date.now();
            // Count messages where expires_at >= currentTime (not expired)
            const range = IDBKeyRange.lowerBound(currentTime);
            const request = index.count(range);

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onerror = () => {
                reject(new Error(`Failed to count messages: ${request.error}`));
            };
        });
    }

    // Cleanup expired messages
    async cleanupExpired() {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('expires_at');
            
            const currentTime = Date.now();
            const range = IDBKeyRange.upperBound(currentTime - 1); // Messages expired before now
            const request = index.openKeyCursor(range);
            
            let deletedCount = 0;
            const deletePromises = [];

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                
                if (cursor) {
                    deletePromises.push(
                        new Promise((deleteResolve, deleteReject) => {
                            const deleteRequest = store.delete(cursor.primaryKey);
                            deleteRequest.onsuccess = () => {
                                deletedCount++;
                                deleteResolve();
                            };
                            deleteRequest.onerror = () => {
                                deleteReject(deleteRequest.error);
                            };
                        })
                    );
                    cursor.continue();
                } else {
                    // All expired messages queued for deletion
                    Promise.all(deletePromises)
                        .then(() => resolve(deletedCount))
                        .catch((error) => reject(error));
                }
            };

            request.onerror = () => {
                reject(new Error(`Failed to cleanup expired messages: ${request.error}`));
            };
        });
    }

    // Close database connection
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

export default IndexedDBStorage;

