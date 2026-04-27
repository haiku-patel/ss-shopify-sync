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
    batchSize: 50,
    syncInterval: 3600000,
    priceMarkup: 1.5,
    autoPublish: false,
  }
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