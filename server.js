require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

const upload = multer({ dest: 'uploads/' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ==========================================
// HÀM TIỆN ÍCH CORE (CHỐNG SẬP SERVER & FIX NaN)
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
        [txHash, type, from, to, amount, currency]
    );
    return txHash;
}

// Bọc Try-Catch để nếu DB lỗi, luôn trả về 0, KHÔNG BAO GIỜ TRẢ VỀ NaN
async function getBalance(wallet, currency) {
    try {
        const res = await pool.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN to_wallet = $1 THEN amount ELSE 0 END), 0) - 
                COALESCE(SUM(CASE WHEN from_wallet = $1 THEN amount ELSE 0 END), 0) as balance
            FROM transaction_history WHERE (to_wallet = $1 OR from_wallet = $1) AND currency = $2
        `, [wallet, currency]);
        const bal = parseFloat(res.rows[0].balance);
        return isNaN(bal) ? 0 : bal;
    } catch (e) {
        console.error(`Lỗi getBalance (${currency}):`, e.message);
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
        if (user.rows.length === 0 || !await bcrypt.compare(password, user.rows[0].password_hash)) return res.status(401).json({ message: 'Sai thông tin' });
        res.json({ token: 'active_session', wallet_address: user.rows[0].wallet_address });
    } catch (e) { res.status(500).send(); }
});

// ==========================================
// 2. MODULE VÍ CHÍNH (WALLET)
// ==========================================
app.get('/api/wallet/assets', async (req, res) => {
    const { wallet } = req.query;
    try {
        const [mpt, usdt, ton, usdc, doge] = await Promise.all([
            getBalance(wallet, 'MPT'), getBalance(wallet, 'USDT'), getBalance(wallet, 'TON'), getBalance(wallet, 'USDC'), getBalance(wallet, 'DOGE')
        ]);
        res.json({ MPT: mpt, USDT: usdt, TON: ton, USDC: usdc, DOGE: doge }); 
    } catch (e) { res.json({ MPT: 0, USDT: 0, TON: 0, USDC: 0, DOGE: 0 }); } // Cứu hộ trả về 0
});

app.post('/api/wallet/send', async (req, res) => {
    const { from_wallet, to_wallet, amount, currency } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const bal = await getBalance(from_wallet, currency);
        if (bal < amount) throw new Error('Số dư không đủ');
        const txHash = await recordTx(client, 'transfer', from_wallet, to_wallet, amount, currency);
        await client.query('COMMIT');
        res.json({ success: true, tx_hash: txHash });
    } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ message: e.message }); } 
    finally { client.release(); }
});

// ==========================================
// 3. MODULE GIAO DỊCH & NẠP RÚT (TRADE)
// ==========================================
// Lịch sử lệnh xử lý - Cứu hộ không dùng UNION ALL để tránh crash SQL
app.get('/api/p2p/my-pending', async (req, res) => {
    const { wallet } = req.query;
    try {
        const withdraws = await pool.query(`SELECT id, asset as type, amount, vnd_amount, status, created_at, 'withdraw' as category FROM withdraw_requests WHERE wallet = $1`, [wallet]);
        const deposits = await pool.query(`SELECT id, currency as type, amount, status, created_at, 'deposit' as category FROM transaction_history WHERE to_wallet = $1 AND type = 'deposit_sepay'`, [wallet]);
        
        let history = [...withdraws.rows, ...deposits.rows];
        history.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); // Sắp xếp mới nhất
        res.json(history);
    } catch(e) { 
        console.error("Lỗi Lịch sử:", e.message);
        res.json([]); // Lỗi thì trả về rỗng, giao diện không bị crash
    }
});

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

// ==========================================
// 4. MODULE STAKING
// ==========================================
app.get('/api/staking/info', async (req, res) => {
    const { wallet } = req.query;
    try {
        let r = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
        if (r.rows.length === 0) {
            await pool.query(`INSERT INTO user_staking (wallet_address) VALUES ($1)`, [wallet]);
            r = await pool.query(`SELECT * FROM user_staking WHERE wallet_address = $1`, [wallet]);
        }
        res.json({ 
            staked_usdt: parseFloat(r.rows[0].staked_usdt || 0), 
            earned_mpt: parseFloat(r.rows[0].earned_mpt || 0), 
            available_usdt: await getBalance(wallet, 'USDT') 
        });
    } catch (e) { res.json({ staked_usdt: 0, earned_mpt: 0, available_usdt: 0 }); }
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
// 5. MODULE EXPLORER (FIX TÌM KIẾM CHI TIẾT)
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
    if (!q) return res.status(400).json({ error: "Missing query" });

    try {
        // 1. Kiểm tra nếu là Hash (Mã giao dịch bắt đầu bằng TX)
        if (q.startsWith('TX')) {
            const tx = await pool.query(`SELECT * FROM transaction_history WHERE tx_hash = $1`, [q]);
            if (tx.rows.length > 0) return res.json(tx.rows[0]);
        }
        
        // 2. Nếu là tìm kiếm địa chỉ Ví (Bao gồm cả ví nội bộ SYSTEM, BANK)
        const txns = await pool.query(`SELECT * FROM transaction_history WHERE from_wallet = $1 OR to_wallet = $1 ORDER BY created_at DESC LIMIT 20`, [q]);
        const userRes = await pool.query(`SELECT * FROM users WHERE wallet_address = $1`, [q]);
        
        // Nếu không có lịch sử và cũng không có trong danh sách user -> 404
        if (userRes.rows.length === 0 && txns.rows.length === 0) return res.status(404).json({ error: "Not found" });

        const mpt = await getBalance(q, 'MPT');
        const usdt = await getBalance(q, 'USDT');
        
        res.json({
            wallet_address: q,
            kyc_status: 'approved', // Mặc định xanh
            balance_mspw: mpt,
            balance_usdt: usdt,
            txns: txns.rows
        });
    } catch (e) { 
        console.error('Lỗi API Search:', e.message);
        res.status(500).json({ error: e.message }); 
    }
});

// ==========================================
// 6. QUẢN TRỊ ADMIN
// ==========================================
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const u = await pool.query(`SELECT COUNT(*) FROM users`);
        const w = await pool.query(`SELECT COUNT(*) FROM withdraw_requests WHERE status = 'pending'`);
        res.json({ total_users: u.rows[0].count, pending_withdraws: w.rows[0].count, pending_p2p: 0 });
    } catch(e) { res.json({ total_users: 0, pending_withdraws: 0, pending_p2p: 0 }); }
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
// 7. WEBHOOK SEPAY (HOÀN THIỆN)
// ==========================================
app.post('/api/webhooks/sepay', async (req, res) => {
    try {
        const { content, amount } = req.body; 
        if (!content || !amount) return res.status(200).send('OK'); // Trả về 200 để SePay không gửi lại vô hạn

        // Tìm chuỗi MXXXX trong nội dung chuyển khoản
        const match = content.match(/M[A-Z0-9]+/i);
        if (!match) return res.status(200).send('No M Tag');

        const walletTag = match[0].replace(/M/i, '').toUpperCase();

        const userQuery = await pool.query(`SELECT wallet_address FROM users WHERE wallet_address LIKE $1`, [`%${walletTag}`]);

        if (userQuery.rows.length > 0) {
            const wallet = userQuery.rows[0].wallet_address;
            const usdtAmount = parseFloat(amount) / 26800; // Tỷ giá 26.800

            await recordTx(pool, 'deposit_sepay', 'BANK_BIDV', wallet, usdtAmount, 'USDT');
            console.log(`✅ Webhook: Đã nạp ${usdtAmount} USDT vào ví ${wallet}`);
        } else {
            console.log(`❌ Webhook: Không tìm thấy ví cho tag: ${walletTag}`);
        }
        res.status(200).json({ success: true });
    } catch (e) {
        console.error('Lỗi Webhook:', e.message);
        res.status(200).send(); // Vẫn báo 200 để ngắt kết nối SePay
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server MetahashPay Online: ${PORT}`));
