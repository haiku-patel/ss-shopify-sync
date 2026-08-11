import { CONFIG } from './config.js';

class InventoryManager {
  constructor(shopifyApi) {
    this.shopify           = shopifyApi;
    this.primaryLocationId = null;
    this.usWarehouseId     = null;
    this.inventoryEnabled  = true;
  }

  async init() {
    // Option A: hard-coded IDs in .env (no read_locations scope needed)
    const envPrimary     = process.env.SHOPIFY_LOCATION_ID?.trim();
    const envUsWarehouse = process.env.SHOPIFY_US_WAREHOUSE_LOCATION_ID?.trim();

    if (envPrimary) {
      this.primaryLocationId = parseInt(envPrimary, 10);
      console.log(`📍 Primary location (from .env): ID ${this.primaryLocationId}`);
      if (envUsWarehouse) {
        this.usWarehouseId = parseInt(envUsWarehouse, 10);
        console.log(`📍 US Warehouse location (from .env): ID ${this.usWarehouseId}`);
      }
      return this;
    }

    // Option B: resolve by name via API (requires read_locations scope)
    try {
      const locations = await this.shopify.getLocations();
      if (!locations.length) throw new Error('No Shopify locations found');

      const primary = locations.find(l =>
        l.name.toLowerCase().includes(CONFIG.sync.primaryLocationName.toLowerCase())
      ) || locations[0];

      this.primaryLocationId = primary.id;
      console.log(`📍 Primary location: "${primary.name}" (ID: ${primary.id})`);

      const usWarehouse = locations.find(l =>
        l.name.toLowerCase().includes('us warehouse')
      );
      if (usWarehouse) {
        this.usWarehouseId = usWarehouse.id;
        console.log(`📍 US Warehouse location: "${usWarehouse.name}" (ID: ${usWarehouse.id})`);
      } else {
        console.log('   ℹ️  No "US Warehouse" location found — stock will go to primary location.');
        console.log('      Create a location named "US Warehouse" in Shopify Admin → Settings → Locations');
        console.log('      to display the split inventory table.');
      }
    } catch (err) {
      if (err.message.includes('403') || err.message.includes('read_locations')) {
        console.warn('\n⚠️  Missing read_locations scope — inventory sync disabled.');
        console.warn('   Add read_locations + write_inventory scopes to your Shopify custom app,');
        console.warn('   OR add these to .env (no scope needed):');
        console.warn('     SHOPIFY_LOCATION_ID=<primary_location_id>');
        console.warn('     SHOPIFY_US_WAREHOUSE_LOCATION_ID=<us_warehouse_id>  (optional)\n');
        this.inventoryEnabled = false;
      } else {
        throw err;
      }
    }

    return this;
  }

  async setInventoryForProduct(shopifyVariants, variantMeta) {
    if (!this.inventoryEnabled || !this.primaryLocationId) return;

    await Promise.allSettled(
      shopifyVariants.map(async variant => {
        const meta = variantMeta[variant.sku];
        if (!meta || !variant.inventory_item_id) return;

        try {
          await this.shopify.updateInventoryItem(variant.inventory_item_id, { tracked: true });

          await this.shopify.setInventoryLevel(
            this.primaryLocationId, variant.inventory_item_id, 0
          );

          if (this.usWarehouseId && this.usWarehouseId !== this.primaryLocationId) {
            await this.shopify.activateInventoryAtLocation(variant.inventory_item_id, this.usWarehouseId);
            await this.shopify.setInventoryLevel(
              this.usWarehouseId, variant.inventory_item_id, meta.usWarehouseQty
            );
          }
        } catch (err) {
          console.error(`   ⚠️  Inventory set failed for SKU ${variant.sku}: ${err.message}`);
        }
      })
    );
  }

}

export { InventoryManager };
