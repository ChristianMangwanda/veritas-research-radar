# Veritas Manual Testing Checklist

## Pre-Testing Setup
- [ ] Load extension in Chrome via `chrome://extensions`
- [ ] Enable "Developer mode" toggle
- [ ] Click "Load unpacked" and select the Veritas directory
- [ ] Verify extension appears in the extensions list
- [ ] Check that no console errors appear

## Test 1: RESTRICTED State Detection
**Test Page:** `tests/test-pages/job-restricted.html`

- [ ] Open the test page in a new tab
- [ ] Wait for badge to appear (should be < 2 seconds)
- [ ] Verify RED badge appears in top-right corner
- [ ] Verify badge text reads "Not Eligible"
- [ ] Verify badge has red emoji (🔴)
- [ ] Click badge to toggle highlights
- [ ] Verify "US Citizenship is required" text is highlighted
- [ ] Click badge again to remove highlights
- [ ] Check toolbar icon shows "✕" badge
- [ ] Check console for scan time (should be < 150ms)

## Test 2: FRIENDLY State Detection
**Test Page:** `tests/test-pages/job-friendly.html`

- [ ] Open the test page in a new tab
- [ ] Wait for badge to appear
- [ ] Verify GREEN badge appears in top-right corner
- [ ] Verify badge text reads "Visa Friendly"
- [ ] Verify badge has green emoji (🟢)
- [ ] Click badge to toggle highlights
- [ ] Verify visa sponsorship text is highlighted in green
- [ ] Check toolbar icon shows "✓" badge
- [ ] Check console for scan time

## Test 3: NEUTRAL State Detection
**Test Page:** `tests/test-pages/job-neutral.html`

- [ ] Open the test page in a new tab
- [ ] Wait for badge to appear
- [ ] Verify GRAY badge appears in top-right corner
- [ ] Verify badge text reads "No Visa Info"
- [ ] Verify badge has gray emoji (⚪)
- [ ] Click badge (should have no highlights)
- [ ] Check toolbar icon shows "?" badge

## Test 4: Real-World Platform Testing

### LinkedIn
- [ ] Navigate to https://www.linkedin.com/jobs
- [ ] Search for "Software Engineer"
- [ ] Click on a few different job postings
- [ ] Verify badge appears for each job
- [ ] Test navigation between jobs (SPA behavior)
- [ ] Verify badge updates without page refresh

### Indeed
- [ ] Navigate to https://www.indeed.com
- [ ] Search for jobs
- [ ] Click on job postings
- [ ] Verify badge appears
- [ ] Test multiple jobs

### Glassdoor
- [ ] Navigate to https://www.glassdoor.com/Job
- [ ] Search for jobs
- [ ] Verify extension works
- [ ] Check badge accuracy

## Test 5: Performance Testing
- [ ] Open Chrome Task Manager (Shift + Esc)
- [ ] Find Veritas extension process
- [ ] Verify memory usage < 10MB
- [ ] Navigate to multiple job pages
- [ ] Verify no memory leaks (memory doesn't continuously grow)
- [ ] Check scan time in console (should be < 150ms)

## Test 6: Edge Cases
- [ ] Test on a very long job posting (> 5000 words)
- [ ] Test on a page with minimal text (< 100 words)
- [ ] Test on a non-job page (e.g., news article)
- [ ] Test with multiple tabs open simultaneously
- [ ] Refresh page and verify badge reappears
- [ ] Test clicking extension icon (should trigger rescan)

## Test 7: UI/UX Testing
- [ ] Verify badge doesn't overlap with page content
- [ ] Test badge hover effect (should lift slightly)
- [ ] Wait 5 seconds and verify badge fades slightly
- [ ] Test on smaller browser window (< 768px width)
- [ ] Verify badge is still visible and readable

## Test 8: Priority Testing (RESTRICTED > FRIENDLY)
**Create a test page with BOTH keywords:**
- [ ] Page contains "US Citizenship required" AND "Sponsorship available"
- [ ] Verify badge shows RESTRICTED (red)
- [ ] Confirm pessimistic approach works correctly

## Test 9: Extension Lifecycle
- [ ] Disable and re-enable the extension
- [ ] Verify it still works after re-enabling
- [ ] Check storage for statistics (install date, scan counts)
- [ ] Unload and reload extension
- [ ] Verify no persistent issues

## Test 10: Browser Compatibility
- [ ] Test Chrome (latest version)
- [ ] Test Microsoft Edge (Chromium-based)
- [ ] Verify manifest V3 compliance

## Known Issues Log
Document any issues found during testing:

| Issue | Severity | Page/URL | Description | Reproducible? |
|:------|:---------|:---------|:------------|:--------------|
| | | | | |

## Performance Metrics Log
Record actual performance metrics:

| Metric | Target | Actual | Pass/Fail |
|:-------|:-------|:-------|:----------|
| Badge render time | < 150ms | | |
| Memory usage | < 10MB | | |
| Extension size | < 50KB | | |

## Sign-Off
- [ ] All critical tests passed
- [ ] Performance targets met
- [ ] No blocking issues found
- [ ] Extension ready for deployment

**Tester Name:** _______________  
**Date:** _______________  
**Chrome Version:** _______________
