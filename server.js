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

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase(); // 6-character code
}

function findUser(pin) {
  return getUsers().find(u => u.pin === pin);
}

// =================== EMAIL OTP STORE ===================
const otps = {}; // { pin: { code, expiresAt } }

// =================== VOICE FLOW ===================
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.gather({ numDigits: 6, action: '/check-pin', method: 'POST' })
       .say('Welcome. Enter your six digit access pin.');
  res.type('text/xml').send(twiml.toString());
});

// =================== CHECK PIN / SEND EMAIL OTP ===================
app.post('/check-pin', async (req, res) => {
  const twiml = new VoiceResponse();
  const pin = req.body.Digits;
  const user = findUser(pin);

  if (!user) {
    twiml.say('Invalid PIN.');
    twiml.hangup();
  } else {
    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    otps[pin] = { code: otp, expiresAt };

    // Send OTP via email
    try {
      await sendEmail(user.email, "Your OTP Code", {
        email: user.email,
        message: `Your one-time code is: ${otp}. It expires in 5 minutes.`
      });
    } catch (err) {
      console.error("Failed to send OTP email:", err.message);
    }

    twiml.gather({
      numDigits: 6,
      action: `/verify-otp?pin=${pin}`,
      method: 'POST'
    }).say('We sent a verification code to your email. Enter the 6-digit code now.');
  }

  res.type('text/xml').send(twiml.toString());
});

// =================== VERIFY EMAIL OTP ===================
app.post('/verify-otp', (req, res) => {
  const twiml = new VoiceResponse();
  const pin = req.query.pin;
  const entered = req.body.Digits;

  const otpData = otps[pin];
  if (!otpData) {
    twiml.say('No OTP found. Please try again.');
    twiml.hangup();
  } else if (Date.now() > otpData.expiresAt) {
    delete otps[pin];
    twiml.say('OTP expired. Please try again.');
    twiml.hangup();
  } else if (entered !== otpData.code) {
    twiml.say('Incorrect code. Access denied.');
    twiml.hangup();
  } else {
    // OTP correct, allow call
    delete otps[pin];
    twiml.gather({
      numDigits: 15,
      action: `/dial-number?pin=${pin}`,
      method: 'POST'
    }).say('OTP verified. Enter the number you want to call.');
  }

  res.type('text/xml').send(twiml.toString());
});

// =================== DIAL NUMBER ===================
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

    user.totalCalls = (user.totalCalls || 0) + minutesUsed;
    saveUsers(users);

    // Send email asynchronously
    if (user.email) {
      try {
        await sendEmail(user.email, "Call Summary", {
          email: user.email,
          message: `You used ${minutesUsed.toFixed(2)} minutes.`,
          balance: user.balance.toFixed(2),
          minutes: user.planMinutes.toFixed(2),
          plan: user.planName || "None",
          referralCode: user.referralCode
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

  // ✅ Check if email already exists
  if (users.find(u => u.email === email)) {
    return res.status(400).json({ error: "User with this email already exists" });
  }

  // ✅ Generate unique PIN
  let pin;
  do { pin = generatePin(); } while (users.find(u => u.pin === pin));

  // ✅ Generate unique referral code
  let referralCode;
  do { referralCode = generateReferralCode(); } while (users.find(u => u.referralCode === referralCode));

  // ✅ Create user object
  const newUser = {
    pin,
    email,
    balance: amount ? parseFloat(amount) : 0,
    planMinutes: 0,
    planName: null,
    planExpires: null,
    referralCode,
    totalCalls: 0,
    referralBonus: 0
  };

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
        balance: newUser.balance.toFixed(2),
        minutes: newUser.planMinutes,
        plan: newUser.planName || "Wallet Only",
        message: "Your calling account is ready.",
        referralCode: newUser.referralCode
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
    planMinutes: newUser.planMinutes,
    referralCode: newUser.referralCode
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
        balance: user.balance,
        referralCode: user.referralCode
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