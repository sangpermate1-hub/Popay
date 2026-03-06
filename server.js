require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- CORE: TÍNH SỐ DƯ (FIX TRIỆT ĐỂ LỖI NaN) ---
async function getBalance(wallet, currency) {
    try {
        const query = `
            SELECT 
                COALESCE(SUM(CASE WHEN to_wallet = $1 THEN amount ELSE 0 END), 0) - 
                COALESCE(SUM(CASE WHEN from_wallet = $1 THEN amount ELSE 0 END), 0) as total
            FROM transaction_history 
            WHERE (to_wallet = $1 OR from_wallet = $1) AND currency = $2
        `;
        const res = await pool.query(query, [wallet, currency]);
        return parseFloat(res.rows[0].total || 0);
    } catch (e) { return 0; }
}

async function recordTx(client, type, from, to, amount, currency) {
    const hash = 'TX' + Math.random().toString(36).substring(2, 12).toUpperCase();
    await client.query(
        `INSERT INTO transaction_history (tx_hash, type, from_wallet, to_wallet, amount, currency) VALUES ($1, $2, $3, $4, $5, $6)`,
        [hash, type, from, to, amount, currency]
    );
    return hash;
}

// --- 1. AUTH & USER ---
app.post('/api/auth/register', async (req, res) => {
    const { full_name, email, password, referred_by } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        const wallet = 'M' + Math.random().toString(36).substring(2, 10).toUpperCase() + Date.now().toString(36).toUpperCase();
        const ref = Math.random().toString(36).substring(2, 8).toUpperCase();
        await pool.query(`INSERT INTO users (wallet_address, full_name, email, password_hash, referral_code, referred_by) VALUES ($1, $2, $3, $4, $5, $6)`, [wallet, full_name, email, hash, ref, referred_by]);
        await recordTx(pool, 'mint', 'SYSTEM', wallet, 0, 'MPT');
        res.status(201).json({ wallet_address: wallet });
    } catch (e) { res.status(400).json({ message: 'Email đã tồn tại' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        if (user.rows.length === 0 || !await bcrypt.compare(password, user.rows[0].password_hash)) {
            return res.status(401).json({ message: 'Sai thông tin' });
        }
        res.json({ token: 'active', wallet_address: user.rows[0].wallet_address });
    } catch (e) { res.status(500).send(); }
});

// --- 2. TÀI SẢN VÍ (INDEX & EXPLORER) ---
app.get('/api/wallet/assets', async (req, res) => {
    const { wallet } = req.query;
    try {
        const [mpt, usdt, ton, usdc, doge] = await Promise.all([
            getBalance(wallet, 'MPT'), getBalance(wallet, 'USDT'),
            getBalance(wallet, 'TON'), getBalance(wallet, 'USDC'), getBalance(wallet, 'DOGE')
        ]);
        res.json({ MPT: mpt, USDT: usdt, TON: ton, USDC: usdc, DOGE: doge });
    } catch (e) { res.json({ MPT: 0, USDT: 0, TON: 0, USDC: 0, DOGE: 0 }); }
});

// --- 3. NẠP (SEPAY) & RÚT (TRADE) ---
app.post('/api/webhooks/sepay', async (req, res) => {
    const { content, amount } = req.body;
    const walletTag = content.replace('MPH', '').toUpperCase();
    try {
        const user = await pool.query(`SELECT wallet_address FROM users WHERE wallet_address LIKE $1`, [`%${walletTag}`]);
        if (user.rows.length > 0) {
            await recordTx(pool, 'deposit_sepay', 'BANK_BIDV', user.rows[0].wallet_address, parseFloat(amount) / 26800, 'USDT');
            res.json({ success: true });
        } else res.status(404).send();
    } catch (e) { res.status(500).send(); }
});

app.post('/api/admin/withdraw-request', async (req, res) => {
    const { wallet, asset, amount, vnd_amount, bank } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (await getBalance(wallet, asset) < amount) throw new Error('Số dư không đủ');
        await recordTx(client, 'withdraw_hold', wallet, 'SYSTEM_HOLD', amount, asset);
        await client.query(`INSERT INTO withdraw_requests (wallet, asset, amount, vnd_amount, bank) VALUES ($1, $2, $3, $4, $5)`, [wallet, asset, amount, vnd_amount, bank]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); }
    finally { client.release(); }
});

// --- 4. ADMIN PANEL (FULL) ---
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const u = await pool.query(`SELECT COUNT(*) FROM users`);
        const w = await pool.query(`SELECT COUNT(*) FROM withdraw_requests WHERE status = 'pending'`);
        const s = await pool.query(`SELECT COALESCE(SUM(staked_usdt), 0) FROM user_staking`);
        res.json({ total_users: u.rows[0].count, total_staking: s.rows[0].coalesce, pending_p2p: w.rows[0].count });
    } catch (e) { res.status(500).send(); }
});

app.get('/api/admin/users', async (req, res) => {
    const r = await pool.query(`SELECT wallet_address, email, created_at FROM users ORDER BY created_at DESC`);
    res.json(r.rows);
});

app.get('/api/admin/withdraws/pending', async (req, res) => {
    const r = await pool.query(`SELECT * FROM withdraw_requests WHERE status = 'pending' ORDER BY created_at DESC`);
    res.json(r.rows);
});

app.post('/api/admin/withdraws/process', async (req, res) => {
    const { id, status } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const req = (await client.query(`SELECT * FROM withdraw_requests WHERE id = $1`, [id])).rows[0];
        if (status === 'completed') await recordTx(client, 'withdraw_done', 'SYSTEM_HOLD', 'BURN', req.amount, req.asset);
        else await recordTx(client, 'withdraw_refund', 'SYSTEM_HOLD', req.wallet, req.amount, req.asset);
        await client.query(`UPDATE withdraw_requests SET status = $1 WHERE id = $2`, [status, id]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).send(); }
    finally { client.release(); }
});

// --- 5. STAKING ---
app.get('/api/staking/info', async (req, res) => {
    const { wallet } = req.query;
    let r = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
    if (r.rows.length === 0) {
        await pool.query(`INSERT INTO user_staking (wallet_address) VALUES ($1)`, [wallet]);
        r = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
    }
    res.json({ staked_usdt: r.rows[0].staked_usdt, earned_mpt: r.rows[0].earned_mpt, available_usdt: await getBalance(wallet, 'USDT') });
});

app.post('/api/staking/deposit', async (req, res) => {
    const { wallet, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (await getBalance(wallet, 'USDT') < amount) throw new Error('Không đủ USDT');
        await recordTx(client, 'stake', wallet, 'SYSTEM_STAKING', amount, 'USDT');
        await client.query(`UPDATE user_staking SET staked_usdt = staked_usdt + $1 WHERE wallet_address = $2`, [amount, wallet]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); }
    finally { client.release(); }
});

// --- 6. EXPLORER (MPT SCAN) ---
app.get('/api/explorer/stats', async (req, res) => {
    const u = await pool.query(`SELECT COUNT(*) FROM users`);
    const t = await pool.query(`SELECT COUNT(*) FROM transaction_history`);
    res.json({ total_wallets: parseInt(u.rows[0].count), total_transactions: parseInt(t.rows[0].count), supply_mspw: 1000000000 });
});

app.get('/api/explorer/search', async (req, res) => {
    const { type, q } = req.query;
    if (type === 'address') {
        const txs = await pool.query(`SELECT * FROM transaction_history WHERE from_wallet = $1 OR to_wallet = $1 ORDER BY created_at DESC LIMIT 20`, [q]);
        res.json({ wallet_address: q, balance_mspw: await getBalance(q, 'MPT'), balance_usdt: await getBalance(q, 'USDT'), txns: txs.rows });
    } else {
        const tx = await pool.query(`SELECT * FROM transaction_history WHERE tx_hash = $1`, [q]);
        res.json(tx.rows[0] || null);
    }
});

// Lịch sử lệnh xử lý tại Trade
app.get('/api/p2p/my-pending', async (req, res) => {
    const r = await pool.query(`
        SELECT 'withdraw' as type, asset, amount, vnd_amount, status, created_at FROM withdraw_requests WHERE wallet = $1
        UNION ALL
        SELECT 'deposit' as type, currency as asset, amount, (amount * 26800)::text as vnd_amount, 'completed' as status, created_at FROM transaction_history WHERE to_wallet = $1 AND type = 'deposit_sepay'
        ORDER BY created_at DESC
    `, [req.query.wallet]);
    res.json(r.rows);
});

// Root & Web Server
app.get('*', (req, res) => { if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'login.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 System Online: ${PORT}`));
