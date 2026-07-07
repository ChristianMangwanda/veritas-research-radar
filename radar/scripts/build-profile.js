#!/usr/bin/env node

/**
 * Resume-aware ranking, step 1: understand the resume once, deeply.
 *
 * Reads a resume (txt/md), has Claude extract a structured career profile
 * matched to the radar's own taxonomy (title classes, matchable skill terms
 * with weights, degree levels, domains), and writes radar/data/profile.json —
 * which is gitignored: resume content and the derived profile never leave
 * this machine except for the single extraction API call.
 *
 * The dashboard then ranks all jobs deterministically against the structured
 * profile — no per-job API calls, no resume text in the browser beyond what
 * you paste locally.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npm run radar:profile -- path/to/resume.txt
 */

const fsp = require('fs/promises');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const OUT_PATH = path.resolve(__dirname, '../data/profile.json');

// Must mirror radar/scripts/lib/title-class.js CLASS_LABELS keys
const TITLE_CLASSES = ['postdoc', 'faculty', 'scientist', 'data_computational',
  'engineering_software', 'research_associate', 'research_support', 'clinical', 'other'];

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'career_stage', 'years_experience', 'degrees', 'title_classes',
    'domains', 'skills', 'target_titles', 'notes_for_ranking'],
  properties: {
    summary: { type: 'string', description: 'Two sentences: who this person is professionally and what they are strongest at.' },
    career_stage: { type: 'string', enum: ['student', 'recent_graduate', 'early_career', 'mid_career', 'senior'] },
    years_experience: { type: 'integer', description: 'Total years of relevant professional/research experience, internships count as fractional.' },
    degrees: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'field', 'status'],
        properties: {
          level: { type: 'string', enum: ['bachelors', 'masters', 'phd', 'md', 'other'] },
          field: { type: 'string' },
          status: { type: 'string', enum: ['completed', 'in_progress'] }
        }
      }
    },
    title_classes: {
      type: 'array',
      description: 'Job classes this person should target, best fit first. Use ONLY the allowed values.',
      items: { type: 'string', enum: TITLE_CLASSES }
    },
    domains: {
      type: 'array',
      description: 'Research/professional domains, most central first (e.g. genomics, machine learning, health economics).',
      items: { type: 'string' }
    },
    skills: {
      type: 'array',
      description: 'Matchable skill terms for word-boundary text matching against job descriptions. Include tools, methods, languages. Each term must be a phrase that would literally appear in a job posting (no single letters; write "R programming" as the alias-bearing term "R," via aliases like "R,", never bare "r").',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'weight'],
        properties: {
          term: { type: 'string', description: 'Primary matchable phrase, lowercase, at least 2 characters.' },
          weight: { type: 'integer', description: '3 = core strength used extensively, 2 = solid working skill, 1 = familiar.' },
          aliases: { type: 'array', items: { type: 'string' }, description: 'Alternate spellings/phrasings that appear in postings (e.g. "scikit-learn" vs "sklearn").' }
        }
      }
    },
    target_titles: {
      type: 'array',
      description: 'Concrete job titles that would fit well, best first.',
      items: { type: 'string' }
    },
    avoid_signals: {
      type: 'array',
      description: 'Terms in a posting that indicate a poor fit (e.g. "registered nurse" for a computational person).',
      items: { type: 'string' }
    },
    notes_for_ranking: { type: 'string', description: 'Anything else a ranking system should know: constraints, preferences, unusual strengths.' }
  }
};

const SYSTEM_PROMPT = `You extract structured career profiles from resumes for a job-matching system aimed at international researchers seeking US cap-exempt employer positions (universities, research institutes, research hospitals).

The system will use your output for deterministic text matching against thousands of job postings, so precision in the skills list matters more than completeness: every term must be something that literally appears in job-posting text, matched with word boundaries. Weight skills by how central they are to this person's actual work, not by how often the word appears.

Be honest about career stage and degree status — the matcher penalizes jobs whose degree requirements the candidate cannot meet, and that protection only works if the profile is accurate.`;

async function main() {
  const resumePath = process.argv[2];
  if (!resumePath) {
    console.error('Usage: npm run radar:profile -- path/to/resume.txt');
    console.error('(txt or md; export your resume as plain text first if it is a PDF)');
    process.exit(1);
  }

  const resumeText = await fsp.readFile(path.resolve(resumePath), 'utf8');
  if (resumeText.trim().length < 200) {
    console.error(`Resume file looks too short (${resumeText.trim().length} chars) — is this the right file?`);
    process.exit(1);
  }

  const client = new Anthropic();
  console.log('Extracting structured profile (claude-opus-4-8)…');

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: PROFILE_SCHEMA } },
      messages: [{
        role: 'user',
        content: `Extract the career profile from this resume:\n\n${resumeText}`
      }]
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('No valid Anthropic credentials. Set ANTHROPIC_API_KEY and rerun:');
      console.error('  ANTHROPIC_API_KEY=sk-ant-... npm run radar:profile -- ' + resumePath);
      process.exit(1);
    }
    throw error;
  }

  if (response.stop_reason === 'refusal') {
    console.error('The extraction request was declined. Check the resume content and retry.');
    process.exit(1);
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  const profile = JSON.parse(textBlock.text);

  // Guard the matcher: drop terms too short for word-boundary matching
  profile.skills = (profile.skills || []).filter((skill) => skill.term && skill.term.trim().length >= 2);

  const output = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_file: path.basename(resumePath),
    model: response.model,
    profile
  };

  await fsp.writeFile(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`\nProfile written to ${path.relative(process.cwd(), OUT_PATH)} (gitignored — stays local)`);
  console.log(`  ${profile.summary}`);
  console.log(`  stage: ${profile.career_stage} | classes: ${profile.title_classes.join(', ')}`);
  console.log(`  skills: ${profile.skills.length} terms | domains: ${profile.domains.join(', ')}`);
  console.log('\nReload the dashboard — jobs now rank against this profile.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
