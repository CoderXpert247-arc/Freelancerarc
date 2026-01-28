require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');
const sendEmail = require('./mailer');
const redis = require('redis');

const { twiml: { VoiceResponse } } = twilio;
const app = express();

// ================= MIDDLEWARE =================
// Admin API JSON parser
app.use('/admin', express.json());

// Twilio routes use URL-encoded parser
const twilioParser = express.urlencoded({ extended: false });

// ================= DEBUG LOGGER =================
app.use((req, res, next) => {
  console.log('--- NEW REQUEST ---');
  console.log('METHOD:', req.method);
  console.log('URL:', req.originalUrl);
  console.log('BODY:', req.body);
  console.log('QUERY:', req.query);
  next();
});

// ================= REDIS =================
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.on('error', (err) => console.error('Redis error:', err));
redisClient.connect()
  .then(() => console.log("✅ Redis Connected"))
  .catch(err => console.error("Redis failed to connect:", err));

async function setSession(key, data, ttl = 600) {
  try {
    console.log(`REDIS SET: ${key} →`, data, `TTL: ${ttl}`);
    await redisClient.set(key, JSON.stringify(data), { EX: ttl });
  } catch (err) { console.error('Redis setSession error:', err); }
}

async function getSession(key) {
  try {
    const data = await redisClient.get(key);
    console.log(`REDIS GET: ${key} →`, data);
    return data ? JSON.parse(data) : null;
  } catch (err) { console.error('Redis getSession error:', err); return null; }
}

async function deleteSession(key) {
  try {
    console.log(`REDIS DEL: ${key}`);
    await redisClient.del(key);
  } catch (err) { console.error('Redis deleteSession error:', err); }
}

// ================= TWILIO =================
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const RATE = parseFloat(process.env.RATE_PER_MINUTE || "0");

// ================= BASE URL =================
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

// ================= USERS FILE =================
const USERS_FILE = path.join(__dirname, 'users.json');
function getUsers() {
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
  const users = JSON.parse(fs.readFileSync(USERS_FILE));
  console.log('Loaded users:', users);
  return users;
}
function saveUsers(users) {
  console.log('Saving users:', users);
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function findUser(pinOrPhone) {
  const users = getUsers();
  let user = users.find(u => u.pin === pinOrPhone || u.phone === pinOrPhone);
  console.log(`findUser(${pinOrPhone}) →`, user);
  return user;
}
function deductMinutes(user, minutes) {
  let remaining = minutes;
  const now = Date.now();
  console.log(`Deducting ${minutes} min from user:`, user.pin);
  if (user.planMinutes > 0 && now < user.planExpires) {
    const usedFromPlan = Math.min(user.planMinutes, remaining);
    user.planMinutes -= usedFromPlan;
    remaining -= usedFromPlan;
    console.log(`Used ${usedFromPlan} from plan, remaining minutes cost: ${remaining}`);
  }
  if (remaining > 0) {
    const cost = (remaining / 60) * RATE;
    user.balance = Math.max(0, user.balance - cost);
    console.log(`Deducted $${cost.toFixed(2)} from balance, new balance: ${user.balance}`);
  }
}

// ================= HELPER FUNCTIONS =================
function generatePin() {
  const pin = Math.floor(100000 + Math.random() * 900000).toString();
  console.log('Generated PIN:', pin);
  return pin;
}
function generateReferralCode() {
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  console.log('Generated referral code:', code);
  return code;
}

// ================= PLANS =================
const PLANS = {
  DAILY_1: { price: 1, minutes: 20, days: 1 },
  DAILY_2: { price: 2, minutes: 45, days: 1 },
  WEEKLY_5: { price: 5, minutes: 110, days: 7 },
  WEEKLY_10: { price: 10, minutes: 240, days: 7 },
  MONTHLY_20: { price: 20, minutes: 500, days: 30 },
  MONTHLY_35: { price: 35, minutes: 950, days: 30 },
  MONTHLY_50: { price: 50, minutes: 1500, days: 30 },
  STUDENT: { price: 10, minutes: 250, days: 30 },
};

// ================= DEBUG EMAIL WRAPPER =================
async function debugEmail(to, subject, body) {
  try {
    console.log('Sending email →', to, subject, body);
    await sendEmail(to, subject, body);
    console.log('Email sent successfully');
  } catch (err) {
    console.error('Email error:', err);
  }
}

// ================= TWILIO VOICE FLOW =================
app.post('/voice', twilioParser, async (req, res) => {
  try {
    console.log('/voice called', req.body);
    const twiml = new VoiceResponse();
    const caller = req.body.From;
    const user = findUser(caller);

    if (!user) {
      twiml.say("You are not registered.");
      twiml.hangup();
    } else {
      await setSession(`call:${caller}`, { stage: 'pin', attempts: 0 }, 300);
      twiml.gather({
        numDigits: 6,
        action: `${BASE_URL}/check-pin`,
        method: 'POST'
      }).say("Welcome. Enter your six digit PIN.");
    }

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('Error /voice:', err);
    res.status(503).send('Service Unavailable');
  }
});

// ================= CHECK PIN =================
app.post('/check-pin', twilioParser, async (req, res) => {
  try {
    console.log('/check-pin called', req.body);
    const twiml = new VoiceResponse();
    const caller = req.body.From;
    const pin = req.body.Digits;
    const call = await getSession(`call:${caller}`);
    console.log('Session data:', call);

    if (!call) {
      twiml.say("Session expired.");
      twiml.hangup();
      return res.type('text/xml').send(twiml.toString());
    }

    call.attempts++;
    const user = findUser(pin);

    if (!user || call.attempts > 3) {
      await deleteSession(`call:${caller}`);
      twiml.say("Invalid PIN.");
      twiml.hangup();
    } else {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      console.log('Generated OTP:', otp);
      await setSession(`otp:${pin}`, { code: otp }, 300);
      await debugEmail(user.email, "Your OTP Code", { message: `OTP: ${otp}` });
      await setSession(`call:${caller}`, { stage: 'otp', pin, attempts: 0 }, 300);

      twiml.gather({
        numDigits: 6,
        action: `${BASE_URL}/verify-otp?pin=${pin}`,
        method: 'POST'
      }).say("OTP sent. Enter code.");
    }

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('Error /check-pin:', err);
    res.status(503).send('Service Unavailable');
  }
});

// ================= VERIFY OTP =================
app.post('/verify-otp', twilioParser, async (req, res) => {
  try {
    console.log('/verify-otp called', req.body, req.query);
    const twiml = new VoiceResponse();
    const caller = req.body.From;
    const pin = req.query.pin;
    const entered = req.body.Digits;

    const call = await getSession(`call:${caller}`);
    const otp = await getSession(`otp:${pin}`);
    console.log('Session call:', call, 'OTP:', otp);

    if (!call || !otp || entered !== otp.code) {
      await deleteSession(`call:${caller}`);
      await deleteSession(`otp:${pin}`);
      twiml.say("OTP failed.");
      twiml.hangup();
    } else {
      await deleteSession(`otp:${pin}`);
      await setSession(`call:${caller}`, { stage: 'dial', pin }, 600);

      twiml.gather({
        numDigits: 15,
        action: `${BASE_URL}/dial-number?pin=${pin}`,
        method: 'POST'
      }).say("Enter number to call.");
    }

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('Error /verify-otp:', err);
    res.status(503).send('Service Unavailable');
  }
});

// ================= DIAL =================
app.post('/dial-number', twilioParser, async (req, res) => {
  try {
    console.log('/dial-number called', req.body, req.query);
    const twiml = new VoiceResponse();
    const number = req.body.Digits;
    const pin = req.query.pin;
    const user = findUser(pin);

    if (!user) {
      twiml.say("User not found.");
      twiml.hangup();
    } else {
      console.log(`Dialing number ${number} for user ${user.pin}`);
      const dial = twiml.dial({
        action: `${BASE_URL}/call-ended?pin=${pin}`,
        method: 'POST',
        callerId: TWILIO_NUMBER
      });
      dial.number(number);
    }

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('Error /dial-number:', err);
    res.status(503).send('Service Unavailable');
  }
});

// ================= CALL ENDED =================
app.post('/call-ended', twilioParser, async (req, res) => {
  try {
    console.log('/call-ended called', req.body, req.query);
    const duration = parseInt(req.body.DialCallDuration || 0);
    const minutesUsed = duration / 60;
    const pin = req.query.pin;

    const users = getUsers();
    const user = users.find(u => u.pin === pin);

    if (user) {
      deductMinutes(user, minutesUsed);
      user.totalCalls = (user.totalCalls || 0) + minutesUsed;
      saveUsers(users);

      await debugEmail(user.email, "Call Summary", {
        message: `Used ${minutesUsed.toFixed(2)} minutes.`
      });
    } else {
      console.log('User not found for call-ended');
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Error /call-ended:', err);
    res.status(503).send('Service Unavailable');
  }
});

// =================== ADMIN ROUTES ===================

// Create new user
app.post('/admin/create-user', async (req, res) => {
  const { amount, plan, key, email, phone } = req.body;
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });

  const users = getUsers();
  const isUnlimited = email === "uchendugoodluck067@gmail.com";

  if (!isUnlimited && users.find(u => u.email === email)) {
    return res.status(400).json({ error: "User with this email already exists" });
  }

  let pin; do { pin = generatePin(); } while (users.find(u => u.pin === pin));
  let referralCode; do { referralCode = generateReferralCode(); } while (users.find(u => u.referralCode === referralCode));

  const newUser = {
    pin,
    email,
    phone,
    balance: amount ? parseFloat(amount) : 0,
    planMinutes: 0,
    planName: null,
    planExpires: null,
    referralCode,
    totalCalls: 0,
    referralBonus: 0
  };

  // ✅ Fix: match plan keys in uppercase
  if (plan && PLANS[plan.toUpperCase()]) {
    const p = PLANS[plan.toUpperCase()];
    newUser.planMinutes = p.minutes;
    newUser.planName = plan.toUpperCase();
    newUser.planExpires = Date.now() + p.days * 86400000;
  }

  users.push(newUser);
  saveUsers(users);

  // Send email (keep original logic)
  try {
    await sendEmail(email, "Account Created", {
      title: "Account Created",
      email,
      pin,
      balance: newUser.balance.toFixed(2),
      planName: newUser.planName || "Wallet Only",
      planMinutes: newUser.planMinutes,
      planExpires: newUser.planExpires,
      referralCode: newUser.referralCode,
      referralBonus: newUser.referralBonus,
      totalCalls: newUser.totalCalls,
      message: "Your calling account is ready. Let's reshape the bounds of telecommunication"
    });
  } catch (err) { console.error(err.message); }

  res.json({
    message: "User created",
    pin,
    balance: newUser.balance,
    plan: newUser.planName,
    planMinutes: newUser.planMinutes,
    planExpires: newUser.planExpires ? new Date(newUser.planExpires) : null,
    referralCode: newUser.referralCode,
    phone: newUser.phone
  });
});

// Admin top-up
app.post('/admin/topup', async (req, res) => {
  const { key, email, amount } = req.body;
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });

  const users = getUsers();
  const user = users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: "User not found" });

  const topupAmount = parseFloat(amount) || 0;
  user.balance += topupAmount;
  if (user.email !== "uchendugoodluck067@gmail.com" && user.balance > 10000) user.balance = 10000;

  saveUsers(users);

  try {
  await sendEmail(user.email, "Wallet Top-up", {
    title: "Wallet Top-up",
    email: user.email,
    balance: user.balance.toFixed(2),
    planName: user.planName || "Wallet Only",
    planMinutes: user.planMinutes,
    planExpires: user.planExpires,
    message: `Your account has been topped up by $${topupAmount.toFixed(2)}. Current balance: $${user.balance.toFixed(2)}.`
  });
} catch (err) { console.error(err.message); }

  res.json({ message: "Top-up successful", balance: user.balance });
});

// Admin activate plan
app.post('/admin/activate-plan', async (req, res) => {
  const { key, email, plan } = req.body;
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });

  const users = getUsers();
  const user = users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (!PLANS[plan]) return res.status(400).json({ error: "Invalid plan" });

  const p = PLANS[plan];
  user.planMinutes = p.minutes;
  user.planName = plan;
  user.planExpires = Date.now() + p.days * 86400000;

  saveUsers(users);

  try {
  await sendEmail(user.email, "Plan Activated", {
    title: "Plan Activated",
    email: user.email,
    planName: user.planName,
    planMinutes: user.planMinutes,
    planExpires: user.planExpires,
    message: `Your plan ${plan} is now active and expires in ${PLANS[plan].days} day(s).`
  });
} catch (err) { console.error(err.message); }

  res.json({ message: "Plan activated", plan: user.planName, minutes: user.planMinutes, expires: new Date(user.planExpires) });
});

// ✅ New endpoint to check users.json in real-time
app.get('/admin/users', (req, res) => {
  res.json(getUsers());
});

// =================== HEALTH CHECK ===================
app.get('/', (req, res) => res.send('Teld Server Running 🚀'));
app.listen(process.env.PORT || 3000, () => console.log("Server live"));