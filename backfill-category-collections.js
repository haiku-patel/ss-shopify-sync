import { config } from 'dotenv';
config();

import { ShopifyAPI } from './shopify-api.js';
import { CollectionManager } from './collections.js';
import { CLEAN_CATEGORY_MAP } from './transformer.js';

// One-time reconciliation: organize EVERY product in the store into exactly
// the 11 approved category collections, and delete every other custom
// collection (brand collections, color-family collections, leftover old
// raw-named category collections, and anything else) — the storefront's
// "Categories" sidebar has no per-collection curation, it lists every custom
// collection that exists, so getting it down to just the 11 requires the
// store to actually only HAVE those 11. This script:
//   1. Sweeps every Shopify product (not just SS-linked ones) and makes sure
//      it's a member of the collection matching its current product_type.
//   2. Reports stragglers whose product_type isn't one of the 11 — split by
//      whether they're SS-linked (fixable by re-running `node index.js`) or
//      not (needs manual product_type assignment in Shopify Admin).
//   3. Deletes every custom collection whose title isn't one of the 11,
//      including duplicates of a kept name (keeps exactly one of each).
//
// Run with:           node backfill-category-collections.js
// Preview only (no writes/deletes): node backfill-category-collections.js --dry-run

const DRY_RUN = process.argv.includes('--dry-run');

const CLEAN_NAMES = [...new Set(Object.values(CLEAN_CATEGORY_MAP))];

async function backfillCategoryCollections() {
  console.log(`\n🔧 Category collection backfill${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);
  console.log(`   Target clean categories (kept): ${CLEAN_NAMES.join(', ')}\n`);

  const shopify     = new ShopifyAPI();
  await shopify.testConnection();
  const collections = await new CollectionManager(shopify).init();

  console.log('\n📥 Loading all Shopify products...');
  const allProducts = await shopify.getAllProducts();
  console.log(`   ${allProducts.length} product(s) total — organizing all of them, not just SS-linked ones.`);

  const isSsLinked = p => (p.tags || '').split(',').map(t => t.trim()).some(t => t.startsWith('ss-style:'));

  // ── Step 1: ensure every product is in its correct clean collection ────
  const byCategory = new Map();
  const stragglers = [];

  for (const p of allProducts) {
    if (CLEAN_NAMES.includes(p.product_type)) {
      if (!byCategory.has(p.product_type)) byCategory.set(p.product_type, []);
      byCategory.get(p.product_type).push(p);
    } else {
      stragglers.push(p);
    }
  }

  console.log('\n📂 Reconciling collection membership...');
  let assigned = 0;
  for (const [category, products] of byCategory) {
    console.log(`   ${category}: ${products.length} product(s)`);
    for (const p of products) {
      if (!DRY_RUN) await collections.assignToCategory(p.id, category);
      assigned++;
      if (assigned % 250 === 0) console.log(`      ...${assigned} assignment(s) processed`);
    }
  }
  console.log(`   ✅ ${assigned} assignment(s) ${DRY_RUN ? 'would be ' : ''}made`);

  if (stragglers.length) {
    const ssStragglers    = stragglers.filter(isSsLinked);
    const otherStragglers = stragglers.filter(p => !isSsLinked(p));

    if (ssStragglers.length) {
      console.log(`\n⚠️  ${ssStragglers.length} SS-linked product(s) still have an unmapped/old product_type — run "node index.js" again to correct these, then re-run this script:`);
      for (const p of ssStragglers.slice(0, 25)) {
        console.log(`      - [${p.id}] "${p.title}" — product_type="${p.product_type}"`);
      }
      if (ssStragglers.length > 25) console.log(`      ...and ${ssStragglers.length - 25} more`);
    }
    if (otherStragglers.length) {
      console.log(`\n⚠️  ${otherStragglers.length} non-SS product(s) have a product_type outside the 11 clean categories — this script can't guess the right one; assign product_type manually in Shopify Admin, then re-run:`);
      for (const p of otherStragglers.slice(0, 25)) {
        console.log(`      - [${p.id}] "${p.title}" — product_type="${p.product_type}"`);
      }
      if (otherStragglers.length > 25) console.log(`      ...and ${otherStragglers.length - 25} more`);
    }
  } else {
    console.log('\n✅ No stragglers — every product already has a clean product_type.');
  }

  // ── Step 2: retire every collection except the 11 kept ones ────────────
  console.log('\n🗑️  Retiring non-category collections...');
  const existing = await shopify.getCustomCollections();
  const keepSet  = new Set(CLEAN_NAMES.map(n => n.toLowerCase()));

  const byLowerTitle = new Map();
  for (const c of existing) {
    const key = c.title.toLowerCase();
    if (!byLowerTitle.has(key)) byLowerTitle.set(key, []);
    byLowerTitle.get(key).push(c);
  }

  const toDelete = [];
  for (const [key, group] of byLowerTitle) {
    if (keepSet.has(key)) {
      if (group.length > 1) {
        console.warn(`   ⚠️  Duplicate collection "${group[0].title}" (${group.length}x) — keeping id ${group[0].id}, retiring the rest`);
        toDelete.push(...group.slice(1));
      }
    } else {
      toDelete.push(...group);
    }
  }

  console.log(`   ${toDelete.length} collection(s) to retire (out of ${existing.length} total).`);
  let deleted = 0;
  for (const c of toDelete) {
    if (DRY_RUN) {
      console.log(`   🔎 Would delete "${c.title}" (id ${c.id})`);
      continue;
    }
    try {
      await shopify.deleteCustomCollection(c.id);
      console.log(`   🗑️  Deleted "${c.title}" (id ${c.id})`);
      deleted++;
    } catch (err) {
      console.warn(`   ⚠️  Failed to delete "${c.title}": ${err.message}`);
    }
  }
  if (!DRY_RUN) console.log(`   ✅ ${deleted}/${toDelete.length} collection(s) deleted`);

  console.log(`\n🎉 Done${DRY_RUN ? ' (dry run — nothing was actually changed)' : ''}!\n`);
}

backfillCategoryCollections().catch(err => {
  console.error('Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
