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
let fileLock = false; // prevent race conditions

function getUsers() {
  try { return JSON.parse(fs.readFileSync('users.json')); }
  catch { return []; }
}

function saveUsers(users) {
  while (fileLock) {} // wait if locked
  fileLock = true;
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
  fileLock = false;
}

function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase(); // 6-character
}

function findUser(pin) {
  return getUsers().find(u => u.pin === pin);
}

// Deduct minutes with plan priority
function deductMinutes(user, minutes) {
  let remaining = minutes;
  const now = Date.now();
  if (user.planMinutes > 0 && now < user.planExpires) {
    const usedFromPlan = Math.min(user.planMinutes, remaining);
    user.planMinutes -= usedFromPlan;
    remaining -= usedFromPlan;
  }
  if (remaining > 0) {
    const cost = (remaining / 60) * RATE; // per second precision
    user.balance = Math.max(0, user.balance - cost);
  }
}

// =================== EMAIL OTP & PENDING CALLS ===================
const otps = {}; // { pin: { code, expiresAt } }
const pendingCalls = {}; // { callerNumber: { pin, stage, startTime, attempts } }

// =================== VOICE FLOW ===================
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();
  const caller = req.body.From;

  const user = getUsers().find(u => u.phone === caller);

  if (!user) {
    twiml.say({ voice: 'alice' }, "You are not registered. Goodbye.");
    twiml.hangup();
  } else {
    const availableMinutes = (user.planMinutes || 0) + ((user.balance || 0) / RATE);
    if (availableMinutes < 1) {
      twiml.say({ voice: 'alice' }, "Insufficient minutes to enter PIN. Goodbye.");
      twiml.hangup();
    } else if (pendingCalls[caller]) {
      twiml.say({ voice: 'alice' }, "You already have an active session. Finish it before calling again.");
      twiml.hangup();
    } else {
      pendingCalls[caller] = { stage: 'pin', startTime: Date.now(), attempts: 0 };
      twiml.gather({ numDigits: 6, action: '/check-pin', method: 'POST' })
           .say({ voice: 'alice' }, 'Welcome. Enter your 6-digit access PIN.');
    }
  }

  res.type('text/xml').send(twiml.toString());
});

// =================== CHECK PIN / SEND OTP ===================
app.post('/check-pin', async (req, res) => {
  const twiml = new VoiceResponse();
  const pin = req.body.Digits;
  const caller = req.body.From;
  const user = findUser(pin);
  const callInfo = pendingCalls[caller];
  const now = Date.now();

  if (!callInfo) {
    twiml.say({ voice: 'alice' }, "Session expired. Goodbye.");
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Deduct time spent entering PIN
  const secondsUsed = (now - callInfo.startTime) / 1000;
  const minutesUsed = secondsUsed / 60;
  if (user) deductMinutes(user, minutesUsed);

  callInfo.attempts++;
  if (!user) {
    twiml.say({ voice: 'alice' }, "Invalid PIN.");
    twiml.hangup();
  } else if (callInfo.attempts > 3) {
    twiml.say({ voice: 'alice' }, "Too many attempts. Goodbye.");
    delete pendingCalls[caller];
    twiml.hangup();
  } else {
    const availableMinutes = (user.planMinutes || 0) + ((user.balance || 0)/RATE);
    if (availableMinutes < 5) { // enough for OTP stage
      twiml.say({ voice: 'alice' }, "Insufficient minutes to verify OTP. Goodbye.");
      delete pendingCalls[caller];
      twiml.hangup();
    } else {
      // Generate OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      otps[pin] = { code: otp, expiresAt: Date.now() + 5 * 60 * 1000 };
      try {
        await sendEmail(user.email, "Your OTP Code", { email: user.email, message: `Your code: ${otp}` });
      } catch (err) { console.error(err.message); }

      pendingCalls[caller] = { stage: 'otp', startTime: Date.now(), pin, attempts: 0 };
      twiml.gather({ numDigits: 6, action: `/verify-otp?pin=${pin}`, method: 'POST' })
           .say({ voice: 'alice' }, "OTP sent. Enter 6-digit code now.");
    }
  }

  res.type('text/xml').send(twiml.toString());
});

// =================== VERIFY OTP ===================
app.post('/verify-otp', (req, res) => {
  const twiml = new VoiceResponse();
  const pin = req.query.pin;
  const entered = req.body.Digits;
  const caller = req.body.From;
  const user = findUser(pin);
  const callInfo = pendingCalls[caller];
  const now = Date.now();

  if (!callInfo) {
    twiml.say({ voice: 'alice' }, "Session expired. Goodbye.");
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Deduct OTP stage time
  const secondsUsed = (now - callInfo.startTime) / 1000;
  const minutesUsed = secondsUsed / 60;
  if (user) deductMinutes(user, minutesUsed);

  callInfo.attempts++;
  if (!user) {
    twiml.say({ voice: 'alice' }, "User not found.");
    twiml.hangup();
  } else if (!otps[pin] || Date.now() > otps[pin].expiresAt) {
    twiml.say({ voice: 'alice' }, "OTP expired or invalid. Goodbye.");
    delete pendingCalls[caller];
    delete otps[pin];
    twiml.hangup();
  } else if (entered !== otps[pin].code) {
    twiml.say({ voice: 'alice' }, "Incorrect OTP. Goodbye.");
    delete pendingCalls[caller];
    twiml.hangup();
  } else {
    delete otps[pin];
    pendingCalls[caller] = { stage: 'dial', pin };
    twiml.gather({ numDigits: 15, action: `/dial-number?pin=${pin}`, method: 'POST' })
         .say({ voice: 'alice' }, "OTP verified. Enter the number to call.");
  }

  res.type('text/xml').send(twiml.toString());
});

// =================== DIAL NUMBER ===================
app.post('/dial-number', (req, res) => {
  const twiml = new VoiceResponse();
  const number = req.body.Digits;
  const pin = req.query.pin;
  const user = findUser(pin);

  if (!user) {
    twiml.say({ voice: 'alice' }, "User not found.");
    twiml.hangup();
  } else if ((user.planMinutes || 0) + ((user.balance || 0)/RATE) <= 0) {
    twiml.say({ voice: 'alice' }, "Insufficient balance. Cannot make call.");
    twiml.hangup();
  } else {
    const dial = twiml.dial({ action: `/call-ended?pin=${pin}`, method: 'POST', callerId: TWILIO_NUMBER });
    dial.number(number);
  }

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
    deductMinutes(user, minutesUsed);
    user.totalCalls = (user.totalCalls || 0) + minutesUsed;
    saveUsers(users);

    try {
      await sendEmail(user.email, "Call Summary", {
        email: user.email,
        message: `You used ${minutesUsed.toFixed(2)} minutes.`,
        balance: user.balance.toFixed(2),
        minutes: user.planMinutes.toFixed(2),
        plan: user.planName || "None",
        referralCode: user.referralCode
      });
    } catch (err) { console.error(err.message); }

    console.log(`Call ended | PIN: ${pin} | Minutes: ${minutesUsed.toFixed(2)} | Wallet: $${user.balance.toFixed(2)}`);
  }

  // Clean session for this user
  Object.keys(pendingCalls).forEach(k => {
    if (pendingCalls[k].pin === pin) delete pendingCalls[k];
  });

  res.sendStatus(200);
});

// =================== ADMIN ROUTES ===================
// =================== ADMIN ROUTES ===================          
          
// Create new user          
app.post('/admin/create-user', async (req, res) => {          
  const { amount, plan, key, email, phone } = req.body;          
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });          
          
  const users = getUsers();          
          
  // Allow unlimited creation ONLY for your Gmail      
  const isUnlimited = email === "uchendugoodluck067@gmail.com";          
          
  if (!isUnlimited && users.find(u => u.email === email)) {          
    return res.status(400).json({ error: "User with this email already exists" });          
  }          
          
  let pin;          
  do { pin = generatePin(); } while (users.find(u => u.pin === pin));          
          
  let referralCode;          
  do { referralCode = generateReferralCode(); } while (users.find(u => u.referralCode === referralCode));          
          
  const newUser = {          
    pin,          
    email,          
    phone,          
    balance: isUnlimited ? (amount ? parseFloat(amount) : 0) : (amount ? parseFloat(amount) : 0),          
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
    referralCode: newUser.referralCode,          
    phone: newUser.phone          
  });          
});          
          
// =================== ADMIN TOP-UP ===================          
app.post('/admin/topup', async (req, res) => {    
  const { key, email, amount } = req.body;    
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });    
    
  const users = getUsers();    
  const user = users.find(u => u.email === email);    
  if (!user) return res.status(404).json({ error: "User not found" });    
    
  const isUnlimited = email === "uchendugoodluck067@gmail.com";    
  const topupAmount = parseFloat(amount) || 0;    
    
  user.balance += topupAmount;    
    
  if (!isUnlimited && user.balance > 10000) { // safety cap for normal users    
    user.balance = 10000;    
  }    
    
  saveUsers(users);    
    
  if (user.email) {    
    try {    
      await sendEmail(user.email, "Wallet Top-up", {    
        email: user.email,    
        message: `Your account has been topped up by $${topupAmount.toFixed(2)}. Current balance: $${user.balance.toFixed(2)}.`    
      });    
    } catch (err) {    
      console.error("Failed to send top-up email:", err.message);    
    }    
  }    
    
  res.json({ message: "Top-up successful", balance: user.balance });    
});    
    
// =================== ADMIN ACTIVATE PLAN ===================          
app.post('/admin/activate-plan', async (req, res) => {    
  const { key, email, plan } = req.body;    
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });    
    
  const users = getUsers();    
  const user = users.find(u => u.email === email);    
  if (!user) return res.status(404).json({ error: "User not found" });    
    
  const isUnlimited = email === "uchendugoodluck067@gmail.com";    
    
  if (!PLANS[plan]) return res.status(400).json({ error: "Invalid plan" });    
    
  const p = PLANS[plan];    
  user.planMinutes = p.minutes;    
  user.planName = plan;    
  user.planExpires = Date.now() + p.days * 86400000;    
    
  saveUsers(users);    
    
  if (user.email) {    
    try {    
      await sendEmail(user.email, "Plan Activated", {    
        email: user.email,    
        plan: plan,    
        minutes: user.planMinutes,    
        message: `Your plan ${plan} is now active and expires in ${p.days} day(s).`    
      });    
    } catch (err) {    
      console.error("Failed to send plan activation email:", err.message);    
    }    
  }    
    
  res.json({ message: "Plan activated", plan: user.planName, minutes: user.planMinutes, expires: new Date(user.planExpires) });    
});    

// =================== HEALTH CHECK ===================
app.get('/', (req, res) => res.send('Teld Server Running 🚀'));
app.listen(process.env.PORT || 3000, () => console.log("Server live"));