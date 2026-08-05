# Building the profile

`radar/data/profile.md` is the one place the radar learns who you are. Every
posting is judged against it and nothing else — not your résumé files, which
exist only to be sent once you have decided to apply.

That makes it the highest-leverage document in the system. A skill missing from
it means those jobs are never surfaced. A skill overstated means a list full of
jobs you cannot get. A constraint invented for you — a salary floor, a city, a
deal-breaker you never said — silently hides work you would have wanted, and
nothing in the interface will ever tell you it happened.

So it is written deliberately, by you, with a model helping. It is not
regenerated behind your back: changing a résumé raises a suggestion, never a
rewrite.

## How to use this

Open a new Claude conversation, attach every résumé you have, paste the prompt
below, and answer its questions. Save what comes back as
`radar/data/profile.md` (gitignored — this repo is public).

Re-run it when what you can do or what you want has genuinely changed. Not when
you reword a bullet point.

---

## The prompt

````text
You are helping me write a profile document that a job-matching system will use
to judge roughly 10,000 job postings on my behalf. I have attached my résumés.

WHAT THIS DOCUMENT IS FOR

A local system fetches research and data roles from universities, hospitals and
research institutes. Each posting is read by a model against this profile, which
answers two questions: can I do this job, and do I want it. The profile is the
ONLY thing it knows about me — the résumés themselves are never sent.

The consequences are asymmetric, and they should shape how you write:

- A capability you leave out means those jobs are never shown to me. I will
  never know they existed. This is the expensive failure.
- A capability you overstate means a list of jobs I cannot get, which wastes my
  time but is visible and correctable.
- A preference you invent — a salary floor, a location, a deal-breaker I did not
  state — silently removes matching jobs with no trace. Never do this. If I have
  not told you a constraint, it does not exist.

BEFORE YOU WRITE

1. Read every attached résumé. They are variants of one person, tailored to
   different audiences — not different people. Synthesise them into one honest
   account. A skill that appears in only one variant is still a skill I have.

2. Separate what I have DONE from what I have been TAUGHT. Coursework and
   personal projects belong in the profile, but not phrased as professional
   experience.

3. Then ASK ME about the things a résumé cannot tell you, and wait for my
   answers before writing anything:
   - What kind of work do I actually want next, in my own words?
   - What would I turn down even if offered?
   - Where am I willing to be, and is remote acceptable or required?
   - Is there a salary floor? ("I don't know" is a valid answer — then there
     isn't one, and you must not invent one.)
   - What is my work-authorisation situation?
   - Anything my résumés overstate or understate that I would want corrected?

   Ask them all at once. Do not guess an answer to any of them.

OUTPUT FORMAT

Return one Markdown document, exactly this shape, in a single code block:

---
years_experience: <number>
career_stage: <student | recent_graduate | early_career | mid_career | senior>
work_authorization: <one line, or omit if I did not say>
locations: [<list, or omit if I did not say>]
remote: <required | open | onsite_ok, or omit if I did not say>
salary_floor: <number, or null — null unless I gave one>
degrees:
  - level: <bachelors | masters | phd | md | other>
    field: <field>
    status: <completed | in_progress>
avoid:
  - <profession or line of work I said I do not want, one per line>
---

## Who I am
One paragraph, third person, plain. What I do, at what level, in what domain.
No adjectives that could describe anyone — no "results-driven", no "passionate",
no "proven track record". A stranger should finish it knowing what I would be
hired to do.

## What I can do
A single comma-separated list of concrete, checkable capabilities: languages,
libraries, tools, methods, data types, platforms. Name things a job posting
would name — "PyTorch", "star-schema modelling", "single-cell RNA-seq" — not
"machine learning expertise". Order by how central each is to me. Include real
strengths that appear in only one résumé.

## What I want
What I am looking for, in my words, from my answers above. Role types, domains,
settings. Concrete.

## What I do not want
Only what I actually said. If I named nothing, write "Nothing stated." — do not
fill this in to be helpful.

## Notes
Anything a reader should know that does not fit above: a career change, a gap,
credentials in progress, a constraint on timing. Omit the section if empty.

RULES

- The prose sections ride in every one of ~10,000 prompts. Keep everything after
  the frontmatter under 300 words. Terse and specific beats complete.
- Do not invent, round up, or soften. If two résumés disagree, ask me.
- Do not describe me as senior, lead or principal unless a résumé shows I held
  such a role.
- Write "What I want" and "What I do not want" from my answers only, never from
  what my résumés imply.
- End by listing anything you were unsure about and had to leave out, so I can
  decide whether it belongs.
````

---

## What happens to it

The frontmatter feeds the deterministic layer — the degree and credential
checks, and the `avoid` list, which sets aside a posting whose *title* names a
profession you have ruled out (in the body it stays a scoring penalty, since a
data posting that mentions nurses is still a data posting).

The prose is what the judging model reads. Roughly 250 tokens, carried on every
posting it reads, which is why the length budget is real.

Nothing here selects which résumé to send. That stays your call, made when you
read the posting; the row shows a suggestion and no more.
