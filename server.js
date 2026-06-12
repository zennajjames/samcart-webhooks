require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Test DB connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('❌ DB connection failed:', err.message);
  else console.log('✅ Connected to Postgres at', res.rows[0].now);
});

app.post('/webhooks/samcart', async (req, res) => {
  const event = req.body;
  console.log('📦 Event received:', event.event_type);
  console.log('📦 Full payload:', JSON.stringify(event, null, 2));

  if (event.event_type === 'order.completed') {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const d = event.data;

      // ── 1. CUSTOMER ──────────────────────────────────────────
      await client.query(`
        INSERT INTO customers (
          customer_id, first_name, last_name, email, phone,
          billing_address_1, billing_address_2,
          billing_city, billing_state, billing_zip, billing_country
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (customer_id) DO UPDATE SET
          first_name = EXCLUDED.first_name,
          last_name  = EXCLUDED.last_name,
          phone      = COALESCE(EXCLUDED.phone, customers.phone)
      `, [
        d.customer?.id,
        d.customer?.first_name,
        d.customer?.last_name,
        d.customer?.email?.toLowerCase(),
        d.customer?.phone,
        d.customer?.billing_address?.address_1,
        d.customer?.billing_address?.address_2,
        d.customer?.billing_address?.city,
        d.customer?.billing_address?.state,
        d.customer?.billing_address?.zip,
        d.customer?.billing_address?.country,
      ]);

      // ── 2. PRODUCT ───────────────────────────────────────────
      // SamCart can send multiple line items; loop through them
      const items = Array.isArray(d.products) ? d.products : [d.product];

      for (const item of items) {
        await client.query(`
          INSERT INTO products (product_id, product_name, sku)
          VALUES ($1, $2, $3)
          ON CONFLICT (product_id) DO UPDATE SET
            product_name = EXCLUDED.product_name
        `, [
          item?.id,
          item?.name,
          item?.sku || null,
        ]);
      }

      // ── 3. ORDER ─────────────────────────────────────────────
      const cleanMoney = (val) =>
        val ? parseFloat(String(val).replace(/[$,]/g, '')) : null;

      await client.query(`
        INSERT INTO orders (
          order_id, customer_id, transaction_id,
          order_date, order_time,
          charge_status, order_total, order_shipping, order_tax,
          payment_method, currency, is_test_order,
          shipping_address_1, shipping_address_2,
          shipping_city, shipping_state, shipping_zip, shipping_country
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (order_id) DO NOTHING
      `, [
        d.order_id,
        d.customer?.id,
        d.transaction_id,
        d.order_date ? new Date(d.order_date) : new Date(),
        d.order_time || null,
        d.charge_status || 'Charged',
        cleanMoney(d.order_total),
        cleanMoney(d.order_shipping),
        cleanMoney(d.order_tax),
        d.payment_method || null,
        d.currency || 'USD',
        d.test_order === true || d.test_order === 'true',
        d.customer?.shipping_address?.address_1,
        d.customer?.shipping_address?.address_2,
        d.customer?.shipping_address?.city,
        d.customer?.shipping_address?.state,
        d.customer?.shipping_address?.zip,
        d.customer?.shipping_address?.country,
      ]);

      // ── 4. ORDER ITEMS ───────────────────────────────────────
      for (const item of items) {
        await client.query(`
          INSERT INTO order_items (order_id, product_id, item_price, quantity, is_upgraded)
          VALUES ($1, $2, $3, $4, $5)
        `, [
          d.order_id,
          item?.id,
          cleanMoney(item?.price),
          item?.quantity || 1,
          item?.upgraded === true || item?.upgraded === 'YES',
        ]);
      }

      await client.query('COMMIT');
      console.log(`✅ Order ${d.order_id} saved — ${items.length} line item(s)`);

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ Error saving order:', err.message);
      return res.status(500).send('Error');
    } finally {
      client.release();
    }
  }

  res.status(200).send('OK');
});

app.listen(process.env.PORT, () => {
  console.log(`🚀 Webhook server running on port ${process.env.PORT}`);
});
