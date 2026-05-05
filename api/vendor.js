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

  const verdict = score >= 70 ? 'LOW RISK' : score >= 40 ? 'REVIEW' : 'STOP';

  return res.status(200).json({
    domain,
    score,
    verdict,
    scannedAt: new Date().toISOString(),
    ...analyzeData
  });
}