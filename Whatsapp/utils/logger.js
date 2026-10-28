// utils/logger.js

const info = (message, ...args) => {
    console.log(`ℹ️ [INFO] ${new Date().toISOString()}: ${message}`, ...args);
};

const warn = (message, ...args) => {
    console.warn(`[WARN] ${new Date().toISOString()}: ${message}`, ...args);
};

const error = (message, ...args) => {
    console.error(`❌ [ERROR] ${new Date().toISOString()}: ${message}`, ...args);
};

module.exports = {
    info,
    warn,
    error
};
