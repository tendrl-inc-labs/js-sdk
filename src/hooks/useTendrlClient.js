// src/hooks/useTendrlClient.js
// React hook for TendrlClient

import { useEffect, useRef } from "react";
import TendrlClient from "../utils/TendrlClient";

const useTendrlClient = ({
    onMessage = null,
    debug = false,
    minBatchSize = 10,
    maxBatchSize = 100,
    minBatchInterval = 100, // in ms
    maxBatchInterval = 1000, // in ms
    maxQueueSize = 1000,
    checkMsgRate = 3000, // Message check frequency in ms (default: 3 seconds)
    checkMsgLimit = 1, // Maximum messages to retrieve per check
    apiBaseUrl = null,
    offlineStorage = false, // Enable offline storage
    dbName = 'tendrl_offline', // IndexedDB database name
}) => {
    const clientRef = useRef(null);

    useEffect(() => {
        // Use provided apiBaseUrl or default to production API
        const baseUrl = apiBaseUrl || 'https://app.tendrl.com/api';
        const apiKey = process.env.REACT_APP_TENDRL_KEY;

        if (!apiKey) {
            console.error("TENDRL_KEY environment variable is missing.");
            return;
        }

        // Initialize the client
        clientRef.current = new TendrlClient({
            apiBaseUrl: baseUrl,
            apiKey,
            debug,
            callback: onMessage,
            minBatchSize,
            maxBatchSize,
            minBatchInterval,
            maxBatchInterval,
            maxQueueSize,
            checkMsgRate,
            checkMsgLimit,
            offlineStorage,
            dbName,
        });

        // Start the client
        clientRef.current.start();

        // Cleanup on unmount
        return () => {
            if (clientRef.current) {
                clientRef.current.stop();
                if (debug) console.log("TendrlClient stopped.");
            }
        };
    }, [debug, onMessage, minBatchSize, maxBatchSize, minBatchInterval, maxBatchInterval, maxQueueSize, checkMsgRate, checkMsgLimit, apiBaseUrl, offlineStorage, dbName]);

    // Function to publish messages
    const publish = (msg, tags = [], entity = "", waitResponse = false) => {
        if (clientRef.current) {
            clientRef.current.publish(msg, tags, entity, waitResponse);
        } else {
            console.error("TendrlClient is not initialized.");
        }
    };

    // Function to check messages
    const checkMessages = (limit = null) => {
        if (clientRef.current) {
            clientRef.current.checkMessages(limit);
        } else {
            console.error("TendrlClient is not initialized.");
        }
    };

    // Function to set message callback
    const setMessageCallback = (callback) => {
        if (clientRef.current) {
            clientRef.current.setMessageCallback(callback);
        } else {
            console.error("TendrlClient is not initialized.");
        }
    };

    // Function to set message check rate
    const setMessageCheckRate = (rateMs) => {
        if (clientRef.current) {
            clientRef.current.setMessageCheckRate(rateMs);
        } else {
            console.error("TendrlClient is not initialized.");
        }
    };

    // Function to set message check limit
    const setMessageCheckLimit = (limit) => {
        if (clientRef.current) {
            clientRef.current.setMessageCheckLimit(limit);
        } else {
            console.error("TendrlClient is not initialized.");
        }
    };

    // Function to send heartbeat
    const sendHeartbeat = async ({ mem_free, mem_total, disk_free, disk_size }) => {
        if (clientRef.current) {
            return await clientRef.current.sendHeartbeat({ mem_free, mem_total, disk_free, disk_size });
        } else {
            console.error("TendrlClient is not initialized.");
        }
    };

    // Get connection state
    const isConnected = clientRef.current ? clientRef.current.isConnected : false;

    return { 
        client: clientRef.current,
        publish, 
        checkMessages, 
        setMessageCallback,
        setMessageCheckRate,
        setMessageCheckLimit,
        sendHeartbeat,
        isConnected,
    };
};

export default useTendrlClient;

