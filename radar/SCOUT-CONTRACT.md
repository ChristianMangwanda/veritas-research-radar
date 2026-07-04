# Scout Producer Contract

Any external producer (the LadyLibertysBrief jobs-scout, a manual paste, or any
future tool) can feed jobs into the radar for employers that expose no clean
ATS feed. The radar trusts nothing: every file passes strict validation in
`radar/scripts/import-scouted.js` before it reaches the dataset.

## File location

One JSON file per employer:

```
radar/data/scouted/<employer-id>.json
```

`<employer-id>` must match an `id` in `radar/employers.json`.

## Schema (version 1)

```json
{
  "schema_version": 1,
  "employer_id": "fred-hutch",
  "scouted_at": "2026-07-04T12:00:00Z",
  "source_url": "https://careers.fredhutch.org/search?q=research",
  "jobs": [
    {
      "title": "Research Technician II",
      "url": "https://careers.fredhutch.org/jobs/12345",
      "location": "Seattle, WA",
      "department": "Immunotherapy",
      "description_text": "Plain-text description as extracted...",
      "posted_at": "2026-07-01"
    }
  ],
  "skipped_reason": null
}
```

- `title` and `url` are **required** per job; `url` must be absolute http(s),
  exactly as observed on the page. Everything else is optional.
- A file is a **full snapshot**: importing it replaces all previously scouted
  jobs for that employer. Jobs missing from the new snapshot will be
  tombstoned by the normal refresh lifecycle.
- If the page could not be scouted, emit `"jobs": []` with a `skipped_reason`
  (`"bot_wall"`, `"robots_disallow"`, `"no_listings_found"`, ...).

## Producer rules (non-negotiable)

1. **Never invent or embellish a posting.** Every job must exist on the page,
   and every field must come from the page.
2. **Respect robots.txt** on the target host. If the careers path is
   disallowed, do not fetch it — report `robots_disallow`.
3. **Never bypass bot walls, CAPTCHAs, or WAFs.** A blocked page is a
   `bot_wall` skip, not a challenge.
4. Fetch politely: sequential requests, small budgets, honest User-Agent.

## Importing

```bash
npm run radar:import-scouted            # imports every file in radar/data/scouted/
```

Accepted jobs land in `radar/data/scouted-jobs.json` with stable ids
(`scout:<employer-id>:<12-char url hash>`). The next `npm run radar:refresh`
merges them into `jobs.json` (source `agent_scout`, extra disclaimer), unless
the employer now has a working live ATS feed (then scout data is redundant and
skipped). Scouted jobs expire **14 days** after their last snapshot unless
re-scouted.
