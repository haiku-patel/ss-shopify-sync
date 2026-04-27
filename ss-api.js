import { CONFIG } from './config.js';

class SSActiveWearAPI {
  constructor() {
    this.baseUrl = 'https://api.ssactivewear.com'; // Fixed: removed /v2
    this.username = CONFIG.ssActivewear.username;
    this.password = CONFIG.ssActivewear.password;
    this.token = null;
  }

  async authenticate() {
    try {
      // SS Activewear uses Basic Auth, not Bearer token
      const credentials = btoa(`${this.username}:${this.password}`);
      
      console.log(`🔄 Authenticating with SS Activewear (Account: ${this.username})...`);
      
      // Test with a simple API call instead of separate auth
      const response = await fetch(`${this.baseUrl}/v2/products/`, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`SS API test failed: ${response.status} - ${errorText}`);
      }

      // If we get here, credentials work
      this.credentials = credentials;
      console.log('✅ SS Activewear authenticated');
      return true;
    } catch (error) {
      console.error('❌ SS Authentication error:', error.message);
      throw error;
    }
  }

  async makeRequest(endpoint, options = {}) {
    if (!this.credentials) {
      await this.authenticate();
    }

    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Basic ${this.credentials}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (response.status === 401) {
      // Credentials invalid
      console.log('🔄 Re-authenticating...');
      this.credentials = null;
      await this.authenticate();
      return this.makeRequest(endpoint, options);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SS API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  // Get all products (single call, no pagination)
  async getAllProducts() {
    console.log('🔄 Fetching all SS products...');
    try {
      const data = await this.makeRequest('/v2/products/');
      console.log(`✅ Fetched ${data.length || 0} products from SS Activewear`);
      return data;
    } catch (error) {
      console.error('❌ Failed to fetch products:', error.message);
      throw error;
    }
  }

  // Test different endpoints to find the right one
  async testConnection() {
    try {
      console.log('🧪 Testing SS Activewear connection...');
      
      // Try basic authentication first
      await this.authenticate();
      
      // Try to fetch a small amount of data
      const products = await this.getAllProducts();
      console.log('✅ SS Activewear connection successful!');
      console.log(`   Products available: ${products.length}`);
      return true;
    } catch (error) {
      console.error('❌ SS Activewear connection failed:', error.message);
      
      // Try alternative endpoints
      console.log('🔄 Trying alternative SS API endpoints...');
      const endpoints = [
        '/v2/products',
        '/products',
        '/v1/products',
      ];
      
      for (const endpoint of endpoints) {
        try {
          console.log(`   Testing: ${endpoint}`);
          const credentials = btoa(`${this.username}:${this.password}`);
          const response = await fetch(`${this.baseUrl}${endpoint}`, {
            headers: { 'Authorization': `Basic ${credentials}` }
          });
          
          if (response.ok) {
            console.log(`✅ Working endpoint found: ${endpoint}`);
            this.workingEndpoint = endpoint;
            return true;
          } else {
            console.log(`   ❌ ${endpoint}: ${response.status}`);
          }
        } catch (err) {
          console.log(`   ❌ ${endpoint}: ${err.message}`);
        }
      }
      
      return false;
    }
  }

  // Get product details
  async getProductDetails(productId) {
    console.log(`🔄 Fetching details for product: ${productId}`);
    return this.makeRequest(`/v2/products/${productId}/`);
  }

  // Get categories
  async getCategories() {
    console.log('🔄 Fetching categories...');
    return this.makeRequest('/v2/categories/');
  }
}

export { SSActiveWearAPI };
