/**
 * CollectionManager — assigns products to Shopify custom collections.
 *
 * Collections created per product:
 *   - By baseCategory  (e.g. "T-Shirts", "Hoodies")
 *   - By brand         (e.g. "Gildan", "Bella + Canvas")
 *   - By color family  (e.g. "Neutrals", "Blues")
 *
 * Collections are created on first encounter and cached for the run.
 * Re-running is safe — Shopify returns 422 when a product is already in a
 * collection, which is silently ignored.
 */
class CollectionManager {
  constructor(shopifyApi) {
    this.shopify         = shopifyApi;
    this.collectionCache = new Map(); // title.toLowerCase() → collection ID
  }

  async init() {
    console.log('📂 Loading existing Shopify collections...');
    const custom = await this.shopify.getCustomCollections();
    for (const c of custom) {
      this.collectionCache.set(c.title.toLowerCase(), c.id);
    }
    console.log(`   Found ${this.collectionCache.size} existing collection(s)`);
    return this;
  }

  async getOrCreate(title) {
    const key = title.toLowerCase();
    if (this.collectionCache.has(key)) return this.collectionCache.get(key);

    console.log(`   📁 Creating collection: "${title}"`);
    const collection = await this.shopify.createCustomCollection(title);
    this.collectionCache.set(key, collection.id);
    return collection.id;
  }

  async assignProduct(productId, brandName, colorFamily, category) {
    const assignments = [];

    if (category)    assignments.push(this._safeAdd(await this.getOrCreate(category),    productId, category));
    if (brandName)   assignments.push(this._safeAdd(await this.getOrCreate(brandName),   productId, brandName));
    if (colorFamily) assignments.push(this._safeAdd(await this.getOrCreate(colorFamily), productId, colorFamily));

    await Promise.all(assignments);
  }

  async _safeAdd(collectionId, productId, label) {
    try {
      await this.shopify.addProductToCollection(collectionId, productId);
    } catch (err) {
      if (!err.message.includes('422')) {
        console.warn(`   ⚠️  Collection "${label}": ${err.message}`);
      }
    }
  }
}

export { CollectionManager };
