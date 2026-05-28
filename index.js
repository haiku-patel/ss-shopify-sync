import { config } from 'dotenv';
import { ProductSync } from './sync.js';

config();

const shop = process.env.SHOPIFY_SHOP?.trim();

async function refreshAccessToken() {
  const clientId     = process.env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error('Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET in .env');
  }

  const res = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to refresh access token (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const token = data.access_token;
  if (!token) throw new Error(`No access_token in response: ${JSON.stringify(data).slice(0, 300)}`);

  process.env.SHOPIFY_ACCESS_TOKEN = token;
  console.log('✅ Access token refreshed');
}

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

await refreshAccessToken();
main();
