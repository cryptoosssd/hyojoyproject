// ===== Подключение Firebase =====
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
    getFirestore, collection, addDoc, query, orderBy, limit,
    onSnapshot, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyCUSTTJhonzZPOKWUbe_qMZfMmVyFSxjPE",
    authDomain: "hyojoy-41840.firebaseapp.com",
    projectId: "hyojoy-41840",
    storageBucket: "hyojoy-41840.firebasestorage.app",
    messagingSenderId: "714253431446",
    appId: "1:714253431446:web:fe08e2cbe51c768dfd48b7",
    measurementId: "G-DQ3F2VMTCJ"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ===== Настройки =====
const K = 0.01;              // 1 акция = 0.01 BTC
const SHAKE = 0.005;         // ±0.5%
const UPDATE_MS = 5000;      // обновление раз в 5 сек
const MAX_TICKS = 800;

const TICKS_COLLECTION = 'hyoj_ticks';

const TIMEFRAMES = {
    '1m':  { ms: 60 * 1000 },
    '1h':  { ms: 60 * 60 * 1000 },
    '1d':  { ms: 24 * 60 * 60 * 1000 },
    '1w':  { ms: 7 * 24 * 60 * 60 * 1000 },
    '1M':  { ms: 30 * 24 * 60 * 60 * 1000 },
    '1y':  { ms: 365 * 24 * 60 * 60 * 1000 }
};

let currentTF = '1h';
let ticks = [];
let last = null;
let canvas = null;
let ctx = null;
let mouse = { x: null, y: null, inside: false };

// ===== Утилиты =====
function fmt(n, d = 2) {
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function pad(x) { return String(x).padStart(2, '0'); }
function timeShort(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function timeFull(ts) {
    const d = new Date(ts);
    return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function timeOnly(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ===== API =====
async function fetchBTC() {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return data.bitcoin.usd;
}

function computeHyoj(btcPrice, prevPrice) {
    let base = btcPrice * K;
    const shake = (Math.random() * 2 - 1) * SHAKE;
    let price = base * (1 + shake);
    if (prevPrice) price = prevPrice * 0.75 + price * 0.25;
    return price;
}

// ===== Firestore =====
async function loadTicksFromDB() {
    const q = query(
        collection(db, TICKS_COLLECTION),
        orderBy('t', 'desc'),
        limit(MAX_TICKS)
    );
    const snap = await getDocs(q);
    const arr = [];
    snap.forEach((d) => {
        const data = d.data();
        arr.push({ t: data.t, p: data.p });
    });
    arr.reverse();
    ticks = arr;
}

function subscribeTicks() {
    const q = query(
        collection(db, TICKS_COLLECTION),
        orderBy('t', 'desc'),
        limit(MAX_TICKS)
    );
    onSnapshot(q, (snap) => {
        const arr = [];
        snap.forEach((d) => {
            const data = d.data();
            arr.push({ t: data.t, p: data.p });
        });
        arr.reverse();
        ticks = arr;
        updateUI();
        drawChart();
    }, (err) => {
        console.error('onSnapshot error:', err);
    });
}

async function pushTick(price) {
    await addDoc(collection(db, TICKS_COLLECTION), {
        t: Date.now(),
        p: price
    });
}

// ===== Агрегация слотов =====
// Возвращает slotsCount слотов, привязанных к абсолютному времени.
// Правый слот = текущий bucket (сейчас). Слоты идут справа налево в прошлое.
function buildCandles(ticks, bucketMs, slotsCount) {
    if (slotsCount < 1) return [];

    const now = Date.now();
    const rightBucket = Math.floor(now / bucketMs) * bucketMs;
    const leftBucket = rightBucket - (slotsCount - 1) * bucketMs;

    const map = new Map();
    for (let i = 0; i < slotsCount; i++) {
        map.set(leftBucket + i * bucketMs, null);
    }

    for (const t of ticks) {
        const bt = Math.floor(t.t / bucketMs) * bucketMs;
        if (bt < leftBucket || bt > rightBucket) continue;
        const cur = map.get(bt);
        if (!cur) {
            map.set(bt, { t: bt, o: t.p, h: t.p, l: t.p, c: t.p });
        } else {
            cur.c = t.p;
            if (t.p > cur.h) cur.h = t.p;
            if (t.p < cur.l) cur.l = t.p;
        }
    }

    const out = [];
    for (let i = 0; i < slotsCount; i++) {
        const bt = leftBucket + i * bucketMs;
        out.push({ t: bt, candle: map.get(bt) });
    }
    return out;
}

// ===== График =====
function resizeCanvas() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawChart() {
    if (!canvas || !ctx) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const bucket = TIMEFRAMES[currentTF].ms;

    const padL = 10;
    const padR = 90;
    const padT = 20;
    const padB = 34;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;

    const SLOT_PX = 56;
    const CANDLE_PX = 18;

    const slotsCount = Math.max(3, Math.floor(chartW / SLOT_PX));

    const slots = buildCandles(ticks, bucket, slotsCount);
    const realCandles = slots.filter((s) => s.candle).map((s) => s.candle);

    if (realCandles.length === 0) {
        ctx.fillStyle = '#666';
        ctx.font = '13px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Собираем данные...', w / 2, h / 2);
        return;
    }

    let min = Infinity, max = -Infinity;
    for (const c of realCandles) {
        if (c.l < min) min = c.l;
        if (c.h > max) max = c.h;
    }
    const padding = (max - min) * 0.08 || 1;
    min -= padding;
    max += padding;
    const range = max - min;

    const priceToY = (p) => padT + chartH * (1 - (p - min) / range);
    const yToPrice = (y) => max - ((y - padT) / chartH) * range;

    // Правый край = самая новая свеча. Сетка прижата вправо.
    const usedW = slotsCount * SLOT_PX;
    const startX = padL + Math.max(0, chartW - usedW);

    // ===== Горизонтальная сетка =====
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.font = '11px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const gridLines = 6;
    for (let i = 0; i <= gridLines; i++) {
        const y = padT + (chartH / gridLines) * i;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + chartW, y);
        ctx.stroke();
        const price = max - (range / gridLines) * i;
        ctx.fillStyle = '#777';
        ctx.fillText('$' + fmt(price), padL + chartW + 8, y);
    }

    // ===== Вертикальные линии слотов =====
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    for (let i = 0; i <= slotsCount; i++) {
        const x = startX + i * SLOT_PX;
        if (x < padL || x > padL + chartW) continue;
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + chartH);
        ctx.stroke();
    }

    // ===== Свечи =====
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (!slot.candle) continue;
        const c = slot.candle;

        const xCenter = startX + SLOT_PX * i + SLOT_PX / 2;
        if (xCenter < padL - SLOT_PX || xCenter > padL + chartW + SLOT_PX) continue;

        const up = c.c >= c.o;
        const color = up ? '#6ee7a8' : '#e07a7a';

        // Фитиль
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        const x = Math.floor(xCenter) + 0.5;
        ctx.moveTo(x, priceToY(c.h));
        ctx.lineTo(x, priceToY(c.l));
        ctx.stroke();

        // Тело
        const yOpen = priceToY(c.o);
        const yClose = priceToY(c.c);
        const top = Math.min(yOpen, yClose);
        const bot = Math.max(yOpen, yClose);
        const bodyH = Math.max(3, bot - top);

        ctx.fillStyle = color;
        ctx.fillRect(
            Math.floor(xCenter - CANDLE_PX / 2),
            Math.floor(top),
            CANDLE_PX,
            Math.ceil(bodyH)
        );
    }

    // ===== Ось времени =====
    ctx.fillStyle = '#777';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = Math.max(1, Math.floor(slotsCount / 7));
    for (let i = 0; i < slots.length; i += step) {
        const xCenter = startX + SLOT_PX * i + SLOT_PX / 2;
        if (xCenter < padL || xCenter > padL + chartW) continue;
        ctx.fillText(timeShort(slots[i].t), xCenter, padT + chartH + 10);
    }

    // ===== Кроссхэйр =====
    if (mouse.inside && mouse.x >= padL && mouse.x <= padL + chartW && mouse.y >= padT && mouse.y <= padT + chartH) {
        const relX = mouse.x - startX;
        const idx = Math.floor(relX / SLOT_PX);
        if (idx >= 0 && idx < slots.length) {
            const slot = slots[idx];
            const xCenter = startX + SLOT_PX * idx + SLOT_PX / 2;

            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(xCenter, padT);
            ctx.lineTo(xCenter, padT + chartH);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(padL, mouse.y);
            ctx.lineTo(padL + chartW, mouse.y);
            ctx.stroke();
            ctx.setLineDash([]);

            const priceAtCursor = yToPrice(mouse.y);
            ctx.fillStyle = '#3a3a3a';
            ctx.strokeStyle = '#666';
            ctx.fillRect(padL + chartW + 2, mouse.y - 10, 84, 20);
            ctx.strokeRect(padL + chartW + 2, mouse.y - 10, 84, 20);
            ctx.fillStyle = '#fff';
            ctx.font = '11px Arial';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText('$' + fmt(priceAtCursor), padL + chartW + 8, mouse.y);

            if (slot.candle) {
                const c = slot.candle;
                const isUp = c.c >= c.o;
                const info = `${timeFull(c.t)}   O ${fmt(c.o)}   H ${fmt(c.h)}   L ${fmt(c.l)}   C ${fmt(c.c)}`;
                ctx.font = '11px Arial';
                const tw = ctx.measureText(info).width + 20;
                ctx.fillStyle = 'rgba(0,0,0,0.75)';
                ctx.fillRect(padL + 6, padT + 6, tw, 22);
                ctx.fillStyle = isUp ? '#6ee7a8' : '#e07a7a';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(info, padL + 16, padT + 17);

                ctx.beginPath();
                ctx.arc(xCenter, priceToY(c.c), 3.5, 0, Math.PI * 2);
                ctx.fillStyle = isUp ? '#6ee7a8' : '#e07a7a';
                ctx.fill();
            }
        }
    }

    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '11px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('HYOJ · ' + currentTF.toUpperCase(), padL + 2, padT + chartH + 10);
}

// ===== UI =====
function updateUI() {
    if (!ticks.length) return;
    const cur = ticks[ticks.length - 1];
    const rounded = cur.p;

    document.getElementById('price').textContent = '$' + fmt(rounded);

    const bucket = TIMEFRAMES[currentTF].ms;
    const now = Date.now();
    const fromTs = now - bucket;
    const inRange = ticks.filter((x) => x.t >= fromTs);
    const first = inRange.length ? inRange[0].p : rounded;
    const change = ((rounded - first) / first) * 100;

    const changeEl = document.getElementById('change');
    changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
    changeEl.className = 'change ' + (change >= 0 ? 'up' : 'down');

    const dayAgo = now - 24 * 60 * 60 * 1000;
    const dayTicks = ticks.filter((x) => x.t >= dayAgo);
    const prices = dayTicks.length ? dayTicks.map((x) => x.p) : [rounded];
    document.getElementById('high').textContent = '$' + fmt(Math.max(...prices));
    document.getElementById('low').textContent = '$' + fmt(Math.min(...prices));

    document.getElementById('k').textContent = K.toFixed(2);
    if (last) document.getElementById('btc').textContent = '$' + Math.round(last.btc).toLocaleString('en-US');
    document.getElementById('updated').textContent = timeOnly(cur.t);
}

// ===== Основной цикл =====
async function update() {
    const statusEl = document.getElementById('status');
    try {
        statusEl.textContent = 'Загрузка...';
        const btc = await fetchBTC();

        const prevPrice = ticks.length ? ticks[ticks.length - 1].p : null;
        const price = computeHyoj(btc, prevPrice);
        const rounded = Math.round(price * 100) / 100;

        last = { btc, price: rounded };

        await pushTick(rounded);

        statusEl.textContent = 'LIVE';
    } catch (e) {
        console.error(e);
        statusEl.textContent = 'Ошибка сети';
    }
}

// ===== Инициализация =====
window.addEventListener('DOMContentLoaded', () => {
    canvas = document.getElementById('chart');
    ctx = canvas.getContext('2d');
    resizeCanvas();

    document.querySelectorAll('.tf-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tf-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            currentTF = btn.dataset.tf;
            drawChart();
        });
    });

    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        mouse.x = e.clientX - rect.left;
        mouse.y = e.clientY - rect.top;
        mouse.inside = true;
        drawChart();
    });
    canvas.addEventListener('mouseleave', () => {
        mouse.inside = false;
        drawChart();
    });

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = 'auth.html';
            return;
        }

        try {
            await loadTicksFromDB();
            updateUI();
            drawChart();
        } catch (e) {
            console.error('loadTicksFromDB error:', e);
        }

        subscribeTicks();
        update();
        setInterval(update, UPDATE_MS);
    });
});

window.addEventListener('resize', () => {
    resizeCanvas();
    drawChart();
});