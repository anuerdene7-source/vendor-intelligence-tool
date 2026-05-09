export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain, note, editor } = req.body;
  if (!domain || !note) return res.status(400).json({ error: 'Missing domain or note' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    const res2 = await fetch(`${supabaseUrl}/rest/v1/vendor_notes`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        domain,
        note,
        editor: editor || 'Team member',
        created_at: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(5000)
    });

    if (!res2.ok) {
      const err = await res2.text();
      throw new Error(`Supabase error: ${err}`);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('manual-edit error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}