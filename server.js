require('dotenv').config();
const express = require('express');
const fs = require('fs');
const twilio = require('twilio');
const sendEmail = require('./mailer'); // your mailer.js

const { twiml: { VoiceResponse } } = twilio;
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 🔥 Prevent crash on bad JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error("Bad JSON:", err.message);
    return res.status(400).json({ error: "Invalid JSON format" });
  }
  next();
});

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const RATE = parseFloat(process.env.RATE_PER_MINUTE);

console.log("Twilio number:", TWILIO_NUMBER);
console.log("Rate per minute:", RATE);

// =================== PLANS ===================
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

// =================== HELPERS ===================
function getUsers() {
  try { return JSON.parse(fs.readFileSync('users.json')); }
  catch { return []; }
}

function saveUsers(users) {
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
}

function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
}

function findUser(pin) {
  return getUsers().find(u => u.pin === pin);
}

// =================== VOICE FLOW ===================
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.gather({ numDigits: 6, action: '/check-pin', method: 'POST' })
       .say('Welcome. Enter your six digit access pin.');
  res.type('text/xml').send(twiml.toString());
});

app.post('/check-pin', (req, res) => {
  const twiml = new VoiceResponse();
  const pin = req.body.Digits;
  const user = findUser(pin);

  if (!user) {
    twiml.say('Invalid pin.');
    twiml.hangup();
  } else {
    const now = Date.now();
    const planActive = user.planMinutes > 0 && now < user.planExpires;
    const totalMinutes = (planActive ? user.planMinutes : 0) + (user.balance / RATE);

    if (totalMinutes <= 0) {
      twiml.say('You have no minutes left.');
      twiml.hangup();
    } else {
      twiml.gather({ numDigits: 15, action: `/dial-number?pin=${pin}`, method: 'POST' })
           .say('Pin accepted. Enter the number.');
    }
  }

  res.type('text/xml').send(twiml.toString());
});

app.post('/dial-number', (req, res) => {
  const twiml = new VoiceResponse();
  const number = req.body.Digits;
  const pin = req.query.pin;

  const dial = twiml.dial({
    action: `/call-ended?pin=${pin}`,
    method: 'POST',
    callerId: TWILIO_NUMBER
  });

  dial.number(number);
  res.type('text/xml').send(twiml.toString());
});

// =================== CALL ENDED ===================
app.post('/call-ended', async (req, res) => {
  const duration = parseInt(req.body.DialCallDuration || 0);
  const minutesUsed = duration / 60;
  const pin = req.query.pin;

  const users = getUsers();
  const user = users.find(u => u.pin === pin);

  if (user) {
    let remaining = minutesUsed;
    const now = Date.now();

    if (user.planMinutes > 0 && now < user.planExpires) {
      const usedFromPlan = Math.min(user.planMinutes, remaining);
      user.planMinutes -= usedFromPlan;
      remaining -= usedFromPlan;
    }

    if (remaining > 0) {
      const cost = remaining * RATE;
      user.balance = Math.max(0, user.balance - cost);
    }

    saveUsers(users);

    // Send email asynchronously
    if (user.email) {
      try {
        await sendEmail(user.email, "Call Summary", {
          email: user.email,
          message: `You used ${minutesUsed.toFixed(2)} minutes.`,
          balance: user.balance.toFixed(2),
          minutes: user.planMinutes.toFixed(2),
          plan: user.planName || "None"
        });
      } catch (err) {
        console.error("Failed to send call summary email:", err.message);
      }
    }

    console.log(`Call ended | PIN: ${pin} | Minutes: ${minutesUsed.toFixed(2)} | Wallet: $${user.balance.toFixed(2)}`);
  }

  res.sendStatus(200);
});

// =================== ADMIN ROUTES ===================

// Create new user
app.post('/admin/create-user', async (req, res) => {
  const { amount, plan, key, email } = req.body;
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });

  const users = getUsers();
  let pin;
  do { pin = generatePin(); } while (users.find(u => u.pin === pin));

  const newUser = { pin, email, balance: 0, planMinutes: 0, planName: null, planExpires: null };

  if (amount) newUser.balance = parseFloat(amount);

  if (plan && PLANS[plan]) {
    const p = PLANS[plan];
    newUser.planMinutes = p.minutes;
    newUser.planName = plan;
    newUser.planExpires = Date.now() + p.days * 86400000;
  }

  users.push(newUser);
  saveUsers(users);

  // Send account creation email
  if (email) {
    try {
      await sendEmail(email, "Account Created", {
        email,
        pin,
        balance: newUser.balance,
        minutes: newUser.planMinutes,
        plan: newUser.planName || "Wallet Only",
        message: "Your calling account is ready."
      });
    } catch (err) {
      console.error("Failed to send account creation email:", err.message);
    }
  }

  res.json({
    message: "User created",
    pin,
    balance: newUser.balance,
    plan: newUser.planName,
    planMinutes: newUser.planMinutes
  });
});

// Top-up
app.post('/admin/topup', async (req, res) => {
  const { pin, amount, key } = req.body;
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });

  const users = getUsers();
  const user = users.find(u => u.pin === pin);
  if (!user) return res.status(404).json({ error: "User not found" });

  user.balance += parseFloat(amount);
  saveUsers(users);

  if (user.email) {
    try {
      await sendEmail(user.email, "Wallet Top-up", {
        email: user.email,
        message: `Wallet credited with $${amount}`,
        balance: user.balance
      });
    } catch (err) {
      console.error("Failed to send top-up email:", err.message);
    }
  }

  res.json({ balance: user.balance });
});

// =================== HEALTH CHECK ===================
app.get('/', (req, res) => res.send('Teld Server Running 🚀'));

app.listen(process.env.PORT || 3000, () => console.log("Server live"));