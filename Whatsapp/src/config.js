// ============================================
// Dynamic Configuration Store
// ============================================
// Allows user to control speed, delays, and rate limits
// live from the Dashboard or via API (like WaSender)

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CONFIG_FILE = path.join(__dirname, '..', 'settings.json');

// Default settings
const DEFAULT_SETTINGS = {
    // Delay between each message in seconds (e.g. 6 seconds = 10 messages/min)
    delaySeconds: 6,
    // Random jitter around delay (± seconds) so it's not a robotic exact timer
    delayJitter: 1,
    // Max messages allowed per hour (0 or >= 600 for high volume)
    maxPerHour: 600,
    // Typing simulation
    enableTyping: true,
    typingSeconds: 2,
    // Spintax variation
    enableSpintax: true
};

let currentSettings = { ...DEFAULT_SETTINGS };

/**
 * Load settings from file on startup (fallback to .env or defaults)
 */
function loadSettings() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
            const saved = JSON.parse(data);
            currentSettings = { ...DEFAULT_SETTINGS, ...saved };
            logger.info(`Loaded custom settings: Delay ${currentSettings.delaySeconds}s, Max/Hour: ${currentSettings.maxPerHour}`);
        } else {
            // Check .env overrides
            if (process.env.MIN_DELAY_MS) {
                currentSettings.delaySeconds = Math.round(parseInt(process.env.MIN_DELAY_MS) / 1000);
            }
            if (process.env.MAX_MESSAGES_PER_HOUR) {
                currentSettings.maxPerHour = parseInt(process.env.MAX_MESSAGES_PER_HOUR);
            }
            saveSettings(currentSettings);
        }
    } catch (err) {
        logger.warn(`Could not load settings file: ${err.message}. Using defaults.`);
        currentSettings = { ...DEFAULT_SETTINGS };
    }
    return currentSettings;
}

/**
 * Save settings to file
 */
function saveSettings(newSettings) {
    try {
        currentSettings = {
            ...currentSettings,
            ...newSettings,
            delaySeconds: Math.max(1, parseInt(newSettings.delaySeconds) || 6),
            delayJitter: Math.max(0, parseFloat(newSettings.delayJitter) || 0),
            maxPerHour: parseInt(newSettings.maxPerHour) ?? 600,
            typingSeconds: Math.max(1, parseInt(newSettings.typingSeconds) || 2),
            enableTyping: newSettings.enableTyping !== false,
            enableSpintax: newSettings.enableSpintax !== false
        };

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentSettings, null, 2));
        logger.info(`Settings updated: Delay ${currentSettings.delaySeconds}s (±${currentSettings.delayJitter}s), Max ${currentSettings.maxPerHour}/hr`);
        return currentSettings;
    } catch (err) {
        logger.error(`Error saving settings: ${err.message}`);
        throw err;
    }
}

function getSettings() {
    return currentSettings;
}

module.exports = {
    loadSettings,
    saveSettings,
    getSettings
};
