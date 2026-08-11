import { CONFIG } from './config.js';
import { sleep } from './utils.js';

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
    weight:            node.inventoryItem?.measurement?.weight?.value ?? null,
    weight_unit:       node.inventoryItem?.measurement?.weight?.unit?.toLowerCase() ?? null,
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

function productToSetInput(data, productId = null) {
  const input = {};
  if (productId !== null)              input.id             = toGid('Product', productId);
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
      ...(v.weight != null ? { inventoryItem: { measurement: { weight: { value: parseFloat(v.weight), unit: weightUnitToGraphQL(v.weight_unit) } } } } : {}),
    }));
  }

  return input;
}

function weightUnitToGraphQL(unit) {
  const map = { lb: 'POUNDS', lbs: 'POUNDS', kg: 'KILOGRAMS', g: 'GRAMS', oz: 'OUNCES' };
  return map[unit?.toLowerCase()] || 'POUNDS';
}

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
  if (v.weight !== undefined && v.weight !== null) {
    gv.inventoryItem = { measurement: { weight: { value: parseFloat(v.weight), unit: weightUnitToGraphQL(v.weight_unit) } } };
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
      inventoryItem { id measurement { weight { unit value } } }
    }}
  }
  images(first: 30) {
    edges { node { id url altText } }
  }
`;

const VARIANT_FIELDS = `
  id sku price compareAtPrice barcode
  selectedOptions { name value }
  inventoryItem { id measurement { weight { unit value } } }
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

  async graphqlRequest(query, variables = {}, _retried = false) {
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
      return this.graphqlRequest(query, variables, _retried);
    }

    if (response.status === 401) {
      if (_retried) throw new Error('Shopify GraphQL HTTP 401: token refresh did not fix the auth error — check CLIENT_ID/SECRET');
      await this._refreshAccessToken();
      return this.graphqlRequest(query, variables, true);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Shopify GraphQL HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const json = await response.json();

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

  async _refreshAccessToken() {
    const clientId     = process.env.SHOPIFY_CLIENT_ID?.trim();
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new Error('Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET');

    const res = await fetch(`https://${this.shop}.myshopify.com/admin/oauth/access_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const data  = await res.json();
    const token = data.access_token;
    if (!token) throw new Error(`No access_token in refresh response`);

    process.env.SHOPIFY_ACCESS_TOKEN = token;
    this.accessToken = token;
    console.log('🔑 Access token refreshed');
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

  // Single method for both create and update — pass productId to update, omit to create.
  async upsertProduct(productData, productId = null) {
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
    const { deletedProductId, userErrors } = data.productDelete;
    if (userErrors?.length) throw new Error(`productDelete: ${userErrors.map(e => e.message).join('; ')}`);
    if (!deletedProductId) {
      console.warn(`   ⚠️  productDelete for ${productId} returned no deletedProductId — Shopify may not have deleted it`);
    }
    return true;
  }

  // ─── Variants ────────────────────────────────────────────────────────────────

  async createVariants(productId, variantDataArray) {
    const variants = variantDataArray.map(variantInputToGraphQL);
    const data = await this.graphqlRequest(`
      mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants { ${VARIANT_FIELDS} }
          userErrors { field message }
        }
      }
    `, { productId: toGid('Product', productId), variants });
    const { productVariants, userErrors } = data.productVariantsBulkCreate;
    if (userErrors?.length) throw new Error(`productVariantsBulkCreate: ${userErrors.map(e => e.message).join('; ')}`);
    return productVariants.map(normalizeVariant);
  }

  // variantUpdates: array of { id, ...changedFields }
  // productId is required — eliminates the extra parent-lookup query.
  async updateVariants(productId, variantUpdates) {
    const variants = variantUpdates.map(({ id, ...data }) => ({
      ...variantInputToGraphQL(data),
      id: toGid('ProductVariant', id),
    }));
    const gqlData = await this.graphqlRequest(`
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { ${VARIANT_FIELDS} }
          userErrors { field message }
        }
      }
    `, { productId: toGid('Product', productId), variants });
    const { productVariants, userErrors } = gqlData.productVariantsBulkUpdate;
    if (userErrors?.length) throw new Error(`productVariantsBulkUpdate: ${userErrors.map(e => e.message).join('; ')}`);
    return productVariants.map(normalizeVariant);
  }

  async deleteVariants(productId, variantIds) {
    const data = await this.graphqlRequest(`
      mutation productVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
        productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
          userErrors { field message }
        }
      }
    `, {
      productId:   toGid('Product', productId),
      variantsIds: variantIds.map(id => toGid('ProductVariant', id)),
    });
    const { userErrors } = data.productVariantsBulkDelete;
    if (userErrors?.length) throw new Error(`productVariantsBulkDelete: ${userErrors.map(e => e.message).join('; ')}`);
    return true;
  }

  // ─── Images ──────────────────────────────────────────────────────────────────

  async addProductImage(productId, imageUrl, altText = '') {
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

    const mediaGid = created.id;
    const imageId  = fromGid(created.image?.id || created.id);

    return { image: { id: imageId, mediaGid, src: created.image?.url, alt: altText } };
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

    await Promise.allSettled(
      publications.map(pub =>
        this.graphqlRequest(`
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
        }).catch(err => {
          if (!err.message.includes('422')) {
            console.warn(`   ⚠️  Could not publish to "${pub.name}": ${err.message}`);
          }
        })
      )
    );
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

  async upsertProductMetafields(productId, metafields) {
    const data = await this.graphqlRequest(`
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }
    `, {
      metafields: metafields.map(mf => ({ ownerId: toGid('Product', productId), ...mf })),
    });
    const { userErrors } = data.metafieldsSet;
    if (userErrors?.length) throw new Error(`metafieldsSet: ${userErrors.map(e => e.message).join('; ')}`);
    return true;
  }

  async upsertProductMetafield(productId, mf) {
    return this.upsertProductMetafields(productId, [mf]);
  }

  // ─── Media ────────────────────────────────────────────────────────────────────

  async getProductMedia(productId) {
    const data = await this.graphqlRequest(`
      query productMedia($id: ID!) {
        product(id: $id) {
          media(first: 250) {
            edges {
              node {
                ... on MediaImage {
                  id
                  image { altText }
                }
              }
            }
          }
        }
      }
    `, { id: toGid('Product', productId) });
    return (data.product?.media?.edges || [])
      .filter(e => e.node?.id)
      .map(e => ({ mediaGid: e.node.id, alt: e.node.image?.altText || '' }));
  }

  // ─── Bulk Operations ──────────────────────────────────────────────────────────

  // Stage a JSONL file for bulk mutation upload, then POST it to the signed URL.
  // Returns the resourceUrl which is passed as stagedUploadPath to runBulkMutation.
  async stagedUpload(filename, content, mimeType = 'text/plain') {
    const data = await this.graphqlRequest(`
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }
    `, {
      input: [{
        filename,
        mimeType,
        httpMethod: 'POST',
        resource:   'BULK_MUTATION_VARIABLES',
      }],
    });

    const { stagedTargets, userErrors } = data.stagedUploadsCreate;
    if (userErrors?.length) throw new Error(`stagedUploadsCreate: ${userErrors.map(e => e.message).join('; ')}`);

    const { url, resourceUrl, parameters } = stagedTargets[0];

    // Parameters must come before the file, and the file must be last.
    const form = new FormData();
    for (const { name, value } of parameters) form.append(name, value);
    form.append('file', new Blob([content], { type: mimeType }), filename);

    const uploadRes = await fetch(url, { method: 'POST', body: form });
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(`Staged upload HTTP ${uploadRes.status}: ${text.slice(0, 300)}`);
    }

    return resourceUrl;
  }

  async runBulkMutation(stagedUploadPath, mutation) {
    const data = await this.graphqlRequest(`
      mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
        bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
          bulkOperation { id status url errorCode }
          userErrors { field message }
        }
      }
    `, { mutation, stagedUploadPath });

    const { bulkOperation, userErrors } = data.bulkOperationRunMutation;
    if (userErrors?.length) throw new Error(`bulkOperationRunMutation: ${userErrors.map(e => e.message).join('; ')}`);
    return bulkOperation;
  }

  // Polls currentBulkOperation until the job is COMPLETED, FAILED, or CANCELED.
  // Starts at 8s intervals, backs off to 30s after the first minute.
  async pollBulkOperation(bulkOpId) {
    let intervalMs = 8000;
    let attempts   = 0;

    while (true) {
      await sleep(intervalMs);
      attempts++;

      const data = await this.graphqlRequest(`{
        currentBulkOperation(type: MUTATION) {
          id status url errorCode objectCount
        }
      }`);

      const op = data.currentBulkOperation;
      if (!op) throw new Error('No current bulk operation found');
      if (op.id !== bulkOpId) throw new Error(`Expected bulk op ${bulkOpId} but found ${op.id} — another operation may have replaced it`);

      const elapsed = Math.round((attempts * intervalMs) / 1000);
      process.stdout.write(`\r   Status: ${op.status} | ${op.objectCount ?? 0} processed | ${elapsed}s elapsed   `);

      if (op.status === 'COMPLETED') { console.log(''); return op; }
      if (op.status === 'FAILED')    throw new Error(`Bulk operation failed: ${op.errorCode || 'unknown'}`);
      if (op.status === 'CANCELED')  throw new Error('Bulk operation was canceled');

      if (attempts > 8 && intervalMs < 30000) intervalMs = 30000;
    }
  }

  // Downloads the result JSONL from the URL returned by pollBulkOperation.
  // Each line is a JSON object with the mutation result for one input line.
  async downloadBulkResults(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download bulk results: ${res.status}`);
    const text = await res.text();
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  async linkMediaToVariants(productId, relinks) {
    const variantMedia = relinks.flatMap(({ mediaGid, variantIds }) =>
      variantIds.map(variantId => ({
        variantId: toGid('ProductVariant', variantId),
        mediaIds:  [mediaGid],
      }))
    );
    if (!variantMedia.length) return true;

    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const data = await this.graphqlRequest(`
          mutation productVariantAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
            productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
              userErrors { field message }
            }
          }
        `, { productId: toGid('Product', productId), variantMedia });

        const errors = data.productVariantAppendMedia?.userErrors || [];
        if (!errors.length) return true;

        const notReady = errors.some(e => /non-?ready/i.test(e.message));
        if (notReady && attempt < maxAttempts) {
          console.log(`      ⏳ Media still processing, retrying in 4s... (${attempt}/${maxAttempts})`);
          await sleep(4000);
          continue;
        }

        console.warn(`   ⚠️  linkMediaToVariants: ${errors.map(e => e.message).join('; ')}`);
        return false;
      } catch (err) {
        console.warn(`   ⚠️  linkMediaToVariants: ${err.message}`);
        return false;
      }
    }

    console.warn(`   ⚠️  linkMediaToVariants: media still not ready after ${maxAttempts} attempts`);
    return false;
  }
}

export { ShopifyAPI, fromGid, productToSetInput };
