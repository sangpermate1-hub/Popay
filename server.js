require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');

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
app.use(express.static(path.join(__dirname)));

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

// BỔ SUNG: TxHash cho Sổ cái để Explorer check được chi tiết
async function recordTx(client, type, from, to, amount, currency) {
    const txHash = 'TX' + Math.random().toString(36).substring(2, 10).toUpperCase() + Date.now().toString(36).toUpperCase();
    await client.query(
        `INSERT INTO transaction_history (tx_hash, type, from_wallet, to_wallet, amount, currency) VALUES ($1, $2, $3, $4, $5, $6)`,
        [txHash, type, from, to, amount, currency]
    );
    return txHash;
}

// FIX LỖI NaN: Sử dụng COALESCE để ép giá trị NULL thành 0
async function getBalance(wallet, currency) {
    const res = await pool.query(`
        SELECT 
            COALESCE(SUM(CASE WHEN to_wallet = $1 THEN amount ELSE 0 END), 0) - 
            COALESCE(SUM(CASE WHEN from_wallet = $1 THEN amount ELSE 0 END), 0) as balance
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
        const usdc = await getBalance(wallet, 'USDC'); // Bổ sung USDC
        const doge = await getBalance(wallet, 'DOGE'); // Bổ sung DOGE
        res.json({ MPT: mpt, USDT: usdt, TON: ton, USDC: usdc, DOGE: doge }); 
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
// 3. MODULE P2P ESCROW (Giữ nguyên theo yêu cầu)
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
        // Hợp nhất cả lệnh P2P và lệnh Rút tiền (withdraw) để tab Lệnh xử lý luôn có dữ liệu
        const result = await pool.query(`
            SELECT id, 'p2p' as category, type, amount, status, created_at FROM p2p_orders WHERE (maker_wallet = $1 OR taker_wallet = $1) AND status NOT IN ('completed', 'cancelled')
            UNION ALL
            SELECT id, 'withdraw' as category, asset as type, amount, status, created_at FROM withdraw_requests WHERE wallet = $1
            ORDER BY created_at DESC
        `, [wallet]);
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
// 5. MODULE EXPLORER (CẬP NHẬT HOÀN THIỆN)
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

// CẬP NHẬT CHÍNH: API Search của Explorer để lấy thông tin ví và Hash
app.get('/api/explorer/search', async (req, res) => {
    const { type, q } = req.query;
    try {
        // 1. Nếu người dùng tìm kiếm bằng địa chỉ Ví (bắt đầu bằng 'M')
        if (type === 'address' || (q && q.startsWith('M'))) {
            // Kiểm tra ví có tồn tại trong hệ thống không
            const userRes = await pool.query(`SELECT * FROM users WHERE wallet_address = $1`, [q]);
            if(userRes.rows.length === 0) return res.status(404).json(null);
            
            // Lấy 20 giao dịch gần nhất của ví này
            const txnsRes = await pool.query(`SELECT * FROM transaction_history WHERE from_wallet = $1 OR to_wallet = $1 ORDER BY created_at DESC LIMIT 20`, [q]);
            
            // Lấy số dư MPT và USDT để hiển thị chi tiết tài sản
            const mpt = await getBalance(q, 'MPT');
            const usdt = await getBalance(q, 'USDT');
            
            res.json({
                wallet_address: q,
                kyc_status: 'unverified', // Mặc định nếu không có bảng KYC
                balance_mspw: mpt,
                balance_usdt: usdt,
                txns: txnsRes.rows
            });
        } 
        // 2. Nếu người dùng tìm kiếm bằng mã Giao dịch (Hash) (bắt đầu bằng 'TX')
        else if (q && q.startsWith('TX')) {
            const txRes = await pool.query(`SELECT * FROM transaction_history WHERE tx_hash = $1`, [q]);
            if(txRes.rows.length === 0) return res.status(404).json(null);
            res.json(txRes.rows[0]);
        } 
        else {
            res.status(400).json({ message: "Invalid search query format" });
        }
    } catch (e) { 
        console.error('Lỗi API Search Explorer:', e);
        res.status(500).send(); 
    }
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
// 7. QUẢN TRỊ ADMIN (BỔ SUNG RÚT TIỀN)
// ==========================================
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const u = await pool.query(`SELECT COUNT(*) FROM users`);
        const w = await pool.query(`SELECT COUNT(*) FROM withdraw_requests WHERE status = 'pending'`);
        const s = await pool.query(`SELECT COALESCE(SUM(staked_usdt), 0) FROM user_staking`);
        res.json({ total_users: u.rows[0].count, total_staking: s.rows[0].coalesce, pending_p2p: 0, pending_withdraws: w.rows[0].count });
    } catch(e) { res.status(500).send(); }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        // Loại bỏ JOIN với user_kyc vì bảng đó có thể chưa tồn tại
        const result = await pool.query(`SELECT wallet_address, email, created_at FROM users`);
        res.json(result.rows);
    } catch(e) { res.status(500).send(); }
});

// BỔ SUNG: API Duyệt Rút Tiền
app.get('/api/admin/withdraws/pending', async (req, res) => {
    try {
        const r = await pool.query(`SELECT * FROM withdraw_requests WHERE status = 'pending' ORDER BY created_at DESC`);
        res.json(r.rows);
    } catch(e) { res.status(500).send(); }
});

app.post('/api/admin/withdraws/process', async (req, res) => {
    const { id, status } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const wd = (await client.query(`SELECT * FROM withdraw_requests WHERE id = $1`, [id])).rows[0];
        if (status === 'completed') {
            await recordTx(client, 'withdraw_final', 'SYSTEM_HOLD', 'BURN', wd.amount, wd.asset);
        } else {
            await recordTx(client, 'withdraw_refund', 'SYSTEM_HOLD', wd.wallet, wd.amount, wd.asset);
        }
        await client.query(`UPDATE withdraw_requests SET status = $1 WHERE id = $2`, [status, id]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).send(); }
    finally { client.release(); }
});

// ==========================================
// 8. WEBHOOK SEPAY (NẠP TIỀN TỰ ĐỘNG)
// ==========================================
// Tỷ giá cố định: 26.800 VND/USDT
app.post('/api/webhooks/sepay', async (req, res) => {
    const { content, amount } = req.body; 
    
    // Kiểm tra dữ liệu webhook có hợp lệ không
    if (!content || !amount) {
        console.error('Webhook nhận được dữ liệu trống.');
        return res.status(400).send('Missing data');
    }

    // Xử lý chuỗi (Loại bỏ khoảng trắng và ký tự lạ, lấy phần đuôi sau MPH)
    const walletTag = content.replace(/[^a-zA-Z0-9]/g, '').replace('MPH', '').toUpperCase();

    try {
        // Tìm ví của khách hàng khớp với tag trong memo
        const userQuery = await pool.query(
            `SELECT wallet_address FROM users WHERE wallet_address LIKE $1`,
            [`%${walletTag}`]
        );

        if (userQuery.rows.length > 0) {
            const wallet = userQuery.rows[0].wallet_address;
            const usdtAmount = parseFloat(amount) / 26800; // Quy đổi VNĐ sang USDT

            // Ghi chép nạp tiền vào Sổ cái
            await recordTx(pool, 'deposit_sepay', 'BANK_BIDV', wallet, usdtAmount, 'USDT');

            console.log(`[Webhook] Tự động nạp ${usdtAmount} USDT vào ví ${wallet}`);
            res.json({ success: true });
        } else {
            console.log(`[Webhook] Không tìm thấy ví khớp với tag: ${walletTag} (Nội dung gốc: ${content})`);
            res.status(404).json({ message: "Wallet tag not found" });
        }
    } catch (e) {
        console.error('Lỗi xử lý Webhook:', e);
        res.status(500).send();
    }
});

// BỔ SUNG: Gửi yêu cầu rút tiền từ Trade.html
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

// Khởi chạy Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server MetahashPay đang chạy tại cổng ${PORT}`);
    console.log(`✅ Kết nối Database Ledger & SePay Webhook sẵn sàng!`);
});
