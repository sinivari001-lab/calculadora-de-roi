#!/usr/bin/env node
/**
 * PreciFy Cloud Server
 * Adapted for Render deployment (headless Puppeteer, env vars, dynamic port)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

let puppeteer, StealthPlugin;
try {
  puppeteer = require('puppeteer-extra');
  StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
} catch {
  puppeteer = null;
}

const PORT = process.env.PORT || 3457;
const HTML_FILE = path.join(__dirname, 'index.html');
const PRODUCTS_FILE = path.join('/tmp', 'precify-products.json');
const DEFAULT_CEP = '41000000';

function getToken() {
  return process.env.ML_ACCESS_TOKEN || '';
}

function getRefreshToken() {
  return process.env.ML_REFRESH_TOKEN || '';
}

function getAppId() {
  return process.env.ML_APP_ID || '';
}

function getSecret() {
  return process.env.ML_SECRET_KEY || '';
}

let browser = null;
async function getBrowser() {
  if (!puppeteer) throw new Error('Puppeteer not available');
  if (!browser || !browser.connected) {
    const launchOpts = {
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-blink-features=AutomationControlled',
        '--single-process',
      ],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    browser = await puppeteer.launch(launchOpts);
  }
  return browser;
}

function mlApiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const opts = {
      hostname: 'api.mercadolibre.com',
      path: endpoint,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
    https.get(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    }).on('error', e => reject(e));
  });
}

function mlPublicGet(endpoint) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'api.mercadolibre.com', path: endpoint }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    }).on('error', e => reject(e));
  });
}

const CORS = { 'Access-Control-Allow-Origin': '*' };
const JSON_CORS = { 'Content-Type': 'application/json', ...CORS };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // Serve HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(HTML_FILE, 'utf8'));
    return;
  }

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, JSON_CORS);
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  // API: Listing fees
  if (url.pathname === '/api/fees') {
    const price = url.searchParams.get('price') || '100';
    const category = url.searchParams.get('category');
    let ep = `/sites/MLB/listing_prices?price=${price}`;
    if (category) ep += `&category_id=${category}`;
    try {
      const { data } = await mlApiGet(ep);
      const result = {};
      if (Array.isArray(data)) {
        data.forEach(item => {
          if (item.listing_type_id === 'gold_pro') {
            result.premium = { name: item.listing_type_name, fee_pct: item.sale_fee_details?.percentage_fee || 0, fee_amount: item.sale_fee_amount || 0, fixed_fee: item.sale_fee_details?.fixed_fee || 0 };
          }
          if (item.listing_type_id === 'gold_special') {
            result.classico = { name: item.listing_type_name, fee_pct: item.sale_fee_details?.percentage_fee || 0, fee_amount: item.sale_fee_amount || 0, fixed_fee: item.sale_fee_details?.fixed_fee || 0 };
          }
        });
      }
      res.writeHead(200, JSON_CORS);
      res.end(JSON.stringify({ ok: true, price: +price, category, ...result }));
    } catch (e) {
      res.writeHead(500, JSON_CORS);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // API: Batch fees
  if (url.pathname === '/api/fees-batch' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const items = JSON.parse(body);
        const results = [];
        for (const item of items) {
          let ep = `/sites/MLB/listing_prices?price=${item.price}`;
          if (item.category) ep += `&category_id=${item.category}`;
          const { data } = await mlApiGet(ep);
          const r = { price: item.price, index: item.index };
          if (Array.isArray(data)) {
            data.forEach(d => {
              if (d.listing_type_id === 'gold_pro') { r.premium_pct = d.sale_fee_details?.percentage_fee || 0; r.premium_amount = d.sale_fee_amount || 0; }
              if (d.listing_type_id === 'gold_special') { r.classico_pct = d.sale_fee_details?.percentage_fee || 0; r.classico_amount = d.sale_fee_amount || 0; }
            });
          }
          results.push(r);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        res.writeHead(200, JSON_CORS);
        res.end(JSON.stringify({ ok: true, results }));
      } catch (e) {
        res.writeHead(500, JSON_CORS);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // API: Shipping
  if (url.pathname === '/api/shipping') {
    const itemId = (url.searchParams.get('item_id') || '').replace(/-/g, '');
    const cep = url.searchParams.get('cep') || '41810130';
    if (!itemId) { res.writeHead(400, JSON_CORS); res.end(JSON.stringify({ ok: false, error: 'item_id required' })); return; }
    try {
      const { status, data } = await mlApiGet(`/items/${itemId}/shipping_options?zip_code=${cep}`);
      if (status !== 200 || !data.options) { res.writeHead(200, JSON_CORS); res.end(JSON.stringify({ ok: false, error: data.message || 'shipping not found' })); return; }
      const recommended = data.options.find(o => o.display === 'recommended') || data.options.find(o => o.shipping_method_type === 'slow') || data.options[0];
      res.writeHead(200, JSON_CORS);
      res.end(JSON.stringify({
        ok: true, sellerCost: recommended.base_cost, buyerCost: recommended.cost,
        listCost: recommended.list_cost, freeShipping: recommended.cost === 0,
        methodType: recommended.shipping_method_type, deliveryDate: recommended.estimated_delivery_time?.date,
        allOptions: data.options.map(o => ({ type: o.shipping_method_type, sellerCost: o.base_cost, buyerCost: o.cost, display: o.display, date: o.estimated_delivery_time?.date })),
      }));
    } catch (e) { res.writeHead(500, JSON_CORS); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // API: Scrape ML product page
  if (url.pathname === '/api/scrape') {
    const mlUrl = url.searchParams.get('url');
    const cep = url.searchParams.get('cep') || DEFAULT_CEP;
    if (!mlUrl) { res.writeHead(400, JSON_CORS); res.end(JSON.stringify({ ok: false, error: 'url required' })); return; }

    try {
      let mlbId = '';
      const idMatch = mlUrl.match(/(MLB[U]?[-]?\d+)/i);
      if (idMatch) mlbId = idMatch[1].toUpperCase();

      let catalog = 'NO';
      if (mlUrl.includes('/p/MLB') || mlUrl.includes('/p/mlb')) catalog = 'YES';

      let titleFromUrl = '';
      const slugMatch = mlUrl.match(/\.com\.br\/([^/]+?)\/(?:p|up)\/MLB/i) || mlUrl.match(/MLB[U]?-?\d+-([^?#]+?)(?:-_JM|_JM)/i);
      if (slugMatch) titleFromUrl = slugMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();

      let data = { title: '', price: 0, sales: 0, shipping: '', shippingCost: 0, freeShipping: false, seller: '', sellerLocation: '', sellerReputation: '', publishedDays: 0, condition: '', gtin: '', listingType: '', fullfilment: false };
      let scraped = false;

      if (puppeteer) {
        try {
          const b = await getBrowser();
          const page = await b.newPage();
          await page.setViewport({ width: 1280, height: 900 });
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
          await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });
          await page.goto(mlUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForSelector('h1, .ui-pdp-title, .andes-money-amount__fraction', { timeout: 15000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 3000));

          const pageUrl = page.url();
          const isLogin = pageUrl.includes('login') || pageUrl.includes('registration');
          const html = await page.content();
          const is404 = html.includes('esta página não existe');

          if (!isLogin && !is404) {
            await page.waitForSelector('.andes-money-amount__fraction, h1.ui-pdp-title', { timeout: 8000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));

            data = await page.evaluate(() => {
              const r = { title: '', price: 0, sales: 0, shipping: '', shippingCost: 0, freeShipping: false, seller: '', sellerLocation: '', sellerReputation: '', publishedDays: 0, condition: '', gtin: '', listingType: '', fullfilment: false, weightGrams: 0 };
              const titleEl = document.querySelector('h1.ui-pdp-title') || document.querySelector('h1');
              if (titleEl) r.title = titleEl.textContent.trim();
              const priceEls = document.querySelectorAll('.andes-money-amount__fraction');
              if (priceEls.length > 0) {
                const container = priceEls[0].closest('.andes-money-amount');
                const cents = container?.querySelector('.andes-money-amount__cents');
                let ps = priceEls[0].textContent.replace(/\./g, '').replace(',', '.');
                if (cents) ps += '.' + cents.textContent;
                r.price = parseFloat(ps) || 0;
              }
              const subtitle = document.querySelector('.ui-pdp-subtitle');
              if (subtitle) { const m = subtitle.textContent.match(/[\+]?(\d[\d.]*)\s*vendido/i); if (m) r.sales = parseInt(m[1].replace(/\./g, '')); }
              if (!r.sales) { const m2 = document.body.innerText.match(/[\+]?(\d[\d.]*)\s*vendidos?/i); if (m2) r.sales = parseInt(m2[1].replace(/\./g, '')); }
              if (subtitle) { if (/novo/i.test(subtitle.textContent)) r.condition = 'Novo'; else if (/usado/i.test(subtitle.textContent)) r.condition = 'Usado'; }
              const sellerEl = document.querySelector('.ui-pdp-seller__header__title, .ui-pdp-action__title');
              if (sellerEl) r.seller = sellerEl.textContent.trim().replace(/^vendido\s*por\s*/i, '');
              if (!r.seller) { const storeEl = document.querySelector('.ui-pdp-seller__link-trigger-button span, .eshops-title'); if (storeEl) r.seller = storeEl.textContent.trim().replace(/^vendido\s*por\s*/i, ''); }
              const shipContainers = document.querySelectorAll('.ui-pdp-media__body, .ui-pdp-shipping, [class*="shipping"], [class*="delivery"]');
              shipContainers.forEach(section => {
                const text = section.textContent;
                if (/frete|envio|chegar|entrega|shipping/i.test(text)) {
                  const greenEl = section.querySelector('.ui-pdp-color--GREEN, [class*="green"]');
                  if (greenEl && /gr[aá]tis/i.test(greenEl.textContent)) { r.freeShipping = true; r.shipping = greenEl.textContent.trim(); }
                  if (/frete\s*gr[aá]tis|envio\s*gr[aá]tis/i.test(text)) { r.freeShipping = true; if (!r.shipping) r.shipping = 'Frete gratis'; }
                  const costMatch = text.match(/R\$\s*(\d+[,.]?\d*)/);
                  if (costMatch) { const cost = parseFloat(costMatch[1].replace(',', '.')); if (!r.freeShipping && cost > 0) { r.shippingCost = cost; r.shipping = 'R$ ' + cost.toFixed(2); } }
                  if (/full/i.test(text)) r.fullfilment = true;
                }
              });
              const bodyHtml = document.body.innerHTML;
              const repMatch = bodyHtml.match(/MercadoL[ií]der\s*(Gold|Platinum|Silver)?/i);
              if (repMatch) r.sellerReputation = repMatch[0].trim();
              const bodyText = document.body.innerText;
              if (/premium/i.test(bodyText)) r.listingType = 'Premium';
              else if (/cl[aá]ssico/i.test(bodyText)) r.listingType = 'Classico';
              if (!r.fullfilment && /full/i.test(bodyText)) r.fullfilment = true;
              return r;
            });
            scraped = data.price > 0 || !!data.title;
          }
          await page.close();
        } catch (e) { console.log('Puppeteer scrape failed:', e.message); }
      }

      // Fallback: try ML API for item data
      if (!scraped && mlbId) {
        try {
          const { status, data: apiData } = await mlApiGet(`/items/${mlbId.replace(/-/g, '')}`);
          if (status === 200 && apiData.id) {
            data.title = apiData.title || '';
            data.price = apiData.price || 0;
            data.sales = apiData.sold_quantity || 0;
            data.condition = apiData.condition === 'new' ? 'Novo' : 'Usado';
            catalog = apiData.catalog_listing ? 'YES' : catalog;
            scraped = true;
          }
        } catch {}
      }

      const title = data.title || titleFromUrl || 'Produto ' + mlbId;
      res.writeHead(200, JSON_CORS);
      res.end(JSON.stringify({
        ok: true, id: mlbId, title, price: data.price || 0, sales: data.sales || 0, catalog, link: mlUrl,
        shipping: data.shipping || '', shippingCost: data.shippingCost || 0, freeShipping: data.freeShipping || false,
        seller: data.seller || '', sellerLocation: data.sellerLocation || '', sellerReputation: data.sellerReputation || '',
        publishedDays: data.publishedDays || 0, condition: data.condition || '', gtin: data.gtin || '',
        listingType: data.listingType || '', fullfilment: data.fullfilment || false, scraped,
      }));
    } catch (e) {
      res.writeHead(200, JSON_CORS);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // API: Item data via ML API
  if (url.pathname === '/api/item-data') {
    const itemId = (url.searchParams.get('id') || '').replace(/-/g, '');
    if (!itemId) { res.writeHead(400, JSON_CORS); res.end(JSON.stringify({ ok: false, error: 'id required' })); return; }
    try {
      const { status, data } = await mlApiGet(`/items/${itemId}`);
      if (status === 200 && data.id) {
        const soldQty = data.sold_quantity || 0;
        const dateCreated = data.date_created || data.start_time || '';
        let days = 0;
        if (dateCreated) days = Math.max(1, Math.round((Date.now() - new Date(dateCreated).getTime()) / 86400000));
        const salesPerDay = days > 0 ? soldQty / days : 0;
        const price = data.price || 0;
        res.writeHead(200, JSON_CORS);
        res.end(JSON.stringify({
          ok: true, source: 'items-api', id: data.id, title: data.title || '', price,
          soldTotal: soldQty, days, salesPerDay: +salesPerDay.toFixed(2), salesPerMonth: Math.round(salesPerDay * 30),
          revenuePerDay: Math.round(salesPerDay * price), revenuePerMonth: Math.round(salesPerDay * 30 * price),
          dateCreated, condition: data.condition || '', listingType: data.listing_type_id || '',
          categoryId: data.category_id || '', sellerId: data.seller_id || '', thumbnail: data.thumbnail || '',
          permalink: data.permalink || '', status: data.status || '',
        }));
        return;
      }
      res.writeHead(200, JSON_CORS);
      res.end(JSON.stringify({ ok: false, error: 'Item not found (status ' + status + ')' }));
    } catch (e) { res.writeHead(500, JSON_CORS); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // API: Token status
  if (url.pathname === '/api/status') {
    const token = getToken();
    if (!token) { res.writeHead(200, JSON_CORS); res.end(JSON.stringify({ ok: false, msg: 'Sem token ML' })); return; }
    try {
      const { status, data } = await mlApiGet('/users/me');
      res.writeHead(200, JSON_CORS);
      res.end(JSON.stringify({ ok: status === 200, nickname: data.nickname, user_id: data.id, msg: status !== 200 ? 'Token invalido' : '' }));
    } catch (e) { res.writeHead(200, JSON_CORS); res.end(JSON.stringify({ ok: false, msg: e.message })); }
    return;
  }

  // API: Renew token via refresh
  if (url.pathname === '/api/renew-token') {
    const appId = getAppId();
    const secret = getSecret();
    const rt = getRefreshToken();
    if (!rt || !appId || !secret) {
      res.writeHead(200, JSON_CORS);
      res.end(JSON.stringify({ ok: false, msg: 'ML_REFRESH_TOKEN, ML_APP_ID ou ML_SECRET_KEY nao configurado' }));
      return;
    }
    try {
      const tokenData = await new Promise((resolve, reject) => {
        const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: appId, client_secret: secret, refresh_token: rt }).toString();
        const r = https.request({
          hostname: 'api.mercadolibre.com', path: '/oauth/token', method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Accept: 'application/json' },
        }, resp => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); });
        r.on('error', reject);
        r.setTimeout(10000, () => { r.destroy(); reject(new Error('Timeout')); });
        r.write(body); r.end();
      });
      if (tokenData.access_token) {
        process.env.ML_ACCESS_TOKEN = tokenData.access_token;
        if (tokenData.refresh_token) process.env.ML_REFRESH_TOKEN = tokenData.refresh_token;
        res.writeHead(200, JSON_CORS);
        res.end(JSON.stringify({ ok: true, renewed: true, msg: 'Token renovado!' }));
      } else {
        res.writeHead(200, JSON_CORS);
        res.end(JSON.stringify({ ok: false, msg: 'Falha ao renovar token' }));
      }
    } catch (e) { res.writeHead(200, JSON_CORS); res.end(JSON.stringify({ ok: false, msg: e.message })); }
    return;
  }

  // API: My items
  if (url.pathname === '/api/my-items') {
    try {
      const { data: me } = await mlApiGet('/users/me');
      if (!me?.id) throw new Error('Token invalido');
      let allIds = [], offset = 0;
      while (true) {
        const { data: search } = await mlApiGet(`/users/${me.id}/items/search?limit=50&offset=${offset}`);
        if (!search?.results?.length) break;
        allIds = allIds.concat(search.results);
        if (allIds.length >= (search.paging?.total || 0)) break;
        offset += 50;
      }
      const items = [];
      for (let i = 0; i < allIds.length; i += 20) {
        const batch = allIds.slice(i, i + 20);
        const { data: multiData } = await mlApiGet(`/items?ids=${batch.join(',')}`);
        if (Array.isArray(multiData)) {
          multiData.forEach(entry => {
            const d = entry.body;
            if (!d || d.error) return;
            const startDate = new Date(d.start_time);
            const daysSincePublished = Math.max(1, Math.floor((Date.now() - startDate.getTime()) / 86400000));
            items.push({
              id: d.id, title: d.title, price: d.price, soldTotal: d.sold_quantity || 0, days: daysSincePublished,
              status: d.status, condition: d.condition, permalink: d.permalink,
              catalog: d.catalog_listing ? 'YES' : 'NO', listingType: d.listing_type_id,
              gtin: d.attributes?.find(a => a.id === 'GTIN')?.value_name || '',
            });
          });
        }
      }
      for (const item of items) {
        try {
          const { data: vd } = await mlApiGet(`/items/${item.id}/visits/time_window?last=30&unit=day`);
          item.visits30d = vd?.total_visits || 0;
          if (Array.isArray(vd?.results)) item.visits30d = vd.results.reduce((s, r) => s + (r.total || 0), 0);
        } catch { item.visits30d = 0; }
      }
      res.writeHead(200, JSON_CORS);
      res.end(JSON.stringify({ ok: true, count: items.length, items }));
    } catch (e) { res.writeHead(500, JSON_CORS); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // API: Visits
  if (url.pathname === '/api/visits') {
    const itemId = url.searchParams.get('id');
    if (!itemId) { res.writeHead(400, JSON_CORS); res.end(JSON.stringify({ ok: false, error: 'Missing id' })); return; }
    try {
      const { data } = await mlApiGet(`/items/${itemId}/visits/time_window?last=30&unit=day`);
      let totalVisits = 0;
      if (Array.isArray(data?.results)) totalVisits = data.results.reduce((s, r) => s + (r.total || 0), 0);
      else if (typeof data?.total_visits === 'number') totalVisits = data.total_visits;
      const itemResp = await mlApiGet(`/items/${itemId}`);
      const soldQty = itemResp.data?.sold_quantity || 0;
      const conversion = totalVisits > 0 ? ((soldQty / totalVisits) * 100) : 0;
      res.writeHead(200, JSON_CORS);
      res.end(JSON.stringify({ ok: true, id: itemId, totalVisits, visitsPerDay: Math.round(totalVisits / 30), soldQty, conversion: +conversion.toFixed(2) }));
    } catch (e) { res.writeHead(500, JSON_CORS); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // API: Save/Load products (temp file on cloud)
  if (url.pathname === '/api/products/save' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const products = JSON.parse(body);
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2), 'utf8');
        res.writeHead(200, JSON_CORS);
        res.end(JSON.stringify({ ok: true, count: products.length }));
      } catch (e) { res.writeHead(500, JSON_CORS); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  if (url.pathname === '/api/products/load') {
    try {
      if (fs.existsSync(PRODUCTS_FILE)) {
        res.writeHead(200, JSON_CORS);
        res.end(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
      } else {
        res.writeHead(200, JSON_CORS);
        res.end('[]');
      }
    } catch (e) { res.writeHead(500, JSON_CORS); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`PreciFy Cloud rodando na porta ${PORT}`);
  console.log(`Token ML: ${getToken() ? 'OK' : 'NAO CONFIGURADO (configure ML_ACCESS_TOKEN nas env vars)'}`);
  console.log(`Puppeteer: ${puppeteer ? 'OK' : 'NAO DISPONIVEL'}`);
});
