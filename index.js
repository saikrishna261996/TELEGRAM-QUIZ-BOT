const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const Redis = require('ioredis');

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN || '8170920973:AAGHtD63apa-4qIRrdV7z2E1k0DFmyXpRog'; 
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const WHATSAPP_URL = 'https://chat.whatsapp.com/GwtVGLUarAVDqBXV4PaYF1'; 

// IMPORTANT: Replace 'YOUR_ADMIN_ID' with your numerical Telegram ID
const ADMIN_ID = 8170920973; 

const CONFIG = {
    RATE_LIMIT_MS: 2000,        
    POLL_DURATION: 25,          
    AUTO_SKIP_BUFFER: 2000,     
    MAX_RETRIES: 3,
    SESSION_TIMEOUT: 7200,      
    NEXT_QUESTION_DELAY: 2500,  
    LEADERBOARD_KEY: 'quiz_leaderboard_v1',
    USER_NAMES_KEY: 'user_display_names'
};

// --- INITIALIZATION ---
const bot = new Telegraf(BOT_TOKEN);
let redis = null;
let useRedis = false;
const sessions = new Map();
const timeouts = new Map(); 

function initRedis() {
    try {
        redis = new Redis(REDIS_URL, { 
            retryStrategy: (times) => Math.min(times * 50, 2000),
            connectTimeout: 10000 
        });
        redis.on('connect', () => { console.log('✅ Redis Connected'); useRedis = true; });
        redis.on('error', (err) => { console.error('❌ Redis Error:', err.message); useRedis = false; });
    } catch { console.log('⚠️ Redis failed! Leaderboard requires Redis.'); }
}

// --- DATA LOADING ---
let quizData = [];
let TOTAL_QUESTIONS = 0;
function loadQuestions() {
    try {
        const raw = fs.readFileSync('questions.json', 'utf8');
        quizData = JSON.parse(raw);
        quizData.forEach(item => {
            item.options = item.options.map(opt => String(opt).substring(0, 100));
        });
        TOTAL_QUESTIONS = quizData.length;
        console.log(`✅ Loaded ${TOTAL_QUESTIONS} questions.`);
    } catch (err) {
        console.error("🚨 JSON Error: Check questions.json!");
        process.exit(1);
    }
}

// --- API SAFETY ---
const chatCooldowns = new Map();
async function safeApi(chatId, apiFn, retries = 0) {
    const now = Date.now();
    const last = chatCooldowns.get(chatId) || 0;
    if (now - last < CONFIG.RATE_LIMIT_MS) {
        await new Promise(r => setTimeout(r, CONFIG.RATE_LIMIT_MS - (now - last)));
    }
    chatCooldowns.set(chatId, Date.now());
    try { return await apiFn(); } catch (error) {
        if (error.response?.error_code === 429 && retries < CONFIG.MAX_RETRIES) {
            const retryAfter = (error.response.parameters?.retry_after || 2) * 1000;
            await new Promise(r => setTimeout(r, retryAfter));
            return safeApi(chatId, apiFn, retries + 1);
        }
        throw error;
    }
}

// --- LEADERBOARD LOGIC ---
async function getLeaderboardText(currentUserId) {
    if (!useRedis) return "⚠️ Leaderboard requires Redis to be connected.";
    const top20 = await redis.zrevrange(CONFIG.LEADERBOARD_KEY, 0, 19, 'WITHSCORES');
    const userRank = await redis.zrevrank(CONFIG.LEADERBOARD_KEY, currentUserId);
    const userScore = await redis.zscore(CONFIG.LEADERBOARD_KEY, currentUserId);

    let text = "🏆 *TOP 20 PERFORMERS* 🏆\n\n";
    if (top20.length === 0) {
        text += "_No scores recorded yet!_";
    } else {
        for (let i = 0; i < top20.length; i += 2) {
            const userId = top20[i];
            const score = top20[i + 1];
            const name = await redis.hget(CONFIG.USER_NAMES_KEY, userId) || "Candidate";
            const rank = (i / 2) + 1;
            const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "🔹";
            text += `${medal} ${rank}. *${name}*: ${score} pts\n`;
        }
    }
    if (userRank !== null) text += `\n---\n🎖 *Your Rank:* #${userRank + 1} | *Score:* ${userScore}`;
    return text;
}

// --- SESSION HELPERS ---
async function getSession(userId) {
    if (useRedis) {
        const data = await redis.hgetall(`session:${userId}`);
        return Object.keys(data).length ? {
            index: parseInt(data.index), chatId: data.chatId,
            score: parseInt(data.score), userName: data.userName
        } : null;
    }
    return sessions.get(userId);
}

async function setSession(userId, session) {
    if (useRedis) {
        await redis.hmset(`session:${userId}`, session);
        await redis.expire(`session:${userId}`, CONFIG.SESSION_TIMEOUT);
        await redis.hset(CONFIG.USER_NAMES_KEY, userId, session.userName);
    } else sessions.set(userId, session);
}

// --- CORE QUIZ LOGIC ---
async function sendQuestion(userId, chatId, index) {
    if (index >= TOTAL_QUESTIONS) {
        const session = await getSession(userId);
        const finalButtons = Markup.inlineKeyboard([
            [Markup.button.url('🔗 Join WhatsApp Community', WHATSAPP_URL)],
            [Markup.button.url('📤 Share with Friends', `https://t.me/share/url?url=${WHATSAPP_URL}&text=Join%20this%20Nursing%20Achievers%20Group!`)]
        ]);

        await safeApi(chatId, () => bot.telegram.sendMessage(chatId, 
            `🎉 *QUIZ COMPLETE!*\n\nFinal Score: *${session?.score || 0}/${TOTAL_QUESTIONS}*`, 
            { parse_mode: 'Markdown', protect_content: true }
        ));

        const lbText = await getLeaderboardText(userId);
        await safeApi(chatId, () => bot.telegram.sendMessage(chatId, lbText, { 
            parse_mode: 'Markdown',
            ...finalButtons 
        }));

        if (useRedis) await redis.del(`session:${userId}`);
        else sessions.delete(userId);
        return;
    }

    if (timeouts.has(userId)) {
        clearTimeout(timeouts.get(userId));
        timeouts.delete(userId);
    }

    const q = quizData[index];
    const session = await getSession(userId);

    await safeApi(chatId, () => bot.telegram.sendMessage(chatId, `📊 *Question ${index + 1}/${TOTAL_QUESTIONS}*`, { parse_mode: 'Markdown' }));
    
    await safeApi(chatId, () => bot.telegram.sendPoll(chatId, q.question, q.options, {
        type: 'quiz',
        correct_option_id: q.correct_index,
        is_anonymous: false,
        open_period: CONFIG.POLL_DURATION,
        protect_content: true,
        explanation: q.explanation || "Nursing concept study required!",
        explanation_parse_mode: 'Markdown'
    }));

    // WhatsApp button under every question
    await safeApi(chatId, () => bot.telegram.sendMessage(chatId, "👇 *Discussion & Notes:*", {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.url('🔗 Join WhatsApp Group', WHATSAPP_URL)]])
    }));

    await setSession(userId, { ...session, index, chatId: String(chatId) });

    const timer = setTimeout(async () => {
        const cur = await getSession(userId);
        if (cur && cur.index === index) {
            await bot.telegram.sendMessage(chatId, "⏰ *Time's up!* Moving to the next question...");
            sendQuestion(userId, chatId, index + 1);
        }
    }, (CONFIG.POLL_DURATION * 1000) + CONFIG.AUTO_SKIP_BUFFER);

    timeouts.set(userId, timer);
}

// --- HANDLERS ---

// 🟢 New: File Upload Handler
bot.on('document', async (ctx) => {
    const { file_id, file_name } = ctx.message.document;

    // Security check: Only you can upload
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply("🚫 Unauthorized. Only the admin can upload questions.");
    }

    if (file_name === 'questions.json') {
        try {
            const link = await ctx.telegram.getFileLink(file_id);
            const response = await fetch(link.href);
            const newQuestions = await response.json();

            if (Array.isArray(newQuestions)) {
                fs.writeFileSync('questions.json', JSON.stringify(newQuestions, null, 2));
                loadQuestions();
                ctx.reply(`✅ Success! Updated questions. Total: ${TOTAL_QUESTIONS}`);
            }
        } catch (err) {
            ctx.reply("🚨 Error: Invalid JSON file format.");
        }
    }
});

bot.start((ctx) => ctx.reply("🏥 *Nursing Achievers Hub Quiz Bot Ready!*", 
    Markup.inlineKeyboard([[Markup.button.url('🔗 Join WhatsApp', WHATSAPP_URL)]])));

bot.command('runquiz', async (ctx) => {
    const userId = ctx.from.id;
    await setSession(userId, { index: 0, score: 0, chatId: String(ctx.chat.id), userName: ctx.from.first_name });
    await sendQuestion(userId, ctx.chat.id, 0);
});

bot.command('leaderboard', async (ctx) => {
    const text = await getLeaderboardText(ctx.from.id);
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.on('poll_answer', async (ctx) => {
    const { user, option_ids } = ctx.update.poll_answer;
    const userId = user.id;
    if (timeouts.has(userId)) { clearTimeout(timeouts.get(userId)); timeouts.delete(userId); }

    const session = await getSession(userId);
    if (!session) return;

    if (option_ids[0] === quizData[session.index].correct_index) {
        session.score++;
        if (useRedis) await redis.zadd(CONFIG.LEADERBOARD_KEY, session.score, userId);
    }
    
    session.index++;
    await setSession(userId, session);
    setTimeout(() => sendQuestion(userId, session.chatId, session.index), CONFIG.NEXT_QUESTION_DELAY);
});

// --- LAUNCH ---
initRedis();
loadQuestions();
bot.launch().then(() => console.log("🚀 Bot Live with Upload, Bulb, and WhatsApp Share!"));