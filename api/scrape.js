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
  const mlUrl = req.query.url;
  if (!mlUrl) return res.status(400).json({ ok: false, error: 'url required' });

  let mlbId = '';
  const idMatch = mlUrl.match(/(MLB[U]?[-]?\d+)/i);
  if (idMatch) mlbId = idMatch[1].toUpperCase().replace(/-/g, '');

  let catalog = 'NO';
  if (mlUrl.includes('/p/MLB') || mlUrl.includes('/p/mlb')) catalog = 'YES';

  let titleFromUrl = '';
  const slugMatch = mlUrl.match(/\.com\.br\/([^/]+?)\/(?:p|up)\/MLB/i) || mlUrl.match(/MLB[U]?-?\d+-([^?#]+?)(?:-_JM|_JM)/i);
  if (slugMatch) titleFromUrl = slugMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();

  try {
    const { status, data } = await mlGet(`/items/${mlbId}`);
    if (status === 200 && data.id) {
      const soldQty = data.sold_quantity || 0;
      const dateCreated = data.date_created || data.start_time || '';
      let days = 0;
      if (dateCreated) days = Math.max(1, Math.round((Date.now() - new Date(dateCreated).getTime()) / 86400000));
      return res.json({
        ok: true, id: data.id, title: data.title || titleFromUrl, price: data.price || 0,
        sales: soldQty, catalog: data.catalog_listing ? 'YES' : catalog, link: mlUrl,
        shipping: '', shippingCost: 0, freeShipping: data.shipping?.free_shipping || false,
        seller: '', sellerLocation: '', sellerReputation: '',
        publishedDays: days, condition: data.condition === 'new' ? 'Novo' : 'Usado',
        listingType: data.listing_type_id === 'gold_pro' ? 'Premium' : 'Classico',
        fullfilment: false, scraped: true,
      });
    }
    res.json({ ok: true, id: mlbId, title: titleFromUrl || 'Produto ' + mlbId, price: 0, sales: 0, catalog, link: mlUrl, shipping: '', shippingCost: 0, freeShipping: false, seller: '', sellerLocation: '', sellerReputation: '', publishedDays: 0, condition: '', listingType: '', fullfilment: false, scraped: false });
  } catch (e) { res.json({ ok: false, error: e.message }); }
};
