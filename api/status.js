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
  const token = process.env.ML_ACCESS_TOKEN;
  if (!token) return res.json({ ok: false, msg: 'Sem token ML' });
  try {
    const { status, data } = await mlGet('/users/me');
    res.json({ ok: status === 200, nickname: data.nickname, user_id: data.id, msg: status !== 200 ? 'Token invalido' : '' });
  } catch (e) { res.json({ ok: false, msg: e.message }); }
};
