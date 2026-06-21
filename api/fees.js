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
  const price = req.query.price || '100';
  const category = req.query.category;
  let ep = `/sites/MLB/listing_prices?price=${price}`;
  if (category) ep += `&category_id=${category}`;
  try {
    const { data } = await mlGet(ep);
    const result = {};
    if (Array.isArray(data)) {
      data.forEach(item => {
        if (item.listing_type_id === 'gold_pro') result.premium = { fee_pct: item.sale_fee_details?.percentage_fee || 0, fee_amount: item.sale_fee_amount || 0, fixed_fee: item.sale_fee_details?.fixed_fee || 0 };
        if (item.listing_type_id === 'gold_special') result.classico = { fee_pct: item.sale_fee_details?.percentage_fee || 0, fee_amount: item.sale_fee_amount || 0, fixed_fee: item.sale_fee_details?.fixed_fee || 0 };
      });
    }
    res.json({ ok: true, price: +price, category, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
};
