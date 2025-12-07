// src/utils/TendrlClientInstance.js

import TendrlClient from "./TendrlClient";

let instance = null;

/**
 * Returns the singleton instance of TendrlClient.
 * If it doesn't exist, it creates one with the provided config.
 * Subsequent calls ignore the config and return the existing instance.
 *
 * @param {Object} config - Configuration object for TendrlClient
 * @returns {TendrlClient} - Singleton instance
 */
const getTendrlClient = (config) => {
    if (!instance) {
        instance = new TendrlClient(config);
    }
    return instance;
};

export default getTendrlClient;