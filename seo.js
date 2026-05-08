/**
 * seo.js — Writes SEO metafields for every synced product.
 *
 * Fields populated:
 *  1. global.title_tag       — <title> tag (≤ 60 chars)
 *  2. global.description_tag — <meta name="description"> (≤ 155 chars)
 *  3. seo.schema_json        — Schema.org Product JSON-LD (for Google Rich Results)
 */

import { ssImageUrl } from './transformer.js';

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function truncate(str, n) {
  if (str.length <= n) return str;
  return str.slice(0, n).replace(/\s\S*$/, '') + '…';
}

function buildSeoTitle(productTitle, brandName, storeName) {
  const full = storeName ? `${productTitle} | ${storeName}` : productTitle;
  return truncate(full, 60);
}

function buildMetaDescription(rows, styleData, productTitle) {
  const sample = rows[0];
  const colors = [...new Set(rows.map(r => r.colorName))];
  const sizes  = [...new Map(rows.map(r => [r.sizeName, r.sizeOrder || 'ZZ'])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([s]) => s);

  let base = '';
  if (styleData?.description) {
    const firstSentence = stripHtml(styleData.description).split(/[.!?]/)[0].trim();
    if (firstSentence.length > 20) base = firstSentence + '. ';
  }

  const colorStr = colors.slice(0, 5).join(', ') + (colors.length > 5 ? ` +${colors.length - 5} more` : '');
  const sizeStr  = sizes.join(', ');
  const cat      = styleData?.baseCategory ? ` ${styleData.baseCategory}.` : '.';

  return truncate(
    `${base}${productTitle}${cat} Available in ${colors.length} color${colors.length > 1 ? 's' : ''}: ${colorStr}. Sizes: ${sizeStr}. Shop wholesale activewear from ${sample.brandName}.`,
    155
  );
}

function buildSchemaJson(rows, styleData, shopifyProduct, shop) {
  const sample  = rows[0];
  const colors  = [...new Set(rows.map(r => r.colorName))];
  const sizes   = [...new Map(rows.map(r => [r.sizeName, r.sizeOrder || 'ZZ'])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([s]) => s);

  const seenImgs = new Set();
  const images   = rows
    .map(r => ssImageUrl(r.colorFrontImage, 'fl'))
    .filter(url => url && !seenImgs.has(url) && seenImgs.add(url));

  const storeUrl   = shop?.domain ? `https://${shop.domain}` : '';
  const productUrl = shopifyProduct?.handle ? `${storeUrl}/products/${shopifyProduct.handle}` : storeUrl;

  const offers = rows.map(row => {
    const price    = (parseFloat(row.customerPrice || 0) * 1.40).toFixed(2);
    const totalQty = (row.warehouses || [])
      .filter(w => !w.dropship)
      .reduce((s, w) => s + (w.qty || 0), 0);

    return {
      '@type':          'Offer',
      sku:              row.sku,
      gtin:             row.gtin || undefined,
      name:             `${row.colorName} / ${row.sizeName}`,
      price,
      priceCurrency:    'USD',
      availability:     totalQty > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition:    'https://schema.org/NewCondition',
      url:              productUrl,
      priceValidUntil:  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    };
  });

  const schema = {
    '@context':   'https://schema.org',
    '@type':      'Product',
    name:         shopifyProduct?.title || `${sample.brandName} ${sample.styleName}`,
    description:  stripHtml(styleData?.description || styleData?.title || ''),
    brand:        { '@type': 'Brand', name: sample.brandName },
    sku:          sample.sku,
    mpn:          sample.styleName,
    category:     styleData?.baseCategory || sample.colorFamily || 'Activewear',
    image:        images,
    color:        colors,
    size:         sizes,
    offers,
  };

  if (sample.gtin) schema.gtin = sample.gtin;

  if (styleData?.sustainableStyle) {
    schema.additionalProperty = [{
      '@type': 'PropertyValue',
      name:    'Sustainable',
      value:   'Yes — meets S&S Sustainable Materials & Manufacturing criteria',
    }];
  }

  return schema;
}

async function writeSeoMetafields(shopifyApi, productId, rows, styleData, shopifyProduct, shop) {
  const productTitle = shopifyProduct?.title || `${rows[0].brandName} ${rows[0].styleName}`;

  const metafields = [
    {
      namespace: 'global',
      key:       'title_tag',
      value:     buildSeoTitle(productTitle, rows[0].brandName, shop?.name),
      type:      'single_line_text_field',
    },
    {
      namespace: 'global',
      key:       'description_tag',
      value:     buildMetaDescription(rows, styleData, productTitle),
      type:      'multi_line_text_field',
    },
    {
      namespace: 'seo',
      key:       'schema_json',
      value:     JSON.stringify(buildSchemaJson(rows, styleData, shopifyProduct, shop)),
      type:      'json',
    },
  ];

  for (const mf of metafields) {
    try {
      await shopifyApi.upsertProductMetafield(productId, mf);
    } catch (err) {
      console.error(`   ⚠️  SEO metafield [${mf.namespace}.${mf.key}]: ${err.message}`);
    }
  }

  console.log(`   🔍 SEO metafields written for product ${productId}`);
}

export { writeSeoMetafields, buildSeoTitle, buildMetaDescription, buildSchemaJson };
