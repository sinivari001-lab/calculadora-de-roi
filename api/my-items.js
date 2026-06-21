const https = require('https');

function mlGet(endpoint) {
  return new Promise((resolve, reject) => {
    const token = process.env.ML_ACCESS_TOKEN || '';
    https.get({
      hostname: 'api.mercadolibre.com', path: endpoint,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, data: d }); } });
    }).on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { data: me } = await mlGet('/users/me');
    if (!me?.id) throw new Error('Token invalido');
    let allIds = [], offset = 0;
    while (true) {
      const { data: search } = await mlGet(`/users/${me.id}/items/search?limit=50&offset=${offset}`);
      if (!search?.results?.length) break;
      allIds = allIds.concat(search.results);
      if (allIds.length >= (search.paging?.total || 0)) break;
      offset += 50;
    }
    const items = [];
    for (let i = 0; i < allIds.length; i += 20) {
      const batch = allIds.slice(i, i + 20);
      const { data: multiData } = await mlGet(`/items?ids=${batch.join(',')}`);
      if (Array.isArray(multiData)) {
        multiData.forEach(entry => {
          const d = entry.body;
          if (!d || d.error) return;
          const days = Math.max(1, Math.floor((Date.now() - new Date(d.start_time).getTime()) / 86400000));
          items.push({ id: d.id, title: d.title, price: d.price, soldTotal: d.sold_quantity || 0, days, status: d.status, condition: d.condition, permalink: d.permalink, catalog: d.catalog_listing ? 'YES' : 'NO', listingType: d.listing_type_id });
        });
      }
    }
    res.json({ ok: true, count: items.length, items });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
};
