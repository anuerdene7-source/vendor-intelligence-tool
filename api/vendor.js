export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { domain } = req.body;
  if (!domain) {
    return res.status(400).json({ error: 'No domain provided' });
  }

  // Step 1: Scrape
  const scrapeRes = await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain })
  });
  const scrapeData = await scrapeRes.json();

  // Step 2: Analyze
  const analyzeRes = await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      domain,
      text: scrapeData.text,
      scrapeStatus: scrapeData.scrapeStatus,
      scrapeNotes: scrapeData.scrapeNotes
    })
  });
  const analyzeData = await analyzeRes.json();

  // Step 3: Score
  const result = analyzeData.result;
  let score = 100;

  if (result) {
    const s = result.security;
    const o = result.operations;
    const c = result.commercial;
    const comp = result.compliance;

    // Security (35 points)
    if (!s.soc2) score -= 25;
    else if (s.soc2_type !== 'II') score -= 10;
    if (!s.iso27001) score -= 10;

    // Operations (25 points)
    if (!o.status_page_found) score -= 15;
    if (o.leadership_changes) score -= 10;

    // Ownership (20 points)
    if (c.ownership_type === 'pe_owned') score -= 15;
    if (c.ownership_type === 'unknown') score -= 10;

    // Compliance (15 points)
    if (!comp.gdpr_mechanism) score -= 10;
    if (!comp.dpa_available) score -= 5;

    // Pricing (5 points)
    if (c.pricing_model === 'contact_sales') score -= 5;
    if (c.pricing_model === 'unknown') score -= 5;
  }

  score = Math.max(0, Math.min(100, score));

 // Security fallback: if all security signals are null and scrape did not fully fail,
  // run a targeted Jina search to find the vendor's trust documentation and try again
  const sec = result ? result.security : null;
  const securityEmpty = sec && 
    sec.soc2 === null && 
    sec.iso27001 === null && 
    sec.hipaa === null && 
    sec.fedramp === null;

  if (securityEmpty && scrapeData.scrapeStatus !== 'failed') {
    console.log(`Security signals empty for ${domain}, running search fallback...`);
    try {
      const searchUrl = `https://s.jina.ai/${encodeURIComponent(domain + ' SOC2 security trust compliance certification')}`;
      const searchRes = await fetch(searchUrl, {
        headers: { 
          'Accept': 'text/plain',
          'Authorization': `Bearer ${process.env.JINA_API_KEY}`
        }
      });

      if (searchRes.ok) {
        const searchText = await searchRes.text();
        if (searchText && searchText.length > 200) {
          // Run a second Claude extraction pass with the search results
          const fallbackPrompt = `You are a vendor risk analyst. Extract security signals from this text and return JSON only. No markdown. No backticks.
{"security":{"soc2":true/false/null,"soc2_type":"I"/"II"/null,"iso27001":true/false/null,"hipaa":true/false/null,"fedramp":true/false/null,"pci":true/false/null,"notes":"string or null"},"compliance":{"gdpr_mechanism":"string or null","data_residency":"US"/"EU"/"both"/"unknown","privacy_policy_updated":"string or null","dpa_available":true/false/null}}
Never guess. Return null if not found.
Text: ${searchText.slice(0, 8000)}`;

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
        })
      });

      const fallbackClaudeData = await fallbackClaudeRes.json();
      const rawFallback = fallbackClaudeData.content[0].text;
      const cleanFallback = rawFallback.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const fallbackData = { result: JSON.parse(cleanFallback) };

          // Only use fallback result if it found something standard scrape missed
          if (fallbackData.result && fallbackData.result.security && fallbackData.result.security.soc2 !== null) {
            console.log(`Search fallback found security signals for ${domain}`);
            
            // Merge fallback security and compliance into original result
            analyzeData.result.security = fallbackData.result.security;
            if (!analyzeData.result.compliance.gdpr_mechanism && fallbackData.result.compliance.gdpr_mechanism) {
              analyzeData.result.compliance = fallbackData.result.compliance;
            }
            analyzeData.result.scrape_notes = `Security documentation found via search fallback. Standard paths returned no security signals.`;

        // Recalculate score with updated security signals
            const s2 = analyzeData.result.security;
            score = 100;
            if (!s2.soc2) score -= 25;
            else if (s2.soc2_type !== 'II') score -= 10;
            if (!s2.iso27001) score -= 10;
            if (!result.operations.status_page_found) score -= 15;
            if (result.operations.leadership_changes) score -= 10;
            if (result.commercial.ownership_type === 'pe_owned') score -= 15;
            if (result.commercial.ownership_type === 'unknown') score -= 10;
            if (!analyzeData.result.compliance.gdpr_mechanism) score -= 10;
            if (!analyzeData.result.compliance.dpa_available) score -= 5;
            if (result.commercial.pricing_model === 'contact_sales') score -= 5;
            if (result.commercial.pricing_model === 'unknown') score -= 5;
            score = Math.max(0, Math.min(100, score));
          }
        }
      }
    } catch (err) {
      console.error(`Search fallback error for ${domain}:`, err.message, err.stack);
    }
  }

  const verdict = score >= 70 ? 'LOW RISK' : score >= 40 ? 'REVIEW' : 'STOP';

  return res.status(200).json({
    domain,
    score,
    verdict,
    scannedAt: new Date().toISOString(),
    ...analyzeData
  });
}