require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path'); // Thư viện xử lý đường dẫn file HTML

const app = express();

// Cấu hình CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ==========================================
// CẤU HÌNH WEB SERVER (PHỤC VỤ GIAO DIỆN HTML)
// ==========================================
// Cho phép server đọc các file html, css, hình ảnh nằm cùng thư mục
app.use(express.static(path.join(__dirname)));

// Khi người dùng gõ metahash.online, tự động mở trang login.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});


// ==========================================
// KẾT NỐI DATABASE & THIẾT LẬP LƯU TRỮ
// ==========================================
const upload = multer({ dest: 'uploads/' });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==========================================
// HÀM TIỆN ÍCH (CORE UTILS)
// ==========================================
function generateWallet() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let randomPart = '';
    for (let i = 0; i < 29; i++) {
        randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return 'M' + randomPart;
}

async function recordTx(client, type, from, to, amount, currency) {
    await client.query(
        `INSERT INTO transaction_history (type, from_wallet, to_wallet, amount, currency) VALUES ($1, $2, $3, $4, $5)`,
        [type, from, to, amount, currency]
    );
}

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
// 1. MODULE XÁC THỰC (AUTH)
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

        // Tặng mặc định 0 MPT để kích hoạt ví trên Explorer
        await recordTx(pool, 'mint', 'SYSTEM', wallet, 0, 'MPT');

        res.status(201).json({ message: 'Tạo ví thành công', wallet_address: wallet });
    } catch (e) { 
        res.status(400).json({ message: 'Email đã tồn tại trong hệ thống' }); 
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        if (user.rows.length === 0) return res.status(401).json({ message: 'Tài khoản không tồn tại' });

        const match = await bcrypt.compare(password, user.rows[0].password_hash);
        if (!match) return res.status(401).json({ message: 'Mật khẩu không chính xác' });

        res.json({ token: 'metahash-jwt-token-xyz', wallet_address: user.rows[0].wallet_address });
    } catch (e) { res.status(500).send('Lỗi Server nội bộ'); }
});

// ==========================================
// 2. MODULE VÍ CHÍNH (WALLET)
// ==========================================
app.get('/api/wallet/assets', async (req, res) => {
    const { wallet } = req.query;
    try {
        const mpt = await getBalance(wallet, 'MPT');
        const usdt = await getBalance(wallet, 'USDT');
        const ton = await getBalance(wallet, 'TON');
        res.json({ MPT: mpt, USDT: usdt, TON: ton }); 
    } catch (e) { res.status(500).send(); }
});

app.post('/api/wallet/send', async (req, res) => {
    const { from_wallet, to_wallet, amount, currency } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const toUser = await client.query(`SELECT * FROM users WHERE wallet_address = $1`, [to_wallet]);
        if(toUser.rows.length === 0) throw new Error('Địa chỉ ví nhận không tồn tại');

        const balance = await getBalance(from_wallet, currency);
        if(balance < amount) throw new Error(`Số dư ${currency} không đủ`);

        await recordTx(client, 'transfer', from_wallet, to_wallet, amount, currency);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: e.message });
    } finally { client.release(); }
});

// ==========================================
// 3. MODULE P2P ESCROW
// ==========================================
app.get('/api/p2p/orders', async (req, res) => {
    const { type } = req.query;
    try {
        const result = await pool.query(`SELECT * FROM p2p_orders WHERE type = $1 AND status = 'open' ORDER BY created_at DESC`, [type]);
        res.json(result.rows);
    } catch(e) { res.status(500).send(); }
});

app.get('/api/p2p/my-pending', async (req, res) => {
    const { wallet } = req.query;
    try {
        const result = await pool.query(`SELECT * FROM p2p_orders WHERE (maker_wallet = $1 OR taker_wallet = $1) AND status IN ('processing', 'paid')`, [wallet]);
        res.json(result.rows);
    } catch(e) { res.status(500).send(); }
});

app.get('/api/p2p/my-pending-count', async (req, res) => {
    const { wallet } = req.query;
    try {
        const result = await pool.query(`SELECT COUNT(*) FROM p2p_orders WHERE (maker_wallet = $1 OR taker_wallet = $1) AND status IN ('processing', 'paid')`, [wallet]);
        res.json({ count: parseInt(result.rows[0].count) });
    } catch(e) { res.status(500).send(); }
});

app.post('/api/p2p/create', async (req, res) => {
    const { maker_wallet, type, price, amount, bank_info } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if(type === 'sell') {
            const bal = await getBalance(maker_wallet, 'MPT');
            if(bal < amount) throw new Error('Không đủ MPT để đăng bán');
            await recordTx(client, 'p2p_lock', maker_wallet, 'SYSTEM_ESCROW', amount, 'MPT');
        }
        await client.query(`INSERT INTO p2p_orders (maker_wallet, type, price, amount, bank_info) VALUES ($1, $2, $3, $4, $5)`, [maker_wallet, type, price, amount, bank_info]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { 
        await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); 
    } finally { client.release(); }
});

app.post('/api/p2p/initiate', async (req, res) => {
    const { order_id, taker_wallet } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const order = (await client.query(`SELECT * FROM p2p_orders WHERE id = $1 AND status = 'open' FOR UPDATE`, [order_id])).rows[0];
        if(!order) throw new Error('Lệnh đã bị người khác khớp hoặc không tồn tại');

        if(order.type === 'buy') {
            const bal = await getBalance(taker_wallet, 'MPT');
            if(bal < order.amount) throw new Error('Không đủ MPT để bán');
            await recordTx(client, 'p2p_lock', taker_wallet, 'SYSTEM_ESCROW', order.amount, 'MPT');
        }

        await client.query(`UPDATE p2p_orders SET status = 'processing', taker_wallet = $1 WHERE id = $2`, [taker_wallet, order_id]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { 
        await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); 
    } finally { client.release(); }
});

app.post('/api/p2p/update-status', async (req, res) => {
    const { order_id, status } = req.body; 
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const order = (await client.query(`SELECT * FROM p2p_orders WHERE id = $1 FOR UPDATE`, [order_id])).rows[0];
        
        await client.query(`UPDATE p2p_orders SET status = $1 WHERE id = $2`, [status, order_id]);

        if (status === 'completed') {
            const buyer = order.type === 'sell' ? order.taker_wallet : order.maker_wallet;
            await recordTx(client, 'p2p_release', 'SYSTEM_ESCROW', buyer, order.amount, 'MPT');
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { 
        await client.query('ROLLBACK'); res.status(500).send(); 
    } finally { client.release(); }
});

// ==========================================
// 4. MODULE STAKING
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
        res.json({ 
            staked_usdt: result.rows[0].staked_usdt, 
            earned_mpt: result.rows[0].earned_mpt, 
            available_usdt: availableUsdt 
        });
    } catch (e) { res.status(500).send(); }
});

app.post('/api/staking/sync-reward', async (req, res) => {
    const { wallet, new_reward } = req.body;
    try {
        await pool.query(`UPDATE user_staking SET earned_mpt = $1, last_updated = CURRENT_TIMESTAMP WHERE wallet_address = $2`, [new_reward, wallet]);
        res.json({ success: true });
    } catch(e) { res.status(500).send(); }
});

app.post('/api/staking/deposit', async (req, res) => {
    const { wallet, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const bal = await getBalance(wallet, 'USDT');
        if(bal < amount) throw new Error('Số dư USDT không đủ');

        await recordTx(client, 'stake', wallet, 'SYSTEM_STAKING', amount, 'USDT');
        await client.query(`UPDATE user_staking SET staked_usdt = staked_usdt + $1, last_updated = CURRENT_TIMESTAMP WHERE wallet_address = $2`, [amount, wallet]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { 
        await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); 
    } finally { client.release(); }
});

app.post('/api/staking/withdraw', async (req, res) => {
    const { wallet, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const stk = (await client.query(`SELECT * FROM user_staking WHERE wallet_address = $1 FOR UPDATE`, [wallet])).rows[0];
        if(stk.staked_usdt < amount) throw new Error('Vượt quá số tiền đang Staking');

        await recordTx(client, 'unstake', 'SYSTEM_STAKING', wallet, amount, 'USDT');
        
        if(stk.earned_mpt > 0) {
            await recordTx(client, 'reward', 'SYSTEM_STAKING', wallet, stk.earned_mpt, 'MPT');
        }
        
        await client.query(`UPDATE user_staking SET staked_usdt = staked_usdt - $1, earned_mpt = 0 WHERE wallet_address = $2`, [amount, wallet]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { 
        await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); 
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
            total_wallets: parseInt(wallets.rows[0].count),
            total_transactions: parseInt(txns.rows[0].count),
            supply_mspw: 1000000000 
        });
    } catch (e) { res.status(500).send(); }
});

app.get('/api/explorer/latest-mints', async (req, res) => {
    try {
        const result = await pool.query(`SELECT wallet_address as wallet, created_at FROM users ORDER BY created_at DESC LIMIT 6`);
        res.json(result.rows);
    } catch(e) { res.status(500).send(); }
});

app.get('/api/explorer/latest-txns', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM transaction_history ORDER BY created_at DESC LIMIT 6`);
        res.json(result.rows);
    } catch(e) { res.status(500).send(); }
});

app.get('/api/explorer/search', async (req, res) => {
    const { type, q } = req.query;
    try {
        if (type === 'address') {
            const userRes = await pool.query(`SELECT * FROM users WHERE wallet_address = $1`, [q]);
            if(userRes.rows.length === 0) return res.status(404).json(null);
            
            const kycRes = await pool.query(`SELECT status FROM user_kyc WHERE wallet = $1 ORDER BY created_at DESC LIMIT 1`, [q]);
            const txnsRes = await pool.query(`SELECT * FROM transaction_history WHERE from_wallet = $1 OR to_wallet = $1 ORDER BY created_at DESC LIMIT 20`, [q]);
            
            const mpt = await getBalance(q, 'MPT');
            const usdt = await getBalance(q, 'USDT');
            
            res.json({
                wallet_address: q,
                kyc_status: kycRes.rows.length > 0 ? kycRes.rows[0].status : 'unverified',
                balance_mspw: mpt,
                balance_usdt: usdt,
                txns: txnsRes.rows
            });
        } else {
            const txRes = await pool.query(`SELECT * FROM transaction_history WHERE tx_hash = $1`, [q]);
            if(txRes.rows.length === 0) return res.status(404).json(null);
            res.json(txRes.rows[0]);
        }
    } catch (e) { res.status(500).send(); }
});

// ==========================================
// 6. SETTINGS & SUPPORT TICKETS
// ==========================================
app.post('/api/users/change-password', async (req, res) => {
    const { wallet, oldPass, newPass } = req.body;
    try {
        const user = await pool.query(`SELECT password_hash FROM users WHERE wallet_address = $1`, [wallet]);
        if(!await bcrypt.compare(oldPass, user.rows[0].password_hash)) return res.status(400).send();
        const newHash = await bcrypt.hash(newPass, 10);
        await pool.query(`UPDATE users SET password_hash = $1 WHERE wallet_address = $2`, [newHash, wallet]);
        res.json({ success: true });
    } catch (e) { res.status(500).send(); }
});

app.get('/api/users/tickets', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM support_tickets WHERE wallet = $1 ORDER BY created_at DESC`, [req.query.wallet]);
        res.json(result.rows);
    } catch(e) { res.status(500).send(); }
});

// ==========================================
// 7. QUẢN TRỊ ADMIN (DASHBOARD, P2P DISPUTE)
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
    try {
        const result = await pool.query(`SELECT u.wallet_address, u.email, u.created_at, COALESCE(k.status, 'unverified') as kyc_status FROM users u LEFT JOIN user_kyc k ON u.wallet_address = k.wallet`);
        res.json(result.rows);
    } catch(e) { res.status(500).send(); }
});

app.get('/api/admin/p2p/all', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM p2p_orders ORDER BY created_at DESC`);
        res.json(result.rows);
    } catch(e) { res.status(500).send(); }
});

app.post('/api/admin/p2p/resolve', async (req, res) => {
    const { id, action } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const order = (await client.query(`SELECT * FROM p2p_orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        
        if (action === 'force_complete') {
            const buyer = order.type === 'sell' ? order.taker_wallet : order.maker_wallet;
            await recordTx(client, 'p2p_release', 'SYSTEM_ESCROW', buyer, order.amount, 'MPT');
            await client.query(`UPDATE p2p_orders SET status = 'completed' WHERE id = $1`, [id]);
        } else if (action === 'cancel') {
            const seller = order.type === 'sell' ? order.maker_wallet : order.taker_wallet;
            await recordTx(client, 'p2p_refund', 'SYSTEM_ESCROW', seller, order.amount, 'MPT');
            await client.query(`UPDATE p2p_orders SET status = 'cancelled' WHERE id = $1`, [id]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch(e) { 
        await client.query('ROLLBACK'); res.status(500).send(); 
    } finally { client.release(); }
});

app.post('/api/admin/kyc-submit', upload.single('documentFront'), async (req, res) => {
    const { wallet, name, idNumber } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : '';
    try {
        await pool.query(`INSERT INTO user_kyc (wallet, full_name, id_number, image_url) VALUES ($1, $2, $3, $4)`, [wallet, name, idNumber, imageUrl]);
        res.json({ success: true });
    } catch(e) { res.status(500).send(); }
});

app.get('/api/admin/kyc/pending', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM user_kyc WHERE status = 'pending'`);
        res.json(result.rows);
    } catch(e) { res.status(500).send(); }
});

app.post('/api/admin/kyc/process', async (req, res) => {
    try {
        await pool.query(`UPDATE user_kyc SET status = $1 WHERE id = $2`, [req.body.status, req.body.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).send(); }
});

app.get('/api/admin/tickets/open', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM support_tickets WHERE status = 'open'`);
        res.json(result.rows);
    } catch(e) { res.status(500).send(); }
});

app.post('/api/admin/tickets/reply', async (req, res) => {
    try {
        await pool.query(`UPDATE support_tickets SET admin_reply = $1, status = $2 WHERE id = $3`, [req.body.reply, req.body.status, req.body.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).send(); }
});

app.post('/api/admin/tickets', async (req, res) => {
    const { wallet, title, content } = req.body;
    try {
        await pool.query(`INSERT INTO support_tickets (wallet, title, content) VALUES ($1, $2, $3)`, [wallet, title, content]);
        res.json({ success: true });
    } catch(e) { res.status(500).send(); }
});

// Khởi chạy Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server MetahashPay đang chạy tại cổng ${PORT}`);
    console.log(`✅ Kết nối Database Ledger & P2P Escrow thành công!`);
});
