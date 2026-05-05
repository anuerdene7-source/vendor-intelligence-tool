export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { domain, text, scrapeStatus, scrapeNotes } = req.body;

  if (!text) {
    return res.status(200).json({
      domain,
      scrapeStatus: 'failed',
      scrapeNotes,
      result: null
    });
  }

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
  "summary": "2-3 sentence plain English verdict for a non-technical CFO",
  "scrape_status": "${scrapeStatus}",
  "scrape_notes": "${scrapeNotes}"
}

If a signal cannot be determined from the text, return null for that field. Never guess. Never invent data.

Scraped text:
${text.slice(0, 12000)}`;

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
      })
    });

    const data = await response.json();
    const rawText = data.content[0].text;
    const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json({ domain, result: parsed });

  } catch (err) {
    console.error('Claude API error:', err.message);
    return res.status(200).json({
      domain,
      scrapeStatus: 'failed',
      scrapeNotes: 'Claude extraction failed. ' + err.message,
      result: null
    });
  }
}