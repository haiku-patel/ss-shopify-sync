import { CONFIG } from './config.js';

// ─── GID utilities ────────────────────────────────────────────────────────────

function fromGid(gid) {
  if (!gid) return null;
  const parts = String(gid).split('/');
  return parseInt(parts[parts.length - 1], 10);
}

function toGid(type, id) {
  return `gid://shopify/${type}/${id}`;
}

// ─── Response normalizers ─────────────────────────────────────────────────────

function normalizeProduct(node) {
  if (!node) return null;
  return {
    id:           fromGid(node.id),
    title:        node.title,
    body_html:    node.descriptionHtml,
    vendor:       node.vendor,
    product_type: node.productType,
    tags:         Array.isArray(node.tags) ? node.tags.join(', ') : (node.tags || ''),
    handle:       node.handle,
    status:       node.status?.toLowerCase(),
    options:      (node.options || []).map(o => ({ id: fromGid(o.id), name: o.name })),
    variants:     (node.variants?.edges || []).map(e => normalizeVariant(e.node)),
    images:       (node.images?.edges  || []).map(e => normalizeImage(e.node)),
  };
}

function normalizeVariant(node) {
  if (!node) return null;
  const opts = node.selectedOptions || [];
  return {
    id:                fromGid(node.id),
    sku:               node.sku,
    price:             node.price,
    compare_at_price:  node.compareAtPrice,
    barcode:           node.barcode,
    option1:           opts[0]?.value ?? null,
    option2:           opts[1]?.value ?? null,
    option3:           opts[2]?.value ?? null,
    inventory_item_id: fromGid(node.inventoryItem?.id),
  };
}

function normalizeImage(node) {
  if (!node) return null;
  return {
    id:  fromGid(node.id),
    src: node.url,
    alt: node.altText || '',
  };
}

// ─── Input adapters ───────────────────────────────────────────────────────────

// Builds a ProductSetInput for the productSet mutation (create or update).
// options/variants are only included when present so partial updates don't wipe them.
function productToSetInput(data, productId = null) {
  const input = {};
  if (productId !== null)           input.id             = toGid('Product', productId);
  if (data.title        !== undefined) input.title           = data.title;
  if (data.body_html    !== undefined) input.descriptionHtml = data.body_html;
  if (data.vendor       !== undefined) input.vendor          = data.vendor;
  if (data.product_type !== undefined) input.productType     = data.product_type;
  if (data.status       !== undefined) input.status          = data.status.toUpperCase();
  if (data.tags !== undefined) {
    input.tags = typeof data.tags === 'string'
      ? data.tags.split(',').map(t => t.trim()).filter(Boolean)
      : data.tags;
  }
  if (data.taxonomyCategoryId) {
    input.category = data.taxonomyCategoryId;
  }

  const opts     = data.options  || [];
  const variants = data.variants || [];

  if (opts.length && variants.length) {
    // Collect unique values per option position from the variant list
    input.productOptions = opts.map((opt, i) => {
      const key    = `option${i + 1}`;
      const unique = [...new Set(variants.map(v => v[key]).filter(Boolean))];
      return { name: opt.name || opt, values: unique.map(n => ({ name: n })) };
    });

    input.variants = variants.map(v => ({
      optionValues: opts
        .map((opt, i) => ({ optionName: opt.name || opt, name: v[`option${i + 1}`] || '' }))
        .filter(ov => ov.name),
      price:           String(v.price ?? '0'),
      ...(v.compare_at_price != null ? { compareAtPrice: String(v.compare_at_price) } : {}),
      sku:             v.sku,
      barcode:         v.barcode,
      inventoryPolicy: v.inventory_policy === 'continue' ? 'CONTINUE' : 'DENY',
    }));
  }

  return input;
}

// Used only for individual variant create/update (not product-level).
function variantInputToGraphQL(v) {
  const gv = {};
  const options = [v.option1, v.option2, v.option3].filter(o => o != null);
  if (options.length)             gv.options           = options;
  if (v.price !== undefined)      gv.price             = String(v.price);
  if (v.compare_at_price != null) gv.compareAtPrice    = String(v.compare_at_price);
  if (v.sku !== undefined)        gv.sku               = v.sku;
  if (v.barcode !== undefined)    gv.barcode           = v.barcode;
  if (v.inventory_management !== undefined) {
    gv.inventoryManagement = v.inventory_management === 'shopify' ? 'SHOPIFY' : 'NOT_MANAGED';
  }
  if (v.inventory_policy !== undefined) {
    gv.inventoryPolicy = v.inventory_policy === 'continue' ? 'CONTINUE' : 'DENY';
  }
  return gv;
}

// ─── Shared field fragments ───────────────────────────────────────────────────

const PRODUCT_FIELDS = `
  id title descriptionHtml vendor productType tags handle status
  options { id name }
  variants(first: 100) {
    edges { node {
      id sku price compareAtPrice barcode
      selectedOptions { name value }
      inventoryItem { id }
    }}
  }
  images(first: 30) {
    edges { node { id url altText } }
  }
`;

const VARIANT_FIELDS = `
  id sku price compareAtPrice barcode
  selectedOptions { name value }
  inventoryItem { id }
`;

class ShopifyAPI {
  constructor() {
    this.shop        = CONFIG.shopify.shop;
    this.accessToken = CONFIG.shopify.accessToken;
    this.apiVersion  = '2025-01';
    this.endpoint    = `https://${this.shop}.myshopify.com/admin/api/${this.apiVersion}/graphql.json`;
    this._publicationIds = null;
  }

  // ─── Core GraphQL request ────────────────────────────────────────────────────

  async graphqlRequest(query, variables = {}) {
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN?.trim() || this.accessToken;

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 429) {
      const retryAfter = parseFloat(response.headers.get('Retry-After') || '60');
      console.warn(`⏳ Rate limited — waiting ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      return this.graphqlRequest(query, variables);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Shopify GraphQL HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const json = await response.json();

    // Cost-based throttle: back off when bucket runs low
    const throttle = json.extensions?.cost?.throttleStatus;
    if (throttle && throttle.currentlyAvailable < 100) {
      const waitMs = Math.ceil((100 - throttle.currentlyAvailable) / throttle.restoreRate) * 1000;
      await sleep(waitMs);
    }

    if (json.errors) {
      const isThrottled = json.errors.some(e => e.extensions?.code === 'THROTTLED');
      if (isThrottled) {
        console.warn('⏳ GraphQL throttled — waiting 2s...');
        await sleep(2000);
        return this.graphqlRequest(query, variables);
      }
      throw new Error(`Shopify GraphQL error: ${json.errors.map(e => e.message).join('; ')}`);
    }

    return json.data;
  }

  // ─── Shop ────────────────────────────────────────────────────────────────────

  async testConnection() {
    const data = await this.graphqlRequest(`{ shop { name myshopifyDomain primaryDomain { host } } }`);
    const shop  = data.shop;
    const domain = shop.primaryDomain?.host || shop.myshopifyDomain;
    console.log(`✅ Shopify connected: ${shop.name} (${domain})`);
    return { name: shop.name, domain };
  }

  // ─── Products ────────────────────────────────────────────────────────────────

  async getProducts(limit = 250, pageInfo = null) {
    const after = pageInfo ? `, after: "${pageInfo}"` : '';
    const data  = await this.graphqlRequest(`{
      products(first: ${limit}${after}) {
        edges { node { ${PRODUCT_FIELDS} } }
        pageInfo { hasNextPage endCursor }
      }
    }`);
    return {
      products: data.products.edges.map(e => normalizeProduct(e.node)),
      pageInfo:  data.products.pageInfo,
    };
  }

  async getAllProducts() {
    const all  = [];
    let cursor = null;
    let page   = 1;
    do {
      console.log(`   📄 Fetching Shopify products page ${page}...`);
      const result = await this.getProducts(250, cursor);
      all.push(...result.products);
      cursor = result.pageInfo.hasNextPage ? result.pageInfo.endCursor : null;
      page++;
    } while (cursor);
    return all;
  }

  async getProductById(productId) {
    const data = await this.graphqlRequest(`
      query getProduct($id: ID!) {
        product(id: $id) { ${PRODUCT_FIELDS} }
      }
    `, { id: toGid('Product', productId) });
    return normalizeProduct(data.product);
  }

  async createProduct(productData) {
    const input = productToSetInput(productData);
    const data  = await this.graphqlRequest(`
      mutation productSet($synchronous: Boolean!, $input: ProductSetInput!) {
        productSet(synchronous: $synchronous, input: $input) {
          product { ${PRODUCT_FIELDS} }
          userErrors { field message }
        }
      }
    `, { synchronous: true, input });
    const { product, userErrors } = data.productSet;
    if (userErrors?.length) throw new Error(`productSet: ${userErrors.map(e => e.message).join('; ')}`);
    return { product: normalizeProduct(product) };
  }

  async updateProduct(productId, productData) {
    const input = productToSetInput(productData, productId);
    const data  = await this.graphqlRequest(`
      mutation productSet($synchronous: Boolean!, $input: ProductSetInput!) {
        productSet(synchronous: $synchronous, input: $input) {
          product { ${PRODUCT_FIELDS} }
          userErrors { field message }
        }
      }
    `, { synchronous: true, input });
    const { product, userErrors } = data.productSet;
    if (userErrors?.length) throw new Error(`productSet: ${userErrors.map(e => e.message).join('; ')}`);
    return { product: normalizeProduct(product) };
  }

  async deleteProduct(productId) {
    const data = await this.graphqlRequest(`
      mutation productDelete($input: ProductDeleteInput!) {
        productDelete(input: $input) {
          deletedProductId
          userErrors { field message }
        }
      }
    `, { input: { id: toGid('Product', productId) } });
    const { userErrors } = data.productDelete;
    if (userErrors?.length) throw new Error(`productDelete: ${userErrors.map(e => e.message).join('; ')}`);
    return true;
  }

  // ─── Variants ────────────────────────────────────────────────────────────────

  async createVariant(productId, variantData) {
    const input = { ...variantInputToGraphQL(variantData), productId: toGid('Product', productId) };
    const data  = await this.graphqlRequest(`
      mutation productVariantCreate($input: ProductVariantInput!) {
        productVariantCreate(input: $input) {
          productVariant { ${VARIANT_FIELDS} }
          userErrors { field message }
        }
      }
    `, { input });
    const { productVariant, userErrors } = data.productVariantCreate;
    if (userErrors?.length) throw new Error(`productVariantCreate: ${userErrors.map(e => e.message).join('; ')}`);
    return { variant: normalizeVariant(productVariant) };
  }

  async updateVariant(variantId, variantData) {
    // productVariantUpdate was removed in 2025-01; use productVariantsBulkUpdate instead.
    // Look up the parent product ID first (one extra query, no signature change needed).
    const lookup = await this.graphqlRequest(`
      query variantParent($id: ID!) { productVariant(id: $id) { product { id } } }
    `, { id: toGid('ProductVariant', variantId) });

    const productGid = lookup.productVariant?.product?.id;
    if (!productGid) throw new Error(`Cannot find parent product for variant ${variantId}`);

    const variant = { ...variantInputToGraphQL(variantData), id: toGid('ProductVariant', variantId) };
    const data = await this.graphqlRequest(`
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { ${VARIANT_FIELDS} }
          userErrors { field message }
        }
      }
    `, { productId: productGid, variants: [variant] });
    const { productVariants, userErrors } = data.productVariantsBulkUpdate;
    if (userErrors?.length) throw new Error(`productVariantsBulkUpdate: ${userErrors.map(e => e.message).join('; ')}`);
    return { variant: normalizeVariant(productVariants[0]) };
  }

  async deleteVariant(productId, variantId) {
    const data = await this.graphqlRequest(`
      mutation productVariantDelete($id: ID!) {
        productVariantDelete(id: $id) {
          deletedProductVariantId
          userErrors { field message }
        }
      }
    `, { id: toGid('ProductVariant', variantId) });
    const { userErrors } = data.productVariantDelete;
    if (userErrors?.length) throw new Error(`productVariantDelete: ${userErrors.map(e => e.message).join('; ')}`);
    return true;
  }

  // ─── Images ──────────────────────────────────────────────────────────────────

  async addProductImage(productId, imageUrl, altText = '', variantIds = []) {
    const data = await this.graphqlRequest(`
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media {
            ... on MediaImage {
              id
              image { id url altText }
            }
          }
          mediaUserErrors { field message }
        }
      }
    `, {
      productId: toGid('Product', productId),
      media:     [{ originalSource: imageUrl, alt: altText, mediaContentType: 'IMAGE' }],
    });

    const { media, mediaUserErrors } = data.productCreateMedia;
    if (mediaUserErrors?.length) throw new Error(`productCreateMedia: ${mediaUserErrors.map(e => e.message).join('; ')}`);

    const created = media?.[0];
    if (!created) return null;

    const imageId = fromGid(created.image?.id || created.id);

    // Associate image with specific variants (best-effort)
    if (variantIds.length && imageId) {
      for (const variantId of variantIds) {
        try {
          await this.graphqlRequest(`
            mutation productVariantUpdate($input: ProductVariantInput!) {
              productVariantUpdate(input: $input) {
                userErrors { field message }
              }
            }
          `, { input: { id: toGid('ProductVariant', variantId), imageId: toGid('ProductImage', imageId) } });
        } catch (_) { /* best-effort */ }
      }
    }

    return { image: { id: imageId, src: created.image?.url, alt: altText } };
  }

  async getProductImages(productId) {
    const data = await this.graphqlRequest(`
      query productImages($id: ID!) {
        product(id: $id) {
          images(first: 250) {
            edges { node { id url altText } }
          }
        }
      }
    `, { id: toGid('Product', productId) });
    return (data.product?.images?.edges || []).map(e => normalizeImage(e.node));
  }

  // ─── Collections ─────────────────────────────────────────────────────────────

  async getCustomCollections() {
    const data = await this.graphqlRequest(`{
      collections(first: 250) {
        edges { node { id title } }
      }
    }`);
    return (data.collections?.edges || []).map(e => ({
      id:    fromGid(e.node.id),
      title: e.node.title,
    }));
  }

  async createCustomCollection(title) {
    const data = await this.graphqlRequest(`
      mutation collectionCreate($input: CollectionInput!) {
        collectionCreate(input: $input) {
          collection { id title }
          userErrors { field message }
        }
      }
    `, { input: { title } });
    const { collection, userErrors } = data.collectionCreate;
    if (userErrors?.length) throw new Error(`collectionCreate: ${userErrors.map(e => e.message).join('; ')}`);
    return { id: fromGid(collection.id), title: collection.title };
  }

  async addProductToCollection(collectionId, productId) {
    const data = await this.graphqlRequest(`
      mutation collectionAddProducts($id: ID!, $productIds: [ID!]!) {
        collectionAddProducts(id: $id, productIds: $productIds) {
          collection { id }
          userErrors { field message }
        }
      }
    `, {
      id:         toGid('Collection', collectionId),
      productIds: [toGid('Product', productId)],
    });
    const { userErrors } = data.collectionAddProducts;
    if (userErrors?.length) {
      // Mimic REST 422 so collections.js silently ignores duplicates
      throw new Error(`422: ${userErrors.map(e => e.message).join('; ')}`);
    }
    return true;
  }

  // ─── Sales channel publishing ─────────────────────────────────────────────────

  async getPublications() {
    if (this._publicationIds) return this._publicationIds;
    try {
      const data = await this.graphqlRequest(`{
        publications(first: 20) {
          edges { node { id name } }
        }
      }`);
      this._publicationIds = (data.publications?.edges || []).map(e => ({
        id:   fromGid(e.node.id),
        name: e.node.name,
      }));
      console.log(`📢 ${this._publicationIds.length} publication channel(s): ${this._publicationIds.map(p => p.name).join(', ')}`);
    } catch (err) {
      if (err.message.includes('403') || err.message.includes('publication') || err.message.includes('ACCESS_DENIED')) {
        console.warn('⚠️  Missing read_publications scope — channel publishing skipped.');
        this._publicationIds = [];
      } else {
        throw err;
      }
    }
    return this._publicationIds;
  }

  async publishToAllChannels(productId) {
    const publications = await this.getPublications();
    if (!publications.length) return;

    const externalChannels = publications.filter(p => {
      const name = p.name.toLowerCase();
      return !name.includes('online store') && !name.includes('point of sale');
    });

    for (const pub of externalChannels) {
      try {
        await this.graphqlRequest(`
          mutation productPublish($input: ProductPublishInput!) {
            productPublish(input: $input) {
              userErrors { field message }
            }
          }
        `, {
          input: {
            id: toGid('Product', productId),
            productPublications: [{ publicationId: toGid('Publication', pub.id) }],
          },
        });
      } catch (err) {
        if (!err.message.includes('422')) {
          console.warn(`   ⚠️  Could not publish to "${pub.name}": ${err.message}`);
        }
      }
    }
  }

  // ─── Inventory ────────────────────────────────────────────────────────────────

  async getLocations() {
    const data = await this.graphqlRequest(`{
      locations(first: 20) {
        edges { node { id name isActive } }
      }
    }`);
    return (data.locations?.edges || [])
      .filter(e => e.node.isActive)
      .map(e => ({ id: fromGid(e.node.id), name: e.node.name }));
  }

  async getInventoryLevels(inventoryItemIds) {
    const ids = (Array.isArray(inventoryItemIds) ? inventoryItemIds : [inventoryItemIds])
      .map(id => toGid('InventoryItem', id));

    const data = await this.graphqlRequest(`
      query inventoryLevels($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on InventoryItem {
            id
            inventoryLevels(first: 20) {
              edges { node {
                location { id }
                quantities(names: ["available"]) { name quantity }
              }}
            }
          }
        }
      }
    `, { ids });

    const levels = [];
    for (const node of (data.nodes || [])) {
      if (!node?.inventoryLevels) continue;
      const itemId = fromGid(node.id);
      for (const { node: lvl } of node.inventoryLevels.edges) {
        const available = lvl.quantities.find(q => q.name === 'available')?.quantity ?? 0;
        levels.push({
          inventory_item_id: itemId,
          location_id:       fromGid(lvl.location.id),
          available,
        });
      }
    }
    return levels;
  }

  async activateInventoryAtLocation(inventoryItemId, locationId) {
    const data = await this.graphqlRequest(`
      mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
          inventoryLevel { id }
          userErrors { field message }
        }
      }
    `, {
      inventoryItemId: toGid('InventoryItem', inventoryItemId),
      locationId:      toGid('Location', locationId),
    });
    const { userErrors } = data.inventoryActivate;
    if (userErrors?.length) throw new Error(`inventoryActivate: ${userErrors.map(e => e.message).join('; ')}`);
    return true;
  }

  async setInventoryLevel(locationId, inventoryItemId, available) {
    const data = await this.graphqlRequest(`
      mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          userErrors { field message }
        }
      }
    `, {
      input: {
        name:                  'available',
        reason:                'correction',
        ignoreCompareQuantity: true,
        quantities: [{
          inventoryItemId: toGid('InventoryItem', inventoryItemId),
          locationId:      toGid('Location', locationId),
          quantity:        available,
        }],
      },
    });
    const { userErrors } = data.inventorySetQuantities;
    if (userErrors?.length) throw new Error(`inventorySetQuantities: ${userErrors.map(e => e.message).join('; ')}`);
    return true;
  }

  async updateInventoryItem(inventoryItemId, itemData) {
    const data = await this.graphqlRequest(`
      mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
          inventoryItem { id }
          userErrors { field message }
        }
      }
    `, {
      id:    toGid('InventoryItem', inventoryItemId),
      input: itemData,
    });
    const { userErrors } = data.inventoryItemUpdate;
    if (userErrors?.length) throw new Error(`inventoryItemUpdate: ${userErrors.map(e => e.message).join('; ')}`);
    return true;
  }

  // ─── Metafields ───────────────────────────────────────────────────────────────
  // metafieldsSet handles upsert natively — no need to check for existing first.

  async upsertProductMetafield(productId, { namespace, key, value, type }) {
    const data = await this.graphqlRequest(`
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }
    `, {
      metafields: [{ ownerId: toGid('Product', productId), namespace, key, value, type }],
    });
    const { userErrors } = data.metafieldsSet;
    if (userErrors?.length) throw new Error(`metafieldsSet: ${userErrors.map(e => e.message).join('; ')}`);
    return true;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export { ShopifyAPI };
