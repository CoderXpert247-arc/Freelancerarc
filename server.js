require('dotenv').config();
const express = require('express');
const fs = require('fs');
const twilio = require('twilio');
const { twiml: { VoiceResponse } } = twilio;

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const RATE = parseFloat(process.env.RATE_PER_MINUTE);

console.log("Twilio number:", TWILIO_NUMBER);
console.log("Rate per minute:", RATE);

// =================== PLANS ===================
const PLANS = {
  DAILY_1:   { price: 1, minutes: 20, days: 1 },
  DAILY_2:   { price: 2, minutes: 45, days: 1 },

  WEEKLY_5:  { price: 5, minutes: 110, days: 7 },
  WEEKLY_10: { price: 10, minutes: 240, days: 7 },

  MONTHLY_20: { price: 20, minutes: 500, days: 30 },
  MONTHLY_35: { price: 35, minutes: 950, days: 30 },
  MONTHLY_50: { price: 50, minutes: 1500, days: 30 },

  STUDENT: { price: 10, minutes: 250, days: 30 },
};

// =================== HELPERS ===================
function getUsers() {
  try {
    return JSON.parse(fs.readFileSync('users.json'));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
}

function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit PIN
}

function findUser(pin) {
  return getUsers().find(u => u.pin === pin);
}

function isNightTime() {
  const hour = new Date().getHours();
  return hour >= 22 || hour <= 6;
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
    const planActive = user.planMinutes > 0 && user.planExpires && now < user.planExpires;
    const totalMinutes = (planActive ? user.planMinutes : 0) + (user.balance > 0 ? user.balance / RATE : 0);

    if (totalMinutes <= 0) {
      twiml.say('You have no available minutes. Please recharge.');
      twiml.hangup();
    } else {
      twiml.gather({ numDigits: 15, action: `/dial-number?pin=${pin}`, method: 'POST' })
           .say('Pin accepted. Enter the number you want to call.');
    }
  }

  res.type('text/xml').send(twiml.toString());
});

app.post('/dial-number', (req, res) => {
  const twiml = new VoiceResponse();
  const number = req.body.Digits;
  const pin = req.query.pin;

  if (!number) {
    twiml.say('No number entered.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const dial = twiml.dial({ action: `/call-ended?pin=${pin}`, method: 'POST', callerId: TWILIO_NUMBER });
  dial.number(number);

  res.type('text/xml').send(twiml.toString());
});

// =================== CALL ENDED ===================
app.post('/call-ended', (req, res) => {
  const duration = parseInt(req.body.DialCallDuration || 0); // in seconds
  const minutesUsed = duration / 60;
  const pin = req.query.pin;

  const users = getUsers();
  const user = users.find(u => u.pin === pin);

  if (user) {
    const now = Date.now();
    let remaining = minutesUsed;

    // Use plan minutes first
    if (user.planMinutes > 0 && user.planExpires && now < user.planExpires) {
      const usedFromPlan = Math.min(user.planMinutes, remaining);
      user.planMinutes -= usedFromPlan;
      remaining -= usedFromPlan;
    }

    // Use balance for remaining minutes
    if (remaining > 0 && user.balance > 0) {
      const cost = remaining * RATE;
      user.balance = Math.max(0, user.balance - cost);
    }

    saveUsers(users);
    console.log(`Call ended for PIN ${pin} | Minutes used: ${minutesUsed.toFixed(2)} | Plan remaining: ${user.planMinutes.toFixed(2)} | Wallet remaining: $${user.balance.toFixed(2)}`);
  }

  res.sendStatus(200);
});

// =================== ADMIN ROUTES ===================

// Create new user with wallet or plan
app.post('/admin/create-user', (req, res) => {
  const { amount, plan, key, referralPin } = req.body;
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });

  // Minimum 100 minutes worth in wallet for referral to work
  const minTopUp = 100 * RATE; // 100 minutes cost in money

  if (referralPin && (!amount || amount < minTopUp)) {
    return res.status(400).json({ error: "You must top up at least 100 minutes worth for referral bonuses" });
  }

  const users = getUsers();
  let pin;
  do { pin = generatePin(); } while (users.find(u => u.pin === pin));

  const newUser = { pin, balance: 0, planMinutes: 0, planName: null, planExpires: null, referrals: 0 };

  // Wallet top-up
  if (amount && amount > 0) newUser.balance = parseFloat(amount);

  // Activate plan
  if (plan) {
    const selectedPlan = PLANS[plan];
    if (!selectedPlan) return res.status(400).json({ error: "Invalid plan" });
    newUser.planMinutes = selectedPlan.minutes;
    newUser.planName = plan;
    newUser.planExpires = Date.now() + selectedPlan.days * 86400000;
  }

  // Apply referral bonuses
  if (referralPin) {
    const refUser = users.find(u => u.pin === referralPin);
    if (refUser) {
      refUser.planMinutes += 5;    // Referrer bonus
      newUser.planMinutes += 10;   // New user bonus
      refUser.referrals += 1;
    }
  }

  users.push(newUser);
  saveUsers(users);

  res.json({ message: "User created", pin, balance: newUser.balance, plan: newUser.planName, planMinutes: newUser.planMinutes });
});

// Recharge wallet for existing user
app.post('/admin/topup', (req, res) => {
  const { pin, amount, key } = req.body;
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });

  const users = getUsers();
  const user = users.find(u => u.pin === pin);
  if (!user) return res.status(404).json({ error: "User not found" });

  user.balance += parseFloat(amount);
  saveUsers(users);
  res.json({ message: "Wallet topped up", balance: user.balance });
});

// Activate plan for existing user
app.post('/admin/activate-plan', (req, res) => {
  const { pin, plan, key } = req.body;
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });

  const users = getUsers();
  const user = users.find(u => u.pin === pin);
  if (!user) return res.status(404).json({ error: "User not found" });

  const selectedPlan = PLANS[plan];
  if (!selectedPlan) return res.status(400).json({ error: "Invalid plan" });

  user.planMinutes = selectedPlan.minutes;
  user.planName = plan;
  user.planExpires = Date.now() + selectedPlan.days * 86400000;
  saveUsers(users);

  res.json({ message: "Plan activated", plan: user.planName, planMinutes: user.planMinutes, expires: user.planExpires });
});

// Check user info
app.post('/admin/user-info', (req, res) => {
  const { pin, key } = req.body;
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });

  const user = findUser(pin);
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({ pin: user.pin, balance: user.balance, planName: user.planName, planMinutes: user.planMinutes, planExpires: user.planExpires });
});

// =================== HEALTH ===================
app.get('/', (req, res) => res.send('Teld Server Running 🚀'));

app.listen(process.env.PORT || 3000, () => console.log("Server live"));