export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { domain } = req.body;
  if (!domain) {
    return res.status(400).json({ error: 'No domain provided' });
  }

  // ─── STEP 1: SCRAPE (parallel, 10s timeout per request) ──────────────────

  const paths = [
    '/security', '/trust', '/trust/security', '/compliance',
    '/privacy', '/pricing', '/about', '/legal/security', '/legal/privacy'
  ];

  const statusUrls = [
    `https://status.${domain}`,
    `https://${domain}/status`
  ];

  // Many vendors host trust docs at non-standard subdomains
  const trustSubdomains = [
    `https://trust.${domain}`,
    `https://trust-portal.${domain}`,
    `https://security.${domain}`
  ];

  let combinedText = '';
  let successCount = 0;
  let statusPageFound = false;
  let statusPageUrl = null;

  const allRequests = [
    ...statusUrls.map(url => ({ type: 'status', url, jinaUrl: `https://r.jina.ai/${url}` })),
    ...trustSubdomains.map(url => ({ type: 'path', path: url, jinaUrl: `https://r.jina.ai/${url}` })),
    ...paths.map(path => ({ type: 'path', path, jinaUrl: `https://r.jina.ai/https://${domain}${path}` }))
  ];

  const results = await Promise.allSettled(
    allRequests.map(async (r) => {
      const response = await fetch(r.jinaUrl, {
        headers: { 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) return null;
      const text = await response.text();
      if (!text || text.length < 200) return null;
      return { ...r, text };
    })
  );

  // Process status page results
  for (const r of results.slice(0, statusUrls.length)) {
    if (r.status === 'fulfilled' && r.value) {
      const t = r.value.text;
      if (!t.includes('404') && !t.includes('Not Found')) {
        combinedText += `\n\n--- /status ---\n${t.slice(0, 3000)}`;
        statusPageFound = true;
        statusPageUrl = r.value.url;
        successCount++;
        break;
      }
    }
  }

  // Process trust subdomains and path results together
  for (const r of results.slice(statusUrls.length)) {
    if (r.status === 'fulfilled' && r.value) {
      combinedText += `\n\n--- ${r.value.path} ---\n${r.value.text.slice(0, 3000)}`;
      successCount++;
    }
  }

  let scrapeStatus = successCount >= 3 ? 'success' : successCount > 0 ? 'partial' : 'failed';
  let scrapeNotes = `Retrieved content from ${successCount} paths. Status page: ${statusPageFound ? statusPageUrl : 'not found'}.`;

  // ─── OPTION A: If direct scrape got nothing, try Jina search immediately ──

  if (successCount === 0 || combinedText.length < 100) {
    console.log(`Direct scrape blocked for ${domain}, trying Jina search...`);
    try {
      const searchQueries = [
        `${domain} SOC2 security compliance trust certifications`,
        `${domain} privacy GDPR data processing agreement`
      ];

      const searchResults = await Promise.allSettled(
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

      for (const r of searchResults) {
        if (r.status === 'fulfilled' && r.value) {
          combinedText += `\n\n--- search results ---\n${r.value.slice(0, 4000)}`;
          successCount++;
        }
      }

      if (successCount > 0) {
        scrapeStatus = 'partial';
        scrapeNotes = `Direct scrape blocked by vendor. Content retrieved via search index for ${domain}.`;
      } else {
        scrapeStatus = 'failed';
        scrapeNotes = `Unable to retrieve public data for ${domain}. Vendor blocks automated scraping. Request security documentation directly from vendor.`;
      }
    } catch (err) {
      console.error(`Search fallback failed for ${domain}:`, err.message);
      scrapeStatus = 'failed';
      scrapeNotes = `Unable to retrieve public data for ${domain}. Request security documentation directly from vendor.`;
    }
  }

  // ─── STEP 2: ANALYZE (25s timeout) ───────────────────────────────────────

  let analyzeResult = null;

  if (combinedText.length > 100) {
    const prompt = `You are a vendor risk analyst. Given the following scraped text from a SaaS vendor's public pages, extract the signals below and return them as a JSON object only. No other text. No markdown. No backticks. Just the raw JSON object.

{
  "security": {
    "soc2": true or false or null,
    "soc2_type": "I" or "II" or null,
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
    "dpa_available": true or false or null
  },
  "operations": {
    "status_page_found": true or false,
    "status_page_url": "string or null",
    "employee_count": "string or null",
    "leadership_changes": true or false or null,
    "leadership_notes": "string or null",
    "layoffs": true or false or null,
    "layoffs_notes": "string or null"
  },
  "commercial": {
    "pricing_model": "public" or "contact_sales" or "freemium" or "unknown",
    "pricing_notes": "string or null",
    "ownership_type": "public" or "pe_owned" or "vc_backed" or "bootstrapped" or "unknown",
    "latest_round": "string or null",
    "founded_year": number or null
  },
  "recommended_actions": ["string", "string"],
  "summary": "2-3 sentence plain English verdict for a non-technical CFO",
  "scrape_status": "${scrapeStatus}",
  "scrape_notes": "${scrapeNotes}"
}

For the operations.layoffs field: only return true if the company themselves announced it via a press release, blog post, or official statement in the scraped text. If only mentioned in third-party news, return null not true.

If a signal cannot be determined from the text, return null for that field. Never guess. Never invent data.

Scraped text:
${combinedText.slice(0, 12000)}`;

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
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: AbortSignal.timeout(25000)
      });

      const data = await response.json();
      const rawText = data.content[0].text;
      const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analyzeResult = JSON.parse(clean);

    } catch (err) {
      console.error('Claude API error:', err.message);
    }
  }

  // ─── STEP 3: SCORE ────────────────────────────────────────────────────────

  let score = 100;

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
  }

  score = Math.max(0, Math.min(100, score));

  // ─── STEP 4: SECURITY SIGNAL FALLBACK ────────────────────────────────────
  // If we got a card but security signals are all null, do one more targeted
  // search specifically for security certifications

  const sec = analyzeResult ? analyzeResult.security : null;
  const securityEmpty = sec &&
    sec.soc2 === null &&
    sec.iso27001 === null &&
    sec.hipaa === null &&
    sec.fedramp === null;

  if (securityEmpty && scrapeStatus !== 'failed') {
    console.log(`Security signals empty for ${domain}, running targeted security search...`);
    try {
      const searchUrl = `https://s.jina.ai/${encodeURIComponent(domain + ' SOC2 Type II certified security trust compliance')}`;
      const searchRes = await fetch(searchUrl, {
        headers: {
          'Accept': 'text/plain',
          'Authorization': `Bearer ${process.env.JINA_API_KEY}`
        },
        signal: AbortSignal.timeout(10000)
      });

      if (searchRes.ok) {
        const searchText = await searchRes.text();
        if (searchText && searchText.length > 200) {
          const fallbackPrompt = `You are a vendor risk analyst. Extract security signals from this text and return JSON only. No markdown. No backticks.
{"security":{"soc2":true/false/null,"soc2_type":"I"/"II"/null,"iso27001":true/false/null,"hipaa":true/false/null,"fedramp":true/false/null,"pci":true/false/null,"notes":"string or null"},"compliance":{"gdpr_mechanism":"string or null","data_residency":"US"/"EU"/"both"/"unknown","privacy_policy_updated":"string or null","dpa_available":true/false/null}}
Never guess. Return null if not found.
Text: ${searchText.slice(0, 6000)}`;

          const fallbackClaudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-5',
              max_tokens: 500,
              messages: [{ role: 'user', content: fallbackPrompt }]
            }),
            signal: AbortSignal.timeout(15000)
          });

          const fallbackClaudeData = await fallbackClaudeRes.json();
          const rawFallback = fallbackClaudeData.content[0].text;
          const cleanFallback = rawFallback.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          const fallbackData = JSON.parse(cleanFallback);

          if (fallbackData.security && fallbackData.security.soc2 !== null) {
            console.log(`Security search found signals for ${domain}`);
            analyzeResult.security = fallbackData.security;
            if (!analyzeResult.compliance.gdpr_mechanism && fallbackData.compliance && fallbackData.compliance.gdpr_mechanism) {
              analyzeResult.compliance = fallbackData.compliance;
            }

            const s2 = analyzeResult.security;
            const o2 = analyzeResult.operations || {};
            const c2 = analyzeResult.commercial || {};
            const comp2 = analyzeResult.compliance || {};
            score = 100;
            if (!s2.soc2) score -= 25;
            else if (s2.soc2_type !== 'II') score -= 10;
            if (!s2.iso27001) score -= 10;
            if (!o2.status_page_found) score -= 15;
            if (o2.leadership_changes) score -= 10;
            if (c2.ownership_type === 'pe_owned') score -= 15;
            if (c2.ownership_type === 'unknown') score -= 10;
            if (!comp2.gdpr_mechanism) score -= 10;
            if (!comp2.dpa_available) score -= 5;
            if (c2.pricing_model === 'contact_sales') score -= 5;
            if (c2.pricing_model === 'unknown') score -= 5;
            score = Math.max(0, Math.min(100, score));
          }
        }
      }
    } catch (err) {
      console.error(`Security search timed out for ${domain}:`, err.message);
    }
  }

  // ─── RETURN ───────────────────────────────────────────────────────────────

  const verdict = score >= 70 ? 'LOW RISK' : score >= 40 ? 'REVIEW' : 'STOP';

  return res.status(200).json({
    domain,
    score,
    verdict,
    scannedAt: new Date().toISOString(),
    result: analyzeResult
  });
}
