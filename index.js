import { URLSearchParams } from 'node:url';
import { config } from 'dotenv'; 
import { ProductSync } from './sync.js'; // ✅ Fixed: Correct named import with space

config();  // ✅ Fixed: Proper function call

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
  throw new Error(
    'Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET in your .env file.'
  );
}

let token = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (token && Date.now() < tokenExpiresAt - 60_000) {
    return token;
  }

  console.log('🔄 Fetching new Shopify access token...');

  const response = await fetch(
    `https://${SHOP}.myshopify.com/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token request failed: ${response.status} - ${errorText}`);
  }

  const { access_token, expires_in } = await response.json();
  token = access_token;
  tokenExpiresAt = Date.now() + (expires_in * 1000);
  
  console.log(`✅ Token obtained: ${token}`);
  return token;
}

// Test the token functionality
getToken()
  .then(token => {
    console.log('🎉 Token retrieval successful!');
  })
  .catch(error => {
    console.error('❌ Error:', error.message);
    process.exit(1);
  });
  
async function main() {
  console.log('🎯 SS Activewear ↔ Shopify Sync Starting...\n');
  
  const sync = new ProductSync();
  
  try {
    await sync.syncProducts();
    console.log('\n🎉 Sync completed successfully!');
  } catch (error) {
    console.error('\n💥 Sync failed:', error.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Sync interrupted by user');
  process.exit(0);
});

// main();
