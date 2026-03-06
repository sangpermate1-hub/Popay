require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname)); // Host file HTML và logo.png

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- TIỆN ÍCH CORE ---
async function getBalance(wallet, currency) {
    const res = await pool.query(`
        SELECT SUM(CASE WHEN to_wallet = $1 THEN amount ELSE 0 END) - 
               SUM(CASE WHEN from_wallet = $1 THEN amount ELSE 0 END) as balance
        FROM transaction_history WHERE (to_wallet = $1 OR from_wallet = $1) AND currency = $2
    `, [wallet, currency]);
    return parseFloat(res.rows[0].balance || 0);
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
        const wallet = 'M' + Math.random().toString(36).substring(2, 15).toUpperCase();
        const ref = Math.random().toString(36).substring(2, 8).toUpperCase();
        await pool.query(`INSERT INTO users (wallet_address, full_name, email, password_hash, referral_code, referred_by) VALUES ($1, $2, $3, $4, $5, $6)`, [wallet, full_name, email, hash, ref, referred_by]);
        await recordTx(pool, 'mint', 'SYSTEM', wallet, 0, 'MPT');
        res.status(201).json({ wallet_address: wallet });
    } catch (e) { res.status(400).json({ message: 'Lỗi đăng ký' }); }
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

// --- 2. WALLET & ASSETS ---
app.get('/api/wallet/assets', async (req, res) => {
    const { wallet } = req.query;
    try {
        const mpt = await getBalance(wallet, 'MPT');
        const usdt = await getBalance(wallet, 'USDT');
        res.json({ MPT: mpt, USDT: usdt, TON: 0, USDC: 0, DOGE: 0 });
    } catch (e) { res.status(500).send(); }
});

app.post('/api/wallet/send', async (req, res) => {
    const { from_wallet, to_wallet, amount, currency } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (await getBalance(from_wallet, currency) < amount) throw new Error('Số dư không đủ');
        await recordTx(client, 'transfer', from_wallet, to_wallet, amount, currency);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); }
    finally { client.release(); }
});

// --- 3. WEBHOOKS SEPAY (NẠP) & WITHDRAW (RÚT) ---
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
        if (await getBalance(wallet, asset) < amount) throw new Error('Không đủ số dư');
        await recordTx(client, 'withdraw_hold', wallet, 'SYSTEM_HOLD', amount, asset);
        await client.query(`INSERT INTO withdraw_requests (wallet, asset, amount, vnd_amount, bank) VALUES ($1, $2, $3, $4, $5)`, [wallet, asset, amount, vnd_amount, bank]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); }
    finally { client.release(); }
});

// --- 4. ADMIN PANEL (FULL API) ---
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const u = await pool.query(`SELECT COUNT(*) FROM users`);
        const s = await pool.query(`SELECT SUM(staked_usdt) FROM user_staking`);
        const w = await pool.query(`SELECT COUNT(*) FROM withdraw_requests WHERE status = 'pending'`);
        const k = await pool.query(`SELECT COUNT(*) FROM user_kyc WHERE status = 'pending'`);
        res.json({ total_users: u.rows[0].count, total_staking: s.rows[0].sum || 0, pending_p2p: w.rows[0].count, pending_kyc: k.rows[0].count });
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

// KYC & Tickets
app.get('/api/admin/kyc/pending', async (req, res) => { res.json((await pool.query(`SELECT * FROM user_kyc WHERE status = 'pending'`)).rows); });
app.post('/api/admin/kyc/process', async (req, res) => { await pool.query(`UPDATE user_kyc SET status = $1 WHERE id = $2`, [req.body.status, req.body.id]); res.json({ success: true }); });
app.get('/api/admin/tickets/open', async (req, res) => { res.json((await pool.query(`SELECT * FROM support_tickets WHERE status = 'open'`)).rows); });
app.post('/api/admin/tickets/reply', async (req, res) => { await pool.query(`UPDATE support_tickets SET admin_reply = $1, status = $2 WHERE id = $3`, [req.body.reply, req.body.status, req.body.id]); res.json({ success: true }); });

// --- 5. STAKING & EXPLORER ---
app.get('/api/staking/info', async (req, res) => {
    const { wallet } = req.query;
    let r = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
    if (r.rows.length === 0) { await pool.query(`INSERT INTO user_staking (wallet_address) VALUES ($1)`, [wallet]); r = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]); }
    res.json({ staked_usdt: r.rows[0].staked_usdt, earned_mpt: r.rows[0].earned_mpt, available_usdt: await getBalance(wallet, 'USDT') });
});

app.post('/api/staking/sync-reward', async (req, res) => { await pool.query(`UPDATE user_staking SET earned_mpt = $1, last_updated = CURRENT_TIMESTAMP WHERE wallet_address = $2`, [req.body.new_reward, req.body.wallet]); res.json({ success: true }); });

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

app.post('/api/staking/withdraw', async (req, res) => {
    const { wallet, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const stk = (await client.query(`SELECT * FROM user_staking WHERE wallet_address = $1 FOR UPDATE`, [wallet])).rows[0];
        if (stk.staked_usdt < amount) throw new Error('Vượt số vốn');
        await recordTx(client, 'unstake', 'SYSTEM_STAKING', wallet, amount, 'USDT');
        if (stk.earned_mpt > 0) await recordTx(client, 'reward', 'SYSTEM_STAKING', wallet, stk.earned_mpt, 'MPT');
        await client.query(`UPDATE user_staking SET staked_usdt = staked_usdt - $1, earned_mpt = 0 WHERE wallet_address = $2`, [amount, wallet]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); }
    finally { client.release(); }
});

// Explorer
app.get('/api/explorer/stats', async (req, res) => {
    const u = await pool.query(`SELECT COUNT(*) FROM users`);
    const t = await pool.query(`SELECT COUNT(*) FROM transaction_history`);
    res.json({ total_wallets: parseInt(u.rows[0].count), total_transactions: parseInt(t.rows[0].count), supply_mspw: 1000000000 });
});

app.get('/api/explorer/latest-mints', async (req, res) => { res.json((await pool.query(`SELECT wallet_address as wallet, created_at FROM users ORDER BY created_at DESC LIMIT 6`)).rows); });
app.get('/api/explorer/latest-txns', async (req, res) => { res.json((await pool.query(`SELECT * FROM transaction_history ORDER BY created_at DESC LIMIT 6`)).rows); });

app.get('/api/explorer/search', async (req, res) => {
    const { type, q } = req.query;
    try {
        if (type === 'address') {
            const txs = await pool.query(`SELECT * FROM transaction_history WHERE from_wallet = $1 OR to_wallet = $1 ORDER BY created_at DESC LIMIT 20`, [q]);
            res.json({ wallet_address: q, kyc_status: 'approved', balance_mspw: await getBalance(q, 'MPT'), balance_usdt: await getBalance(q, 'USDT'), txns: txs.rows });
        } else res.json((await pool.query(`SELECT * FROM transaction_history WHERE tx_hash = $1`, [q])).rows[0] || null);
    } catch (e) { res.status(500).send(); }
});

// Settings & Tickets User
app.get('/api/users/tickets', async (req, res) => { res.json((await pool.query(`SELECT * FROM support_tickets WHERE wallet = $1 ORDER BY created_at DESC`, [req.query.wallet])).rows); });
app.post('/api/admin/tickets', async (req, res) => { await pool.query(`INSERT INTO support_tickets (wallet, title, content) VALUES ($1, $2, $3)`, [req.body.wallet, req.body.title, req.body.content]); res.json({ success: true }); });

// Lịch sử lệnh xử lý tại Trade.html
app.get('/api/p2p/my-pending', async (req, res) => {
    const r = await pool.query(`
        SELECT 'withdraw' as type, asset, amount, vnd_amount, status, created_at FROM withdraw_requests WHERE wallet = $1
        UNION ALL
        SELECT 'deposit' as type, currency as asset, amount, (amount * 26800)::text as vnd_amount, 'completed' as status, created_at FROM transaction_history WHERE to_wallet = $1 AND type = 'deposit_sepay'
        ORDER BY created_at DESC
    `, [req.query.wallet]);
    res.json(r.rows);
});

app.get('/api/p2p/my-pending-count', async (req, res) => {
    const r = await pool.query(`SELECT COUNT(*) FROM withdraw_requests WHERE wallet = $1 AND status = 'pending'`, [req.query.wallet]);
    res.json({ count: parseInt(r.rows[0].count) });
});

// ROOT REDIRECT
app.get('*', (req, res) => { if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'login.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MetahashPay Online: ${PORT}`));
