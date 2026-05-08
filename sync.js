import { SSActiveWearAPI }   from './ss-api.js';
import { ShopifyAPI }        from './shopify-api.js';
import { InventoryManager }  from './inventory.js';
import { CollectionManager } from './collections.js';
import { CONFIG }            from './config.js';
import { writeSeoMetafields } from './seo.js';
import {
  shouldExcludeProduct,
  groupByStyle,
  groupByColor,
  transformStyleToShopifyProduct,
  diffProduct,
  ssImageUrl,
} from './transformer.js';

// Shopify REST API hard limit — styles with more variants are split by color
const MAX_REST_VARIANTS = 100;

class ProductSync {
  constructor() {
    this.ssApi       = new SSActiveWearAPI();
    this.shopify     = new ShopifyAPI();
    this.inventory   = null;
    this.collections = null;
    this.shop        = null;

    this.stats = {
      created: 0, updated: 0, noChange: 0, removed: 0,
      skippedDropship: 0, skippedOutOfStock: 0,
      errors: 0, chunksProcessed: 0,
    };

    // Key is either:
    //   styleId (number)            — styles with ≤100 variants (one product per style)
    //   "styleId:colorKey" (string) — styles split by color (one product per color group)
    this.existingProductMap = new Map();
    this.seenProductKeys    = new Set();
  }

  // ─── Public entry points ──────────────────────────────────────────────────

  async fullSync() {
    console.log('\n🚀 ═══════════════════════════════════');
    console.log('   SS Activewear → Shopify FULL SYNC');
    console.log('═══════════════════════════════════\n');

    await this._init();
    await this._loadExistingShopifyProducts();

    await this.ssApi.fetchAllProductsInChunks(
      async (skuRows, styleMap, chunkIndex, total) => {
        await this._processChunk(skuRows, styleMap, chunkIndex, total);
        this.stats.chunksProcessed++;
      }
    );

    await this._removeStaleListings();
    this._printStats();
  }

  async syncSkus(skus) {
    console.log(`\n🔄 Partial sync for ${skus.length} SKU(s)...`);
    await this._init();
    await this._loadExistingShopifyProducts();

    const rows = await this.ssApi.getProductsBySkus(skus);
    if (!rows.length) {
      console.log('⚠️  No products returned for given SKUs');
      return;
    }

    const styleIds = [...new Set(rows.map(r => r.styleID))];
    const styleMap = await this.ssApi.getStylesByIds(styleIds);

    await this._processChunk(rows, styleMap, 1, 1);
    this._printStats();
  }

  // ─── Initialisation ───────────────────────────────────────────────────────

  async _init() {
    this.shop        = await this.shopify.testConnection();
    this.inventory   = await new InventoryManager(this.shopify).init();
    this.collections = await new CollectionManager(this.shopify).init();
  }

  // ─── Load existing Shopify products ──────────────────────────────────────
  // Recognises two tag formats:
  //   ss-style:7269            → regular product  (number key)
  //   ss-style:7269:White      → split-by-color   (string key "7269:White")

  async _loadExistingShopifyProducts() {
    console.log('\n📥 Loading existing Shopify products...');
    const products = await this.shopify.getAllProducts();
    let duplicatesFound = 0;

    for (const p of products) {
      const tags     = (p.tags || '').split(',').map(t => t.trim());
      const styleTag = tags.find(t => t.startsWith('ss-style:'));
      if (!styleTag) continue;

      const parts   = styleTag.split(':');
      const styleId = parseInt(parts[1]);
      if (isNaN(styleId)) continue;

      const key = parts.length >= 3
        ? `${styleId}:${parts.slice(2).join(':')}`
        : styleId;

      if (this.existingProductMap.has(key)) {
        duplicatesFound++;
        console.warn(`   ⚠️  Duplicate ${styleTag} — keeping ${this.existingProductMap.get(key)}, ignoring ${p.id}`);
      } else {
        this.existingProductMap.set(key, p.id);
      }
    }

    console.log(`   ✅ ${this.existingProductMap.size} SS-linked product(s) mapped`);
    if (duplicatesFound) console.warn(`   ⚠️  ${duplicatesFound} duplicate(s) found — delete manually in Shopify admin`);
  }

  // ─── Chunk processing ─────────────────────────────────────────────────────

  async _processChunk(skuRows, styleMap, chunkIndex, totalChunks) {
    const byStyle = groupByStyle(skuRows);
    console.log(`\n📦 Chunk ${chunkIndex}/${totalChunks}: ${byStyle.size} style(s)`);

    const styleEntries = [...byStyle.entries()];
    for (let i = 0; i < styleEntries.length; i += CONFIG.sync.shopifyBatchSize) {
      const batch = styleEntries.slice(i, i + CONFIG.sync.shopifyBatchSize);
      await Promise.allSettled(
        batch.map(([styleId, rows]) => this._processStyle(styleId, rows, styleMap))
      );
    }
  }

  // ─── Per-style logic ──────────────────────────────────────────────────────

  async _processStyle(styleId, rows, styleMap) {
    try {
      const sample = rows[0];
      console.log(`\n   🔍 Style ${styleId} | ${sample?.brandName} ${sample?.styleName} | ${rows.length} SKU(s)`);

      // Step 1: filter excluded SKUs
      const validRows = [];
      let dropshipCount = 0, oosCount = 0;
      for (const row of rows) {
        const { exclude, reason } = shouldExcludeProduct(row);
        if (exclude) {
          if (reason === 'dropship-only') { this.stats.skippedDropship++; dropshipCount++; }
          else                            { this.stats.skippedOutOfStock++; oosCount++; }
        } else {
          validRows.push(row);
        }
      }

      if (dropshipCount || oosCount) {
        console.log(`      ⏭️  Excluded: ${dropshipCount} dropship-only, ${oosCount} out-of-stock → ${validRows.length} valid SKU(s)`);
      }

      if (!validRows.length) {
        console.log(`      ⚠️  All SKUs excluded — removing listing if it exists`);
        for (const key of this._getStyleKeys(styleId)) {
          await this._removeProductByKey(key, rows[0]);
        }
        return;
      }

      const styleData = styleMap?.get(styleId) || null;

      // Step 2: split by color when variants > REST API limit of 100
      if (validRows.length > MAX_REST_VARIANTS) {
        console.log(`   ✂️  Style ${styleId}: ${validRows.length} variants — splitting by color`);
        const colorGroups = groupByColor(validRows);
        for (const [colorName, colorRows] of colorGroups) {
          const colorKey = sanitizeColorKey(colorName);
          const key      = `${styleId}:${colorKey}`;
          this.seenProductKeys.add(key);
          if (this.existingProductMap.has(key)) {
            await this._diffAndUpdate(key, colorRows, styleData, colorName);
          } else {
            await this._createProduct(key, colorRows, styleData, colorName);
          }
        }
        return;
      }

      // Step 3: regular single-product path
      this.seenProductKeys.add(styleId);
      if (this.existingProductMap.has(styleId)) {
        await this._diffAndUpdate(styleId, validRows, styleData);
      } else {
        await this._createProduct(styleId, validRows, styleData);
      }

    } catch (err) {
      const s = rows[0];
      console.error(`   ❌ Style ${styleId} (${s?.brandName} ${s?.styleName}): ${err.message}`);
      this.stats.errors++;
    }
  }

  // ─── Create ───────────────────────────────────────────────────────────────

  async _createProduct(key, rows, styleData, colorName = null) {
    const sample = rows[0];
    const { product, variantMeta } = transformStyleToShopifyProduct(rows, styleData);

    const { styleId, colorKey } = parseProductKey(key);
    const ssTag = colorKey ? `ss-style:${styleId}:${colorKey}` : `ss-style:${styleId}`;
    product.tags += `,${ssTag}`;

    if (colorName) product.title += ` - ${colorName}`;
    product.status = 'draft';

    console.log(`\n   ✨ Creating: "${product.title}"`);
    console.log(`      Variants: ${product.variants.length} | Tags: ${product.tags.slice(0, 100)}…`);

    let response;
    try {
      response = await this.shopify.createProduct(product);
    } catch (err) {
      console.error(`   ❌ Shopify rejected "${product.title}": ${err.message}`);
      this.stats.errors++;
      return;
    }

    const created = response.product;
    if (!created) {
      console.error(`   ❌ Create failed — no product in response: ${JSON.stringify(response).slice(0, 300)}`);
      this.stats.errors++;
      return;
    }

    console.log(`      ✅ Created → Shopify ID: ${created.id}`);
    this.existingProductMap.set(key, created.id);

    console.log(`      📦 Setting inventory...`);
    await this.inventory.setInventoryForProduct(created.variants, variantMeta);

    console.log(`      🖼️  Uploading images...`);
    await this._syncImages(created.id, created.variants, rows);

    console.log(`      📂 Assigning collections...`);
    await this.collections.assignProduct(created.id, sample.brandName, sample.colorFamily, styleData?.baseCategory);

    console.log(`      📢 Publishing to sales channels...`);
    await this.shopify.publishToAllChannels(created.id);

    console.log(`      🔍 Writing SEO metafields...`);
    const fullProduct = await this.shopify.getProductById(created.id);
    await writeSeoMetafields(this.shopify, created.id, rows, styleData, fullProduct, this.shop);

    this.stats.created++;
  }

  // ─── Diff-and-update ──────────────────────────────────────────────────────

  async _diffAndUpdate(key, rows, styleData, colorName = null) {
    const shopifyProductId = this.existingProductMap.get(key);

    const existing = await this.shopify.getProductById(shopifyProductId);
    if (!existing) {
      this.existingProductMap.delete(key);
      return this._createProduct(key, rows, styleData, colorName);
    }

    const { freshProduct, variantMeta } = (() => {
      const { product, variantMeta } = transformStyleToShopifyProduct(rows, styleData);
      if (colorName) product.title += ` - ${colorName}`;
      return { freshProduct: product, variantMeta };
    })();

    const existingInventoryMap = await this._loadInventoryMap(existing.variants);
    const { productChanged, variantChanges, inventoryChanges } =
      diffProduct(existing, freshProduct, variantMeta, existingInventoryMap);

    const hasVariantWork =
      variantChanges.toAdd.length > 0 ||
      variantChanges.toUpdate.length > 0 ||
      variantChanges.toDelete.length > 0;

    const hasInventoryWork = inventoryChanges.length > 0;

    if (!productChanged && !hasVariantWork && !hasInventoryWork) {
      // Still sync any missing images (e.g. new angles added to transformer)
      await this._syncImages(shopifyProductId, existing.variants, rows);
      console.log(`   ✅ No change: ${existing.title}`);
      this.stats.noChange++;
      return;
    }

    const changes = [];
    if (productChanged)                  changes.push('product fields');
    if (variantChanges.toAdd.length)     changes.push(`+${variantChanges.toAdd.length} variants`);
    if (variantChanges.toUpdate.length)  changes.push(`~${variantChanges.toUpdate.length} variants`);
    if (variantChanges.toDelete.length)  changes.push(`-${variantChanges.toDelete.length} variants`);
    if (hasInventoryWork)                changes.push(`${inventoryChanges.length} inventory`);
    console.log(`   🔄 Updating: ${existing.title} [${changes.join(', ')}]`);

    const sample = rows[0];
    await this.collections.assignProduct(shopifyProductId, sample.brandName, sample.colorFamily, styleData?.baseCategory);
    await this.shopify.publishToAllChannels(shopifyProductId);

    if (productChanged) {
      const { styleId, colorKey } = parseProductKey(key);
      const ssTag = colorKey ? `ss-style:${styleId}:${colorKey}` : `ss-style:${styleId}`;
      await this.shopify.updateProduct(shopifyProductId, {
        title:              freshProduct.title,
        body_html:          freshProduct.body_html,
        vendor:             freshProduct.vendor,
        product_type:       freshProduct.product_type,
        tags:               normaliseTags(freshProduct.tags) + `,${ssTag}`,
        taxonomyCategoryId: freshProduct.taxonomyCategoryId,
      });
    }

    if (hasVariantWork) {
      await this._applyVariantChanges(shopifyProductId, variantChanges);
    }

    if (hasInventoryWork && this.inventory.inventoryEnabled) {
      await this._applyInventoryChanges(inventoryChanges);
    }

    // Sync images — uploads any missing angles or images for newly added colors
    await this._syncImages(shopifyProductId, existing.variants, rows);

    if (productChanged) {
      const latestProduct = await this.shopify.getProductById(shopifyProductId);
      await writeSeoMetafields(this.shopify, shopifyProductId, rows, styleData, latestProduct, this.shop);
    }

    this.stats.updated++;
  }

  // ─── Inventory loading helper ──────────────────────────────────────────────

  async _loadInventoryMap(variants) {
    const map = new Map();
    if (!this.inventory.inventoryEnabled || !this.inventory.primaryLocationId) return map;

    const trackingLocationId = this.inventory.usWarehouseId || this.inventory.primaryLocationId;
    const itemIds = variants.filter(v => v.inventory_item_id).map(v => v.inventory_item_id);
    if (!itemIds.length) return map;

    const CHUNK = 50;
    for (let i = 0; i < itemIds.length; i += CHUNK) {
      try {
        const levels = await this.shopify.getInventoryLevels(itemIds.slice(i, i + CHUNK));
        for (const level of levels) {
          if (level.location_id === trackingLocationId) {
            map.set(level.inventory_item_id, level.available ?? null);
          }
        }
      } catch (_) { /* non-fatal — treat as unchanged */ }
    }
    return map;
  }

  // ─── Apply variant changes ─────────────────────────────────────────────────

  async _applyVariantChanges(productId, { toAdd, toUpdate, toDelete }) {
    for (const v of toAdd) {
      try {
        await this.shopify.createVariant(productId, v);
        console.log(`     ➕ Added variant: ${v.sku}`);
      } catch (err) {
        console.error(`     ⚠️  Add variant ${v.sku}: ${err.message}`);
      }
    }

    for (const { existing, fresh, changed } of toUpdate) {
      try {
        await this.shopify.updateVariant(existing.id, changed);
        console.log(`     ✏️  Updated ${existing.sku}: ${Object.keys(changed).join(', ')}`);
      } catch (err) {
        console.error(`     ⚠️  Update variant ${existing.sku}: ${err.message}`);
      }
    }

    for (const v of toDelete) {
      try {
        await this.shopify.deleteVariant(productId, v.id);
        console.log(`     🗑️  Removed discontinued variant: ${v.sku}`);
      } catch (err) {
        console.error(`     ⚠️  Delete variant ${v.sku}: ${err.message}`);
      }
    }
  }

  // ─── Apply inventory changes ───────────────────────────────────────────────

  async _applyInventoryChanges(inventoryChanges) {
    const targetLocationId = this.inventory.usWarehouseId || this.inventory.primaryLocationId;

    await Promise.allSettled(
      inventoryChanges.map(async ({ sku, inventoryItemId, oldQty, newQty }) => {
        try {
          await this.shopify.setInventoryLevel(targetLocationId, inventoryItemId, newQty);
          console.log(`     📦 Inventory ${sku}: ${oldQty ?? '?'} → ${newQty}`);
        } catch (err) {
          console.error(`     ⚠️  Inventory update ${sku}: ${err.message}`);
        }
      })
    );
  }

  // ─── Images ───────────────────────────────────────────────────────────────
  //
  // Uploads ALL available image angles for each color:
  //   - Front image  → linked to the color's variant IDs (drives Shopify color swatch)
  //   - Side, Back, Direct Side, On-Model Front/Side/Back → no variant link
  //
  // Dedup: if ANY image with a color's alt text already exists on the product,
  // that color is skipped entirely to avoid duplicate uploads on re-runs.

  async _syncImages(productId, shopifyVariants, ssRows) {
    // Map color name → variant IDs so the front image links to the right swatch
    const colorVariantMap = new Map();
    for (const variant of shopifyVariants) {
      const color = variant.option1;
      if (!colorVariantMap.has(color)) colorVariantMap.set(color, []);
      colorVariantMap.get(color).push(variant.id);
    }

    // Fetch existing images and collect alt texts to skip already-uploaded colors
    let existingAlts = new Set();
    try {
      const existing = await this.shopify.getProductImages(productId);
      for (const img of existing) {
        if (img.alt) existingAlts.add(img.alt);
      }
    } catch (_) { /* non-fatal */ }

    const seenUrls   = new Set();
    const uploads    = [];
    const seenColors = new Set();

    for (const row of ssRows) {
      if (seenColors.has(row.colorName)) continue;
      seenColors.add(row.colorName);

      const variantIds = colorVariantMap.get(row.colorName) || [];
      const alt        = `${row.brandName} ${row.styleName} - ${row.colorName}`;

      // Skip this color if images are already on Shopify
      if (existingAlts.has(alt)) continue;

      // Front image — linked to variant IDs for color swatch matching
      const frontSrc = ssImageUrl(row.colorFrontImage, 'fl');
      if (frontSrc && !seenUrls.has(frontSrc)) {
        seenUrls.add(frontSrc);
        uploads.push({ src: frontSrc, alt, variantIds });
      }

      // Additional angles — no variant link needed
      const extraPaths = [
        row.colorSideImage,
        row.colorBackImage,
        row.colorDirectSideImage,
        row.colorOnModelFrontImage,
        row.colorOnModelSideImage,
        row.colorOnModelBackImage,
      ];
      for (const imgPath of extraPaths) {
        const src = ssImageUrl(imgPath, 'fl');
        if (!src || seenUrls.has(src)) continue;
        seenUrls.add(src);
        uploads.push({ src, alt, variantIds: [] });
      }
    }

    if (!uploads.length) {
      console.log(`      🖼️  Images already up to date`);
      return;
    }

    await Promise.allSettled(
      uploads.map(({ src, alt, variantIds }) =>
        this.shopify.addProductImage(productId, src, alt, variantIds)
          .catch(err => console.error(`     ⚠️  Image upload: ${err.message}`))
      )
    );
    console.log(`      🖼️  Uploaded ${uploads.length} image(s)`);
  }

  // ─── Removal ──────────────────────────────────────────────────────────────

  async _removeProductByKey(key, sampleRow) {
    const shopifyProductId = this.existingProductMap.get(key);
    if (!shopifyProductId) return;
    console.log(`   🗑️  Removing: ${sampleRow?.brandName} ${sampleRow?.styleName}`);
    try {
      await this.shopify.deleteProduct(shopifyProductId);
      this.existingProductMap.delete(key);
      this.stats.removed++;
    } catch (err) {
      console.error(`   ❌ Remove failed: ${err.message}`);
      this.stats.errors++;
    }
  }

  _getStyleKeys(styleId) {
    const keys = [];
    for (const key of this.existingProductMap.keys()) {
      if (key === styleId || (typeof key === 'string' && key.startsWith(`${styleId}:`))) {
        keys.push(key);
      }
    }
    return keys;
  }

  async _removeStaleListings() {
    const staleKeys = [...this.existingProductMap.keys()].filter(
      k => !this.seenProductKeys.has(k)
    );

    if (!staleKeys.length) {
      console.log('\n✅ No stale listings to remove');
      return;
    }

    console.log(`\n🗑️  Removing ${staleKeys.length} stale listing(s)...`);
    for (const key of staleKeys) {
      const productId = this.existingProductMap.get(key);
      try {
        await this.shopify.deleteProduct(productId);
        console.log(`   Removed product ${productId} (key: ${key})`);
        this.stats.removed++;
      } catch (err) {
        console.error(`   ❌ Failed to remove ${productId}: ${err.message}`);
        this.stats.errors++;
      }
    }
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  _printStats() {
    console.log('\n╔══════════════════════════════════╗');
    console.log('║         Sync Complete!           ║');
    console.log('╠══════════════════════════════════╣');
    console.log(`║  ✨ Created:              ${String(this.stats.created).padStart(5)} ║`);
    console.log(`║  🔄 Updated:              ${String(this.stats.updated).padStart(5)} ║`);
    console.log(`║  ✅ No change:            ${String(this.stats.noChange).padStart(5)} ║`);
    console.log(`║  🗑️  Removed:              ${String(this.stats.removed).padStart(5)} ║`);
    console.log(`║  ⏭️  Skipped (dropship):   ${String(this.stats.skippedDropship).padStart(5)} ║`);
    console.log(`║  ⏭️  Skipped (OOS):        ${String(this.stats.skippedOutOfStock).padStart(5)} ║`);
    console.log(`║  ❌ Errors:               ${String(this.stats.errors).padStart(5)} ║`);
    console.log('╚══════════════════════════════════╝\n');
  }
}

// ─── Module-level helpers ──────────────────────────────────────────────────────

function normaliseTags(tagsStr) {
  return (tagsStr || '').split(',').map(t => t.trim()).filter(Boolean).sort().join(',');
}

function parseProductKey(key) {
  if (typeof key === 'number') return { styleId: key, colorKey: null };
  const str = String(key);
  const idx = str.indexOf(':');
  return { styleId: parseInt(str.slice(0, idx)), colorKey: str.slice(idx + 1) };
}

function sanitizeColorKey(colorName) {
  return colorName
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export { ProductSync };
