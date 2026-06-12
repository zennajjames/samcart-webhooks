require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('❌ DB connection failed:', err.message);
  else console.log('✅ Connected to Postgres at', res.rows[0].now);
});

app.post('/webhooks/samcart', async (req, res) => {
  const event = req.body;
  console.log('📦 Event received:', event.type);
  console.log('📦 Full payload:', JSON.stringify(event, null, 2));

  if (event.type === 'Order') {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const c = event.customer;
      const o = event.order;
      const products = event.products || [];

      const cleanMoney = (val) =>
        val ? parseFloat(String(val).replace(/[$,]/g, '')) : null;

      // ── 1. CUSTOMER ──────────────────────────────────────────
      await client.query(`
        INSERT INTO customers (
          customer_id, first_name, last_name, email, phone,
          billing_address_1, billing_city, billing_state,
          billing_zip, billing_country
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (customer_id) DO UPDATE SET
          first_name = EXCLUDED.first_name,
          last_name  = EXCLUDED.last_name,
          phone      = COALESCE(EXCLUDED.phone, customers.phone)
      `, [
        c.customer_id,
        c.first_name,
        c.last_name,
        c.email?.toLowerCase(),
        c.phone_number || null,
        c.billing_address || null,
        c.billing_city || null,
        c.billing_state || null,
        c.billing_zip || null,
        c.billing_country || null,
      ]);

      // ── 2. PRODUCTS ──────────────────────────────────────────
      for (const item of products) {
        await client.query(`
          INSERT INTO products (product_id, product_name)
          VALUES ($1, $2)
          ON CONFLICT (product_id) DO UPDATE SET
            product_name = EXCLUDED.product_name
        `, [
          item.id,
          item.name,
        ]);
      }

      // ── 3. ORDER ─────────────────────────────────────────────
      const transactionId = Array.isArray(o.transaction_id)
        ? o.transaction_id[0]
        : o.transaction_id;

      await client.query(`
        INSERT INTO orders (
          order_id, customer_id, transaction_id,
          order_date, charge_status,
          order_total, order_shipping, order_tax,
          payment_method, currency, is_test_order,
          shipping_address_1, shipping_city, shipping_state,
          shipping_zip, shipping_country
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (order_id) DO NOTHING
      `, [
        o.id,
        c.customer_id,
        transactionId,
        o.created_at ? new Date(o.created_at) : new Date(),
        products[0]?.status || 'Charged',
        cleanMoney(o.total),
        cleanMoney(o.total_shipping),
        cleanMoney(o.total_tax),
        o.processor || null,
        'USD',
        false,
        o.shipping_address || null,
        o.shipping_city || null,
        o.shipping_state || null,
        o.shipping_zip || null,
        o.shipping_country || null,
      ]);

      // ── 4. ORDER ITEMS ───────────────────────────────────────
      for (const item of products) {
        await client.query(`
          INSERT INTO order_items (order_id, product_id, item_price, quantity)
          VALUES ($1, $2, $3, $4)
        `, [
          o.id,
          item.id,
          cleanMoney(item.price),
          item.quantity || 1,
        ]);
      }

      await client.query('COMMIT');
      console.log(`✅ Order ${o.id} saved — ${products.length} line item(s)`);

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
