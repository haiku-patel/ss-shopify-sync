import { CONFIG } from './config.js';

class ShopifyAPI {
  constructor() {
    this.shop = CONFIG.shopify.shop;
    this.accessToken = CONFIG.shopify.accessToken;
    this.apiVersion = '2025-01'; // Using the version that works!
  }

  async makeRestRequest(endpoint, options = {}) {
    const url = `https://${this.shop}.myshopify.com/admin/api/${this.apiVersion}/${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Shopify API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  async testConnection() {
    try {
      console.log(`🔄 Testing connection to: https://${this.shop}.myshopify.com`);
      console.log(`🔄 Using API version: ${this.apiVersion}`);
      console.log(`🔄 Token: ${this.accessToken?.substring(0, 15)}...`);
      
      const shop = await this.makeRestRequest('shop.json');
      
      console.log('✅ Shopify connection successful!');
      console.log(`   Shop: ${shop.shop.name}`);
      console.log(`   Domain: ${shop.shop.domain}`);
      console.log(`   Email: ${shop.shop.email}`);
      
      return true;
    } catch (error) {
      console.error('❌ Shopify connection failed:', error.message);
      throw error;
    }
  }

  async createProduct(productData) {
    try {
      const result = await this.makeRestRequest('products.json', {
        method: 'POST',
        body: JSON.stringify({ product: productData })
      });
      return result;
    } catch (error) {
      console.error('❌ Failed to create product:', error.message);
      throw error;
    }
  }

  async getProducts(limit = 50, page_info = null) {
    try {
      let endpoint = `products.json?limit=${limit}`;
      if (page_info) {
        endpoint += `&page_info=${page_info}`;
      }
      
      const result = await this.makeRestRequest(endpoint);
      return result;
    } catch (error) {
      console.error('❌ Failed to get products:', error.message);
      throw error;
    }
  }

  async updateProduct(productId, productData) {
    try {
      const result = await this.makeRestRequest(`products/${productId}.json`, {
        method: 'PUT',
        body: JSON.stringify({ product: productData })
      });
      return result;
    } catch (error) {
      console.error('❌ Failed to update product:', error.message);
      throw error;
    }
  }

  async getProduct(productId) {
    try {
      const result = await this.makeRestRequest(`products/${productId}.json`);
      return result;
    } catch (error) {
      console.error('❌ Failed to get product:', error.message);
      throw error;
    }
  }
}

export { ShopifyAPI };
