require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
app.use(cors()); // Cho phép tất cả các nguồn truy cập
app.use(express.json());

// ==========================================
// 1. KẾT NỐI DATABASE (NEON.TECH)
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// Tự động khởi tạo cấu trúc dữ liệu nếu chưa có
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                wallet_address VARCHAR(50) UNIQUE NOT NULL,
                ref_code VARCHAR(20) UNIQUE NOT NULL,
                referred_by VARCHAR(20),
                usdt_balance DECIMAL(15, 2) DEFAULT 0.00,
                popt_balance DECIMAL(15, 2) DEFAULT 0.00,
                kyc_status VARCHAR(20) DEFAULT 'unverified',
                airdrop_last_claim DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                user_address VARCHAR(50),
                type VARCHAR(20), -- 'send', 'receive'
                title VARCHAR(255),
                amount DECIMAL(15, 2),
                asset VARCHAR(10),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS spot_orders (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                type VARCHAR(10), -- 'buy', 'sell'
                price DECIMAL(15, 4),
                amount DECIMAL(15, 2),
                status VARCHAR(20) DEFAULT 'open', -- 'open', 'filled', 'cancelled'
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS p2p_ads (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                merchant VARCHAR(100),
                type VARCHAR(10), -- 'buy', 'sell'
                rate DECIMAL(15, 2),
                amount DECIMAL(15, 2),
                min_limit DECIMAL(15, 2),
                max_limit DECIMAL(15, 2),
                orders_count INTEGER DEFAULT 0,
                status VARCHAR(20) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS p2p_orders (
                id VARCHAR(20) PRIMARY KEY,
                ad_id INTEGER REFERENCES p2p_ads(id),
                user_id INTEGER REFERENCES users(id),
                merchant_name VARCHAR(100),
                type VARCHAR(10), -- User's action: 'buy' or 'sell'
                usdt_amount DECIMAL(15, 2),
                vnd_amount DECIMAL(15, 2),
                rate DECIMAL(15, 2),
                my_bank VARCHAR(255),
                merchant_bank VARCHAR(255) DEFAULT 'Vietcombank - 0123456789 - POPAY MERCHANT',
                status VARCHAR(20) DEFAULT 'pending_payment', -- 'pending_payment', 'pending_release', 'completed'
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS tickets (
                id VARCHAR(20) PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                user_address VARCHAR(50),
                subject VARCHAR(255),
                message TEXT,
                status VARCHAR(20) DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS kyc_requests (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                wallet_address VARCHAR(50),
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Đã đồng bộ cấu trúc Database Popay (Neon.tech)");
    } catch (err) {
        console.error("❌ Lỗi khởi tạo Database:", err);
    }
}
initDB();

// ==========================================
// 2. MIDDLEWARE BẢO MẬT
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.header('Authorization');
    if (!authHeader) return res.status(401).json({ error: 'Truy cập bị từ chối' });
    
    const token = authHeader.split(' ')[1];
    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET);
        req.user = verified;
        next();
    } catch (err) {
        res.status(400).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
    }
};

const authenticateAdmin = (req, res, next) => {
    const authHeader = req.header('Authorization');
    const token = authHeader && authHeader.split(' ')[1];
    if (token === process.env.ADMIN_TOKEN) next();
    else res.status(403).json({ error: 'Không có quyền quản trị' });
};

// ==========================================
// 3. API TÀI KHOẢN & VÍ
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    const { username, password, refCode } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        // Địa chỉ ví 22 ký tự (POPT + 18 hex)
        const walletAddress = "POPT" + crypto.randomBytes(9).toString('hex').toUpperCase(); 
        const myRefCode = crypto.randomBytes(3).toString('hex').toUpperCase();

        const newUser = await pool.query(
            `INSERT INTO users (username, password, wallet_address, ref_code, referred_by, usdt_balance, popt_balance) 
             VALUES ($1, $2, $3, $4, $5, 500.00, 1000.00) RETURNING id, wallet_address`,
            [username, hashedPassword, walletAddress, myRefCode, refCode || null]
        );

        await pool.query(
            `INSERT INTO transactions (user_id, user_address, type, title, amount, asset) VALUES 
            ($1, $2, 'receive', 'Quà tặng tân thủ', 500, 'USDT'), 
            ($1, $2, 'receive', 'Quà tặng tân thủ', 1000, 'POPT')`,
            [newUser.rows[0].id, walletAddress]
        );

        res.status(201).json({ message: "Đăng ký thành công", wallet: walletAddress });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: "Tài khoản đã tồn tại" });
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
        if (user.rows.length === 0) return res.status(400).json({ error: "Sai tài khoản hoặc mật khẩu" });

        const validPassword = await bcrypt.compare(password, user.rows[0].password);
        if (!validPassword) return res.status(400).json({ error: "Sai tài khoản hoặc mật khẩu" });

        const token = jwt.sign({ id: user.rows[0].id, address: user.rows[0].wallet_address, username: user.rows[0].username }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ token });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const user = await pool.query(`SELECT username, wallet_address, ref_code, usdt_balance, popt_balance, kyc_status FROM users WHERE id = $1`, [req.user.id]);
        res.json(user.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/history', authenticateToken, async (req, res) => {
    try {
        const history = await pool.query(`SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
        res.json(history.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Gửi Tiền & Hệ Thống Referral
app.post('/api/transaction/send', authenticateToken, async (req, res) => {
    const { receiverAddress, amount, asset } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const balanceField = asset === 'USDT' ? 'usdt_balance' : 'popt_balance';
        
        const sender = await client.query(`SELECT ${balanceField}, referred_by FROM users WHERE id = $1 FOR UPDATE`, [req.user.id]);
        if (parseFloat(sender.rows[0][balanceField]) < amount) throw new Error("Số dư không đủ");

        const receiver = await client.query(`SELECT id FROM users WHERE wallet_address = $1 FOR UPDATE`, [receiverAddress]);
        if (receiver.rows.length === 0) throw new Error("Không tìm thấy địa chỉ ví nhận");

        await client.query(`UPDATE users SET ${balanceField} = ${balanceField} - $1 WHERE id = $2`, [amount, req.user.id]);
        await client.query(`UPDATE users SET ${balanceField} = ${balanceField} + $1 WHERE id = $2`, [amount, receiver.rows[0].id]);

        await client.query(`INSERT INTO transactions (user_id, user_address, type, title, amount, asset) VALUES ($1, $2, 'send', $3, $4, $5)`, [req.user.id, req.user.address, `Gửi tới ${receiverAddress.substring(0,8)}`, amount, asset]);
        await client.query(`INSERT INTO transactions (user_id, user_address, type, title, amount, asset) VALUES ($1, $2, 'receive', $3, $4, $5)`, [receiver.rows[0].id, receiverAddress, `Nhận từ ${req.user.address.substring(0,8)}`, amount, asset]);

        // Affiliate Reward
        const txCount = await client.query(`SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND type = 'send'`, [req.user.id]);
        if (parseInt(txCount.rows[0].count) === 1 && sender.rows[0].referred_by) {
            const referrer = await client.query(`SELECT id, wallet_address FROM users WHERE ref_code = $1`, [sender.rows[0].referred_by]);
            if (referrer.rows.length > 0) {
                await client.query(`UPDATE users SET popt_balance = popt_balance + 1 WHERE id = $1`, [referrer.rows[0].id]);
                await client.query(`INSERT INTO transactions (user_id, user_address, type, title, amount, asset) VALUES ($1, $2, 'receive', 'Thưởng giới thiệu', 1, 'POPT')`, [referrer.rows[0].id, referrer.rows[0].wallet_address]);
            }
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

// ==========================================
// 4. API SPOT TRADING
// ==========================================
app.get('/api/trade/spot/open', authenticateToken, async (req, res) => {
    try {
        const orders = await pool.query(`SELECT * FROM spot_orders WHERE user_id = $1 AND status = 'open' ORDER BY created_at DESC`, [req.user.id]);
        res.json(orders.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/trade/spot/order', authenticateToken, async (req, res) => {
    const { type, price, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const user = await client.query(`SELECT usdt_balance, popt_balance FROM users WHERE id = $1 FOR UPDATE`, [req.user.id]);
        
        if (type === 'buy') {
            const totalUSDT = price * amount;
            if (parseFloat(user.rows[0].usdt_balance) < totalUSDT) throw new Error("Số dư USDT không đủ");
            await client.query(`UPDATE users SET usdt_balance = usdt_balance - $1 WHERE id = $2`, [totalUSDT, req.user.id]);
        } else {
            if (parseFloat(user.rows[0].popt_balance) < amount) throw new Error("Số dư POPT không đủ");
            await client.query(`UPDATE users SET popt_balance = popt_balance - $1 WHERE id = $2`, [amount, req.user.id]);
        }

        await client.query(`INSERT INTO spot_orders (user_id, type, price, amount) VALUES ($1, $2, $3, $4)`, [req.user.id, type, price, amount]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

app.post('/api/trade/spot/cancel', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const order = await client.query(`SELECT * FROM spot_orders WHERE id = $1 AND user_id = $2 AND status = 'open' FOR UPDATE`, [req.body.orderId, req.user.id]);
        if (order.rows.length === 0) throw new Error("Lệnh không tồn tại hoặc đã khớp");

        const o = order.rows[0];
        if (o.type === 'buy') {
            await client.query(`UPDATE users SET usdt_balance = usdt_balance + $1 WHERE id = $2`, [o.price * o.amount, req.user.id]);
        } else {
            await client.query(`UPDATE users SET popt_balance = popt_balance + $1 WHERE id = $2`, [o.amount, req.user.id]);
        }

        await client.query(`UPDATE spot_orders SET status = 'cancelled' WHERE id = $1`, [o.id]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

app.post('/api/trade/spot/execute', authenticateToken, async (req, res) => {
    // API mô phỏng khớp lệnh (Triggered by frontend when price matches)
    const { orderId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const order = await client.query(`SELECT * FROM spot_orders WHERE id = $1 AND user_id = $2 AND status = 'open' FOR UPDATE`, [orderId, req.user.id]);
        if (order.rows.length === 0) throw new Error("Lệnh không hợp lệ");

        const o = order.rows[0];
        if (o.type === 'buy') {
            await client.query(`UPDATE users SET popt_balance = popt_balance + $1 WHERE id = $2`, [o.amount, req.user.id]);
            await client.query(`INSERT INTO transactions (user_id, user_address, type, title, amount, asset) VALUES ($1, $2, 'receive', 'Khớp lệnh Mua Spot', $3, 'POPT')`, [req.user.id, req.user.address, o.amount]);
        } else {
            const usdtEarned = o.price * o.amount;
            await client.query(`UPDATE users SET usdt_balance = usdt_balance + $1 WHERE id = $2`, [usdtEarned, req.user.id]);
            await client.query(`INSERT INTO transactions (user_id, user_address, type, title, amount, asset) VALUES ($1, $2, 'receive', 'Khớp lệnh Bán Spot', $3, 'USDT')`, [req.user.id, req.user.address, usdtEarned]);
        }

        await client.query(`UPDATE spot_orders SET status = 'filled' WHERE id = $1`, [o.id]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

// ==========================================
// 5. API P2P TRADING (ESCROW LOGIC)
// ==========================================
app.get('/api/p2p/ads', authenticateToken, async (req, res) => {
    const { type } = req.query; // 'buy' or 'sell'
    try {
        const ads = await pool.query(`SELECT * FROM p2p_ads WHERE status = 'active' AND type = $1 ORDER BY rate ${type === 'buy' ? 'DESC' : 'ASC'}`, [type]);
        res.json(ads.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/p2p/ad/create', authenticateToken, async (req, res) => {
    const { type, rate, amount, min, max } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (type === 'sell') {
            const user = await client.query(`SELECT usdt_balance FROM users WHERE id = $1 FOR UPDATE`, [req.user.id]);
            if (parseFloat(user.rows[0].usdt_balance) < amount) throw new Error("Không đủ USDT để khóa");
            await client.query(`UPDATE users SET usdt_balance = usdt_balance - $1 WHERE id = $2`, [amount, req.user.id]);
        }
        
        await client.query(`INSERT INTO p2p_ads (user_id, merchant, type, rate, amount, min_limit, max_limit) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [req.user.id, req.user.username, type, rate, amount, min, max]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

app.get('/api/p2p/orders/pending', authenticateToken, async (req, res) => {
    try {
        const orders = await pool.query(`SELECT * FROM p2p_orders WHERE user_id = $1 AND status != 'completed' AND status != 'cancelled' ORDER BY created_at DESC`, [req.user.id]);
        res.json(orders.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/p2p/order/create', authenticateToken, async (req, res) => {
    const { adId, type, usdt, vnd, rate, myBank } = req.body;
    const orderId = 'P2P' + Math.floor(100000 + Math.random() * 900000);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        if (type === 'sell') {
            // User is selling USDT, lock it now
            const user = await client.query(`SELECT usdt_balance FROM users WHERE id = $1 FOR UPDATE`, [req.user.id]);
            if (parseFloat(user.rows[0].usdt_balance) < usdt) throw new Error("Không đủ USDT");
            await client.query(`UPDATE users SET usdt_balance = usdt_balance - $1 WHERE id = $2`, [usdt, req.user.id]);
        }

        const ad = await pool.query(`SELECT merchant FROM p2p_ads WHERE id = $1`, [adId]);
        const merchantName = ad.rows.length > 0 ? ad.rows[0].merchant : 'Merchant';

        await client.query(
            `INSERT INTO p2p_orders (id, ad_id, user_id, merchant_name, type, usdt_amount, vnd_amount, rate, my_bank) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [orderId, adId, req.user.id, merchantName, type, usdt, vnd, rate, myBank]
        );
        
        await client.query('COMMIT');
        res.json({ success: true, orderId });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

app.post('/api/p2p/order/action', authenticateToken, async (req, res) => {
    const { orderId, action } = req.body; // action: 'paid' or 'release'
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const order = await client.query(`SELECT * FROM p2p_orders WHERE id = $1 AND user_id = $2 FOR UPDATE`, [orderId, req.user.id]);
        if (order.rows.length === 0) throw new Error("Đơn hàng không hợp lệ");
        
        const o = order.rows[0];
        if (action === 'paid' && o.status === 'pending_payment') {
            await client.query(`UPDATE p2p_orders SET status = 'pending_release' WHERE id = $1`, [orderId]);
        } else if (action === 'release' && o.status === 'pending_release') {
            await client.query(`UPDATE p2p_orders SET status = 'completed' WHERE id = $1`, [orderId]);
            // If user was selling, merchant paid, user releases. USDT was already locked, transaction done.
            // If user was buying, user paid, merchant releases. Add USDT to user.
            if (o.type === 'buy') {
                await client.query(`UPDATE users SET usdt_balance = usdt_balance + $1 WHERE id = $2`, [o.usdt_amount, req.user.id]);
                await client.query(`INSERT INTO transactions (user_id, user_address, type, title, amount, asset) VALUES ($1, $2, 'receive', 'P2P Mua USDT', $3, 'USDT')`, [req.user.id, req.user.address, o.usdt_amount]);
            } else {
                 await client.query(`INSERT INTO transactions (user_id, user_address, type, title, amount, asset) VALUES ($1, $2, 'send', 'P2P Bán USDT', $3, 'USDT')`, [req.user.id, req.user.address, o.usdt_amount]);
            }
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

// ==========================================
// 6. CÁC API PHỤ (AIRDROP, KYC, TICKET)
// ==========================================
app.post('/api/airdrop/claim', authenticateToken, async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const user = await client.query(`SELECT airdrop_last_claim FROM users WHERE id = $1 FOR UPDATE`, [req.user.id]);
        const lastClaimStr = user.rows[0].airdrop_last_claim ? user.rows[0].airdrop_last_claim.toISOString().split('T')[0] : null;

        if (lastClaimStr === today) throw new Error("Bạn đã điểm danh hôm nay rồi.");

        await client.query(`UPDATE users SET popt_balance = popt_balance + 0.2, airdrop_last_claim = CURRENT_DATE WHERE id = $1`, [req.user.id]);
        await client.query(`INSERT INTO transactions (user_id, user_address, type, title, amount, asset) VALUES ($1, $2, 'receive', 'Airdrop Toàn Cầu', 0.2, 'POPT')`, [req.user.id, req.user.address]);
        
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

app.post('/api/ticket/create', authenticateToken, async (req, res) => {
    const { subject, message } = req.body;
    const ticketId = 'TK' + Math.floor(1000 + Math.random() * 9000);
    try {
        await pool.query(`INSERT INTO tickets (id, user_id, user_address, subject, message) VALUES ($1, $2, $3, $4, $5)`, [ticketId, req.user.id, req.user.address, subject, message]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/kyc/submit', authenticateToken, async (req, res) => {
    try {
        await pool.query(`UPDATE users SET kyc_status = 'pending' WHERE id = $1`, [req.user.id]);
        await pool.query(`INSERT INTO kyc_requests (user_id, wallet_address) VALUES ($1, $2)`, [req.user.id, req.user.address]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 7. API ADMIN QUYỀN LỰC
// ==========================================
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        const users = await pool.query(`SELECT COUNT(*) FROM users`);
        const sums = await pool.query(`SELECT SUM(usdt_balance) as total_usdt, SUM(popt_balance) as total_popt FROM users`);
        const history = await pool.query(`SELECT * FROM transactions ORDER BY created_at DESC LIMIT 20`);
        res.json({ totalUsers: users.rows[0].count, totalUSDT: sums.rows[0].total_usdt || 0, totalPOPT: sums.rows[0].total_popt || 0, history: history.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/user/:address', authenticateAdmin, async (req, res) => {
    try {
        const user = await pool.query(`SELECT wallet_address, usdt_balance, popt_balance, kyc_status FROM users WHERE wallet_address = $1`, [req.params.address]);
        if (user.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy" });
        res.json(user.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/fund', authenticateAdmin, async (req, res) => {
    const { targetAddress, amount, asset, action } = req.body;
    const balanceField = asset === 'USDT' ? 'usdt_balance' : 'popt_balance';
    try {
        const user = await pool.query(`SELECT id FROM users WHERE wallet_address = $1`, [targetAddress]);
        if (user.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy user" });

        if (action === 'add') {
            await pool.query(`UPDATE users SET ${balanceField} = ${balanceField} + $1 WHERE id = $2`, [amount, user.rows[0].id]);
            await pool.query(`INSERT INTO transactions (user_id, user_address, type, title, amount, asset) VALUES ($1, $2, 'receive', 'Admin Bơm Tiền', $3, $4)`, [user.rows[0].id, targetAddress, amount, asset]);
        } else {
            await pool.query(`UPDATE users SET ${balanceField} = ${balanceField} - $1 WHERE id = $2`, [amount, user.rows[0].id]);
            await pool.query(`INSERT INTO transactions (user_id, user_address, type, title, amount, asset) VALUES ($1, $2, 'send', 'Admin Trừ Tiền', $3, $4)`, [user.rows[0].id, targetAddress, amount, asset]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/kyc/pending', authenticateAdmin, async (req, res) => {
    try {
        const list = await pool.query(`SELECT * FROM kyc_requests WHERE status = 'pending' ORDER BY created_at ASC`);
        res.json(list.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/kyc/process', authenticateAdmin, async (req, res) => {
    const { userId, status } = req.body; 
    try {
        await pool.query(`UPDATE users SET kyc_status = $1 WHERE id = $2`, [status, userId]);
        await pool.query(`UPDATE kyc_requests SET status = $1 WHERE user_id = $2`, [status, userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/tickets', authenticateAdmin, async (req, res) => {
    try {
        const tickets = await pool.query(`SELECT * FROM tickets ORDER BY created_at DESC`);
        res.json(tickets.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/ticket/close', authenticateAdmin, async (req, res) => {
    try {
        await pool.query(`UPDATE tickets SET status = 'closed' WHERE id = $1`, [req.body.ticketId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Popay Server is running on port ${PORT}`);
});
