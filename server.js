require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();

// --- 1. CẤU HÌNH MIDDLEWARE & STATIC HOST ---
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname)); // Phục vụ toàn bộ file HTML, hình ảnh, CSS

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==========================================
// CORE LOGIC: HÀM TÍNH TOÁN (FIX LỖI NaN)
// ==========================================
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
    const hash = 'TX' + Math.random().toString(36).substring(2, 10).toUpperCase() + Date.now().toString(36).toUpperCase();
    await client.query(
        `INSERT INTO transaction_history (tx_hash, type, from_wallet, to_wallet, amount, currency) VALUES ($1, $2, $3, $4, $5, $6)`,
        [hash, type, from, to, amount, currency]
    );
    return hash;
}

// ==========================================
// MODULE 1: XÁC THỰC (AUTH)
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    const { full_name, email, password, referred_by } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        const wallet = 'M' + Math.random().toString(36).substring(2, 15).toUpperCase();
        const ref = Math.random().toString(36).substring(2, 8).toUpperCase();
        await pool.query(`INSERT INTO users (wallet_address, full_name, email, password_hash, referral_code, referred_by) VALUES ($1, $2, $3, $4, $5, $6)`, 
            [wallet, full_name, email, hash, ref, referred_by]);
        await recordTx(pool, 'mint', 'SYSTEM', wallet, 0, 'MPT');
        res.status(201).json({ wallet_address: wallet });
    } catch (e) { res.status(400).json({ message: 'Email đã tồn tại hoặc lỗi dữ liệu' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        if (user.rows.length === 0 || !await bcrypt.compare(password, user.rows[0].password_hash)) {
            return res.status(401).json({ message: 'Sai thông tin đăng nhập' });
        }
        res.json({ token: 'active_session_metahash', wallet_address: user.rows[0].wallet_address });
    } catch (e) { res.status(500).send(); }
});

// ==========================================
// MODULE 2: VÍ & TÀI SẢN (INDEX.HTML)
// ==========================================
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

app.post('/api/wallet/send', async (req, res) => {
    const { from_wallet, to_wallet, amount, currency } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const bal = await getBalance(from_wallet, currency);
        if (bal < amount) throw new Error('Số dư không đủ');
        await recordTx(client, 'transfer', from_wallet, to_wallet, amount, currency);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); }
    finally { client.release(); }
});

// ==========================================
// MODULE 3: GIAO DỊCH (TRADE.HTML & SEPAY)
// ==========================================
// Webhook nạp tiền tự động
app.post('/api/webhooks/sepay', async (req, res) => {
    const { content, amount } = req.body;
    const tag = content.replace('MPH', '').toUpperCase();
    try {
        const user = await pool.query(`SELECT wallet_address FROM users WHERE wallet_address LIKE $1`, [`%${tag}`]);
        if (user.rows.length > 0) {
            const usdtReceived = parseFloat(amount) / 26800;
            await recordTx(pool, 'deposit_sepay', 'BANK_BIDV', user.rows[0].wallet_address, usdtReceived, 'USDT');
            res.json({ success: true });
        } else res.status(404).send();
    } catch (e) { res.status(500).send(); }
});

// Yêu cầu rút tiền gửi Admin
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

// Xem lịch sử nạp rút tại Trade.html tab 3
app.get('/api/p2p/my-pending', async (req, res) => {
    const { wallet } = req.query;
    try {
        const r = await pool.query(`
            SELECT 'withdraw' as type, asset, amount, vnd_amount, status, created_at FROM withdraw_requests WHERE wallet = $1
            UNION ALL
            SELECT 'deposit' as type, currency as asset, amount, (amount * 26800)::text as vnd_amount, 'completed' as status, created_at 
            FROM transaction_history WHERE to_wallet = $1 AND type = 'deposit_sepay'
            ORDER BY created_at DESC
        `, [wallet]);
        res.json(r.rows);
    } catch (e) { res.status(500).send(); }
});

// ==========================================
// MODULE 4: QUẢN TRỊ (ADMIN.HTML)
// ==========================================
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const u = await pool.query(`SELECT COUNT(*) FROM users`);
        const w = await pool.query(`SELECT COUNT(*) FROM withdraw_requests WHERE status = 'pending'`);
        const k = await pool.query(`SELECT COUNT(*) FROM user_kyc WHERE status = 'pending'`);
        res.json({ total_users: u.rows[0].count, total_staking: 0, pending_p2p: w.rows[0].count, pending_kyc: k.rows[0].count });
    } catch (e) { res.status(500).send(); }
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
        const reqData = (await client.query(`SELECT * FROM withdraw_requests WHERE id = $1`, [id])).rows[0];
        if (status === 'completed') await recordTx(client, 'withdraw_done', 'SYSTEM_HOLD', 'BURN', reqData.amount, reqData.asset);
        else await recordTx(client, 'withdraw_refund', 'SYSTEM_HOLD', reqData.wallet, reqData.amount, reqData.asset);
        await client.query(`UPDATE withdraw_requests SET status = $1 WHERE id = $2`, [status, id]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).send(); }
    finally { client.release(); }
});

app.get('/api/admin/users', async (req, res) => {
    const r = await pool.query(`SELECT wallet_address, email, created_at FROM users ORDER BY created_at DESC`);
    res.json(r.rows);
});

// ==========================================
// MODULE 5: STAKING
// ==========================================
app.get('/api/staking/info', async (req, res) => {
    const { wallet } = req.query;
    try {
        let r = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
        if (r.rows.length === 0) {
            await pool.query(`INSERT INTO user_staking (wallet_address) VALUES ($1)`, [wallet]);
            r = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
        }
        res.json({ staked_usdt: r.rows[0].staked_usdt, earned_mpt: r.rows[0].earned_mpt, available_usdt: await getBalance(wallet, 'USDT') });
    } catch (e) { res.status(500).send(); }
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

// ==========================================
// MODULE 6: EXPLORER (MPT SCAN)
// ==========================================
app.get('/api/explorer/stats', async (req, res) => {
    const u = await pool.query(`SELECT COUNT(*) FROM users`);
    const t = await pool.query(`SELECT COUNT(*) FROM transaction_history`);
    res.json({ total_wallets: parseInt(u.rows[0].count), total_transactions: parseInt(t.rows[0].count), supply_mspw: 1000000000 });
});

app.get('/api/explorer/search', async (req, res) => {
    const { type, q } = req.query;
    try {
        if (type === 'address') {
            const txs = await pool.query(`SELECT * FROM transaction_history WHERE from_wallet = $1 OR to_wallet = $1 ORDER BY created_at DESC LIMIT 15`, [q]);
            res.json({ wallet_address: q, balance_mspw: await getBalance(q, 'MPT'), balance_usdt: await getBalance(q, 'USDT'), txns: txs.rows });
        } else {
            const tx = await pool.query(`SELECT * FROM transaction_history WHERE tx_hash = $1`, [q]);
            res.json(tx.rows[0] || null);
        }
    } catch (e) { res.status(500).send(); }
});

// ==========================================
// CẤU HÌNH WEB SERVER CHỐNG LỖI ROUTING
// ==========================================
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'login.html'));
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MetahashPay Online: ${PORT}`));
