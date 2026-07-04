# Veritas - Visa Eligibility Scanner

![Version](https://img.shields.io/badge/version-1.3.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Chrome](https://img.shields.io/badge/chrome-extension-orange)

**Instantly identify visa sponsorship eligibility on job postings**

Veritas automatically scans job descriptions and displays a color-coded badge indicating whether the position requires U.S. citizenship, offers visa sponsorship, or contains no visa information. Built specifically for international students (F-1, OPT, CPT) navigating the U.S. job market.

---

## Features

### Core Functionality
- **Automatic Detection**: Scans job postings on 14+ major platforms
- **Manual Scan**: Click extension icon to scan any webpage
- **Color-Coded Badge**: Instant visual feedback (RED / GREEN / GRAY)
- **Keyword Highlighting**: Click badge to see matched phrases
- **Dismissible**: X button to close badge when done
- **Privacy-First**: 100% local processing, zero data collection
- **Research Job Radar**: Fetches public ATS postings (Greenhouse, Lever, Ashby, SmartRecruiters, Workday) from curated likely cap-exempt research employers

### Smart Detection (117 Patterns)
- **RESTRICTED** (66 patterns): US citizenship, security clearance, "no sponsorship", green card only, US persons / ITAR / export control
- **FRIENDLY** (51 patterns): H-1B, OPT/CPT, STEM OPT, TN visa, E-3 visa, immigration support
- **Negation-aware**: phrases like "No security clearance required" no longer flag a job as restricted

### Supported Platforms
Auto-scans on: LinkedIn, Indeed, Glassdoor, Monster, ZipRecruiter, Handshake, Simplify, Wellfound, Angel.co, Greenhouse, Lever, Workday, and more.

---

## Installation

### Quick Install (5 minutes)

**For detailed step-by-step instructions with screenshots, see [INSTALLATION.md](INSTALLATION.md)**

1. **Download Veritas**
   - Click the green **"Code"** button above
   - Select **"Download ZIP"**
   - Extract the ZIP file to a folder on your computer

2. **Open Chrome Extensions**
   - Go to `chrome://extensions/` in your Chrome browser
   - Enable **"Developer mode"** (toggle in top-right)

3. **Load Extension**
   - Click **"Load unpacked"**
   - Select the extracted Veritas folder
   - Click **"Select Folder"**

4. **Start Using**
   - Visit any job posting on LinkedIn, Indeed, Glassdoor, etc.
   - The badge will appear automatically!

**Stuck?** See the [troubleshooting section](INSTALLATION.md#troubleshooting) in INSTALLATION.md

### Chrome Web Store
*(Coming soon - under review)*

---

## How to Use

### Automatic Scanning
1. Visit any job posting on LinkedIn, Indeed, Glassdoor, etc.
2. Badge appears automatically within 1-2 seconds
3. Badge color indicates visa status:
   - **RED** = Sponsorship required (US citizenship / No sponsorship)
   - **GREEN** = Visa friendly (H-1B sponsorship / OPT/CPT eligible)
   - **GRAY** = No visa information found

### Manual Scanning
1. Visit any webpage (e.g., company blog, career page)
2. Click the Veritas icon in your toolbar
3. Badge appears with analysis

### Interacting with Badge
- **Click badge body** - Toggle keyword highlighting
- **Click X button** - Dismiss badge
- **Auto-fade**: Badge becomes semi-transparent after 5 seconds

---

## Detection Examples

### Detected as RESTRICTED (RED)
- "US Citizenship required"
- "Security clearance needed"
- "No visa sponsorship available"
- "Must be authorized to work without sponsorship"
- "Green card holders only"
- "Cannot sponsor H-1B"

### Detected as FRIENDLY (GREEN)
- "We sponsor H-1B visas"
- "OPT/CPT students welcome"
- "Visa sponsorship available"
- "International candidates encouraged"
- "STEM OPT eligible"
- "Immigration support provided"
- "TN visa eligible" (Canada/Mexico)
- "E-3 visa accepted" (Australia)

---

## Technical Details

### Architecture
- **Manifest V3** compliant
- **Vanilla JavaScript** (no frameworks, minimal footprint)
- **IIFE pattern** for content script isolation
- **Service Worker** for background coordination
- **MutationObserver** for SPA support

### Performance
- Scan time: < 100ms average
- Memory: < 10MB
- Bundle size: ~40KB
- Debounced rescanning: 1.5s delay

### Privacy & Security
- **Zero data collection**
- **No external API calls from the extension** (the optional local Research Radar fetches public ATS job boards)
- **Local processing only**
- **Minimal permissions**: `activeTab`, `storage`, `scripting`
- **Open source** (MIT License)

---

## What's New in v1.2

### Major Improvements
- **95+ keyword patterns** (up from 44)
- **Manual scan** on any webpage
- **Dismissible badge** with X button
- **New high-contrast icon**
- **Better stability** (content hashing prevents blinking)
- **Restricted to job sites** (no longer runs everywhere)

### New Detections
- Security clearance = citizenship requirement
- Cap-exempt H-1B positions
- TN visa (NAFTA - Canada/Mexico)
- E-3 visa (Australia)
- Immigration team mentions
- Transfer H-1B support

See [CHANGELOG.md](CHANGELOG.md) for full version history.

---

## Development

### File Structure
```
veritas/
├── manifest.json          # Extension config
├── icons/                 # Extension icons (16, 48, 128px)
├── scripts/
│   ├── background.js      # Service worker
│   ├── content.js         # Main content script
│   ├── keywords.js        # 117 detection patterns
│   └── ui.js              # Badge & highlighting
├── styles/
│   └── injected.css       # Badge styles
├── tests/
│   ├── test-pages/        # Sample job postings
│   └── manual-test-checklist.md
├── LICENSE                # MIT License
├── CHANGELOG.md           # Version history
└── README.md              # This file
```

### Running Tests
1. Run `npm test`
2. Open test pages: `tests/test-pages/job-*.html`
3. Follow `tests/manual-test-checklist.md`
4. Check console for logs (scan times, matches)

### Research Job Radar

A single instrument for cap-exempt research roles, in three layers:

- **The daily sourcer** (Node, every 6 hours): nine ATS adapters (Greenhouse,
  Lever, Ashby, SmartRecruiters, Workday, Recruitee, Breezy, Workable, USAJOBS)
  plus the aggregator firehose and per-employer scout snapshots. Every posting
  runs through the Veritas analyzer; closed postings become tombstones.
- **The enrichment layer** (monthly): manufactures the cap-exempt signal by
  joining four government datasets via entity resolution — DOL LCA disclosures
  (who sponsors, in which titles), IPEDS (the legal definition of the
  higher-education exemption), IRS EO BMF (501(c)(3) research nonprofits by NTEE
  code), and the USCIS H-1B Employer Data Hub (who gets petitions approved). It
  emits a **cap-exempt directory** of ~20,000 employers and a ranked discovery
  list, and upgrades the registry.
- **The scout** (Python + Playwright, `scout/`): the aggregator firehose and
  JS-page scraper. Scrapes research-job boards (Nature Careers, Science
  Careers, HigherEdJobs), tags each job with its employer, and the importer
  keeps only those that resolve into the cap-exempt directory. This is how the
  radar covers hundreds of employers without wiring each one by hand.

Commands:

```bash
npm run radar:refresh            # daily layer (fetch + merge + lifecycle)
npm run radar:serve              # dashboard at http://localhost:4173
npm run radar:enrich             # monthly joins (~350MB cached downloads)
npm run scout:aggregators -- --all --import   # firehose (needs scout/ venv)
npm run scout:jobs -- --all --import          # per-employer scout
npm run radar:import-aggregated  # cap-exempt filter over scraped jobs
```

See [scout/README.md](scout/README.md) for the Python setup. **Policy note:**
as of 2026-07 the scout treats robots.txt as advisory (logged, not enforced)
by owner decision; it stays throttled and does not defeat CAPTCHAs.

Data boundaries:
- Public GitHub Actions data: `radar/employers.json`, `radar/data/jobs.json`, `radar/data/refresh-report.json`.
- Local-only data: resume text, browser profile extraction, and `radar/data/local-state.json`.
- The dashboard computes resume fit in the browser. Resume text is not written by the server and is not used by GitHub Actions.

DOL enrichment is an explicit local import step. Download an OFLC LCA disclosure file, convert it to CSV if needed, then run:

```bash
npm run radar:import-dol -- path/to/LCA_Disclosure_Data.csv
npm run radar:refresh
```

This creates `radar/data/dol-sponsor-signals.json`, which the refresh uses as a sponsorship-history signal. It is still not a guarantee that a current role will sponsor or that an employer is cap-exempt.

Employer evidence levels:
- `verified`: manually confirmed from an authoritative source.
- `likely`: institution type suggests cap-exempt fit, pending direct confirmation.
- `unknown`: needs review.

Source policy:

| Source | Access | Cadence |
|---|---|---|
| Greenhouse / Lever / Ashby / SmartRecruiters / Recruitee / Breezy / Workable | public JSON APIs | every 6h |
| Workday | per-tenant CXS feed (`ats_config`), research-title prefilter + caps | every 6h |
| USAJOBS | official API, free key (`USAJOBS_API_KEY` + `USAJOBS_EMAIL`) | every 6h |
| Aggregators (Nature Careers, Science Careers, HigherEdJobs) | Playwright scrape, cap-exempt-filtered | on demand, 7-day TTL |
| Per-employer scout snapshots | `scout/` Playwright, per `radar/SCOUT-CONTRACT.md` | on demand, 14-day TTL |
| IPEDS HD | direct zip download (NCES) | monthly enrich |
| IRS EO BMF | direct CSV downloads (~340MB) | monthly enrich |
| USCIS H-1B Data Hub | direct CSVs, newest 3 fiscal years | monthly enrich |
| DOL LCA disclosures | browser download via `scout/scout_dol.py` (Akamai-gated) → import | when refreshed |

Postings that disappear from a source become `status: "closed"` tombstones
kept for 30 days, so triaged jobs never silently vanish.

---

## Contributing

Contributions welcome! Areas for improvement:
- Additional keyword patterns
- Platform-specific selectors
- UI/UX enhancements
- Bug reports

**How to contribute:**
1. Fork the repository
2. Create feature branch
3. Make changes
4. Submit pull request

---

## Known Limitations

1. **Keyword-based only**: v1.2 uses regex, not AI/NLP
2. **Complex conditionals**: "Sponsorship for PhDs only" - still shows FRIENDLY
3. **English only**: No multi-language support yet
4. **Chrome only**: Firefox/Safari support planned for v2.0

---

## Roadmap

### v1.3 (Q1 2026)
- User-configurable keywords
- Statistics dashboard
- Platform-specific DOM improvements

### v2.0 (Q2 2026)
- AI/LLM integration for nuanced language
- Auto-filter mode (hide ineligible jobs)
- Company H-1B database integration

### v3.0 (Future)
- Multi-browser support (Firefox, Safari, Edge)
- Mobile browser support
- Collaborative filtering

---

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

## Support

- **Issues**: [GitHub Issues](https://github.com/ChristianMangwanda/Veritas/issues)
- **Questions**: Create a discussion on GitHub

---

## Acknowledgments

Built for international students navigating the complex U.S. job market.

**Special thanks** to the international student community for feedback and testing.

---

**Current Version**: 1.3.0  
**Last Updated**: July 2026  
**Minimum Chrome Version**: 88+
