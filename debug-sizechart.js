import { config } from 'dotenv';
config();

import { SSActiveWearAPI } from './ss-api.js';
import { ssSizeChartUrl } from './transformer.js';

// Fetches a few styles from SS and checks whether size chart data is available.
// Run with: node debug-sizechart.js
// To test specific style IDs: node debug-sizechart.js 39,4397,5514

async function debugSizeChart() {
  const ss = new SSActiveWearAPI();

  // Use CLI args if provided, otherwise fall back to a small default sample
  const argIds = process.argv[2]?.split(',').map(Number).filter(Boolean);
  const styleIds = argIds?.length ? argIds : [39, 4397, 5514, 3278, 2562];

  console.log(`\n🔍 Size Chart Debug — checking ${styleIds.length} style(s): [${styleIds.join(', ')}]\n`);

  let found = 0, missing = 0;

  for (const styleId of styleIds) {
    console.log(`${'─'.repeat(50)}`);
    console.log(`Style ID: ${styleId}`);

    let styleData;
    try {
      const data = await ss.makeRequest(`/v2/styles/?styleid=${styleId}`);
      styleData = Array.isArray(data) ? data[0] : data;
    } catch (err) {
      console.log(`  ❌ SS API error: ${err.message}`);
      continue;
    }

    if (!styleData) {
      console.log(`  ⚠️  No style data returned`);
      missing++;
      continue;
    }

    console.log(`  Brand / Style: ${styleData.brandName} ${styleData.styleName} — ${styleData.title}`);

    // Show all fields that contain "size" or "chart" in their name
    const relatedFields = Object.entries(styleData)
      .filter(([k]) => /size|chart/i.test(k));

    if (relatedFields.length) {
      console.log(`  Fields matching size/chart:`);
      for (const [k, v] of relatedFields) {
        console.log(`    ${k}: ${JSON.stringify(v)}`);
      }
    } else {
      console.log(`  ⚠️  No fields matching "size" or "chart" found`);
    }

    // Check what ssSizeChartUrl produces
    const url = ssSizeChartUrl(styleData);
    if (url) {
      console.log(`  ✅ Size chart URL: ${url}`);
      found++;
    } else {
      console.log(`  ❌ ssSizeChartUrl returned null — metafield would NOT be written`);
      missing++;
    }
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ✅ Size chart found:   ${found}/${styleIds.length}`);
  console.log(`  ❌ Size chart missing: ${missing}/${styleIds.length}`);
  console.log(`${'═'.repeat(50)}\n`);
}

debugSizeChart().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
