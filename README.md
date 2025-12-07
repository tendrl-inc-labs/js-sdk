# Tendrl JavaScript SDK

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/tendrl-inc/clients/tendrl_js_sdk)
[![Node.js Version](https://img.shields.io/badge/node.js-16+-339933.svg)](https://nodejs.org/)
[![React Version](https://img.shields.io/badge/react-18+-61DAFB.svg)](https://reactjs.org/)
[![License](https://img.shields.io/badge/license-Proprietary-red.svg)](LICENSE)

A modern JavaScript/React SDK for messaging with dynamic batching, automatic message checking, and offline storage.

## ⚠️ License Notice

**This software is licensed for use with Tendrl services only.**

### ✅ Allowed

- Use the software with Tendrl services
- Inspect and learn from the code for educational purposes
- Modify or extend the software for personal or Tendrl-related use

### ❌ Not Allowed

- Use in any competing product or service
- Connect to any backend not operated by Tendrl, Inc.
- Package into any commercial or hosted product (e.g., SaaS, PaaS)
- Copy design patterns or protocol logic for another system without permission

For licensing questions, contact: `support@tendrl.com`

## Features

- **Dynamic Batching**: Queue-aware batch processing (10-100 messages)
- **Message Queuing**: In-memory queue with configurable size limits
- **React Integration**: Custom hooks for seamless React integration
- **Performance Monitoring**: Built-in queue load and batch optimization
- **Error Handling**: Robust error handling and connection management
- **Automatic Message Checking**: Background polling for incoming messages (matches Python SDK)
- **Message Transformation**: Automatic format conversion for consistency
- **Connection State Management**: Built-in connection state tracking
- **Offline Storage**: IndexedDB-based message persistence (matches Python SDK)

## Installation

### NPM (Recommended)

```bash
npm install tendrl
```

### Manual Installation

Alternatively, you can copy the `src/` directory into your project and import directly.

### For React Projects

The React hooks require React as a peer dependency (which you likely already have):

```bash
npm install react  # If not already installed
```

### For Non-React Projects

You can use the client class directly without React - no dependencies required.

## Quick Start

### Using NPM Package

```javascript
import TendrlClient from 'tendrl';
// or
import TendrlClient from 'tendrl/utils';
// or for React hooks
import useTendrlClient from 'tendrl/hooks';
```

### Using Source Code Directly

```javascript
import TendrlClient from './path/to/src/utils/TendrlClient';

// Initialize client
const client = new TendrlClient({
    apiBaseUrl: 'https://app.tendrl.com/api',
    apiKey: 'your_api_key',
    debug: true,
    callback: (message) => {
        console.log('Received:', message);
    }
});

// Start client
client.start();

// Publish messages
client.publish({
    event: 'user_action',
    timestamp: Date.now(),
    data: { action: 'click', button: 'submit' }
}, ['ui', 'events']);

// Check for messages manually (automatic checking is enabled)
client.checkMessages(5);
```

### React Integration

```jsx
import React from 'react';
import useTendrlClient from './hooks/useTendrlClient';

function MyComponent() {
    const { client, isConnected, publish } = useTendrlClient({
        onMessage: (message) => {
            console.log('Received:', message);
        }
    });

    const handleButtonClick = () => {
        publish({
            event: 'button_click',
            component: 'MyComponent',
            timestamp: Date.now()
        }, ['ui', 'interaction']);
    };

    return (
        <div>
            <p>Status: {isConnected ? 'Connected' : 'Disconnected'}</p>
            <button onClick={handleButtonClick}>
                Send Event
            </button>
        </div>
    );
}
```

## Configuration Options

```javascript
const client = new TendrlClient({
    apiBaseUrl: 'https://app.tendrl.com/api', // API base URL (default: https://app.tendrl.com/api)
    apiKey: 'your_api_key',                   // Authentication key (required)
    debug: false,                             // Enable debug logging
    minBatchSize: 10,                         // Minimum messages per batch
    maxBatchSize: 100,                        // Maximum messages per batch
    minBatchInterval: 100,                    // Minimum batch interval (ms)
    maxBatchInterval: 1000,                   // Maximum batch interval (ms)
    maxQueueSize: 1000,                       // Maximum queue size
    callback: (message) => console.log(message), // Message callback function
    checkMsgRate: 3000,                       // Automatic message check frequency (ms, default: 3000)
    checkMsgLimit: 1,                        // Maximum messages per check (default: 1)
    offlineStorage: false,                   // Enable offline storage (IndexedDB)
    dbName: 'tendrl_offline',                // IndexedDB database name
});
```

## API Reference

### Methods

#### `publish(message, tags, entity, waitResponse)`

Publishes a message to the server. Accepts both string and object messages (matching Python SDK behavior).

**Parameters:**

- `message` (string | object): Message data. If a string is provided, it will be wrapped in `{data: message}` automatically.
- `tags` (string[]): Optional array of tags for categorization.
- `entity` (string): Optional destination entity ID.
- `waitResponse` (boolean): If true, waits for response before returning (synchronous).

```javascript
// Publish an object (async, queued)
client.publish({
    sensor: 'temperature',
    value: 23.5
}, ['sensors', 'environment']);

// Publish a string (automatically wrapped in {data: "..."})
client.publish('Simple text message', ['logs']);

// Synchronous publishing (immediate, waits for response)
client.publish({
    alert: 'high_temperature',
    value: 45.0
}, ['alerts'], 'sensor-001', true);
```

#### `checkMessages(limit)`

Requests messages from the server. If automatic message checking is enabled, this is called automatically at the configured interval.

```javascript
client.checkMessages(10); // Get up to 10 messages (uses default limit if null)
```

#### `setMessageCallback(callback)`

Sets or updates the message callback function. If automatic message checking is running, it will be restarted with the new callback.

```javascript
client.setMessageCallback((message) => {
    console.log('Received:', message);
    return true; // Return false if processing failed
});
```

#### `setMessageCheckRate(rateMs)`

Sets the automatic message checking frequency in milliseconds.

```javascript
client.setMessageCheckRate(5000); // Check every 5 seconds
```

#### `setMessageCheckLimit(limit)`

Sets the maximum number of messages to retrieve per check.

```javascript
client.setMessageCheckLimit(10); // Get up to 10 messages per check
```

#### `checkConnectionState()`

Checks the current connection state and returns true if connected, false otherwise.

```javascript
const isConnected = await client.checkConnectionState();
```

#### `start()`

Starts the client. No async connection needed - this is synchronous.

```javascript
client.start();
```

#### `stop()`

Stops the client and updates entity status to offline.

```javascript
client.stop();
```

#### `isConnected` (property)

Returns the current connection state (read-only property).

```javascript
if (client.isConnected) {
    console.log('Client is connected');
}
```

#### `sendHeartbeat({ mem_free, mem_total, disk_free, disk_size })`

Sends a heartbeat message with system resource information. Always sends immediately and waits for response (matching Python SDK behavior).

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `mem_free` | `number` | Available RAM in bytes (must be non-negative if provided) |
| `mem_total` | `number` | Total RAM in bytes (must be non-negative if provided) |
| `disk_free` | `number` | Available filesystem space in bytes (must be non-negative if provided) |
| `disk_size` | `number` | Total filesystem size in bytes (must be non-negative if provided) |

**Returns:** `Promise<any>` - Resolves with server response or `null` on error

**Throws:** `Error` - If any provided parameter is negative. Backend will validate required fields and return appropriate errors.

**Example:**

```javascript
// Send heartbeat with system resource information
await client.sendHeartbeat({
    mem_free: 8589934592,      // 8 GB in bytes
    mem_total: 17179869184,    // 16 GB in bytes
    disk_free: 107374182400,   // 100 GB in bytes
    disk_size: 1073741824000   // 1 TB in bytes
});
```

**Notes:**

- All values must be in bytes and non-negative (≥ 0) if provided
- The heartbeat message is sent immediately (bypasses queue) and waits for server response

### Message Callbacks

```javascript
// Set up callback to handle incoming messages
function messageHandler(message) {
    // Process incoming message
    // Message format matches Python SDK: {msg_type, data, context: {tags}, source, timestamp, dest, request_id}
    console.log(`Received: ${message.msg_type} from ${message.source}`);
    
    // Access message data
    const data = message.data;
    const tags = message.context?.tags || [];
    
    // Return true to indicate successful processing
    // Return false if processing failed (won't stop other messages)
    return true;
}

// Set callback (automatic message checking will start if client is running)
client.setMessageCallback(messageHandler);

// Configure checking behavior (optional)
client.setMessageCheckRate(5000); // Check every 5 seconds (default: 3000ms)
client.setMessageCheckLimit(10);  // Max messages per check (default: 1)

// Manual message check
client.checkMessages(5);
```

**Automatic Message Checking**: When a callback is set and the client is running, messages are automatically checked at the configured interval (`checkMsgRate`). This matches the Python SDK's behavior.

### IncomingMessage Structure

| Field | Type | Description | Required |
|-------|------|-------------|----------|
| `msg_type` | `string` | Message type identifier (e.g., "command", "notification", "alert") | ✅ Yes |
| `source` | `string` | Sender's resource path (set by server) | ✅ Yes |
| `dest` | `string` | Destination entity identifier | ❌ Optional |
| `timestamp` | `string` | RFC3339 timestamp (set by server) | ✅ Yes |
| `data` | `any` | The actual message payload (can be any JSON type) | ✅ Yes |
| `context` | `object` | Message metadata | ❌ Optional |
| `request_id` | `string` | Request identifier (if message was a request) | ❌ Optional |

### Message Context Structure

| Field | Type | Description | Required |
|-------|------|-------------|----------|
| `tags` | `string[]` | Message tags for categorization | ❌ Optional |
| `dynamicActions` | `object` | Server-side validation results | ❌ Optional |

### Message Checking How It Works

1. **Automatic Background Checking**: When a callback is set, the SDK automatically checks for messages every 3 seconds (configurable via `checkMsgRate`)
2. **Manual Checking**: You can call `checkMessages()` manually anytime
3. **Message Transformation**: Incoming messages are automatically transformed from CheckMessage format to Message format (matching Python SDK)
4. **Callback Execution**: Your callback function is called for each incoming message
5. **Error Handling**: Failed callbacks don't stop other message processing
6. **Connectivity Aware**: Automatically handles network failures and updates connectivity state

### React Hooks

#### `useTendrlClient`

```javascript
import useTendrlClient from 'tendrl/hooks';
// or
import { useTendrlClient } from 'tendrl';

const {
    client,              // TendrlClient instance
    isConnected,         // Connection status
    publish,             // Publish function
    checkMessages,       // Manual message check function
    setMessageCallback,  // Set/update message callback
    setMessageCheckRate, // Set message check frequency
    setMessageCheckLimit, // Set message check limit
    sendHeartbeat,       // Send heartbeat function
} = useTendrlClient({
    onMessage: (message) => {
        // Handle incoming messages
        console.log('Received:', message);
    },
    debug: false,
    checkMsgRate: 3000,  // Check every 3 seconds
    checkMsgLimit: 1,    // Get 1 message per check
    // ... other config options
});
```

## Message Format

### Publishing Messages

Messages are automatically formatted. You can publish either:

- **Objects**: Passed directly as message data
- **Strings**: Automatically wrapped in `{data: "your string"}`

```javascript
// Object message
client.publish({ event: 'click', button: 'submit' }, ['ui']);

// String message (automatically wrapped)
client.publish('Log message', ['logs']);
```

## Error Handling

```javascript
// Start error handling
try {
    client.start();
    console.log('Client started successfully');
} catch (error) {
    console.error('Failed to start client:', error);
}

// Message publishing error handling
try {
    client.publish(messageData, tags);
} catch (error) {
    console.error('Publishing failed:', error);
}

// Check connection state
const isConnected = await client.checkConnectionState();
if (!isConnected) {
    console.warn('Client is not connected');
}
```

## Performance Features

### Dynamic Batching

- Automatically adjusts batch size based on queue load
- Optimizes sending intervals based on queue performance
- Prevents queue overflow with configurable limits

### Memory Management

- Configurable queue size limits
- Automatic message discarding when queue is full (or offline storage if enabled)
- Efficient batch processing to minimize memory usage

## Offline Storage

The SDK supports offline message storage using IndexedDB (browser's native database). This ensures messages are not lost during network outages.

### Enabling Offline Storage

```javascript
const client = new TendrlClient({
    apiBaseUrl: 'https://app.tendrl.com/api',
    apiKey: 'your_api_key',
    offlineStorage: true,  // Enable offline storage
    dbName: 'tendrl_offline',  // Optional: custom database name
});
```

### How It Works

1. **When Offline**: Messages are automatically stored in IndexedDB when:
   - Connection is lost
   - Queue is full (messages stored instead of discarded)
   - Publish fails due to network error

2. **When Online**: Stored messages are automatically processed when connection is restored:
   - Messages are sent in batches (50 messages per batch)
   - Tags are preserved from original messages
   - Messages are deleted after successful sending

3. **TTL Expiration**: Messages expire after 1 hour (3600 seconds) by default
   - Expired messages are automatically cleaned up
   - Cleanup runs every minute

### Offline Storage Features

- **Automatic Storage**: Messages stored when offline or queue full
- **Automatic Processing**: Messages sent when connection restored
- **Tag Preservation**: Tags are stored and restored with messages
- **TTL Expiration**: Messages expire after configurable time
- **Batch Processing**: Large backlogs processed in manageable batches
- **Error Handling**: Failed batches don't affect successfully sent messages

### Example Usage

```javascript
const client = new TendrlClient({
    apiBaseUrl: 'https://app.tendrl.com/api',
    apiKey: 'your_api_key',
    offlineStorage: true,
    debug: true,
});

client.start();

// Publish messages - they'll be stored offline if connection is lost
client.publish({ sensor: 'temp', value: 23.5 }, ['sensors']);

// When connection is restored, offline messages are automatically processed
// No manual intervention needed!
```

## Development

### SDK Structure

The SDK code is located in the `src/` directory:

- `src/hooks/` - React hooks (`useTendrlClient`)
- `src/utils/` - Client class (`TendrlClient`)

### Examples

Example applications are located in the `examples/` directory. See `examples/README.md` for details on running the examples.

To run the examples:

```bash
cd examples
npm install
npm start
```

## Environment Variables

```bash
REACT_APP_TENDRL_KEY=your_api_key
```

**Note**: The API base URL is set statically in the code with production default (`https://app.tendrl.com/api`). You only need to set `REACT_APP_TENDRL_KEY`. Override the URL via `apiBaseUrl` parameter only if you're using a different environment.

## Browser Compatibility

- Chrome 88+
- Firefox 84+
- Safari 14+
- Edge 88+

## License

Copyright (c) 2025 tendrl, inc.
All rights reserved. Unauthorized copying, distribution, modification, or usage of this code, via any medium, is strictly prohibited without express permission from the author.
