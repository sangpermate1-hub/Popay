require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// Kết nối Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==========================================
// HÀM TIỆN ÍCH DÙNG CHUNG
// ==========================================
function generateWallet() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let randomPart = '';
    for (let i = 0; i < 30; i++) randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    return 'MSPW-0x' + randomPart;
}

// Ghi chép giao dịch (Ledger)
async function recordTx(client, type, from, to, amount, currency) {
    await client.query(
        `INSERT INTO transaction_history (type, from_wallet, to_wallet, amount, currency) VALUES ($1, $2, $3, $4, $5)`,
        [type, from, to, amount, currency]
    );
}

// Tính số dư ví động từ Sổ cái
async function getBalance(wallet, currency) {
    const res = await pool.query(`
        SELECT 
            SUM(CASE WHEN to_wallet = $1 THEN amount ELSE 0 END) - 
            SUM(CASE WHEN from_wallet = $1 THEN amount ELSE 0 END) as balance
        FROM transaction_history WHERE (to_wallet = $1 OR from_wallet = $1) AND currency = $2
    `, [wallet, currency]);
    return parseFloat(res.rows[0].balance || 0);
}

// ==========================================
// 1. MODULE XÁC THỰC & VÍ (AUTH & WALLET)
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    const { full_name, email, password, referred_by } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        const wallet = generateWallet();
        const ref = Math.random().toString(36).substring(2, 10).toUpperCase();

        await pool.query(
            `INSERT INTO users (wallet_address, full_name, email, password_hash, referral_code, referred_by) VALUES ($1, $2, $3, $4, $5, $6)`,
            [wallet, full_name, email, hash, ref, referred_by]
        );
        res.status(201).json({ message: 'Thành công', wallet_address: wallet });
    } catch (e) { res.status(400).json({ message: 'Email đã tồn tại' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        if (user.rows.length === 0) return res.status(401).json({ message: 'Sai thông tin' });

        const match = await bcrypt.compare(password, user.rows[0].password_hash);
        if (!match) return res.status(401).json({ message: 'Sai thông tin' });

        res.json({ token: 'jwt-token-mock', wallet_address: user.rows[0].wallet_address });
    } catch (e) { res.status(500).send('Lỗi Server'); }
});

app.get('/api/wallet/assets', async (req, res) => {
    const { wallet } = req.query;
    try {
        // Tính toán số dư thực tế cho từng loại coin
        const mspw = await getBalance(wallet, 'MSPW');
        const usdt = await getBalance(wallet, 'USDT');
        res.json({ MSPW: mspw, USDT: usdt, BTC: 0, ETH: 0, VNDW: 0 }); // Có thể mở rộng thêm
    } catch (e) { res.status(500).send(); }
});

// API Chuyển tiền (Send) trong index.html
app.post('/api/wallet/send', async (req, res) => {
    const { from_wallet, to_wallet, amount, currency } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const balance = await getBalance(from_wallet, currency);
        if(balance < amount) throw new Error('Số dư không đủ');

        await recordTx(client, 'transfer', from_wallet, to_wallet, amount, currency);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: e.message });
    } finally { client.release(); }
});

// ==========================================
// 2. MODULE P2P ESCROW
// ==========================================
app.get('/api/p2p/orders', async (req, res) => {
    const { type } = req.query;
    const result = await pool.query(`SELECT * FROM p2p_orders WHERE type = $1 AND status = 'open' ORDER BY created_at DESC`, [type]);
    res.json(result.rows);
});

app.get('/api/p2p/my-pending', async (req, res) => {
    const { wallet } = req.query;
    const result = await pool.query(`SELECT * FROM p2p_orders WHERE (maker_wallet = $1 OR taker_wallet = $1) AND status IN ('processing', 'paid')`, [wallet]);
    res.json(result.rows);
});

app.post('/api/p2p/create', async (req, res) => {
    const { maker_wallet, type, price, amount, bank_info } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Nếu Bán MSPW, phải khóa số MSPW của Maker vào Escrow
        if(type === 'sell') {
            const bal = await getBalance(maker_wallet, 'MSPW');
            if(bal < amount) throw new Error('Không đủ MSPW để đăng bán');
            await recordTx(client, 'p2p_lock', maker_wallet, 'SYSTEM_ESCROW', amount, 'MSPW');
        }
        await client.query(`INSERT INTO p2p_orders (maker_wallet, type, price, amount, bank_info) VALUES ($1, $2, $3, $4, $5)`, [maker_wallet, type, price, amount, bank_info]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); 
    } finally { client.release(); }
});

app.post('/api/p2p/initiate', async (req, res) => {
    const { order_id, taker_wallet } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const order = (await client.query(`SELECT * FROM p2p_orders WHERE id = $1 AND status = 'open' FOR UPDATE`, [order_id])).rows[0];
        if(!order) throw new Error('Lệnh đã bị lấy');

        // Nếu Maker Mua (Nghĩa là Taker vào Bán). Taker phải bị khóa MSPW
        if(order.type === 'buy') {
            const bal = await getBalance(taker_wallet, 'MSPW');
            if(bal < order.amount) throw new Error('Bạn không đủ MSPW để bán');
            await recordTx(client, 'p2p_lock', taker_wallet, 'SYSTEM_ESCROW', order.amount, 'MSPW');
        }

        await client.query(`UPDATE p2p_orders SET status = 'processing', taker_wallet = $1 WHERE id = $2`, [taker_wallet, order_id]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); 
    } finally { client.release(); }
});

app.post('/api/p2p/update-status', async (req, res) => {
    const { order_id, status } = req.body; // processing -> paid -> completed
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const order = (await client.query(`SELECT * FROM p2p_orders WHERE id = $1 FOR UPDATE`, [order_id])).rows[0];
        
        await client.query(`UPDATE p2p_orders SET status = $1 WHERE id = $2`, [status, order_id]);

        // Nếu hoàn tất, nhả coin từ Escrow cho người Mua
        if (status === 'completed') {
            const buyer = order.type === 'sell' ? order.taker_wallet : order.maker_wallet;
            await recordTx(client, 'p2p_release', 'SYSTEM_ESCROW', buyer, order.amount, 'MSPW');
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).send(); } 
    finally { client.release(); }
});

// ==========================================
// 3. MODULE STAKING
// ==========================================
app.get('/api/staking/info', async (req, res) => {
    const { wallet } = req.query;
    try {
        let result = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
        if (result.rows.length === 0) {
            await pool.query(`INSERT INTO user_staking (wallet_address) VALUES ($1)`, [wallet]);
            result = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
        }
        const availableUsdt = await getBalance(wallet, 'USDT');
        res.json({ staked_usdt: result.rows[0].staked_usdt, earned_mspw: result.rows[0].earned_mspw, available_usdt: availableUsdt });
    } catch (e) { res.status(500).send(); }
});

app.post('/api/staking/sync-reward', async (req, res) => {
    const { wallet, new_reward } = req.body;
    await pool.query(`UPDATE user_staking SET earned_mspw = $1, last_updated = CURRENT_TIMESTAMP WHERE wallet_address = $2`, [new_reward, wallet]);
    res.json({ success: true });
});

app.post('/api/staking/deposit', async (req, res) => {
    const { wallet, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const bal = await getBalance(wallet, 'USDT');
        if(bal < amount) throw new Error('Không đủ USDT');

        await recordTx(client, 'stake', wallet, 'SYSTEM_STAKING', amount, 'USDT');
        await client.query(`UPDATE user_staking SET staked_usdt = staked_usdt + $1, last_updated = CURRENT_TIMESTAMP WHERE wallet_address = $2`, [amount, wallet]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); } 
    finally { client.release(); }
});

app.post('/api/staking/withdraw', async (req, res) => {
    const { wallet, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const stk = (await client.query(`SELECT * FROM user_staking WHERE wallet_address = $1 FOR UPDATE`, [wallet])).rows[0];
        if(stk.staked_usdt < amount) throw new Error('Vượt quá số tiền Staking');

        // Trả gốc USDT
        await recordTx(client, 'unstake', 'SYSTEM_STAKING', wallet, amount, 'USDT');
        // Trả lãi MSPW
        if(stk.earned_mspw > 0) await recordTx(client, 'reward', 'SYSTEM_STAKING', wallet, stk.earned_mspw, 'MSPW');
        
        await client.query(`UPDATE user_staking SET staked_usdt = staked_usdt - $1, earned_mspw = 0 WHERE wallet_address = $2`, [amount, wallet]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); } 
    finally { client.release(); }
});

// ==========================================
// 4. MODULE USER SETTINGS & TICKETS
// ==========================================
app.get('/api/users/tickets', async (req, res) => {
    const result = await pool.query(`SELECT * FROM support_tickets WHERE wallet = $1 ORDER BY created_at DESC`, [req.query.wallet]);
    res.json(result.rows);
});

app.post('/api/admin/tickets', async (req, res) => {
    const { wallet, title, content } = req.body;
    await pool.query(`INSERT INTO support_tickets (wallet, title, content) VALUES ($1, $2, $3)`, [wallet, title, content]);
    res.json({ success: true });
});

// ==========================================
// 5. MODULE ADMIN (DASHBOARD & QUẢN LÝ)
// ==========================================
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const u = await pool.query(`SELECT COUNT(*) FROM users`);
        const s = await pool.query(`SELECT SUM(staked_usdt) FROM user_staking`);
        const p = await pool.query(`SELECT COUNT(*) FROM p2p_orders WHERE status IN ('processing', 'paid')`);
        const t = await pool.query(`SELECT COUNT(*) FROM support_tickets WHERE status = 'open'`);
        res.json({ total_users: u.rows[0].count, total_staking: s.rows[0].sum || 0, pending_p2p: p.rows[0].count, open_tickets: t.rows[0].count });
    } catch(e) { res.status(500).send(); }
});

app.get('/api/admin/users', async (req, res) => {
    const result = await pool.query(`
        SELECT u.wallet_address, u.email, u.created_at, COALESCE(k.status, 'unverified') as kyc_status 
        FROM users u LEFT JOIN user_kyc k ON u.wallet_address = k.wallet
    `);
    res.json(result.rows);
});

app.get('/api/admin/p2p/all', async (req, res) => {
    const result = await pool.query(`SELECT * FROM p2p_orders ORDER BY created_at DESC`);
    res.json(result.rows);
});

// API Giải quyết tranh chấp
app.post('/api/admin/p2p/resolve', async (req, res) => {
    const { id, action } = req.body; // force_complete hoặc cancel
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const order = (await client.query(`SELECT * FROM p2p_orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        
        if (action === 'force_complete') {
            const buyer = order.type === 'sell' ? order.taker_wallet : order.maker_wallet;
            await recordTx(client, 'p2p_release', 'SYSTEM_ESCROW', buyer, order.amount, 'MSPW');
            await client.query(`UPDATE p2p_orders SET status = 'completed' WHERE id = $1`, [id]);
        } else if (action === 'cancel') {
            const seller = order.type === 'sell' ? order.maker_wallet : order.taker_wallet;
            await recordTx(client, 'p2p_refund', 'SYSTEM_ESCROW', seller, order.amount, 'MSPW');
            await client.query(`UPDATE p2p_orders SET status = 'cancelled' WHERE id = $1`, [id]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch(e) { await client.query('ROLLBACK'); res.status(500).send(); } 
    finally { client.release(); }
});

// Khởi chạy Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server MySPay đang chạy tại http://localhost:${PORT}`);
    console.log(`🔌 Đã thiết lập cơ chế Ledger và Escrow`);
});
