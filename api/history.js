export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { domain } = req.query;
  try {
    let url = `${process.env.SUPABASE_URL}/rest/v1/vendor_scans?order=scanned_at.desc`;
    if (domain) url += `&domain=eq.${encodeURIComponent(domain)}&limit=50`;
    else url += `&limit=500`;
    const r = await fetch(url, {
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error('Supabase fetch failed');
    const data = await r.json();
    return res.status(200).json({ scans: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
