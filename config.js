import { config } from 'dotenv';
config();

export const CONFIG = {
  shopify: {
    shop: process.env.SHOPIFY_SHOP?.trim(),
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN?.trim(),
    clientId: process.env.SHOPIFY_CLIENT_ID?.trim(),
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET?.trim(),
  },
  ssActivewear: {
    username: process.env.SS_USERNAME?.trim(),
    password: process.env.SS_PASSWORD?.trim(),
    baseUrl: 'https://api.ssactivewear.com/v2',
  },
  sync: {
    styleBatchSize:       parseInt(process.env.STYLE_BATCH_SIZE    || '40'),
    shopifyBatchSize:     parseInt(process.env.SHOPIFY_BATCH_SIZE  || '5'),
    requestDelay:         parseInt(process.env.REQUEST_DELAY       || '500'),
    priceMarkupMultiplier: 1.40,
    autoPublish:          process.env.AUTO_PUBLISH === 'true',
    primaryLocationName:  process.env.PRIMARY_LOCATION_NAME || '9400 Harwin Dr.',
  },
};

const required = [
  'SHOPIFY_SHOP',
  'SHOPIFY_ACCESS_TOKEN',
  'SS_USERNAME',
  'SS_PASSWORD'
];

for (const env of required) {
  if (!process.env[env]) {
    throw new Error(`Missing required environment variable: ${env}`);
  }
}

console.log('✅ Configuration loaded successfully');
console.log('Shop:', CONFIG.shopify.shop);
console.log('SS user:', CONFIG.ssActivewear.username);