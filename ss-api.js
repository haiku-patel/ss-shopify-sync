import { CONFIG } from './config.js';

class SSActiveWearAPI {
  constructor() {
    this.baseUrl     = 'https://api.ssactivewear.com';
    this.username    = CONFIG.ssActivewear.username;
    this.password    = CONFIG.ssActivewear.password;
    this.credentials = btoa(`${this.username}:${this.password}`);
    console.log(`✅ SS Activewear credentials set (Account: ${this.username})`);
  }

  async makeRequest(endpoint, options = {}) {
    // Re-read credentials fresh from env on every request in case .env changed between runs
    this.credentials = btoa(`${process.env.SS_USERNAME?.trim()}:${process.env.SS_PASSWORD?.trim()}`);

    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Basic ${this.credentials}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (response.status === 401) throw new Error('SS Activewear: Invalid credentials (401)');
    if (response.status === 404) return null;
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SS API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  // ─── Styles API ───────────────────────────────────────────────────────────────
  // Lightweight — returns text metadata only (no images), safe to fetch all at once.

  async getAllStyles() {
    console.log('🔄 Fetching all SS Activewear styles...');
    const data = await this.makeRequest('/v2/styles/');
    console.log(`✅ Found ${data?.length || 0} styles`);
    return data || [];
  }

  // Returns Map<styleID (integer), styleObject> for O(1) lookup.
  async getStyleMap() {
    const styles = await this.getAllStyles();
    const map = new Map();
    for (const s of styles) map.set(s.styleID, s);
    return map;
  }

  // Fetch style data for a specific set of IDs (used in partial/SKU syncs).
  async getStylesByIds(styleIds) {
    if (!styleIds.length) return new Map();
    const data = await this.makeRequest(`/v2/styles/?styleid=${styleIds.join(',')}`);
    const map = new Map();
    for (const s of (data || [])) map.set(s.styleID, s);
    return map;
  }

  // ─── Products API ─────────────────────────────────────────────────────────────

  // Fetch all SKU rows for a batch of style IDs.
  // This is the core building block for the chunked full-catalog fetch.
  async getProductsByStyleIds(styleIds) {
    if (!styleIds.length) return [];
    const data = await this.makeRequest(`/v2/products/?styleid=${styleIds.join(',')}`);
    return data || [];
  }

  // Fetch SKU rows for specific SKUs (used in partial sync).
  async getProductsBySkus(skus) {
    if (!skus.length) return [];
    const data = await this.makeRequest(`/v2/products/${skus.join(',')}`);
    return data || [];
  }

  async getProduct(sku) {
    return this.makeRequest(`/v2/products/${sku}`);
  }

  // ─── Chunked full-catalog fetch ───────────────────────────────────────────────
  //
  // /v2/products/ returns 1 GB+ unfiltered — never call it without a styleid filter.
  //
  // Strategy:
  //   1. Fetch all styles (lightweight text-only response, ~a few MB)
  //   2. Chunk style IDs into groups of `chunkSize`
  //   3. For each chunk: GET /v2/products/?styleid=id1,id2,...
  //
  // The styleMap is passed to every onBatch call so the transformer can look up
  // the HTML description, baseCategory, etc. without extra API calls.
  //
  // Callback signature: onBatch(skuRows, styleMap, chunkIndex, totalChunks)

  async fetchAllProductsInChunks(onBatch, chunkSize = CONFIG.sync.styleBatchSize) {
    const styleMap = await this.getStyleMap();
    const styleIds = [...styleMap.keys()];

    if (!styleIds.length) {
      console.warn('⚠️  No styles returned from SS Activewear');
      return;
    }

    const totalChunks = Math.ceil(styleIds.length / chunkSize);
    console.log(`\n📦 ${styleIds.length} styles → ${totalChunks} chunk(s) of up to ${chunkSize}`);

    for (let i = 0; i < styleIds.length; i += chunkSize) {
      const chunk      = styleIds.slice(i, i + chunkSize);
      const chunkIndex = Math.floor(i / chunkSize) + 1;

      console.log(`\n🔄 Chunk ${chunkIndex}/${totalChunks} — styles ${i + 1}–${Math.min(i + chunkSize, styleIds.length)}`);

      try {
        const products = await this.getProductsByStyleIds(chunk);
        console.log(`   ↳ ${products.length} SKU row(s) returned`);
        await onBatch(products, styleMap, chunkIndex, totalChunks);
      } catch (err) {
        console.error(`   ❌ Chunk ${chunkIndex} failed: ${err.message}`);
      }

      await sleep(CONFIG.sync.requestDelay);
    }

    console.log('\n✅ All chunks processed');
  }

  // ─── Connection test ──────────────────────────────────────────────────────────
  // Fetches a single known style (Gildan 2000) — lightweight, fast, verifies auth.

  async testConnection() {
    console.log('🧪 Testing SS Activewear connection...');
    const data = await this.makeRequest('/v2/styles/?styleid=39');
    if (data?.length) {
      console.log(`✅ SS Activewear connected — sample style: ${data[0].brandName} ${data[0].title}`);
      return true;
    }
    throw new Error('SS Activewear: unexpected empty response on connection test');
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export { SSActiveWearAPI };
