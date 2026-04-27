import { ShopifyAPI } from './shopify-api.js';
import { SSActiveWearAPI } from './ss-api.js';

async function testShopify() {
  console.log('🧪 Testing Shopify connection...');
  const shopify = new ShopifyAPI();
  
  try {
    const result = await shopify.testConnection();
    return result;
  } catch (error) {
    console.error('❌ Shopify detailed error:', error.message);
    return false;
  }
}

async function testSSActivewear() {
  console.log('🧪 Testing SS Activewear connection...');
  const ss = new SSActiveWearAPI();
  
  try {
    const result = await ss.testConnection();
    return result;
  } catch (error) {
    console.error('❌ SS Activewear detailed error:', error.message);
    return false;
  }
}

async function testConnections() {
  console.log('🔍 Testing API connections...\n');

  // Test Shopify
  console.log('1️⃣ Testing Shopify...');
  const shopifyWorking = await testShopify();
  
  console.log('\n' + '='.repeat(50) + '\n');
  
  // Test SS Activewear  
  console.log('2️⃣ Testing SS Activewear...');
  const ssWorking = await testSSActivewear();

  console.log('\n📊 Final Connection Summary:');
  console.log(`   Shopify: ${shopifyWorking ? '✅' : '❌'}`);
  console.log(`   SS Activewear: ${ssWorking ? '✅' : '❌'}`);
  
  if (shopifyWorking && ssWorking) {
    console.log('\n🎉 All connections working! Ready to sync.');
    
    // Quick sample check
    try {
      console.log('\n📦 Quick sample check...');
      const shopify = new ShopifyAPI();
      const products = await shopify.getProducts(5);
      console.log(`   Existing Shopify products: ${products.products?.length || 0}`);
    } catch (error) {
      console.log(`   Could not fetch sample products: ${error.message}`);
    }
    
  } else {
    console.log('\n⚠️  Please fix the connection issues above before syncing.');
  }
}

testConnections();
