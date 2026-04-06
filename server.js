require('dotenv').config();
const express = require('express');
const path    = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app    = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Web search via Tavily ─────────────────────────────────────────────────────

async function tavilySearch(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key:        process.env.TAVILY_API_KEY,
      query,
      search_depth:   'basic',
      max_results:    4,
      include_answer: false
    })
  });
  if (!res.ok) throw new Error(`Tavily error ${res.status}`);
  const data = await res.json();
  return (data.results || []).map(r => ({
    title:       (r.title   || '').slice(0, 120),
    url:         r.url      || '',
    description: (r.content || r.description || '').slice(0, 400)
  }));
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a private markets intelligence analyst working for Proof Private Markets. Your task is to produce a comprehensive, accurate LP briefing document from the web search results provided.

Proof Private Markets is a tech-enabled risk monitoring and reporting platform for institutional LPs. It ingests fund documents (LPA, side letters, ESG reports, operational materials), runs compliance and risk analysis across five disciplines (law, operations, sustainability, technology, alignment), and produces LP-ready reports and dashboards. Strong targets are institutions with $500M+ in private markets AUM, multi-manager PE/VC/infrastructure portfolios, and active fund governance concerns.

After researching, output ONLY a valid JSON object in this exact format — no markdown, no preamble:
{
  "institution": {
    "name": "full official name",
    "aum": "total AUM e.g. '$45B'",
    "hq": "city, country",
    "type": "pension fund | endowment | family office | sovereign wealth fund | insurance company | development finance institution | other",
    "investment_focus": "one sentence describing overall investment mandate",
    "private_markets_allocation": "estimated allocation to private markets as % and/or $ figure, or 'Not disclosed'"
  },
  "fund_exposures": [
    {"manager": "GP name", "strategy": "PE | VC | Infrastructure | Private Credit | Real Assets | Real Estate | Multi-strategy", "notes": "fund name, vintage, or commitment context if known"}
  ],
  "regulatory": {
    "jurisdiction": "US (SEC) | UK (FCA) | EU (AIFMD) | Multi-jurisdiction | Other",
    "registration": "specific registration or filing reference",
    "compliance_notes": "relevant regulatory context, reporting obligations, or jurisdictional complexity"
  },
  "recent_activity": [
    {"date": "month year or Q1 2025 format", "event": "description of new commitment, re-up, exit, manager termination, or fund close"}
  ],
  "risk_flags": [
    {"flag": "description of the specific flag", "severity": "low | medium | high", "source": "brief source reference or 'Public record'"}
  ],
  "key_contacts": [
    {"name": "Full Name or 'Not identified'", "title": "exact job title", "linkedin": "LinkedIn profile URL or null"}
  ],
  "warm_entry_points": [
    {"type": "interview | conference | article | report | linkedin post", "description": "brief description", "url": "URL or null"}
  ],
  "esg": {
    "score": 7,
    "rating": "ESG Leader | ESG Active | ESG Developing | ESG Minimal",
    "brief": "2-3 sentence summary of their ESG stance, commitments, and requirements imposed on their fund managers",
    "key_factors": ["specific factor 1", "specific factor 2", "specific factor 3"],
    "frameworks": ["UNPRI", "TCFD", "SFDR Article 8", "etc — list only what applies"],
    "gp_requirements": "what ESG reporting or compliance they require from their fund managers — e.g. annual ESG questionnaire, TCFD-aligned reporting, exclusion lists"
  },
  "proof_fit": {
    "score": 8,
    "rating": "Strong Fit | Good Fit | Moderate Fit | Weak Fit",
    "rationale": "2-3 sentence explanation of why this LP is or is not a strong fit for Proof, referencing their specific portfolio complexity, AUM, jurisdiction, and any visible governance pain points.",
    "key_drivers": ["specific driver 1", "specific driver 2", "specific driver 3"]
  }
}

Rules:
- If data is genuinely unknown after searching, use "Not identified" or "Unknown" — do not fabricate
- fund_exposures should list every manager you can find evidence for
- key_contacts should focus on: CIO, Head of Private Markets, Head of Risk, General Counsel, COO, CFO
- recent_activity: last 12-18 months only
- risk_flags: include governance, ESG, regulatory, concentration, or reputational flags — if none found, return an empty array
- esg.score: 1-10 where 10 = most advanced ESG integration (signed UNPRI, SFDR Article 9, mandatory ESG reporting to GPs, public sustainability reports)
- proof_fit.score: 1-10 where 10 = ideal prospect (large AUM, complex multi-manager PM portfolio, multi-jurisdiction, active governance challenges)`;

// ── Research function ─────────────────────────────────────────────────────────
// Single-shot: run all searches in parallel first, then one Claude call.

function buildSearchQueries(query) {
  return [
    `${query} AUM private markets portfolio fund managers PE VC infrastructure`,
    `${query} CIO investment team key contacts recent commitments 2024 2025`,
    `${query} regulatory filing SEC FCA governance risk`,
    `${query} ESG sustainability responsible investment UNPRI TCFD SFDR impact`,
  ];
}

async function researchLP(query) {
  // 1. Run all searches in parallel
  const queries = buildSearchQueries(query);
  const searchResults = await Promise.allSettled(queries.map(q => tavilySearch(q)));

  // 2. Compile results into a single context block
  const context = searchResults.map((r, i) => {
    if (r.status === 'rejected') return `SEARCH ${i+1} (${queries[i]}): failed`;
    const items = r.value.map(item =>
      `  Title: ${item.title}\n  URL: ${item.url}\n  ${item.description}`
    ).join('\n\n');
    return `SEARCH ${i+1}: "${queries[i]}"\n${items || '  No results'}`;
  }).join('\n\n---\n\n');

  // 3. Single Claude call to synthesize
  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 3000,
    system:     SYSTEM_PROMPT,
    messages:   [{
      role:    'user',
      content: `Using the web search results below, produce a complete structured briefing for: "${query}"\n\nSEARCH RESULTS:\n${context}`
    }]
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';
  if (!text) throw new Error('Empty response from Claude');
  return JSON.parse(text.replace(/```json\n?|```\n?/g, '').trim());
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/research', async (req, res) => {
  const { query } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: 'Query is required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!process.env.TAVILY_API_KEY)    return res.status(500).json({ error: 'TAVILY_API_KEY not configured' });

  try {
    const briefing = await researchLP(query.trim());
    res.json({ ok: true, briefing });
  } catch (err) {
    console.error('[research error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Proof LP Intelligence running at http://localhost:${PORT}`));
