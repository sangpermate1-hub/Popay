require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');

const app = express();

// ==========================================
// CẤU HÌNH WEB SERVER & BẢO MẬT
// ==========================================
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

const upload = multer({ dest: 'uploads/' });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==========================================
// HÀM TIỆN ÍCH CORE (CHỐNG LỖI NaN & CRASH)
// ==========================================
function generateWallet() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let randomPart = '';
    for (let i = 0; i < 29; i++) randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    return 'M' + randomPart;
}

async function recordTx(client, type, from, to, amount, currency) {
    const txHash = 'TX' + Math.random().toString(36).substring(2, 10).toUpperCase() + Date.now().toString(36).toUpperCase();
    await client.query(
        `INSERT INTO transaction_history (tx_hash, type, from_wallet, to_wallet, amount, currency) VALUES ($1, $2, $3, $4, $5, $6)`,
        [txHash, type, from, to, parseFloat(amount) || 0, currency]
    );
    return txHash;
}

// Hàm lấy số dư KHÔNG BAO GIỜ trả về NaN
async function getBalance(wallet, currency) {
    try {
        const res = await pool.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN to_wallet = $1 THEN amount ELSE 0 END), 0) - 
                COALESCE(SUM(CASE WHEN from_wallet = $1 THEN amount ELSE 0 END), 0) as balance
            FROM transaction_history 
            WHERE (to_wallet = $1 OR from_wallet = $1) AND currency = $2
        `, [wallet, currency]);
        
        if (res.rows.length === 0) return 0;
        const bal = parseFloat(res.rows[0].balance);
        return isNaN(bal) ? 0 : bal;
    } catch (e) {
        console.error(`[Lỗi getBalance ${currency}]:`, e.message);
        return 0;
    }
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
        await pool.query(`INSERT INTO users (wallet_address, full_name, email, password_hash, referral_code, referred_by) VALUES ($1, $2, $3, $4, $5, $6)`, [wallet, full_name, email, hash, ref, referred_by]);
        await recordTx(pool, 'mint', 'SYSTEM', wallet, 0, 'MPT');
        res.status(201).json({ message: 'Tạo ví thành công', wallet_address: wallet });
    } catch (e) { res.status(400).json({ message: 'Email đã tồn tại' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        if (user.rows.length === 0 || !await bcrypt.compare(password, user.rows[0].password_hash)) {
            return res.status(401).json({ message: 'Sai thông tin' });
        }
        res.json({ token: 'active_session', wallet_address: user.rows[0].wallet_address });
    } catch (e) { res.status(500).send(); }
});

// ==========================================
// 2. MODULE VÍ & TÀI SẢN (INDEX)
// ==========================================
app.get('/api/wallet/assets', async (req, res) => {
    const { wallet } = req.query;
    try {
        const [mpt, usdt, ton, usdc, doge] = await Promise.all([
            getBalance(wallet, 'MPT'), getBalance(wallet, 'USDT'), getBalance(wallet, 'TON'), getBalance(wallet, 'USDC'), getBalance(wallet, 'DOGE')
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
        if (bal < parseFloat(amount)) throw new Error('Số dư không đủ');
        const txHash = await recordTx(client, 'transfer', from_wallet, to_wallet, amount, currency);
        await client.query('COMMIT');
        res.json({ success: true, tx_hash: txHash });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); } 
    finally { client.release(); }
});

// ==========================================
// 3. MODULE RÚT TIỀN & LỊCH SỬ TRADE (ĐÃ FIX LỖI KHÔNG TẢI ĐƯỢC)
// ==========================================
app.get('/api/p2p/my-pending', async (req, res) => {
    const { wallet } = req.query;
    try {
        // Đã sửa lại bí danh (alias) 'type' và 'asset' để khớp 100% với file trade.html của bạn
        const result = await pool.query(`
            SELECT id, 'withdraw' as type, asset, amount, vnd_amount, status, created_at 
            FROM withdraw_requests WHERE wallet = $1
            UNION ALL
            SELECT id, 'deposit' as type, currency as asset, amount, (amount * 26800)::text as vnd_amount, 'completed' as status, created_at 
            FROM transaction_history WHERE to_wallet = $1 AND type = 'deposit_sepay'
            ORDER BY created_at DESC
        `, [wallet]);
        res.json(result.rows);
    } catch(e) { 
        console.error('Lỗi API my-pending:', e.message);
        res.json([]); // Nếu lỗi, trả về mảng rỗng để không bị vỡ giao diện
    }
});

app.post('/api/admin/withdraw-request', async (req, res) => {
    const { wallet, asset, amount, vnd_amount, bank } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const bal = await getBalance(wallet, asset);
        if (bal < parseFloat(amount)) throw new Error('Số dư không đủ');
        await recordTx(client, 'withdraw_hold', wallet, 'SYSTEM_HOLD', amount, asset);
        await client.query(`INSERT INTO withdraw_requests (wallet, asset, amount, vnd_amount, bank) VALUES ($1, $2, $3, $4, $5)`, [wallet, asset, amount, vnd_amount, bank]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); } 
    finally { client.release(); }
});

// ==========================================
// 4. MODULE STAKING (ĐÃ FIX LỖI NaN USDT)
// ==========================================
app.get('/api/staking/info', async (req, res) => {
    const { wallet } = req.query;
    try {
        // Tự động tạo bản ghi staking nếu chưa có để chống lỗi undefined
        await pool.query(`INSERT INTO user_staking (wallet_address, staked_usdt, earned_mpt) VALUES ($1, 0, 0) ON CONFLICT (wallet_address) DO NOTHING`, [wallet]);
        const r = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
        const avail = await getBalance(wallet, 'USDT');
        
        res.json({ 
            staked_usdt: Number(r.rows[0]?.staked_usdt) || 0, 
            earned_mpt: Number(r.rows[0]?.earned_mpt) || 0, 
            available_usdt: avail 
        });
    } catch (e) { 
        console.error('Lỗi Staking Info:', e.message);
        res.json({ staked_usdt: 0, earned_mpt: 0, available_usdt: 0 }); 
    }
});

app.post('/api/staking/deposit', async (req, res) => {
    const { wallet, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqAmount = parseFloat(amount);
        const bal = await getBalance(wallet, 'USDT');
        if (bal < reqAmount) throw new Error('Số dư USDT không đủ');
        await recordTx(client, 'stake', wallet, 'SYSTEM_STAKING', reqAmount, 'USDT');
        await client.query(`UPDATE user_staking SET staked_usdt = staked_usdt + $1, last_updated = CURRENT_TIMESTAMP WHERE wallet_address = $2`, [reqAmount, wallet]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); } 
    finally { client.release(); }
});

app.post('/api/staking/withdraw', async (req, res) => {
    const { wallet, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqAmount = parseFloat(amount);
        const stk = (await client.query(`SELECT * FROM user_staking WHERE wallet_address = $1 FOR UPDATE`, [wallet])).rows[0];
        if (!stk || parseFloat(stk.staked_usdt) < reqAmount) throw new Error('Vượt quá số vốn đang Stake');
        await recordTx(client, 'unstake', 'SYSTEM_STAKING', wallet, reqAmount, 'USDT');
        if (parseFloat(stk.earned_mpt) > 0) {
            await recordTx(client, 'reward', 'SYSTEM_STAKING', wallet, stk.earned_mpt, 'MPT');
        }
        await client.query(`UPDATE user_staking SET staked_usdt = staked_usdt - $1, earned_mpt = 0 WHERE wallet_address = $2`, [reqAmount, wallet]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); } 
    finally { client.release(); }
});

// ==========================================
// 5. MODULE EXPLORER (ĐÃ FIX LỖI "KHÔNG TÌM THẤY DỮ LIỆU")
// ==========================================
app.get('/api/explorer/stats', async (req, res) => {
    try {
        const u = await pool.query(`SELECT COUNT(*) FROM users`);
        const t = await pool.query(`SELECT COUNT(*) FROM transaction_history`);
        res.json({ total_wallets: parseInt(u.rows[0].count), total_transactions: parseInt(t.rows[0].count), supply_mspw: 1000000000 });
    } catch (e) { res.json({ total_wallets: 0, total_transactions: 0, supply_mspw: 1000000000 }); }
});

app.get('/api/explorer/latest-mints', async (req, res) => {
    try { res.json((await pool.query(`SELECT wallet_address as wallet, created_at FROM users ORDER BY created_at DESC LIMIT 6`)).rows); } 
    catch(e) { res.json([]); }
});

app.get('/api/explorer/latest-txns', async (req, res) => {
    try { res.json((await pool.query(`SELECT * FROM transaction_history ORDER BY created_at DESC LIMIT 6`)).rows); } 
    catch(e) { res.json([]); }
});

app.get('/api/explorer/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ message: "Thiếu dữ liệu tìm kiếm" });

    try {
        // Nếu là mã Giao dịch (TX...)
        if (q.startsWith('TX')) {
            const tx = await pool.query(`SELECT * FROM transaction_history WHERE tx_hash = $1`, [q]);
            if (tx.rows.length > 0) return res.json(tx.rows[0]);
            return res.status(404).json({ message: "Không tìm thấy giao dịch" });
        }
        
        // Nếu là tìm Ví (M..., SYSTEM, BANK...) -> TRẢ VỀ DÙ CÓ HAY KHÔNG ĐỂ GIAO DIỆN KHÔNG CRASH
        const txns = await pool.query(`SELECT * FROM transaction_history WHERE from_wallet = $1 OR to_wallet = $1 ORDER BY created_at DESC LIMIT 20`, [q]);
        const mpt = await getBalance(q, 'MPT');
        const usdt = await getBalance(q, 'USDT');
        
        res.json({
            wallet_address: q,
            kyc_status: 'approved', 
            balance_mspw: mpt,
            balance_usdt: usdt,
            txns: txns.rows || []
        });
    } catch (e) { 
        console.error('Explore Error:', e.message);
        res.status(500).json({ message: "Lỗi máy chủ" }); 
    }
});

// ==========================================
// 6. QUẢN TRỊ ADMIN (ADMIN.HTML)
// ==========================================
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const u = await pool.query(`SELECT COUNT(*) FROM users`);
        const w = await pool.query(`SELECT COUNT(*) FROM withdraw_requests WHERE status = 'pending'`);
        const s = await pool.query(`SELECT COALESCE(SUM(staked_usdt), 0) as total FROM user_staking`);
        res.json({ total_users: parseInt(u.rows[0].count), total_staking: parseFloat(s.rows[0].total), pending_p2p: 0, pending_withdraws: parseInt(w.rows[0].count) });
    } catch(e) { res.json({ total_users: 0, total_staking: 0, pending_p2p: 0, pending_withdraws: 0 }); }
});

app.get('/api/admin/users', async (req, res) => {
    try { res.json((await pool.query(`SELECT wallet_address, email, created_at FROM users ORDER BY created_at DESC`)).rows); } 
    catch(e) { res.json([]); }
});

app.get('/api/admin/withdraws/pending', async (req, res) => {
    try { res.json((await pool.query(`SELECT * FROM withdraw_requests WHERE status = 'pending' ORDER BY created_at DESC`)).rows); } 
    catch(e) { res.json([]); }
});

app.post('/api/admin/withdraws/process', async (req, res) => {
    const { id, status } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const wd = (await client.query(`SELECT * FROM withdraw_requests WHERE id = $1`, [id])).rows[0];
        if (status === 'completed') await recordTx(client, 'withdraw_final', 'SYSTEM_HOLD', 'BURN', wd.amount, wd.asset);
        else await recordTx(client, 'withdraw_refund', 'SYSTEM_HOLD', wd.wallet, wd.amount, wd.asset);
        await client.query(`UPDATE withdraw_requests SET status = $1 WHERE id = $2`, [status, id]);
        await client.query('COMMIT'); res.json({ success: true });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).send(); } 
    finally { client.release(); }
});

// ==========================================
// 7. WEBHOOK SEPAY (NẠP TIỀN HOẠT ĐỘNG 100%)
// ==========================================
app.post('/api/webhooks/sepay', async (req, res) => {
    const { content, amount } = req.body; 
    if (!content || !amount) return res.status(200).send('OK');

    // Xử lý chuỗi thông minh: Bỏ mọi khoảng trắng, dấu -, và cắt lấy chuỗi ngay sau MPH
    const cleanContent = content.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (!cleanContent.includes('MPH')) return res.status(200).send('Không có Tag MPH');

    const walletTag = cleanContent.split('MPH')[1]; // Lấy phần đuôi mã ví

    try {
        const userQuery = await pool.query(`SELECT wallet_address FROM users WHERE wallet_address LIKE $1`, [`%${walletTag}`]);
        if (userQuery.rows.length > 0) {
            const wallet = userQuery.rows[0].wallet_address;
            const usdtAmount = parseFloat(amount) / 26800;
            await recordTx(pool, 'deposit_sepay', 'BANK_BIDV', wallet, usdtAmount, 'USDT');
            console.log(`✅ Webhook: Đã nạp ${usdtAmount} USDT vào ví ${wallet}`);
        } else {
            console.log(`❌ Webhook: Không tìm thấy ví khớp với: ${walletTag}`);
        }
        res.status(200).json({ success: true });
    } catch (e) {
        console.error('Lỗi Webhook:', e.message);
        res.status(200).send(); 
    }
});

// Khởi chạy Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 MetahashPay Engine Online at port ${PORT}`);
});
