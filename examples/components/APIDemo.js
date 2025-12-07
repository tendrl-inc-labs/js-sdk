// examples/components/APIDemo.js

import React, { useState, useEffect } from "react";
import useTendrlClient from "../../src/hooks/useTendrlClient";

const APIDemo = () => {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState("");
    const [connectionStatus, setConnectionStatus] = useState("Disconnected");

    // Callback to handle incoming messages
    const handleMessage = (message) => {
        setMessages((prevMessages) => [...prevMessages, message]);
        console.log("Received message:", message);
    };

    // Initialize TendrlClient
    const { client, isConnected, publish, checkMessages } = useTendrlClient({
        debug: true,
        onMessage: handleMessage,
        minBatchSize: 10,
        maxBatchSize: 100,
        minBatchInterval: 100,
        maxBatchInterval: 1000,
        maxQueueSize: 1000,
        checkMsgRate: 3000,
        checkMsgLimit: 1,
    });

    // Monitor connection status
    useEffect(() => {
        const interval = setInterval(() => {
            setConnectionStatus(isConnected ? "Connected" : "Disconnected");
        }, 1000); // Update every second

        return () => clearInterval(interval);
    }, [isConnected]);

    // Function to send a message
    const sendMessage = () => {
        if (input.trim() === "") return;

        // Can send string or object
        const message = { content: input, timestamp: Date.now() };
        publish(message, ["chat", "demo"], "");
        setInput("");
    };

    // Function to send a string message
    const sendStringMessage = () => {
        if (input.trim() === "") return;

        // String messages are automatically wrapped in {data: "..."}
        publish(input, ["chat", "string"], "");
        setInput("");
    };

    // Function to manually check for messages
    const manualCheck = () => {
        checkMessages(5);
    };

    return (
        <div style={styles.container}>
            <h2>Tendrl Client Demo</h2>
            <p>Status: <strong>{connectionStatus}</strong></p>
            <p style={styles.info}>
                Messages are sent via API and automatically batched for optimal performance.
            </p>
            <div style={styles.messageContainer}>
                <h3>Received Messages:</h3>
                {messages.length === 0 ? (
                    <p style={styles.empty}>No messages yet...</p>
                ) : (
                    messages.map((msg, index) => (
                        <div key={index} style={styles.message}>
                            <strong>{msg.msg_type || 'message'}:</strong> {JSON.stringify(msg.data, null, 2)}
                            {msg.context?.tags && (
                                <div style={styles.tags}>
                                    Tags: {msg.context.tags.join(', ')}
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>
            <div style={styles.inputContainer}>
                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Type a message..."
                    style={styles.input}
                    onKeyPress={(e) => {
                        if (e.key === 'Enter') {
                            sendMessage();
                        }
                    }}
                />
                <button onClick={sendMessage} style={styles.button}>
                    Send Object
                </button>
                <button onClick={sendStringMessage} style={styles.buttonSecondary}>
                    Send String
                </button>
                <button onClick={manualCheck} style={styles.button}>
                    Check Messages
                </button>
            </div>
        </div>
    );
};

// Simple inline styles for demonstration
const styles = {
    container: {
        padding: "20px",
        maxWidth: "600px",
        margin: "20px auto",
        border: "1px solid #ccc",
        borderRadius: "8px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
    },
    info: {
        fontSize: "14px",
        color: "#666",
        marginBottom: "20px",
        padding: "10px",
        backgroundColor: "#f0f8ff",
        borderRadius: "4px",
    },
    messageContainer: {
        height: "300px",
        overflowY: "scroll",
        border: "1px solid #eee",
        padding: "10px",
        marginBottom: "20px",
        backgroundColor: "#f9f9f9",
        borderRadius: "4px",
    },
    empty: {
        color: "#999",
        fontStyle: "italic",
        textAlign: "center",
        padding: "20px",
    },
    message: {
        marginBottom: "10px",
        padding: "8px",
        backgroundColor: "#fff",
        borderRadius: "4px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
    },
    tags: {
        marginTop: "5px",
        fontSize: "12px",
        color: "#666",
    },
    inputContainer: {
        display: "flex",
        gap: "10px",
        flexWrap: "wrap",
    },
    input: {
        flex: 1,
        minWidth: "200px",
        padding: "10px",
        borderRadius: "4px",
        border: "1px solid #ccc",
        fontSize: "16px",
    },
    button: {
        padding: "10px 20px",
        borderRadius: "4px",
        border: "none",
        backgroundColor: "#28a745",
        color: "#fff",
        cursor: "pointer",
        fontSize: "16px",
    },
    buttonSecondary: {
        padding: "10px 20px",
        borderRadius: "4px",
        border: "none",
        backgroundColor: "#17a2b8",
        color: "#fff",
        cursor: "pointer",
        fontSize: "16px",
    },
};

export default APIDemo;

