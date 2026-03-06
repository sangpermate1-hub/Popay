require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();

// --- CẤU HÌNH HỆ THỐNG ---
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname)); // Cho phép truy cập index.html, admin.html, logo.png...

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- UTILS: TÍNH SỐ DƯ THỰC TẾ ---
async function getBalance(wallet, currency) {
    const res = await pool.query(`
        SELECT 
            SUM(CASE WHEN to_wallet = $1 THEN amount ELSE 0 END) - 
            SUM(CASE WHEN from_wallet = $1 THEN amount ELSE 0 END) as balance
        FROM transaction_history WHERE (to_wallet = $1 OR from_wallet = $1) AND currency = $2
    `, [wallet, currency]);
    return parseFloat(res.rows[0].balance || 0);
}

async function recordTx(client, type, from, to, amount, currency) {
    const hash = 'TX' + Math.random().toString(36).substring(2, 15).toUpperCase();
    await client.query(
        `INSERT INTO transaction_history (tx_hash, type, from_wallet, to_wallet, amount, currency) VALUES ($1, $2, $3, $4, $5, $6)`,
        [hash, type, from, to, amount, currency]
    );
    return hash;
}

// --- ROUTING GIAO DIỆN ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// --- 1. API XÁC THỰC ---
app.post('/api/auth/register', async (req, res) => {
    const { full_name, email, password, referred_by } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        const wallet = 'M' + Math.random().toString(36).substring(2, 15).toUpperCase() + Math.random().toString(36).substring(2, 15).toUpperCase();
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
            return res.status(401).json({ message: 'Sai tài khoản hoặc mật khẩu' });
        }
        res.json({ token: 'active-session', wallet_address: user.rows[0].wallet_address });
    } catch (e) { res.status(500).send(); }
});

// --- 2. API VÍ & NẠP RÚT ---
app.get('/api/wallet/assets', async (req, res) => {
    const { wallet } = req.query;
    try {
        const mpt = await getBalance(wallet, 'MPT');
        const usdt = await getBalance(wallet, 'USDT');
        res.json({ MPT: mpt, USDT: usdt, TON: 0, USDC: 0, DOGE: 0 });
    } catch (e) { res.status(500).send(); }
});

// WEBHOOK SEPAY (Nạp tự động)
app.post('/api/webhooks/sepay', async (req, res) => {
    const { content, amount } = req.body;
    const walletTag = content.replace('MPH', '').toUpperCase();
    try {
        const user = await pool.query(`SELECT wallet_address FROM users WHERE wallet_address LIKE $1`, [`%${walletTag}`]);
        if (user.rows.length > 0) {
            const wallet = user.rows[0].wallet_address;
            const usdtAmount = parseFloat(amount) / 26800; // Giá nạp cố định
            await recordTx(pool, 'deposit_sepay', 'BANK_BIDV', wallet, usdtAmount, 'USDT');
            res.json({ success: true });
        } else res.status(404).send();
    } catch (e) { res.status(500).send(); }
});

// GỬI YÊU CẦU RÚT (Từ trade.html)
app.post('/api/admin/withdraw-request', async (req, res) => {
    const { wallet, asset, amount, vnd_amount, bank } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const bal = await getBalance(wallet, asset);
        if (bal < amount) throw new Error('Số dư không đủ');
        await recordTx(client, 'withdraw_hold', wallet, 'SYSTEM_HOLD', amount, asset);
        await client.query(`INSERT INTO withdraw_requests (wallet, asset, amount, vnd_amount, bank) VALUES ($1, $2, $3, $4, $5)`, [wallet, asset, amount, vnd_amount, bank]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); }
    finally { client.release(); }
});

// --- 3. API QUẢN TRỊ (Fix Admin Crash) ---
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const u = await pool.query(`SELECT COUNT(*) FROM users`);
        const s = await pool.query(`SELECT SUM(staked_usdt) FROM user_staking`);
        const w = await pool.query(`SELECT COUNT(*) FROM withdraw_requests WHERE status = 'pending'`);
        res.json({ total_users: u.rows[0].count, total_staking: s.rows[0].sum || 0, pending_p2p: w.rows[0].count });
    } catch (e) { res.status(500).json({ message: "Lỗi Dashboard" }); }
});

app.get('/api/admin/withdraws/pending', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM withdraw_requests WHERE status = 'pending' ORDER BY created_at DESC`);
        res.json(result.rows);
    } catch (e) { res.status(500).send(); }
});

app.post('/api/admin/withdraws/process', async (req, res) => {
    const { id, status } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqData = (await client.query(`SELECT * FROM withdraw_requests WHERE id = $1`, [id])).rows[0];
        if (status === 'completed') {
            await recordTx(client, 'withdraw_done', 'SYSTEM_HOLD', 'BURN', reqData.amount, reqData.asset);
        } else {
            await recordTx(client, 'withdraw_refund', 'SYSTEM_HOLD', reqData.wallet, reqData.amount, reqData.asset);
        }
        await client.query(`UPDATE withdraw_requests SET status = $1 WHERE id = $2`, [status, id]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).send(); }
    finally { client.release(); }
});

// Lịch sử lệnh xử lý cho User (Tại trade.html tab 3)
app.get('/api/p2p/my-pending', async (req, res) => {
    const { wallet } = req.query;
    try {
        const result = await pool.query(`
            SELECT 'withdraw' as type, asset, amount, vnd_amount, status, created_at FROM withdraw_requests WHERE wallet = $1
            UNION ALL
            SELECT 'deposit' as type, currency as asset, amount, (amount * 26800)::text as vnd_amount, 'completed' as status, created_at FROM transaction_history WHERE to_wallet = $1 AND type = 'deposit_sepay'
            ORDER BY created_at DESC
        `, [wallet]);
        res.json(result.rows);
    } catch (e) { res.status(500).send(); }
});

// --- 4. API EXPLORER & STAKING (GIỮ NGUYÊN) ---
app.get('/api/explorer/stats', async (req, res) => {
    const w = await pool.query(`SELECT COUNT(*) FROM users`);
    const t = await pool.query(`SELECT COUNT(*) FROM transaction_history`);
    res.json({ total_wallets: parseInt(w.rows[0].count), total_transactions: parseInt(t.rows[0].count), supply_mspw: 1000000000 });
});

app.get('/api/explorer/latest-mints', async (req, res) => {
    const r = await pool.query(`SELECT wallet_address as wallet, created_at FROM users ORDER BY created_at DESC LIMIT 6`);
    res.json(r.rows);
});

app.get('/api/explorer/latest-txns', async (req, res) => {
    const r = await pool.query(`SELECT * FROM transaction_history ORDER BY created_at DESC LIMIT 6`);
    res.json(r.rows);
});

app.get('/api/explorer/search', async (req, res) => {
    const { type, q } = req.query;
    try {
        if (type === 'address') {
            const mpt = await getBalance(q, 'MPT');
            const usdt = await getBalance(q, 'USDT');
            const txs = await pool.query(`SELECT * FROM transaction_history WHERE from_wallet = $1 OR to_wallet = $1 ORDER BY created_at DESC LIMIT 10`, [q]);
            res.json({ wallet_address: q, kyc_status: 'approved', balance_mspw: mpt, balance_usdt: usdt, txns: txs.rows });
        } else {
            const tx = await pool.query(`SELECT * FROM transaction_history WHERE tx_hash = $1`, [q]);
            res.json(tx.rows[0] || null);
        }
    } catch (e) { res.status(500).send(); }
});

app.get('/api/staking/info', async (req, res) => {
    const { wallet } = req.query;
    let result = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
    if (result.rows.length === 0) {
        await pool.query(`INSERT INTO user_staking (wallet_address) VALUES ($1)`, [wallet]);
        result = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
    }
    const avail = await getBalance(wallet, 'USDT');
    res.json({ staked_usdt: result.rows[0].staked_usdt, earned_mpt: result.rows[0].earned_mpt, available_usdt: avail });
});

app.post('/api/staking/sync-reward', async (req, res) => {
    await pool.query(`UPDATE user_staking SET earned_mpt = $1, last_updated = CURRENT_TIMESTAMP WHERE wallet_address = $2`, [req.body.new_reward, req.body.wallet]);
    res.json({ success: true });
});

app.post('/api/staking/deposit', async (req, res) => {
    const { wallet, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const bal = await getBalance(wallet, 'USDT');
        if(bal < amount) throw new Error('Số dư USDT không đủ');
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
        if(stk.staked_usdt < amount) throw new Error('Vượt quá số vốn');
        await recordTx(client, 'unstake', 'SYSTEM_STAKING', wallet, amount, 'USDT');
        if(stk.earned_mpt > 0) await recordTx(client, 'reward', 'SYSTEM_STAKING', wallet, stk.earned_mpt, 'MPT');
        await client.query(`UPDATE user_staking SET staked_usdt = staked_usdt - $1, earned_mpt = 0 WHERE wallet_address = $2`, [amount, wallet]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); }
    finally { client.release(); }
});

// KHỞI CHẠY
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MetahashPay Online tại cổng ${PORT}`));
