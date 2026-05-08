import { config } from 'dotenv';
import { ProductSync } from './sync.js';

config();

// Shopify custom-app access tokens are permanent — copy the Admin API access token
// from Shopify Admin → Apps → your app → API credentials into .env as
// SHOPIFY_ACCESS_TOKEN. No runtime refresh is needed or supported.

async function main() {
  // CLI:  node index.js [--skus SKU1,SKU2,...]
  const args      = process.argv.slice(2);
  const skuFlag   = args.indexOf('--skus');
  const targetSkus = skuFlag !== -1
    ? args[skuFlag + 1]?.split(',').filter(Boolean)
    : null;

  const sync = new ProductSync();

  try {
    if (targetSkus?.length) {
      console.log(`\n🎯 Partial sync — targeting ${targetSkus.length} SKU(s)`);
      await sync.syncSkus(targetSkus);
    } else {
      await sync.fullSync();
    }
    console.log('\n🎉 Done!');
  } catch (error) {
    console.error('\n💥 Sync failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('\n👋 Interrupted — exiting cleanly');
  process.exit(0);
});

main();
