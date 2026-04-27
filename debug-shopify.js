import { config } from 'dotenv';
config();

async function debugShopify() {
  const shop = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  console.log('🔍 Shopify Debug Information:');
  console.log(`Shop: ${shop}`);
  console.log(`Token: ${token?.substring(0, 15)}...`);
  console.log(`Token length: ${token?.length}`);
  console.log(`Full shop URL: https://${shop}.myshopify.com`);

  // Test 1: Simple shop info
  console.log('\n🧪 Test 1: Basic shop info...');
  try {
    const response = await fetch(`https://${shop}.myshopify.com/admin/api/2025-01/shop.json`, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });

    console.log(`Response status: ${response.status}`);
    console.log(`Response headers:`, Object.fromEntries(response.headers.entries()));

    if (response.ok) {
      const data = await response.json();
      console.log('✅ Success!', data.shop?.name);
    } else {
      const errorText = await response.text();
      console.log('❌ Error:', errorText);
    }
  } catch (error) {
    console.log('❌ Request failed:', error.message);
  }

  // Test 2: Try different API versions
  console.log('\n🧪 Test 2: Try different API versions...');
  const versions = ['2025-01', '2024-10', '2024-07', '2024-04'];
  
  for (const version of versions) {
    try {
      const response = await fetch(`https://${shop}.myshopify.com/admin/api/${version}/shop.json`, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      });
      
      console.log(`   API ${version}: ${response.status} ${response.ok ? '✅' : '❌'}`);
      
      if (response.ok) {
        const data = await response.json();
        console.log(`     Shop name: ${data.shop?.name}`);
        break;
      } else if (response.status === 401) {
        const errorText = await response.text();
        console.log(`     Error: ${errorText}`);
      }
    } catch (error) {
      console.log(`   API ${version}: Error - ${error.message}`);
    }
  }

  // Test 3: Check token format
  console.log('\n🧪 Test 3: Token validation...');
  if (!token) {
    console.log('❌ No token found in environment variables');
  } else if (!token.startsWith('shpat_')) {
    console.log('⚠️  Token doesn\'t start with "shpat_" - this might be an issue');
    console.log('   Expected format: shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  } else {
    console.log('✅ Token format looks correct');
  }

  // Test 4: Check if it's a custom app token vs admin API token
  console.log('\n🧪 Test 4: Testing with GraphQL...');
  try {
    const response = await fetch(`https://${shop}.myshopify.com/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({
        query: `{
          shop {
            name
            email
            plan {
              displayName
            }
          }
        }`
      }),
    });

    console.log(`GraphQL Response status: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      if (data.errors) {
        console.log('❌ GraphQL errors:', data.errors);
      } else {
        console.log('✅ GraphQL Success!', data.data?.shop?.name);
      }
    } else {
      const errorText = await response.text();
      console.log('❌ GraphQL Error:', errorText);
    }
  } catch (error) {
    console.log('❌ GraphQL Request failed:', error.message);
  }
}

debugShopify();
