/**
 * Veritas Content Script
 * Main execution engine that runs on job posting pages
 */

(function () {
    'use strict';

    const LOG_PREFIX = '[Veritas]';

    // Configuration
    const SCAN_DEBOUNCE_MS = 1500; // Increased to 1.5 seconds for better stability
    const MIN_TEXT_LENGTH = 100;  // Minimum text length to consider valid job description

    // State
    let scanTimeout = null;
    let lastScannedUrl = null;
    let lastContentHash = null;

    /**
     * Simple hash function for content comparison
     */
    function hashContent(text) {
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            const char = text.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash;
    }

    /**
     * Main scan function - analyzes the current page for visa eligibility
     */
    function scanCurrentPage() {
        try {
            // Get current URL
            const currentUrl = window.location.href;

            // Extract job description text
            const jobText = window.Veritas.extractJobDescription();

            // Skip if text is too short (probably not a job posting)
            if (!jobText || jobText.length < MIN_TEXT_LENGTH) {
                console.log(`${LOG_PREFIX} Not enough text found (${jobText?.length || 0} chars), skipping scan`);
                return;
            }

            // Check if content has actually changed
            const contentHash = hashContent(jobText);
            if (lastContentHash === contentHash && lastScannedUrl === currentUrl) {
                console.log(`${LOG_PREFIX} Content unchanged (hash: ${contentHash}), skipping rescan`);
                return;
            }

            // Update hash and URL
            lastContentHash = contentHash;
            lastScannedUrl = currentUrl;

            // Analyze text for keywords
            const startTime = performance.now();
            const result = window.Veritas.analyzeText(jobText);
            const scanTime = performance.now() - startTime;

            console.log(`${LOG_PREFIX} ✓ Scan completed in ${scanTime.toFixed(2)}ms`);
            console.log(`${LOG_PREFIX} Result: ${result.state} (${result.matches.length} matches)`);

            // Update UI
            window.Veritas.injectBadge(result.state, result.matches);

            // Send result to service worker
            chrome.runtime.sendMessage({
                type: 'SCAN_RESULT',
                state: result.state,
                url: currentUrl,
                matchCount: result.matches.length,
                scanTime: scanTime
            }).catch(err => {
                // Service worker might not be ready, that's okay
                console.debug(`${LOG_PREFIX} Service worker not available:`, err.message);
            });

        } catch (error) {
            // specific handling for context invalidated (happens on extension reload)
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('Extension context invalidated')) {
                console.log(`${LOG_PREFIX} Context invalidated. Please refresh the page.`);
                return;
            }
            console.error(`${LOG_PREFIX} ✗ Error during scan:`, error);
        }
    }

    /**
     * Debounced scan function to avoid excessive processing
     */
    function debouncedScan() {
        clearTimeout(scanTimeout);
        scanTimeout = setTimeout(() => {
            scanCurrentPage();
        }, SCAN_DEBOUNCE_MS);
    }

    /**
     * Initialize the extension on page load
     */
    function init() {
        console.log(`${LOG_PREFIX} ✓ Extension initialized on ${window.location.hostname}`);

        // Perform initial scan after a short delay to ensure DOM is ready
        setTimeout(() => {
            scanCurrentPage();
        }, 1000);

        // Set up MutationObserver for single-page applications
        const observer = new MutationObserver((mutations) => {
            // Only rescan if significant changes AND enough time has passed
            const hasSignificantChanges = mutations.some(mutation => {
                // Ignore our own badge changes
                if (mutation.target.id === 'veritas-badge' ||
                    mutation.target.classList?.contains('veritas-badge')) {
                    return false;
                }
                return mutation.addedNodes.length > 5 || mutation.removedNodes.length > 5;
            });

            if (hasSignificantChanges) {
                debouncedScan();
            }
        });

        // Observe the document body for changes
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Listen for URL changes (pushState/replaceState)
        let lastUrl = location.href;
        new MutationObserver(() => {
            const url = location.href;
            if (url !== lastUrl) {
                lastUrl = url;
                console.log('[Veritas] URL changed, rescanning...');
                // Reset state for new page
                lastContentHash = null;
                window.Veritas.removeBadge();
                debouncedScan();
            }
        }).observe(document, { subtree: true, childList: true });
    }

    // Start the extension when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Listen for messages from service worker
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'RESCAN') {
            console.log('[Veritas] Rescan requested');
            // Reset the content hash so scanCurrentPage() cannot short-circuit
            // on unchanged content — a manual rescan must always redraw the badge.
            lastContentHash = null;
            window.Veritas.removeBadge();
            scanCurrentPage();
            sendResponse({ success: true });
        }
        return true; // Keep message channel open for async response
    });

})();
