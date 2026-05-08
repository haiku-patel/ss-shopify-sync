import { config } from 'dotenv';
import { ProductSync } from './sync.js';

config();

// Shopify custom-app access tokens are permanent — copy the Admin API access token
// from Shopify Admin → Apps → your app → API credentials into .env as
// SHOPIFY_ACCESS_TOKEN. No runtime refresh is needed or supported.

async function main() {
  // CLI:  node index.js [--skus SKU1,SKU2,...] [--initial] [--resume]
  //   (no flags)  ongoing sync  — update existing, create new vendor styles
  //   --initial   bulk load     — first-time upload with daily limit tracking
  //   --resume    continue load — pick up where --initial left off
  const args        = process.argv.slice(2);
  const skuFlag     = args.indexOf('--skus');
  const targetSkus  = skuFlag !== -1
    ? args[skuFlag + 1]?.split(',').filter(Boolean)
    : null;
  const initialMode = args.includes('--initial');
  const resumeMode  = args.includes('--resume');

  const sync = new ProductSync({ initial: initialMode, resume: resumeMode });
  syncInstance = sync;

  try {
    if (targetSkus?.length) {
      console.log(`\n🎯 Partial sync — targeting ${targetSkus.length} SKU(s)`);
      await sync.syncSkus(targetSkus);
    } else {
      if (initialMode) console.log('\n📦 Initial load mode — daily variant limit tracking enabled');
      if (resumeMode)  console.log('\n🔁 Resume mode — continuing from last checkpoint...');
      await sync.fullSync();
    }
    console.log('\n🎉 Done!');
  } catch (error) {
    console.error('\n💥 Sync failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

let syncInstance = null;
process.on('SIGINT', () => {
  console.log('\n👋 Interrupted — saving checkpoint and exiting...');
  syncInstance?._saveCheckpoint();
  process.exit(0);
});

main();
