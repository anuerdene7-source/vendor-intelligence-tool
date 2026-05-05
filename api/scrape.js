export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { domain } = req.body;

  if (!domain) {
    return res.status(400).json({ error: 'No domain provided' });
  }

  const paths = [
    '/security',
    '/trust',
    '/security-compliance',
    '/compliance',
    '/privacy',
    '/pricing',
    '/about',
    '/newsroom',
    '/news',
    '/blog'
  ];

  const statusUrls = [
    `https://status.${domain}`,
    `https://${domain}/status`,
    `https://${domain}/system-status`
  ];

  let combinedText = '';
  let successCount = 0;
  let statusPageFound = false;
  let statusPageUrl = null;

  // Check status page first
  for (const statusUrl of statusUrls) {
    try {
      const url = `https://r.jina.ai/${statusUrl}`;
      const response = await fetch(url, {
        headers: { 'Accept': 'text/plain' }
      });
      if (response.ok) {
        const text = await response.text();
        if (text && text.length > 200 && !text.includes('404') && !text.includes('Not Found')) {
          combinedText += `\n\n--- /status ---\n${text.slice(0, 3000)}`;
          statusPageFound = true;
          statusPageUrl = statusUrl;
          successCount++;
          break;
        }
      }
    } catch (err) {
      console.error(`Failed status page check ${statusUrl}:`, err.message);
    }
  }

  for (const path of paths) {
    try {
      const url = `https://r.jina.ai/https://${domain}${path}`;
      const response = await fetch(url, {
        headers: { 'Accept': 'text/plain' }
      });

      if (response.ok) {
        const text = await response.text();
        if (text && text.length > 200) {
          combinedText += `\n\n--- ${path} ---\n${text.slice(0, 3000)}`;
          successCount++;
        }
      }
    } catch (err) {
      console.error(`Failed to scrape ${domain}${path}:`, err.message);
    }
  }

  if (successCount === 0) {
    return res.status(200).json({
      domain,
      scrapeStatus: 'failed',
      scrapeNotes: 'No content retrieved from any path. Manual review required.',
      text: ''
    });
  }

  return res.status(200).json({
    domain,
    scrapeStatus: successCount >= 3 ? 'success' : 'partial',
    scrapeNotes: `Retrieved content from ${successCount} paths. Status page: ${statusPageFound ?statusPageUrl : 'not found'}.`,
    statusPageFound,
    statusPageUrl,
    text: combinedText
  });
}