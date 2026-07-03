/**
 * Veritas Service Worker (Background Script)
 * Handles extension lifecycle events and manages state
 */

const LOG_PREFIX = '[Veritas BG]';

// Event: Extension installed or updated
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log(`${LOG_PREFIX} ✓ Extension installed`);

        // Set default storage values
        chrome.storage.local.set({
            installDate: Date.now(),
            totalScans: 0,
            restrictedCount: 0,
            friendlyCount: 0,
            neutralCount: 0
        });

        // Open welcome page (optional for v1.0)
        // chrome.tabs.create({ url: 'https://github.com/ChristianMangwanda/Veritas' });
    } else if (details.reason === 'update') {
        console.log(`${LOG_PREFIX} ✓ Extension updated to v${chrome.runtime.getManifest().version}`);
    }
});

// Event: Message received from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SCAN_RESULT') {
        handleScanResult(message, sender.tab);
    }
    return true; // Keep message channel open
});

/**
 * Handles scan results from content scripts
 * @param {Object} message - The scan result message
 * @param {Object} tab - The tab that sent the message
 */
function handleScanResult(message, tab) {
    const { state, url, matchCount, scanTime } = message;

    console.log(`${LOG_PREFIX} Scan result: ${state} (${matchCount} matches, ${scanTime.toFixed(2)}ms)`);

    // Update toolbar badge
    updateToolbarBadge(tab.id, state);

    // Store result for this URL
    chrome.storage.local.set({
        [`result_${url}`]: {
            state,
            matchCount,
            scanTime,
            timestamp: Date.now()
        }
    });

    // Update statistics
    updateStatistics(state);
}

/**
 * Updates the toolbar icon badge based on scan state
 * @param {number} tabId - The tab ID
 * @param {string} state - The visa eligibility state
 */
function updateToolbarBadge(tabId, state) {
    const badgeConfig = {
        'RESTRICTED': { text: '✕', color: '#dc2626' },
        'FRIENDLY': { text: '✓', color: '#10b981' },
        'NEUTRAL': { text: '?', color: '#999999' }
    };

    const config = badgeConfig[state] || badgeConfig['NEUTRAL'];

    chrome.action.setBadgeText({
        tabId,
        text: config.text
    });

    chrome.action.setBadgeBackgroundColor({
        tabId,
        color: config.color
    });
}

/**
 * Updates usage statistics
 * @param {string} state - The scan result state
 */
function updateStatistics(state) {
    chrome.storage.local.get(['totalScans', 'restrictedCount', 'friendlyCount', 'neutralCount'], (data) => {
        const updates = {
            totalScans: (data.totalScans || 0) + 1
        };

        if (state === 'RESTRICTED') {
            updates.restrictedCount = (data.restrictedCount || 0) + 1;
        } else if (state === 'FRIENDLY') {
            updates.friendlyCount = (data.friendlyCount || 0) + 1;
        } else {
            updates.neutralCount = (data.neutralCount || 0) + 1;
        }

        chrome.storage.local.set(updates);
    });
}

// Event: Tab updated (user navigated to new page)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Clear badge when navigating to a new page
    if (changeInfo.status === 'loading') {
        chrome.action.setBadgeText({ tabId, text: '' });
    }
});

// Event: Extension icon clicked
chrome.action.onClicked.addListener(async (tab) => {
    try {
        // Check if we can inject scripts on this page
        if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
            console.log(`${LOG_PREFIX} Cannot scan Chrome internal pages`);
            return;
        }

        // Try to send message to existing content script first
        try {
            await chrome.tabs.sendMessage(tab.id, { type: 'RESCAN' });
            console.log(`${LOG_PREFIX} ✓ Triggered rescan on active content script`);
            return;
        } catch (err) {
            // Content script not loaded, inject it manually
            console.log(`${LOG_PREFIX} Injecting scripts manually...`);
        }

        // Inject CSS first
        await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['styles/injected.css']
        });

        // Inject JavaScript files in order
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['scripts/keywords.js']
        });

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['scripts/ui.js']
        });

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['scripts/content.js']
        });

        console.log(`${LOG_PREFIX} ✓ Manual scan initiated`);
    } catch (error) {
        console.error(`${LOG_PREFIX} ✗ Error during manual scan:`, error);
    }
});

console.log(`${LOG_PREFIX} ✓ Service worker initialized`);
