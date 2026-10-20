const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!SECRET_KEY) {
  console.error("PAYSTACK_SECRET_KEY is missing");
  process.exit(1);
}

// Database path.
// On Render, mount a persistent disk at /var/data.
const dbPath = process.env.DB_PATH || path.join(__dirname, "wallet.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    email TEXT PRIMARY KEY,
    balance_kobo INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    reference TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    amount_kobo INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const findTransaction = db.prepare(`
  SELECT * FROM transactions WHERE reference = ?
`);

const createTransaction = db.prepare(`
  INSERT INTO transactions
    (reference, email, amount_kobo, status)
  VALUES (?, ?, ?, 'pending')
`);

const createWallet = db.prepare(`
  INSERT INTO wallets (email, balance_kobo)
  VALUES (?, 0)
  ON CONFLICT(email) DO NOTHING
`);

const getWallet = db.prepare(`
  SELECT balance_kobo FROM wallets WHERE email = ?
`);

const creditWallet = db.prepare(`
  UPDATE wallets
  SET balance_kobo = balance_kobo + ?
  WHERE email = ?
`);

const markSuccessful = db.prepare(`
  UPDATE transactions
  SET status = 'success'
  WHERE reference = ? AND status = 'pending'
`);

const markFailed = db.prepare(`
  UPDATE transactions
  SET status = 'failed'
  WHERE reference = ? AND status = 'pending'
`);

const creditOnce = db.transaction((reference) => {
  const tx = findTransaction.get(reference);

  if (!tx) {
    throw new Error("Transaction not found");
  }

  if (tx.status === "success") {
    return false;
  }

  if (tx.status !== "pending") {
    throw new Error("Transaction is not pending");
  }

  createWallet.run(tx.email);
  creditWallet.run(tx.amount_kobo, tx.email);
  markSuccessful.run(reference);

  return true;
});

// 1. Initialize a Paystack payment.
app.post("/api/payments/initialize", async (req, res) => {
  try {
    const email =
      typeof req.body.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";

    const amountNaira = Number(req.body.amount);

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !Number.isFinite(amountNaira) ||
      amountNaira < 100 ||
      amountNaira > 1000000 ||
      Math.round(amountNaira * 100) !== amountNaira * 100
    ) {
      return res.status(400).json({
        error: "Enter a valid email and an amount from ₦100 to ₦1,000,000."
      });
    }

    const amountKobo = Math.round(amountNaira * 100);
    const reference = "DAVTU_" + crypto.randomUUID();

    const callbackUrl =
      process.env.PAYSTACK_CALLBACK_URL ||
      `${req.protocol}://${req.get("host")}/payment/callback`;

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          amount: amountKobo,
          reference,
          callback_url: callbackUrl,
          currency: "NGN",
          channels: ["card", "bank", "ussd", "bank_transfer"]
        })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.status || !result.data?.authorization_url) {
      return res.status(502).json({
        error: "Could not initialize payment. Check your Paystack settings."
      });
    }

    createTransaction.run(reference, email, amountKobo);

    return res.json({
      authorization_url: result.data.authorization_url,
      reference
    });
  } catch (error) {
    console.error("Payment initialization error:", error.message);

    return res.status(500).json({
      error: "Unable to start payment."
    });
  }
});

// 2. Verify a transaction directly with Paystack.
async function verifyWithPaystack(reference) {
  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`
      }
    }
  );

  const result = await response.json();

  if (!response.ok || !result.status || !result.data) {
    throw new Error("Paystack verification failed");
  }

  return result.data;
}

// 3. Verify payment and credit the wallet only once.
app.post("/api/payments/verify", async (req, res) => {
  try {
    const reference = req.body.reference;

    if (
      typeof reference !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(reference)
    ) {
      return res.status(400).json({
        error: "Invalid payment reference."
      });
    }

    const tx = findTransaction.get(reference);

    if (!tx) {
      return res.status(404).json({
        error: "Transaction not found."
      });
    }

    if (tx.status === "success") {
      const wallet = getWallet.get(tx.email);

      return res.json({
        success: true,
        alreadyCredited: true,
        balance: wallet.balance_kobo / 100
      });
    }

    if (tx.status !== "pending") {
      return res.status(400).json({
        error: "This transaction is not pending."
      });
    }

    const payment = await verifyWithPaystack(reference);

    if (
      payment.status !== "success" ||
      payment.reference !== reference ||
      payment.amount !== tx.amount_kobo ||
      payment.currency !== "NGN" ||
      payment.customer?.email?.toLowerCase() !== tx.email
    ) {
      return res.status(400).json({
        error: "Payment could not be verified."
      });
    }

    creditOnce(reference);

    const wallet = getWallet.get(tx.email);

    return res.json({
      success: true,
      message: "Payment verified and wallet credited.",
      balance: wallet.balance_kobo / 100
    });
  } catch (error) {
    console.error("Payment verification error:", error.message);

    return res.status(500).json({
      error: "Could not verify payment. Please check again."
    });
  }
});

// 4. Paystack webhook.
// This allows Paystack to notify your server about successful payments.
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];

    const expected = crypto
      .createHmac("sha512", SECRET_KEY)
      .update(req.body)
      .digest("hex");

    if (
      typeof signature !== "string" ||
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
      )
    ) {
      return res.sendStatus(401);
    }

    let event;

    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.sendStatus(400);
    }

    // Acknowledge events that do not require wallet crediting.
    if (event.event !== "charge.success") {
      return res.sendStatus(200);
    }

    try {
      const reference = event.data?.reference;
      const tx = findTransaction.get(reference);

      if (!tx) {
        // Do not credit a reference that our server did not create.
        console.error("Unknown payment reference:", reference);
        return res.sendStatus(200);
      }

      const payment = await verifyWithPaystack(reference);

      if (
        payment.status !== "success" ||
        payment.reference !== reference ||
        payment.amount !== tx.amount_kobo ||
        payment.currency !== "NGN" ||
        payment.customer?.email?.toLowerCase() !== tx.email
      ) {
        return res.sendStatus(200);
      }

      creditOnce(reference);

      return res.sendStatus(200);
    } catch (error) {
      console.error("Webhook processing error:", error.message);

      // A non-2xx response allows Paystack to retry the webhook.
      return res.sendStatus(500);
    }
  }
);

// 5. Check wallet balance.
// This endpoint is for testing only until authentication is added.
app.get("/api/wallet", (req, res) => {
  const email =
    typeof req.query.email === "string"
      ? req.query.email.trim().toLowerCase()
      : "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: "A valid email is required."
    });
  }

  createWallet.run(email);

  const wallet = getWallet.get(email);

  return res.json({
    balance: wallet.balance_kobo / 100,
    currency: "NGN"
  });
});

// 6. Payment callback page.
app.get("/payment/callback", (req, res) => {
  res.send(`
    <!doctype html>
    <html lang="en">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Payment Status</title>
      <body style="font-family:Arial,sans-serif;padding:30px">
        <h2>Payment submitted</h2>
        <p>Return to Dan Ahmed VTU to check your payment status.</p>
        <p>Do not assume payment succeeded until verification completes.</p>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Dan Ahmed VTU server listening on port ${PORT}`);
});
