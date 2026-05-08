export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { domain, note, editor } = req.body;
  if (!domain || !note) return res.status(400).json({ error: 'Missing domain or note' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    // Get the most recent scan for this domain
    const getRes = await fetch(
      `${supabaseUrl}/rest/v1/vendor_scans?domain=eq.${encodeURIComponent(domain)}&order=scanned_at.desc&limit=1`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        },
        signal: AbortSignal.timeout(5000)
      }
    );

    if (!getRes.ok) throw new Error('Failed to fetch scan from Supabase');
    const scans = await getRes.json();
    if (!scans.length) return res.status(404).json({ error: `No scan found for ${domain}` });

    const scan = scans[0];
    const existingNotes = scan.manual_notes || [];

    const newNote = {
      note,
      editor: editor || 'Team member',
      timestamp: new Date().toISOString()
    };

    const updatedNotes = [...existingNotes, newNote];

    // Patch the row with the updated notes array
    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/vendor_scans?id=eq.${scan.id}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ manual_notes: updatedNotes }),
        signal: AbortSignal.timeout(5000)
      }
    );

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      throw new Error(`Supabase PATCH failed: ${errText}`);
    }

    return res.status(200).json({ success: true, note: newNote });

  } catch (err) {
    console.error('manual-edit error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
