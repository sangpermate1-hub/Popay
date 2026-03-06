require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');

/**
 * METAHASHPAY - CORE ENGINE
 * @author Trung An
 * @version 3.0.0 (Stable Online)
 */

const app = express();

// --- 1. CẤU HÌNH HỆ THỐNG ---
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname)); // Host toàn bộ giao diện HTML và logo.png

// Kết nối Neon.tech với cơ chế chống rò rỉ kết nối
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// ==========================================
// CORE UTILS: XỬ LÝ SỐ DƯ & LEDGER (FIX NaN)
// ==========================================

/**
 * Lấy số dư an toàn - Triệt tiêu lỗi NaN tuyệt đối
 */
async function getSafeBalance(wallet, currency) {
    try {
        const query = `
            SELECT 
                COALESCE(SUM(CASE WHEN to_wallet = $1 THEN amount ELSE 0 END), 0) - 
                COALESCE(SUM(CASE WHEN from_wallet = $1 THEN amount ELSE 0 END), 0) as balance
            FROM transaction_history 
            WHERE (to_wallet = $1 OR from_wallet = $1) AND currency = $2
        `;
        const res = await pool.query(query, [wallet, currency]);
        // Ép kiểu về số thực, nếu lỗi mặc định trả về 0
        const balance = parseFloat(res.rows[0].balance);
        return isNaN(balance) ? 0 : balance;
    } catch (e) {
        console.error(`[Ledger Error] Failed to get ${currency} balance for ${wallet}:`, e);
        return 0;
    }
}

/**
 * Ghi chép sổ cái với TxHash duy nhất
 */
async function recordTx(client, type, from, to, amount, currency) {
    const txHash = 'TX' + Math.random().toString(36).substring(2, 12).toUpperCase() + Date.now().toString(36).toUpperCase();
    await client.query(
        `INSERT INTO transaction_history (tx_hash, type, from_wallet, to_wallet, amount, currency) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [txHash, type, from, to, amount, currency]
    );
    return txHash;
}

// ==========================================
// 1. MODULE XÁC THỰC (AUTH)
// ==========================================

app.post('/api/auth/register', async (req, res) => {
    const { full_name, email, password, referred_by } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        const wallet = 'M' + Math.random().toString(36).substring(2, 15).toUpperCase();
        const refCode = Math.random().toString(36).substring(2, 8).toUpperCase();

        await pool.query(
            `INSERT INTO users (wallet_address, full_name, email, password_hash, referral_code, referred_by) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [wallet, full_name, email, hash, refCode, referred_by || null]
        );

        // Kích hoạt ví trên Blockchain Explorer
        await recordTx(pool, 'mint', 'SYSTEM', wallet, 0, 'MPT');
        
        res.status(201).json({ success: true, wallet_address: wallet });
    } catch (e) {
        res.status(400).json({ success: false, message: 'Email hoặc ví đã tồn tại' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        if (user.rows.length === 0) return res.status(401).json({ message: 'Tài khoản không tồn tại' });

        const match = await bcrypt.compare(password, user.rows[0].password_hash);
        if (!match) return res.status(401).json({ message: 'Mật khẩu sai' });

        res.json({ success: true, wallet_address: user.rows[0].wallet_address, token: 'mth_session_jwt_v3' });
    } catch (e) { res.status(500).send(); }
});

// ==========================================
// 2. MODULE VÍ CHÍNH (WALLET)
// ==========================================

app.get('/api/wallet/assets', async (req, res) => {
    const { wallet } = req.query;
    if (!wallet) return res.status(400).json({ message: 'Wallet address required' });
    
    try {
        // Lấy đồng thời tất cả tài sản để tăng tốc độ load
        const [mpt, usdt, ton, usdc, doge] = await Promise.all([
            getSafeBalance(wallet, 'MPT'),
            getSafeBalance(wallet, 'USDT'),
            getSafeBalance(wallet, 'TON'),
            getSafeBalance(wallet, 'USDC'),
            getSafeBalance(wallet, 'DOGE')
        ]);

        res.json({ 
            MPT: mpt, 
            USDT: usdt, 
            TON: ton, 
            USDC: usdc, 
            DOGE: doge 
        });
    } catch (e) {
        res.status(500).json({ MPT: 0, USDT: 0, TON: 0, USDC: 0, DOGE: 0 });
    }
});

app.post('/api/wallet/send', async (req, res) => {
    const { from_wallet, to_wallet, amount, currency } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const balance = await getSafeBalance(from_wallet, currency);
        if (balance < amount) throw new Error(`Số dư ${currency} không đủ`);

        const toUser = await client.query(`SELECT wallet_address FROM users WHERE wallet_address = $1`, [to_wallet]);
        if (toUser.rows.length === 0 && !to_wallet.startsWith('SYSTEM')) throw new Error('Ví nhận không tồn tại');

        const txHash = await recordTx(client, 'transfer', from_wallet, to_wallet, amount, currency);
        
        await client.query('COMMIT');
        res.json({ success: true, hash: txHash });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: e.message });
    } finally { client.release(); }
});

// ==========================================
// 3. MODULE P2P ESCROW (TRADE.HTML)
// ==========================================

app.get('/api/p2p/orders', async (req, res) => {
    const { type } = req.query; // buy hoặc sell
    try {
        const result = await pool.query(
            `SELECT * FROM p2p_orders WHERE type = $1 AND status = 'open' ORDER BY created_at DESC`, 
            [type]
        );
        res.json(result.rows);
    } catch (e) { res.status(500).json([]); }
});

app.post('/api/p2p/create', async (req, res) => {
    const { maker_wallet, type, price, amount, bank_info } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Nếu Bán MPT -> Khóa tiền vào Escrow ngay
        if (type === 'sell') {
            const bal = await getSafeBalance(maker_wallet, 'MPT');
            if (bal < amount) throw new Error('Không đủ MPT để đăng bán');
            await recordTx(client, 'p2p_lock', maker_wallet, 'SYSTEM_ESCROW', amount, 'MPT');
        }

        await client.query(
            `INSERT INTO p2p_orders (maker_wallet, type, price, amount, bank_info, status) 
             VALUES ($1, $2, $3, $4, $5, 'open')`,
            [maker_wallet, type, price, amount, bank_info]
        );
        
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: e.message });
    } finally { client.release(); }
});

// ==========================================
// 4. MODULE STAKING (STAKING.HTML)
// ==========================================

app.get('/api/staking/info', async (req, res) => {
    const { wallet } = req.query;
    try {
        let result = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
        
        // Nếu chưa có trong bảng Staking, tự động tạo mới
        if (result.rows.length === 0) {
            await pool.query(`INSERT INTO user_staking (wallet_address, staked_usdt, earned_mpt) VALUES ($1, 0, 0)`, [wallet]);
            result = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
        }

        const availableUsdt = await getSafeBalance(wallet, 'USDT');
        
        res.json({ 
            staked_usdt: parseFloat(result.rows[0].staked_usdt || 0), 
            earned_mpt: parseFloat(result.rows[0].earned_mpt || 0), 
            available_usdt: availableUsdt // Đây là chỗ fix NaN Khả dụng
        });
    } catch (e) {
        res.status(500).json({ staked_usdt: 0, earned_mpt: 0, available_usdt: 0 });
    }
});

app.post('/api/staking/deposit', async (req, res) => {
    const { wallet, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const bal = await getSafeBalance(wallet, 'USDT');
        if (bal < amount) throw new Error('Số dư USDT không đủ');

        await recordTx(client, 'stake_lock', wallet, 'SYSTEM_STAKING', amount, 'USDT');
        await client.query(
            `UPDATE user_staking SET staked_usdt = staked_usdt + $1, last_updated = CURRENT_TIMESTAMP WHERE wallet_address = $2`,
            [amount, wallet]
        );
        
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: e.message });
    } finally { client.release(); }
});

// ==========================================
// 5. MODULE EXPLORER (MPT SCAN)
// ==========================================

app.get('/api/explorer/stats', async (req, res) => {
    try {
        const wallets = await pool.query(`SELECT COUNT(*) FROM users`);
        const txns = await pool.query(`SELECT COUNT(*) FROM transaction_history`);
        res.json({
            total_wallets: parseInt(wallets.rows[0].count || 0),
            total_transactions: parseInt(txns.rows[0].count || 0),
            supply_mspw: 1000000000 
        });
    } catch (e) { res.status(500).json({ total_wallets: 0, total_transactions: 0, supply_mspw: 0 }); }
});

app.get('/api/explorer/latest-mints', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT wallet_address as wallet, created_at FROM users ORDER BY created_at DESC LIMIT 10`
        );
        res.json(result.rows);
    } catch (e) { res.json([]); }
});

app.get('/api/explorer/latest-txns', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM transaction_history ORDER BY created_at DESC LIMIT 10`
        );
        res.json(result.rows);
    } catch (e) { res.json([]); }
});

// ==========================================
// 6. MODULE NẠP RÚT (WEBHOOK SEPAY & ADMIN)
// ==========================================

/**
 * Webhook SePay nạp tiền tự động
 */
app.post('/api/webhooks/sepay', async (req, res) => {
    const { content, amount } = req.body;
    const walletTag = content.replace('MPH', '').toUpperCase();
    try {
        const user = await pool.query(`SELECT wallet_address FROM users WHERE wallet_address LIKE $1`, [`%${walletTag}`]);
        if (user.rows.length > 0) {
            const wallet = user.rows[0].wallet_address;
            const usdtReceived = parseFloat(amount) / 26800; // Tỷ giá nạp cố định
            await recordTx(pool, 'deposit_sepay', 'BANK_SYSTEM', wallet, usdtReceived, 'USDT');
            res.json({ success: true });
        } else res.status(404).json({ message: 'User not found' });
    } catch (e) { res.status(500).send(); }
});

/**
 * Yêu cầu rút tiền gửi Admin
 */
app.post('/api/admin/withdraw-request', async (req, res) => {
    const { wallet, asset, amount, vnd_amount, bank } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const bal = await getSafeBalance(wallet, asset);
        if (bal < amount) throw new Error('Số dư không đủ để rút');

        await recordTx(client, 'withdraw_lock', wallet, 'SYSTEM_WITHDRAW_HOLD', amount, asset);
        await client.query(
            `INSERT INTO withdraw_requests (wallet, asset, amount, vnd_amount, bank, status) 
             VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [wallet, asset, amount, vnd_amount, bank]
        );
        
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: e.message });
    } finally { client.release(); }
});

// ==========================================
// 7. ADMIN MANAGEMENT
// ==========================================

app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const u = await pool.query(`SELECT COUNT(*) FROM users`);
        const w = await pool.query(`SELECT COUNT(*) FROM withdraw_requests WHERE status = 'pending'`);
        const k = await pool.query(`SELECT COUNT(*) FROM user_kyc WHERE status = 'pending'`);
        res.json({ 
            total_users: parseInt(u.rows[0].count), 
            pending_withdraws: parseInt(w.rows[0].count),
            pending_kyc: parseInt(k.rows[0].count)
        });
    } catch (e) { res.status(500).send(); }
});

// Khởi chạy Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 MetahashPay System Online: ${PORT}`);
});
