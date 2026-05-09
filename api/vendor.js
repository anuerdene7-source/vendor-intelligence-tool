export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { domain } = req.body;
  if (!domain) {
    return res.status(400).json({ error: 'No domain provided' });
  }

  const startTime = Date.now();

  // 24-month cutoff for news — never hardcoded year
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - 24);
  const cutoffYear = cutoffDate.getFullYear();
  const cutoffYear2 = cutoffYear + 1;

  let errorCode = null;
  const toolsLog = [];

  // ─── FIRECRAWL HELPER ─────────────────────────────────────────────────────
  // Handles JS-rendered pages and Cloudflare-protected sites.
  // Returns clean markdown or null if page inaccessible.
  // onlyMainContent: false ensures cert details in sidebars are captured.

  async function firecrawl(url) {
    try {
      const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url,
          formats: ['markdown'],
          onlyMainContent: false,
          timeout: 20000
        }),
        signal: AbortSignal.timeout(25000)
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!data.success || !data.data?.markdown) return null;
      const text = data.data.markdown;
      return text.length > 200 ? text : null;
    } catch (err) {
      console.error(`Firecrawl failed for ${url}:`, err.message);
      toolsLog.push(`Firecrawl timeout: ${url} — ${err.message}`);
      return null;
    }
  }

  // ─── SUPABASE HELPER ──────────────────────────────────────────────────────
  // REST API calls — no npm package needed.

  async function supabaseGet(path) {
    try {
      const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
        },
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      console.error('Supabase GET failed:', err.message);
      return null;
    }
  }

  async function supabaseInsert(data) {
    try {
      const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/vendor_scans`, {
        method: 'POST',
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(5000)
      });
      return res.ok;
    } catch (err) {
      console.error('Supabase INSERT failed:', err.message);
      return false;
    }
  }

  // ─── STEP 0: DISCOVERY via Serper.dev ────────────────────────────────────
  // Two queries: standard paths AND explicit trust subdomain search.
  // Fixes vendors like notion.so where site: query returns blog posts.
  const vendorName = domain.replace(/^www\./, '').split('.')[0].toLowerCase();
  let discoveredUrls = [];

  try {
    const [standardSearch, trustSearch] = await Promise.allSettled([
      fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: `site:${domain} security OR trust OR compliance OR privacy OR DPA`,
          num: 8
        }),
        signal: AbortSignal.timeout(8000)
      }),
      fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: `"${vendorName}" site:trust.${domain} OR site:security.${domain} OR "${vendorName}" DPA "sub-processors" GDPR`,
          num: 5
        }),
        signal: AbortSignal.timeout(8000)
      })
    ]);

    const allOrganic = [];
    for (const r of [standardSearch, trustSearch]) {
      if (r.status === 'fulfilled' && r.value.ok) {
        const data = await r.value.json();
        allOrganic.push(...(data.organic || []));
      }
    }

    const baseDomain = domain.replace(/^www\./, '');
    discoveredUrls = [...new Set(
      allOrganic
        .map(r => r.link)
        .filter(url => {
          try {
            const hostname = new URL(url).hostname;
            return hostname === baseDomain ||
              hostname === `www.${baseDomain}` ||
              hostname.endsWith(`.${baseDomain}`);
          } catch { return false; }
        })
    )].slice(0, 8);

    toolsLog.push(`Serper: found ${discoveredUrls.length} vendor URLs`);
    console.log(`[Serper] Found ${discoveredUrls.length} vendor URLs for ${domain}`);
  } catch (err) {
    console.error(`Serper discovery failed for ${domain}:`, err.message);
    errorCode = 'DISCOVERY_FAILED';
    toolsLog.push(`Serper: FAILED — ${err.message}`);
  }

  // ─── STEP 1b: PARALLEL NEWS SEARCH via Serper ────────────────────────────
  // Runs in parallel with scraping. THIRD_PARTY content only.

  const newsSearchPromise = (async () => {
    try {
      const newsRes = await fetch('https://google.serper.dev/news', {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: `"${domain}" layoffs OR breach OR "data breach" OR "leadership change" OR acquired OR funding ${cutoffYear} OR ${cutoffYear2}`,
          num: 5
        }),
        signal: AbortSignal.timeout(8000)
      });
      if (!newsRes.ok) return '';
      const newsData = await newsRes.json();
      const articles = newsData.news || [];
      toolsLog.push(`Serper news: found ${articles.length} articles`);
      if (!articles.length) return '';
      return articles.map(a =>
        `[THIRD_PARTY: ${a.source || 'news'} — ${a.date || 'recent'}]\nTitle: ${a.title}\nSnippet: ${a.snippet}`
      ).join('\n\n');
    } catch (err) {
      console.error(`News search failed for ${domain}:`, err.message);
      toolsLog.push(`Serper news: FAILED — ${err.message}`);
      return '';
    }
  })();

  // ─── STEP 1: SCRAPE via Firecrawl (parallel) ─────────────────────────────

  const standardPaths = [
    '/security', '/trust', '/trust/security',
    '/compliance', '/privacy', '/about'
  ];

  const trustSubdomains = [
    `https://trust.${domain}`,
    `https://trust-portal.${domain}`,
    `https://security.${domain}`
  ];

  const statusUrls = [
    `https://status.${domain}`,
    `https://${domain}/status`
  ];

  const discoveredRequests = discoveredUrls
    .filter(url => !statusUrls.some(s => url.includes('/status')))
    .map(url => ({ url, label: `VENDOR_OWNED: ${url}` }));

  const allScrapeTargets = [
    ...statusUrls.map(url => ({ url, label: `VENDOR_OWNED: ${url}`, isStatus: true })),
    ...discoveredRequests,
    ...trustSubdomains.map(url => ({ url, label: `VENDOR_OWNED: ${url}` })),
    ...standardPaths.map(path => ({ url: `https://${domain}${path}`, label: `VENDOR_OWNED: ${domain}${path}` }))
  ];

  let combinedText = '';
  let successCount = 0;
  let statusPageFound = false;
  let statusPageUrl = null;
  const successfulPaths = [];

  const scrapeResults = await Promise.allSettled(
    allScrapeTargets.map(async (target) => {
      const text = await firecrawl(target.url);
      if (!text) return null;
      return { ...target, text };
    })
  );

  for (let i = 0; i < statusUrls.length; i++) {
    const r = scrapeResults[i];
    if (r.status === 'fulfilled' && r.value) {
      const t = r.value.text;
      if (!t.toLowerCase().includes('404') && !t.toLowerCase().includes('not found')) {
        combinedText += `\n\n[${r.value.label}]\n${t.slice(0, 3000)}`;
        statusPageFound = true;
        statusPageUrl = r.value.url;
        successCount++;
        successfulPaths.push(r.value.url);
        break;
      }
    }
  }

  for (let i = statusUrls.length; i < scrapeResults.length; i++) {
    const r = scrapeResults[i];
    if (r.status === 'fulfilled' && r.value) {
      combinedText += `\n\n[${r.value.label}]\n${r.value.text.slice(0, 3000)}`;
      successCount++;
      successfulPaths.push(r.value.url || r.value.label);
    }
  }

  toolsLog.push(`Firecrawl: scraped ${successCount}/${allScrapeTargets.length} paths`);

  let scrapeStatus = successCount >= 3 ? 'success' : successCount > 0 ? 'partial' : 'failed';
  let scrapeNotes = `Retrieved content from ${successCount} paths. Status page: ${statusPageFound ? statusPageUrl : 'not found'}.`;
  if (discoveredUrls.length > 0) scrapeNotes += ` Serper discovery found ${discoveredUrls.length} vendor URLs.`;

  // ─── FALLBACK: If Firecrawl got nothing, try Jina search ─────────────────

  if (successCount === 0 || combinedText.length < 100) {
    errorCode = 'SCRAPE_BLOCKED';
    toolsLog.push('Firecrawl: blocked — trying Jina search fallback');
    console.log(`Firecrawl returned nothing for ${domain}, trying Jina search fallback...`);
    try {
      const searchQueries = [
        `${domain} SOC2 security compliance trust certifications`,
        `${domain} privacy GDPR data processing agreement sub-processors`
      ];

      const fallbackResults = await Promise.allSettled(
        searchQueries.map(async (query) => {
          const r = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
            headers: { 'Accept': 'text/plain', 'Authorization': `Bearer ${process.env.JINA_API_KEY}` },
            signal: AbortSignal.timeout(12000)
          });
          if (!r.ok) return null;
          const text = await r.text();
          return text && text.length > 200 ? text : null;
        })
      );

      for (const r of fallbackResults) {
        if (r.status === 'fulfilled' && r.value) {
          combinedText += `\n\n[THIRD_PARTY: search index]\n${r.value.slice(0, 4000)}`;
          successCount++;
        }
      }

      if (successCount > 0) {
        scrapeStatus = 'partial';
        scrapeNotes = `Firecrawl blocked. Content from search index — security certifications may be unverified.`;
        toolsLog.push('Jina fallback: success');
      } else {
        errorCode = 'SCRAPE_FAILED';
        scrapeStatus = 'failed';
        scrapeNotes = `No public data available for ${domain}. Request security documentation directly from vendor.`;
        toolsLog.push('Jina fallback: also failed');
      }
    } catch (err) {
      errorCode = 'SCRAPE_FAILED';
      scrapeStatus = 'failed';
      scrapeNotes = `No public data available for ${domain}. Request security documentation directly from vendor.`;
      toolsLog.push(`Jina fallback: FAILED — ${err.message}`);
    }
  }

  const newsText = await newsSearchPromise;

  // ─── STEP 2: ANALYZE via Claude ──────────────────────────────────────────

  let analyzeResult = null;
  const fullText = [combinedText, newsText].filter(Boolean).join('\n\n');

  if (fullText.length > 100) {
    const prompt = `You are a vendor risk analyst. The text below contains content from a SaaS vendor's public pages.

IMPORTANT SOURCE RULES:
- Sections marked [VENDOR_OWNED] are from the vendor's own domain. Trust these for security certifications, sub-processors, DPA, and compliance signals.
- Sections marked [THIRD_PARTY] are from news or search results. Use these ONLY for layoffs, breaches, leadership changes, and funding signals. NEVER extract security certifications from THIRD_PARTY content.

Extract the signals below and return a JSON object only. No markdown. No backticks. No other text.

{
  "security": {
    "soc2": true or false or null,
    "soc2_type": "I" or "II" or null,
    "soc2_expiry_date": "date string or null",
    "iso27001": true or false or null,
    "hipaa": true or false or null,
    "fedramp": true or false or null,
    "pci": true or false or null,
    "notes": "string or null"
  },
  "compliance": {
    "gdpr_mechanism": "string or null",
    "data_residency": "US" or "EU" or "both" or "unknown",
    "privacy_policy_updated": "date string or null",
    "dpa_available": true or false or null,
    "sub_processors": ["string"] or []
  },
  "operations": {
    "status_page_found": true or false,
    "status_page_url": "string or null",
    "status_incidents": "string describing recent incidents or null",
    "layoffs": true or false or null,
    "layoffs_notes": "string or null",
    "recent_breach": true or false or null,
    "breach_notes": "string or null",
    "leadership_changes": true or false or null,
    "leadership_notes": "string or null"
  },
  "commercial": {
    "pricing_model": "public" or "contact_sales" or "freemium" or "unknown",
    "pricing_notes": "string or null",
    "ownership_type": "public" or "pe_owned" or "vc_backed" or "bootstrapped" or "unknown",
    "latest_round": "string or null",
    "founded_year": number or null
  },
  "recommended_actions": ["string", "string"],
  "summary": "2-3 sentence plain English verdict for a non-technical CFO"
}

For layoffs and breaches: only flag true if reported within the last 24 months based on article dates.
For sub_processors: extract named companies from DPA or trust page VENDOR_OWNED content only. Return empty array if none found.
For soc2_expiry_date: extract the certificate expiry or renewal date if mentioned. Return null if not found.
For status_incidents: summarise any recent incidents from the status page content. Return null if none found.
If a signal cannot be determined, return null. Never guess.

Content:
${fullText.slice(0, 14000)}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: AbortSignal.timeout(30000)
      });

      const data = await response.json();
      if (data.error || !data.content || !data.content[0]) {
        throw new Error(`Claude error: ${JSON.stringify(data.error || data)}`);
      }
      const rawText = data.content[0].text;
      const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analyzeResult = JSON.parse(clean);
      toolsLog.push('Claude: extraction successful');
      // ─── STEP 2.5: CERT FALLBACK ──────────────────────────────────────────────
// If scrape succeeded but all security fields are null, Google has already
// rendered those JS pages. Pull snippets directly and run a second Claude pass.
const _s = analyzeResult?.security || {};
const _allNull = _s.soc2 === null && _s.iso27001 === null && _s.hipaa === null && _s.fedramp === null;

if (_allNull && scrapeStatus !== 'failed' && process.env.SERPER_API_KEY) {
  console.log(`Security signals empty for ${domain}, running cert snippet fallback...`);
  try {
    const certRes = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: `${vendorName} SOC 2 "ISO 27001" HIPAA FedRAMP security certifications`,
        num: 8
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (certRes.ok) {
      const certData = await certRes.json();
      const snippets = (certData.organic || [])
        .map(r => `[SOURCE: ${r.link}]\n${r.title}\n${r.snippet}`)
        .join('\n\n');
      if (snippets.length > 100) {
        const certPrompt = `You are a vendor risk analyst. Based ONLY on these Google search snippets, extract security certification signals. Return JSON only, no markdown, no backticks.

{"security":{"soc2":null,"soc2_type":null,"iso27001":null,"hipaa":null,"fedramp":null,"pci":null,"notes":null}}

Only set true if a snippet explicitly confirms the certification is held by this vendor. Never guess.

Snippets:
${snippets.slice(0, 6000)}`;

        const certApiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 400,
            messages: [{ role: 'user', content: certPrompt }]
          }),
          signal: AbortSignal.timeout(20000)
        });
        const certApiData = await certApiRes.json();
        if (certApiData.content?.[0]?.text) {
          const certClean = certApiData.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          const certResult = JSON.parse(certClean);
          if (certResult.security) {
            analyzeResult.security = { ...analyzeResult.security, ...certResult.security };
            toolsLog.push('Claude: cert snippet fallback successful');
          }
        }
      }
    }
  } catch (err) {
    console.error('Cert fallback failed:', err.message);
    toolsLog.push(`Cert fallback: FAILED — ${err.message}`);
  }

    } catch (err) {
      console.error('Claude API error:', err.message);
      errorCode = errorCode || 'EXTRACTION_FAILED';
      toolsLog.push(`Claude: FAILED — ${err.message}`);

      try {
        const simplePrompt = `Extract vendor risk signals from this text and return JSON only. No markdown.
{"security":{"soc2":null,"soc2_type":null,"soc2_expiry_date":null,"iso27001":null,"hipaa":null,"fedramp":null,"pci":null,"notes":null},"compliance":{"gdpr_mechanism":null,"data_residency":"unknown","privacy_policy_updated":null,"dpa_available":null,"sub_processors":[]},"operations":{"status_page_found":false,"status_page_url":null,"status_incidents":null,"layoffs":null,"layoffs_notes":null,"recent_breach":null,"breach_notes":null,"leadership_changes":null,"leadership_notes":null},"commercial":{"pricing_model":"unknown","pricing_notes":null,"ownership_type":"unknown","latest_round":null,"founded_year":null},"recommended_actions":["Request vendor security questionnaire directly."],"summary":"Insufficient public data to assess vendor risk."}
Text: ${fullText.slice(0, 6000)}`;

        const retryRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 1200,
            messages: [{ role: 'user', content: simplePrompt }]
          }),
          signal: AbortSignal.timeout(20000)
        });

        const retryData = await retryRes.json();
        if (retryData.error || !retryData.content || !retryData.content[0]) {
          throw new Error(`Retry error: ${JSON.stringify(retryData.error)}`);
        }
        const retryRaw = retryData.content[0].text;
        const retryClean = retryRaw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        analyzeResult = JSON.parse(retryClean);
        errorCode = null;
        toolsLog.push('Claude: retry successful');
      } catch (retryErr) {
        console.error('Claude retry failed:', retryErr.message);
        toolsLog.push(`Claude retry: FAILED — ${retryErr.message}`);
      }
    }
  }

  // ─── STEP 3: SCORE + EXPIRY CHECK ─────────────────────────────────────────

  let score = 100;
  let expiryFlag = false;
  let expiryDays = null;

  if (analyzeResult) {
    const s = analyzeResult.security || {};
    const o = analyzeResult.operations || {};
    const c = analyzeResult.commercial || {};
    const comp = analyzeResult.compliance || {};

    if (!s.soc2) score -= 25;
    else if (s.soc2_type !== 'II') score -= 10;
    if (!s.iso27001) score -= 10;
    if (!o.status_page_found) score -= 15;
    if (o.leadership_changes) score -= 10;
    if (c.ownership_type === 'pe_owned') score -= 15;
    if (c.ownership_type === 'unknown') score -= 10;
    if (!comp.gdpr_mechanism) score -= 10;
    if (!comp.dpa_available) score -= 5;
    if (c.pricing_model === 'contact_sales') score -= 5;
    if (c.pricing_model === 'unknown') score -= 5;
    if (o.recent_breach) score -= 15;
    if (o.layoffs) score -= 5;

    if (s.soc2_expiry_date) {
      try {
        const expiryDate = new Date(s.soc2_expiry_date);
        const today = new Date();
        expiryDays = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
        if (expiryDays <= 90 && expiryDays > 0) { expiryFlag = true; score -= 10; }
        else if (expiryDays <= 0) { expiryFlag = true; score -= 20; }
      } catch (e) {
        console.error('Could not parse expiry date:', s.soc2_expiry_date);
      }
    }
  }

  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 70 ? 'LOW RISK' : score >= 40 ? 'REVIEW' : 'STOP';

  if (!analyzeResult) {
    analyzeResult = {
      security: { soc2: null, soc2_type: null, soc2_expiry_date: null, iso27001: null, hipaa: null, fedramp: null, pci: null, notes: null },
      compliance: { gdpr_mechanism: null, data_residency: 'unknown', privacy_policy_updated: null, dpa_available: null, sub_processors: [] },
      operations: { status_page_found: false, status_page_url: null, status_incidents: null, layoffs: null, recent_breach: null, leadership_changes: null },
      commercial: { pricing_model: 'unknown', pricing_notes: null, ownership_type: 'unknown', latest_round: null, founded_year: null },
      recommended_actions: ['Request vendor security questionnaire directly.', 'Ask vendor to provide SOC 2 report, DPA, and sub-processor list via email.'],
      summary: 'No public data could be retrieved for this vendor. Request documentation directly before onboarding or renewal.'
    };
  }

  const duration = Date.now() - startTime;

  // ─── STEP 4: SUPABASE — GET PREVIOUS SCAN + STORE CURRENT ────────────────

  let renewalDiff = null;
  let previousScan = null;

  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    try {
      const prevScans = await supabaseGet(
        `vendor_scans?domain=eq.${encodeURIComponent(domain)}&order=scanned_at.desc&limit=1`
      );

      if (prevScans && prevScans.length > 0) {
        previousScan = prevScans[0];
        const changes = [];
        const prevScore = previousScan.score;
        const prevResult = previousScan.result || {};

        if (Math.abs(score - prevScore) >= 10) {
          changes.push(`Score changed from ${prevScore} to ${score} (${score > prevScore ? '+' : ''}${score - prevScore})`);
        }
        const prevSoc2 = prevResult.security?.soc2;
        const currSoc2 = analyzeResult.security?.soc2;
        if (prevSoc2 !== currSoc2) {
          changes.push(`SOC 2 status changed from ${prevSoc2 === null ? 'unknown' : prevSoc2} to ${currSoc2 === null ? 'unknown' : currSoc2}`);
        }
        const prevOwnership = prevResult.commercial?.ownership_type;
        const currOwnership = analyzeResult.commercial?.ownership_type;
        if (prevOwnership && currOwnership && prevOwnership !== currOwnership) {
          changes.push(`Ownership changed from ${prevOwnership} to ${currOwnership}`);
        }
        if (!prevResult.operations?.recent_breach && analyzeResult.operations?.recent_breach) {
          changes.push(`Breach detected since last scan`);
        }
        if (changes.length > 0) {
          renewalDiff = {
            changes,
            previousScore: prevScore,
            previousScannedAt: previousScan.scanned_at
          };
        }
      }

      await supabaseInsert({
        domain,
        score,
        verdict,
        error_code: errorCode,
        scrape_status: scrapeStatus,
        scrape_notes: scrapeNotes,
        result: analyzeResult,
        expiry_flag: expiryFlag,
        expiry_days: expiryDays
      });

      toolsLog.push('Supabase: scan stored');
    } catch (err) {
      console.error('Supabase error (non-critical):', err.message);
      toolsLog.push(`Supabase: FAILED — ${err.message}`);
    }
  }

  // ─── STEP 5: SLACK NOTIFICATIONS ──────────────────────────────────────────
  // User-facing channel: clean summary with score and key signals.
  // Admin channel: full debug payload with error codes, timing, tools log.

  const slackPromises = [];

  // User-facing Slack
  if (process.env.SLACK_WEBHOOK_URL) {
    slackPromises.push((async () => {
      try {
        const color = score >= 70 ? '#15803D' : score >= 40 ? '#92400E' : '#B91C1C';
        const s = analyzeResult.security || {};
        const comp = analyzeResult.compliance || {};

        const blocks = [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*${domain}* — ${score}/100 — *${verdict}*` }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*SOC 2:* ${s.soc2 === true ? `Yes${s.soc2_type ? ' Type ' + s.soc2_type : ''}` : s.soc2 === false ? 'No' : '--'}` },
              { type: 'mrkdwn', text: `*ISO 27001:* ${s.iso27001 === true ? 'Yes' : '--'}` },
              { type: 'mrkdwn', text: `*GDPR:* ${comp.gdpr_mechanism ? 'Yes' : '--'}` },
              { type: 'mrkdwn', text: `*DPA:* ${comp.dpa_available === true ? 'Yes' : '--'}` }
            ]
          }
        ];

        if (expiryFlag && expiryDays !== null) {
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: expiryDays > 0 ? `:warning: *SOC 2 expiring in ${expiryDays} days*` : `:rotating_light: *SOC 2 has expired*` }
          });
        }

        if (renewalDiff) {
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `:arrows_counterclockwise: *Changes since last scan:*\n${renewalDiff.changes.map(c => `• ${c}`).join('\n')}` }
          });
        }

        const missingFields = [];
        if (s.soc2 === null) missingFields.push('SOC 2');
        if (comp.dpa_available === null) missingFields.push('DPA');
        if ((comp.sub_processors || []).length === 0) missingFields.push('Sub-processors');

        if (missingFields.length > 0) {
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `:pencil: *Needs manual review:* ${missingFields.join(', ')} — <https://vendor-intelligence-tool.vercel.app|Open portal>` }
          });
        }

        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `Scrape: ${scrapeStatus} · ${duration}ms · ${new Date().toUTCString()}` }]
        });

        await fetch(process.env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attachments: [{ color, blocks }] }),
          signal: AbortSignal.timeout(5000)
        });
      } catch (err) {
        console.error('User Slack notification failed:', err.message);
      }
    })());
  }

  // Admin Slack — full debug payload
  const hasAnyIssue = errorCode || score === 0 || scrapeStatus === 'failed' || toolsLog.some(t => t.includes('FAILED') || t.includes('timeout') || t.includes('blocked'));
if (process.env.SLACK_ADMIN_WEBHOOK_URL && hasAnyIssue) {
    slackPromises.push((async () => {
      try {
        const isError = !!errorCode;
        const adminColor = isError ? '#B91C1C' : score < 40 ? '#92400E' : '#888888';

        const adminBlocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${isError ? ':rotating_light:' : ':white_check_mark:'} *${domain}* — ${score}/100 — ${verdict}${errorCode ? ` — \`${errorCode}\`` : ''}`
            }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Scrape status:* ${scrapeStatus}` },
              { type: 'mrkdwn', text: `*Duration:* ${duration}ms` },
              { type: 'mrkdwn', text: `*Paths found:* ${successCount}` },
              { type: 'mrkdwn', text: `*Discovered URLs:* ${discoveredUrls.length}` }
            ]
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Tools log:*\n${toolsLog.map(t => `• ${t}`).join('\n')}` }
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Scrape notes:* ${scrapeNotes}` }
          }
        ];

        if (renewalDiff) {
          adminBlocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*Renewal diff:*\n${renewalDiff.changes.map(c => `• ${c}`).join('\n')}\nPrevious scan: ${renewalDiff.previousScannedAt}` }
          });
        }

        adminBlocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `${new Date().toUTCString()} · vendor-intelligence-tool.vercel.app` }]
        });

        await fetch(process.env.SLACK_ADMIN_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attachments: [{ color: adminColor, blocks: adminBlocks }] }),
          signal: AbortSignal.timeout(5000)
        });
      } catch (err) {
        console.error('Admin Slack notification failed:', err.message);
      }
    })());
  }

  await Promise.allSettled(slackPromises);

  // ─── RETURN ───────────────────────────────────────────────────────────────

  return res.status(200).json({
    domain,
    score,
    verdict,
    scannedAt: new Date().toISOString(),
    errorCode,
    expiryFlag,
    expiryDays,
    renewalDiff,
    result: {
      ...analyzeResult,
      scrape_status: scrapeStatus,
      scrape_notes: scrapeNotes
    }
  });
}
