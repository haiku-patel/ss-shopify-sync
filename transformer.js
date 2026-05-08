import { CONFIG } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// SS Activewear → Shopify product transformer
//
// SS returns a FLAT list of SKU objects (one row per color+size combination).
// Shopify wants products grouped by style with:
//   Option1 = Color
//   Option2 = Size
//   One variant per color+size pair
// ─────────────────────────────────────────────────────────────────────────────


// ─── Shopify taxonomy category mapping ───────────────────────────────────────
// Maps SS baseCategory → Shopify standard taxonomy GID.
// Edit values here if Shopify rejects an ID — IDs come from Shopify's public
// taxonomy: https://shopify.github.io/product-taxonomy/

const CATEGORY_MAP = {
  'T-Shirts - Core':         'gid://shopify/TaxonomyCategory/aa-1-13-8',   // Clothing > Shirts & Tops > T-Shirts
  'T-Shirts - Long Sleeve':  'gid://shopify/TaxonomyCategory/aa-1-13-8',   // Clothing > Shirts & Tops > T-Shirts
  'T-Shirts - Premium':      'gid://shopify/TaxonomyCategory/aa-1-13-8',   // Clothing > Shirts & Tops > T-Shirts
  'Fleece - Core - Crew':    'gid://shopify/TaxonomyCategory/aa-1-13-14',  // Clothing > Shirts & Tops > Sweatshirts
  'Fleece - Core - Hood':    'gid://shopify/TaxonomyCategory/aa-1-13-13',  // Clothing > Shirts & Tops > Hoodies
  'Fleece - Premium - Crew': 'gid://shopify/TaxonomyCategory/aa-1-13-14',  // Clothing > Shirts & Tops > Sweatshirts
  'Fleece - Premium - Hood': 'gid://shopify/TaxonomyCategory/aa-1-13-13',  // Clothing > Shirts & Tops > Hoodies
  'Polos':                   'gid://shopify/TaxonomyCategory/aa-1-13-6',   // Clothing > Shirts & Tops > Polo Shirts
  'Headwear':                'gid://shopify/TaxonomyCategory/aa-2-17',     // Clothing Accessories > Hats
  'Bottoms':                 'gid://shopify/TaxonomyCategory/aa-1-1-1',    // Activewear > Activewear Pants
  'Outerwear':               'gid://shopify/TaxonomyCategory/aa-1-10',     // Clothing > Outerwear
  'Knits & Layering':        'gid://shopify/TaxonomyCategory/aa-1-13-12',  // Clothing > Shirts & Tops > Sweaters
  'Wovens':                  'gid://shopify/TaxonomyCategory/aa-1-13-7',   // Clothing > Shirts & Tops > Woven Shirts
  'Accessories':             'gid://shopify/TaxonomyCategory/aa-2',        // Clothing Accessories
  'Bags':                    'gid://shopify/TaxonomyCategory/lb',          // Luggage & Bags
};

// ─── Filtering ────────────────────────────────────────────────────────────────

/**
 * Determines whether a single SKU row should be EXCLUDED from the store.
 *
 * Rule 1 — DROPSHIP-ONLY:
 *   Every warehouse entry for this SKU has dropship=true.
 *   SS has no physical stock to ship — never listed.
 *
 * Rule 2 — OUT-OF-STOCK:
 *   Total qty across ALL non-dropship warehouses is zero.
 *   A SKU with mixed dropship + at least one regular in-stock warehouse IS included.
 *
 * Rule 3 — NO WAREHOUSE DATA:
 *   No warehouse array → treat as unavailable.
 */
function shouldExcludeProduct(skuRow) {
  const warehouses = skuRow.warehouses || [];

  if (warehouses.length === 0) return { exclude: true, reason: 'out-of-stock' };

  const regularWarehouses = warehouses.filter(w => w.dropship !== true);
  if (regularWarehouses.length === 0) return { exclude: true, reason: 'dropship-only' };

  const totalRegularQty = regularWarehouses.reduce((sum, w) => sum + (w.qty || 0), 0);
  if (totalRegularQty === 0) return { exclude: true, reason: 'out-of-stock' };

  return { exclude: false };
}


// ─── Pricing ──────────────────────────────────────────────────────────────────

function calculatePrice(customerPrice) {
  const base = parseFloat(customerPrice) || 0;
  return (base * CONFIG.sync.priceMarkupMultiplier).toFixed(2);
}


// ─── Image URLs ───────────────────────────────────────────────────────────────

/**
 * Converts an SS image path to a full absolute URL at the requested size.
 *
 * SS path format: "Images/Color/17130_f_fm.jpg"
 * Sizes: _fm (medium), _fl (large), _fs (small)
 */
function ssImageUrl(path, size = 'fl') {
  if (!path) return null;
  const normalised = path.includes('_fm') ? path.replace('_fm', `_${size}`) : path;
  return `https://www.ssactivewear.com/${normalised}`;
}


// ─── Grouping helpers ─────────────────────────────────────────────────────────

function groupByStyle(skuRows) {
  const map = new Map();
  for (const row of skuRows) {
    const id = row.styleID;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}

function groupByColor(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.colorName)) map.set(row.colorName, []);
    map.get(row.colorName).push(row);
  }
  return map;
}

function getColors(rows) {
  const seen = new Set();
  const colors = [];
  for (const r of rows) {
    if (!seen.has(r.colorName)) {
      seen.add(r.colorName);
      colors.push(r.colorName);
    }
  }
  return colors;
}

function getSizes(rows) {
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.sizeName)) seen.set(r.sizeName, r.sizeOrder || 'ZZ');
  }
  return [...seen.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([size]) => size);
}


// ─── Description ──────────────────────────────────────────────────────────────

function buildDescription(rows, styleData) {
  const sample = rows[0];
  const colors = getColors(rows);
  const sizes  = getSizes(rows);

  let mainDescription = '';
  if (styleData?.description?.trim()) {
    mainDescription = styleData.description.trim();
  } else if (styleData?.title) {
    mainDescription = `<p>${styleData.title}</p>`;
  } else {
    mainDescription = `<p>${sample.brandName} ${sample.styleName}</p>`;
  }

  const detailLines = [
    `<li><strong>Brand:</strong> ${sample.brandName}</li>`,
    `<li><strong>Style:</strong> ${sample.styleName}${styleData?.title ? ` — ${styleData.title}` : ''}</li>`,
    styleData?.baseCategory ? `<li><strong>Category:</strong> ${styleData.baseCategory}</li>` : '',
    `<li><strong>Available Colors:</strong> ${colors.join(', ')}</li>`,
    `<li><strong>Available Sizes:</strong> ${sizes.join(', ')}</li>`,
    sample.countryOfOrigin ? `<li><strong>Country of Origin:</strong> ${sample.countryOfOrigin}</li>` : '',
    styleData?.sustainableStyle ? `<li>♻️ <strong>Sustainable Style</strong></li>` : '',
    styleData?.newStyle ? `<li>🆕 <strong>New Arrival</strong></li>` : '',
  ].filter(Boolean);

  return `${mainDescription}\n\n<hr/>\n<ul>\n${detailLines.join('\n')}\n</ul>`.trim();
}


// ─── Tags ─────────────────────────────────────────────────────────────────────

function buildTags(rows, styleData) {
  const sample = rows[0];
  const tags = new Set([
    'SS Activewear',
    sample.brandName,
    sample.styleName,
    sample.colorFamily,
    styleData?.baseCategory,
    styleData?.title,
  ]);

  const sizes = getSizes(rows);
  if (sizes.length) tags.add(`Sizes: ${sizes[0]}–${sizes[sizes.length - 1]}`);

  if (styleData?.sustainableStyle) tags.add('Sustainable');
  if (styleData?.newStyle)         tags.add('New Arrival');

  return [...tags].filter(Boolean);
}


// ─── Inventory meta ───────────────────────────────────────────────────────────

function buildVariantMeta(rows) {
  const variantMeta = {};

  for (const row of rows) {
    const regularWarehouses = (row.warehouses || []).filter(w => w.dropship !== true);
    const totalAvailableQty = regularWarehouses.reduce((sum, w) => sum + (w.qty || 0), 0);

    variantMeta[row.sku] = {
      gtin:             row.gtin || '',
      availableQty:     totalAvailableQty,
      usWarehouseQty:   totalAvailableQty,
      warehouseBreakdown: regularWarehouses.map(w => ({
        warehouseAbbr: w.warehouseAbbr,
        qty: w.qty || 0,
      })),
      customerPrice: row.customerPrice,
      retailPrice:   row.retailPrice,
      mapPrice:      row.mapPrice,
      warehouses:    row.warehouses || [],
    };
  }

  return variantMeta;
}


// ─── Core transformer ─────────────────────────────────────────────────────────

function transformStyleToShopifyProduct(rows, styleData = null) {
  const sample = rows[0];
  const colors = getColors(rows);
  const sizes  = getSizes(rows);

  const variantMeta = buildVariantMeta(rows);
  const variants    = [];

  for (const row of rows) {
    const price          = calculatePrice(row.customerPrice);
    const compareAtPrice = row.retailPrice ? parseFloat(row.retailPrice).toFixed(2) : null;

    variants.push({
      option1:              row.colorName,
      option2:              row.sizeName,
      sku:                  row.sku,
      barcode:              row.gtin || '',
      price,
      compare_at_price:     compareAtPrice,
      inventory_management: 'shopify',
      inventory_policy:     'deny',
      requires_shipping:    true,
      weight:               parseFloat(row.unitWeight || 0),
      weight_unit:          'lb',
      taxable:              true,
    });
  }

  const productTitle = styleData?.title
    ? `${sample.brandName} ${styleData.title}`
    : `${sample.brandName} ${sample.styleName}`;

  const baseCategory = styleData?.baseCategory;
  const product = {
    title:              productTitle,
    body_html:          buildDescription(rows, styleData),
    vendor:             sample.brandName,
    product_type:       baseCategory || sample.colorFamily || 'Activewear',
    tags:               buildTags(rows, styleData).join(','),
    status:             'draft',
    taxonomyCategoryId: CATEGORY_MAP[baseCategory] || null,
    options: [
      { name: 'Color', values: colors },
      { name: 'Size',  values: sizes  },
    ],
    variants,
    // Images are NOT included here — _syncImages() handles all angles
    // (front, side, back, on-model) after product creation to avoid duplicates.
  };

  return { product, variantMeta };
}


// ─── Change detection ─────────────────────────────────────────────────────────

function diffProduct(existingShopifyProduct, freshProduct, freshVariantMeta, existingInventoryMap) {

  // ── Product-level fields ──────────────────────────────────────
  const productChanged =
    existingShopifyProduct.title        !== freshProduct.title        ||
    existingShopifyProduct.body_html    !== freshProduct.body_html    ||
    existingShopifyProduct.vendor       !== freshProduct.vendor       ||
    existingShopifyProduct.product_type !== freshProduct.product_type ||
    normaliseTags(existingShopifyProduct.tags) !== normaliseTags(freshProduct.tags);

  // ── Variant-level diff ────────────────────────────────────────
  const existingBySku = new Map(
    (existingShopifyProduct.variants || []).map(v => [v.sku, v])
  );
  const freshBySku = new Map(
    (freshProduct.variants || []).map(v => [v.sku, v])
  );

  const toAdd    = [];
  const toUpdate = [];
  const toDelete = [];

  for (const [sku, fresh] of freshBySku) {
    if (!existingBySku.has(sku)) {
      toAdd.push(fresh);
    } else {
      const existing = existingBySku.get(sku);
      const changed  = variantFieldsChanged(existing, fresh);
      if (changed) toUpdate.push({ existing, fresh, changed });
    }
  }

  for (const [sku, existing] of existingBySku) {
    if (!freshBySku.has(sku)) toDelete.push(existing);
  }

  // ── Inventory diff ────────────────────────────────────────────
  const inventoryChanges = [];
  for (const existing of (existingShopifyProduct.variants || [])) {
    const meta = freshVariantMeta[existing.sku];
    if (!meta || !existing.inventory_item_id) continue;

    const currentQty = existingInventoryMap?.get(existing.inventory_item_id) ?? null;
    if (currentQty !== meta.availableQty) {
      inventoryChanges.push({
        sku:             existing.sku,
        inventoryItemId: existing.inventory_item_id,
        oldQty:          currentQty,
        newQty:          meta.availableQty,
      });
    }
  }

  return {
    productChanged,
    variantChanges: { toAdd, toUpdate, toDelete },
    inventoryChanges,
  };
}

function variantFieldsChanged(existing, fresh) {
  const changes = {};

  if (String(existing.price)                          !== String(fresh.price))            changes.price            = fresh.price;
  if (String(existing.compare_at_price || '')         !== String(fresh.compare_at_price || '')) changes.compare_at_price = fresh.compare_at_price;
  if ((existing.barcode || '')                        !== (fresh.barcode || ''))           changes.barcode          = fresh.barcode;
  if (String(existing.weight || 0)                    !== String(fresh.weight || 0))       changes.weight           = fresh.weight;

  return Object.keys(changes).length > 0 ? changes : null;
}

function normaliseTags(tagsStr) {
  return (tagsStr || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .sort()
    .join(',');
}

function buildProductUpdatePayload(existingShopifyProduct, newRows, styleData = null) {
  const { product: freshProduct, variantMeta } = transformStyleToShopifyProduct(newRows, styleData);

  const update = {
    id:           extractId(existingShopifyProduct.id),
    title:        freshProduct.title,
    body_html:    freshProduct.body_html,
    vendor:       freshProduct.vendor,
    product_type: freshProduct.product_type,
    tags:         freshProduct.tags,
    status:       'draft',
  };

  return { update, variantMeta, freshVariants: freshProduct.variants, freshProduct };
}

function extractId(gidOrInt) {
  if (typeof gidOrInt === 'number') return gidOrInt;
  const match = String(gidOrInt).match(/\/(\d+)$/);
  return match ? parseInt(match[1]) : gidOrInt;
}


export {
  shouldExcludeProduct,
  calculatePrice,
  ssImageUrl,
  groupByStyle,
  groupByColor,
  transformStyleToShopifyProduct,
  buildProductUpdatePayload,
  buildVariantMeta,
  diffProduct,
  extractId,
};
