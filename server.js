require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');

const app = express();

// 1. Cấu hình Middleware & Web Server
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname)); // Phát các file HTML, hình ảnh trực tiếp

// 2. Kết nối Database Neon.tech
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const upload = multer({ dest: 'uploads/' });

// ==========================================
// HÀM TIỆN ÍCH (CORE UTILS)
// ==========================================

// Tạo địa chỉ ví M...
function generateWallet() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let randomPart = '';
    for (let i = 0; i < 29; i++) randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    return 'M' + randomPart;
}

// Ghi Sổ cái (Ledger) - Mọi biến động tiền tệ phải qua đây
async function recordTx(client, type, from, to, amount, currency) {
    const txHash = 'TX' + Math.random().toString(36).substring(2, 15).toUpperCase();
    await client.query(
        `INSERT INTO transaction_history (tx_hash, type, from_wallet, to_wallet, amount, currency) VALUES ($1, $2, $3, $4, $5, $6)`,
        [txHash, type, from, to, amount, currency]
    );
    return txHash;
}

// Tính số dư từ Sổ cái
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
// 3. ĐỊNH TUYẾN GIAO DIỆN (FRONTEND HOST)
// ==========================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// ==========================================
// 4. API XÁC THỰC (AUTH)
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
        res.status(201).json({ wallet_address: wallet });
    } catch (e) { res.status(400).json({ message: 'Email đã tồn tại' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        if (user.rows.length === 0) return res.status(401).json({ message: 'Tài khoản không tồn tại' });
        const match = await bcrypt.compare(password, user.rows[0].password_hash);
        if (!match) return res.status(401).json({ message: 'Sai mật khẩu' });
        res.json({ token: 'jwt-xyz', wallet_address: user.rows[0].wallet_address });
    } catch (e) { res.status(500).send(); }
});

// ==========================================
// 5. API VÍ & TÀI SẢN
// ==========================================
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
        const bal = await getBalance(from_wallet, currency);
        if(bal < amount) throw new Error('Số dư không đủ');
        await recordTx(client, 'transfer', from_wallet, to_wallet, amount, currency);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); }
    finally { client.release(); }
});

// ==========================================
// 6. WEBHOOK SEPAY (NẠP TIỀN TỰ ĐỘNG)
// ==========================================
app.post('/api/webhooks/sepay', async (req, res) => {
    const { content, amount, gateway } = req.body; // Dữ liệu từ SePay
    // Nội dung mẫu: "MPHABC123" -> lấy "ABC123"
    const walletTag = content.replace('MPH', '').toUpperCase();
    
    try {
        // Tìm người dùng có 6 ký tự cuối ví khớp với nội dung chuyển khoản
        const userRes = await pool.query(`SELECT wallet_address FROM users WHERE wallet_address LIKE $1`, [`%${walletTag}`]);
        
        if (userRes.rows.length > 0) {
            const wallet = userRes.rows[0].wallet_address;
            const usdtAmount = parseFloat(amount) / 26800; // Tỷ giá nạp cố định
            
            await recordTx(pool, 'deposit_sepay', 'BANK_BIDV', wallet, usdtAmount, 'USDT');
            console.log(`✅ Đã nạp ${usdtAmount} USDT cho ví ${wallet}`);
            res.json({ success: true });
        } else {
            console.log(`❌ Không tìm thấy ví cho nội dung: ${content}`);
            res.status(404).send();
        }
    } catch (e) { res.status(500).send(); }
});

// ==========================================
// 7. API RÚT TIỀN (GỬI ĐẾN ADMIN)
// ==========================================
app.post('/api/admin/withdraw-request', async (req, res) => {
    const { wallet, asset, amount, vnd_amount, bank } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const bal = await getBalance(wallet, asset);
        if(bal < amount) throw new Error('Số dư không đủ để rút');

        // Tạm khóa tiền của khách bằng cách chuyển vào ví hệ thống rút
        await recordTx(client, 'withdraw_hold', wallet, 'SYSTEM_WITHDRAW_HOLD', amount, asset);

        await client.query(
            `INSERT INTO withdraw_requests (wallet, asset, amount, vnd_amount, bank, status) VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [wallet, asset, amount, vnd_amount, bank]
        );
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); }
    finally { client.release(); }
});

// ==========================================
// 8. API QUẢN TRỊ (ADMIN)
// ==========================================
app.get('/api/admin/dashboard', async (req, res) => {
    const u = await pool.query(`SELECT COUNT(*) FROM users`);
    const s = await pool.query(`SELECT SUM(staked_usdt) FROM user_staking`);
    const p = await pool.query(`SELECT COUNT(*) FROM withdraw_requests WHERE status = 'pending'`);
    res.json({ total_users: u.rows[0].count, total_staking: s.rows[0].sum || 0, pending_p2p: p.rows[0].count });
});

app.get('/api/admin/withdraws/pending', async (req, res) => {
    const result = await pool.query(`SELECT * FROM withdraw_requests WHERE status = 'pending' ORDER BY created_at DESC`);
    res.json(result.rows);
});

app.post('/api/admin/withdraws/process', async (req, res) => {
    const { id, status } = req.body; // status: 'completed' hoặc 'rejected'
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqData = (await client.query(`SELECT * FROM withdraw_requests WHERE id = $1`, [id])).rows[0];
        
        if (status === 'completed') {
            // Xóa bỏ số tiền đang treo (vì admin đã chuyển khoản bank ngoài xong)
            await recordTx(client, 'withdraw_done', 'SYSTEM_WITHDRAW_HOLD', 'BURN_ADDRESS', reqData.amount, reqData.asset);
        } else {
            // Hoàn lại tiền cho khách nếu từ chối
            await recordTx(client, 'withdraw_refund', 'SYSTEM_WITHDRAW_HOLD', reqData.wallet, reqData.amount, reqData.asset);
        }

        await client.query(`UPDATE withdraw_requests SET status = $1 WHERE id = $2`, [status, id]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).send(); }
    finally { client.release(); }
});

// ==========================================
// 9. MODULE STAKING & EXPLORER (GIỮ NGUYÊN)
// ==========================================
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
        if(bal < amount) throw new Error('Không đủ USDT');
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
        const stk = (await client.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet])).rows[0];
        if(stk.staked_usdt < amount) throw new Error('Vượt quá số vốn');
        await recordTx(client, 'unstake', 'SYSTEM_STAKING', wallet, amount, 'USDT');
        if(stk.earned_mpt > 0) await recordTx(client, 'reward', 'SYSTEM_STAKING', wallet, stk.earned_mpt, 'MPT');
        await client.query(`UPDATE user_staking SET staked_usdt = staked_usdt - $1, earned_mpt = 0 WHERE wallet_address = $2`, [amount, wallet]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); }
    finally { client.release(); }
});

// API Explorer
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
    if (type === 'address') {
        const mpt = await getBalance(q, 'MPT');
        const usdt = await getBalance(q, 'USDT');
        const txs = await pool.query(`SELECT * FROM transaction_history WHERE from_wallet = $1 OR to_wallet = $1 ORDER BY created_at DESC`, [q]);
        res.json({ wallet_address: q, kyc_status: 'approved', balance_mspw: mpt, balance_usdt: usdt, txns: txs.rows });
    } else {
        const tx = await pool.query(`SELECT * FROM transaction_history WHERE tx_hash = $1`, [q]);
        res.json(tx.rows[0]);
    }
});

// Khởi chạy
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MetahashPay Online tại cổng ${PORT}`));
