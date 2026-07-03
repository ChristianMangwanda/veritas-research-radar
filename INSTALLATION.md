# Installing Veritas

Veritas is loaded as an unpacked Chrome extension. No build step is required.

## Prerequisites

- Google Chrome 88 or newer (or a Chromium-based browser such as Edge or Brave)

## Step-by-step

1. **Get the code**
   - Clone the repository, or download the ZIP from GitHub (green **Code** button → **Download ZIP**) and extract it to a folder you will keep — Chrome loads the extension from this folder, so don't delete it afterwards.

2. **Open the extensions page**
   - Type `chrome://extensions` in the address bar and press Enter.

3. **Enable Developer mode**
   - Toggle **Developer mode** in the top-right corner of the page.

4. **Load the extension**
   - Click **Load unpacked**.
   - Select the folder that contains `manifest.json` (the repository root).
   - Veritas appears in your extensions list with a shield icon.

5. **Verify it works**
   - Visit any job posting on LinkedIn, Indeed, Glassdoor, etc. A color-coded badge appears in the top-right of the page within a couple of seconds.
   - To test without visiting a job site, open one of the sample pages in `tests/test-pages/` (e.g. `job-restricted.html`) and click the Veritas toolbar icon to scan it. Note: sample pages open as `file://` URLs, so you must first enable **Allow access to file URLs** on the extension's details page (`chrome://extensions` → Veritas → Details).

## Updating

After pulling new code, go to `chrome://extensions` and click the circular **reload** arrow on the Veritas card. Then refresh any open job-site tabs.

## Troubleshooting

**The badge never appears on a job site**
- The site may not be in the auto-scan list (see `content_scripts.matches` in `manifest.json`). Click the Veritas toolbar icon to scan the page manually — this works on any site.
- Some pages load job content late; wait a couple of seconds or click the toolbar icon to rescan.

**Badge doesn't appear on the sample test pages**
- Test pages are local files. Enable **Allow access to file URLs** in the extension's details page, then click the toolbar icon on the test page.

**Console says "Extension context invalidated"**
- This happens when the extension is reloaded while a tab is open. Refresh the tab and it resolves itself.

**The badge is hidden behind page content**
- Dismiss and rescan via the toolbar icon. If it persists on a specific site, please open an issue with the URL.

**Nothing works after an update**
- Remove the extension from `chrome://extensions` and load it again via **Load unpacked**.

**Still stuck?**
- Check the DevTools console (`F12` → Console) for lines prefixed with `[Veritas]` and include them in a [GitHub issue](https://github.com/ChristianMangwanda/Veritas/issues).
