import { SSActiveWearAPI } from './ss-api.js';
import { ShopifyAPI } from './shopify-api.js';
import { CONFIG } from './config.js';

class ProductSync {
  constructor() {
    this.ssApi = new SSActiveWearAPI();
    this.shopifyApi = new ShopifyAPI();
    this.syncStats = {
      created: 0,
      updated: 0,
      errors: 0,
      skipped: 0
    };
  }

  // Transform SS product to Shopify format
  transformProduct(ssProduct) {
    const shopifyProduct = {
      title: ssProduct.name,
      descriptionHtml: ssProduct.description || '',
      vendor: ssProduct.brand || 'SS Activewear',
      productType: ssProduct.category,
      tags: [
        'SS Activewear',
        ssProduct.brand,
        ssProduct.category,
        ...(ssProduct.tags || [])
      ].filter(Boolean),
      status: CONFIG.sync.autoPublish ? 'ACTIVE' : 'DRAFT',
      variants: ssProduct.variants?.map(variant => ({
        sku: variant.sku,
        price: (parseFloat(variant.wholesalePrice) * CONFIG.sync.priceMarkup).toFixed(2),
        compareAtPrice: variant.msrp,
        inventoryManagement: 'SHOPIFY',
        inventoryPolicy: 'DENY',
        requiresShipping: true,
        weight: variant.weight || 0,
        weightUnit: 'POUNDS',
        options: [
          variant.size,
          variant.color,
        ].filter(Boolean)
      })) || []
    };

    return shopifyProduct;
  }

  // Main sync function
  async syncProducts() {
    console.log('🚀 Starting product sync...');
    
    try {
      // Step 1: Get existing Shopify products
      console.log('📥 Fetching existing Shopify products...');
      const existingProducts = await this.getExistingProducts();
      const existingSkus = new Set(existingProducts.map(p => p.sku));

      // Step 2: Get SS Activewear products
      console.log('📥 Fetching SS Activewear products...');
      const ssProducts = await this.getAllSSProducts();

      console.log(`📊 Found ${ssProducts.length} SS products, ${existingProducts.length} existing Shopify products`);

      // Step 3: Process products in batches
      for (let i = 0; i < ssProducts.length; i += CONFIG.sync.batchSize) {
        const batch = ssProducts.slice(i, i + CONFIG.sync.batchSize);
        console.log(`🔄 Processing batch ${Math.floor(i / CONFIG.sync.batchSize) + 1}...`);
        
        await Promise.all(batch.map(product => this.processProduct(product, existingSkus)));
        
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      this.printSyncStats();
      
    } catch (error) {
      console.error('❌ Sync failed:', error.message);
      throw error;
    }
  }

  async getAllSSProducts() {
    const allProducts = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.ssApi.getAllProducts(page);
      allProducts.push(...response.products);
      
      hasMore = response.products.length === 100; // Assuming 100 per page
      page++;
    }

    return allProducts;
  }

  async getExistingProducts() {
    const allProducts = [];
    let hasNext = true;
    let cursor = null;

    while (hasNext) {
      const response = await this.shopifyApi.getProducts(50, cursor);
      
      const products = response.products.edges.map(edge => ({
        id: edge.node.id,
        handle: edge.node.handle,
        title: edge.node.title,
        sku: edge.node.variants.edges[0]?.node.sku
      }));
      
      allProducts.push(...products);
      
      hasNext = response.products.pageInfo.hasNextPage;
      cursor = response.products.pageInfo.endCursor;
    }

    return allProducts;
  }

  async processProduct(ssProduct, existingSkus) {
    try {
      const mainSku = ssProduct.variants?.[0]?.sku || ssProduct.sku;
      
      if (existingSkus.has(mainSku)) {
        console.log(`⏭️  Skipping existing product: ${ssProduct.name}`);
        this.syncStats.skipped++;
        return;
      }

      const shopifyProduct = this.transformProduct(ssProduct);
      const result = await this.shopifyApi.createProduct(shopifyProduct);

      if (result.productCreate.userErrors.length > 0) {
        console.error(`❌ Error creating product ${ssProduct.name}:`, result.productCreate.userErrors);
        this.syncStats.errors++;
      } else {
        console.log(`✅ Created product: ${ssProduct.name}`);
        this.syncStats.created++;
      }

    } catch (error) {
      console.error(`❌ Error processing product ${ssProduct.name}:`, error.message);
      this.syncStats.errors++;
    }
  }

  printSyncStats() {
    console.log('\n📊 Sync Complete! Statistics:');
    console.log(`✅ Created: ${this.syncStats.created}`);
    console.log(`🔄 Updated: ${this.syncStats.updated}`);
    console.log(`⏭️  Skipped: ${this.syncStats.skipped}`);
    console.log(`❌ Errors: ${this.syncStats.errors}`);
  }
}

export { ProductSync };
