export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { domain } = req.body;
  if (!domain) {
    return res.status(400).json({ error: 'No domain provided' });
  }

  // 24-month cutoff for news — never hardcoded year
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - 24);
  const cutoffYear = cutoffDate.getFullYear();
  const cutoffYear2 = cutoffYear + 1;

  let errorCode = null;

  // ─── FIRECRAWL HELPER ─────────────────────────────────────────────────────
  // Handles JS-rendered pages, bypasses Cloudflare, returns clean markdown.
  // Falls back cleanly with null if page is inaccessible.

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
          onlyMainContent: true,
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
      return null;
    }
  }

  // ─── STEP 0: DISCOVERY via Serper.dev ────────────────────────────────────
  // Find real vendor-owned URLs before scraping.
  // Prevents guessing paths and hitting dead ends.

  let discoveredUrls = [];

  try {
    const serperRes = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        q: `site:${domain} security OR trust OR compliance OR privacy OR DPA`,
        num: 10
      }),
      signal: AbortSignal.timeout(8000)
    });

    if (serperRes.ok) {
      const serperData = await serperRes.json();
      const organic = serperData.organic || [];
      discoveredUrls = organic
        .map(r => r.link)
        .filter(url => {
          try {
            const hostname = new URL(url).hostname;
            const baseDomain = domain.replace(/^www\./, '');
            return hostname === baseDomain ||
              hostname === `www.${baseDomain}` ||
              hostname.endsWith(`.${baseDomain}`);
          } catch { return false; }
        })
        .slice(0, 5);
      console.log(`[Serper] Found ${discoveredUrls.length} vendor URLs for ${domain}`);
    }
  } catch (err) {
    console.error(`Serper discovery failed for ${domain}:`, err.message);
    errorCode = 'DISCOVERY_FAILED';
  }

  // ─── STEP 1b: PARALLEL NEWS SEARCH via Serper ────────────────────────────
  // Runs in parallel with scraping. THIRD_PARTY content only.
  // Used for layoffs, breaches, leadership changes — never security certs.

  const newsSearchPromise = (async () => {
    try {
      const newsRes = await fetch('https://google.serper.dev/news', {
        method: 'POST',
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          q: `"${domain}" layoffs OR breach OR "data breach" OR "leadership change" OR acquired OR funding ${cutoffYear} OR ${cutoffYear2}`,
          num: 5
        }),
        signal: AbortSignal.timeout(8000)
      });
      if (!newsRes.ok) return '';
      const newsData = await newsRes.json();
      const articles = newsData.news || [];
      if (!articles.length) return '';
      return articles.map(a =>
        `[THIRD_PARTY: ${a.source || 'news'} — ${a.date || 'recent'}]\nTitle: ${a.title}\nSnippet: ${a.snippet}`
      ).join('\n\n');
    } catch (err) {
      console.error(`News search failed for ${domain}:`, err.message);
      return '';
    }
  })();

  // ─── STEP 1: SCRAPE via Firecrawl (parallel) ─────────────────────────────
  // Firecrawl handles JS-rendered pages and Cloudflare-protected sites.
  // Scrape discovered URLs + standard paths simultaneously.
  // Kept to 8 paths max to stay within Firecrawl free tier limits.

  const standardPaths = [
    '/security', '/trust', '/trust/security',
    '/compliance', '/privacy', '/about'
  ];

  const trustSubdomains = [
    `https://trust.${domain}`,
    `https://trust-portal.${domain}`
  ];

  const statusUrls = [
    `https://status.${domain}`,
    `https://${domain}/status`
  ];

  // Build URL list: discovered first, then trust subdomains, then standard paths
  const discoveredRequests = discoveredUrls
    .filter(url => !statusUrls.some(s => url.includes('status')))
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

  // Run all scrapes in parallel
  const scrapeResults = await Promise.allSettled(
    allScrapeTargets.map(async (target) => {
      const text = await firecrawl(target.url);
      if (!text) return null;
      return { ...target, text };
    })
  );

  // Process status page results first
  for (let i = 0; i < statusUrls.length; i++) {
    const r = scrapeResults[i];
    if (r.status === 'fulfilled' && r.value) {
      const t = r.value.text;
      if (!t.includes('404') && !t.toLowerCase().includes('not found')) {
        combinedText += `\n\n[${r.value.label}]\n${t.slice(0, 3000)}`;
        statusPageFound = true;
        statusPageUrl = r.value.url;
        successCount++;
        break;
      }
    }
  }

  // Process all other results
  for (let i = statusUrls.length; i < scrapeResults.length; i++) {
    const r = scrapeResults[i];
    if (r.status === 'fulfilled' && r.value) {
      combinedText += `\n\n[${r.value.label}]\n${r.value.text.slice(0, 3000)}`;
      successCount++;
    }
  }

  let scrapeStatus = successCount >= 3 ? 'success' : successCount > 0 ? 'partial' : 'failed';
  let scrapeNotes = `Retrieved content from ${successCount} paths. Status page: ${statusPageFound ? statusPageUrl : 'not found'}.`;
  if (discoveredUrls.length > 0) {
    scrapeNotes += ` Serper discovery found ${discoveredUrls.length} vendor URLs.`;
  }

  // ─── FALLBACK: If Firecrawl got nothing, try Jina search index ───────────

  if (successCount === 0 || combinedText.length < 100) {
    errorCode = 'SCRAPE_BLOCKED';
    console.log(`Firecrawl returned nothing for ${domain}, trying Jina search fallback...`);
    try {
      const searchQueries = [
        `${domain} SOC2 security compliance trust certifications`,
        `${domain} privacy GDPR data processing agreement sub-processors`
      ];

      const fallbackResults = await Promise.allSettled(
        searchQueries.map(async (query) => {
          const r = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
            headers: {
              'Accept': 'text/plain',
              'Authorization': `Bearer ${process.env.JINA_API_KEY}`
            },
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
      } else {
        errorCode = 'SCRAPE_FAILED';
        scrapeStatus = 'failed';
        scrapeNotes = `No public data available for ${domain}. Request security documentation directly from vendor.`;
      }
    } catch (err) {
      errorCode = 'SCRAPE_FAILED';
      scrapeStatus = 'failed';
      scrapeNotes = `No public data available for ${domain}. Request security documentation directly from vendor.`;
    }
  }

  // Wait for news search to complete
  const newsText = await newsSearchPromise;

  // ─── STEP 2: ANALYZE via Claude ──────────────────────────────────────────
  // Vendor-owned content trusted for security certs and compliance signals.
  // Third-party content used only for operating health and commercial signals.

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

    } catch (err) {
      console.error('Claude API error:', err.message);
      errorCode = errorCode || 'EXTRACTION_FAILED';

      // Retry once with simplified prompt
      try {
        const simplePrompt = `Extract vendor risk signals from this text and return JSON only. No markdown.
{"security":{"soc2":null,"soc2_type":null,"soc2_expiry_date":null,"iso27001":null,"hipaa":null,"fedramp":null,"pci":null,"notes":null},"compliance":{"gdpr_mechanism":null,"data_residency":"unknown","privacy_policy_updated":null,"dpa_available":null,"sub_processors":[]},"operations":{"status_page_found":false,"status_page_url":null,"status_incidents":null,"layoffs":null,"layoffs_notes":null,"recent_breach":null,"breach_notes":null,"leadership_changes":null,"leadership_notes":null},"commercial":{"pricing_model":"unknown","pricing_notes":null,"ownership_type":"unknown","latest_round":null,"founded_year":null},"recommended_actions":["Request vendor security questionnaire directly."],"summary":"Insufficient public data to assess vendor risk. Request documentation directly."}
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
          throw new Error(`Claude retry error: ${JSON.stringify(retryData.error)}`);
        }
        const retryRaw = retryData.content[0].text;
        const retryClean = retryRaw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        analyzeResult = JSON.parse(retryClean);
        errorCode = null;
      } catch (retryErr) {
        console.error('Claude retry failed:', retryErr.message);
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

    // SOC 2 expiry check
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

  // Minimal result for complete failures
  if (!analyzeResult) {
    analyzeResult = {
      security: { soc2: null, soc2_type: null, soc2_expiry_date: null, iso27001: null, hipaa: null, fedramp: null, pci: null, notes: null },
      compliance: { gdpr_mechanism: null, data_residency: 'unknown', privacy_policy_updated: null, dpa_available: null, sub_processors: [] },
      operations: { status_page_found: false, status_page_url: null, status_incidents: null, layoffs: null, recent_breach: null, leadership_changes: null },
      commercial: { pricing_model: 'unknown', pricing_notes: null, ownership_type: 'unknown', latest_round: null, founded_year: null },
      recommended_actions: [
        'Request vendor security questionnaire directly.',
        'Ask vendor to provide SOC 2 report, DPA, and sub-processor list via email.'
      ],
      summary: 'No public data could be retrieved for this vendor. Request documentation directly before onboarding or renewal.'
    };
  }

  // ─── STEP 4: SLACK NOTIFICATION ──────────────────────────────────────────

  if (process.env.SLACK_WEBHOOK_URL) {
    try {
      const color = score >= 70 ? '#15803D' : score >= 40 ? '#92400E' : '#B91C1C';
      const s = analyzeResult.security || {};
      const comp = analyzeResult.compliance || {};

      const blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${domain}* — ${score}/100 — *${verdict}*`
          }
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
          text: {
            type: 'mrkdwn',
            text: expiryDays > 0
              ? `:warning: *SOC 2 expiring in ${expiryDays} days* — request updated certificate`
              : `:rotating_light: *SOC 2 has expired* — do not renew without updated cert`
          }
        });
      }

      const missingFields = [];
      if (s.soc2 === null) missingFields.push('SOC 2');
      if (comp.dpa_available === null) missingFields.push('DPA');
      if ((comp.sub_processors || []).length === 0) missingFields.push('Sub-processors');

      if (missingFields.length > 0) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:pencil: *Needs manual review:* ${missingFields.join(', ')} — <https://vendor-intelligence-tool.vercel.app|Open portal>`
          }
        });
      }

      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Scrape: ${scrapeStatus} · ${new Date().toUTCString()}` }]
      });

      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachments: [{ color, blocks }] }),
        signal: AbortSignal.timeout(5000)
      });
    } catch (err) {
      console.error('Slack notification failed (non-critical):', err.message);
    }
  }

  // ─── RETURN ───────────────────────────────────────────────────────────────

  return res.status(200).json({
    domain,
    score,
    verdict,
    scannedAt: new Date().toISOString(),
    errorCode,
    expiryFlag,
    expiryDays,
    result: {
      ...analyzeResult,
      scrape_status: scrapeStatus,
      scrape_notes: scrapeNotes
    }
  });
}
