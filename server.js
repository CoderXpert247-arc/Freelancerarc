require('dotenv').config();
const express = require('express');
const fs = require('fs');
const twilio = require('twilio');
const { twiml: { VoiceResponse } } = twilio;

const app = express();

// ===== GLOBAL REQUEST LOGGER =====
app.use((req, res, next) => {
  console.log('\n===== INCOMING REQUEST =====');
  console.log('URL:', req.originalUrl);
  console.log('Method:', req.method);
  console.log('Body:', req.body);
  console.log('Query:', req.query);
  console.log('============================\n');
  next();
});

// ===== Middleware =====
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===== Twilio Client =====
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const RATE = parseFloat(process.env.RATE_PER_MINUTE);

console.log("Twilio number loaded:", TWILIO_NUMBER);
console.log("Rate per minute:", RATE);

// ===== Helpers =====
function getUsers() {
  try {
    const users = JSON.parse(fs.readFileSync('users.json'));
    console.log("Loaded users:", users);
    return users;
  } catch (err) {
    console.log("users.json missing — returning empty list");
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
  console.log("Users saved:", users);
}

function findUser(pin) {
  const user = getUsers().find(u => u.pin === pin);
  console.log("Searching PIN:", pin, "Found:", user);
  return user;
}

function generatePin() {
  const pin = Math.floor(1000 + Math.random() * 9000).toString();
  console.log("Generated PIN:", pin);
  return pin;
}

// ===== 1. Incoming Call =====
app.post('/voice', (req, res) => {
  console.log("📞 CALL STARTED");
  const twiml = new VoiceResponse();

  twiml.gather({ numDigits: 4, action: '/check-pin', method: 'POST' })
       .say('Welcome. Enter your four digit access pin.');

  res.type('text/xml').send(twiml.toString());
});

// ===== 2. Check PIN =====
app.post('/check-pin', (req, res) => {
  const twiml = new VoiceResponse();
  const pin = req.body.Digits || req.query.Digits;

  console.log("User entered PIN:", pin);

  const user = findUser(pin);

  if (!user) {
    console.log("❌ INVALID PIN");
    twiml.say('Invalid pin.');
    twiml.hangup();
  } else if (user.balance <= 0) {
    console.log("💰 NO BALANCE");
    twiml.say('Your balance is empty.');
    twiml.hangup();
  } else {
    console.log("✅ PIN ACCEPTED");
    twiml.gather({
      numDigits: 15,
      action: `/dial-number?pin=${pin}`,
      method: 'POST'
    }).say('Pin accepted. Enter the number you want to call.');
  }

  res.type('text/xml').send(twiml.toString());
});

// ===== 3. Dial Call =====
app.post('/dial-number', (req, res) => {
  const twiml = new VoiceResponse();
  const number = req.body.Digits || req.query.Digits;
  const pin = req.query.pin;

  console.log("📲 Dial request:", number, "for PIN:", pin);

  if (!number) {
    console.log("❌ No number entered");
    twiml.say('No number entered.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const dial = twiml.dial({
    action: `/call-ended?pin=${pin}`,
    method: 'POST',
    callerId: TWILIO_NUMBER
  });

  dial.number(number);

  console.log("📡 Twilio dialing now...");
  res.type('text/xml').send(twiml.toString());
});

// ===== 4. Call Ended =====
app.post('/call-ended', (req, res) => {
  console.log("☎️ CALL ENDED WEBHOOK HIT");

  const duration = parseInt(req.body.DialCallDuration || 0);
  const pin = req.query.pin;

  console.log("Call duration:", duration, "PIN:", pin);

  const users = getUsers();
  const user = users.find(u => u.pin === pin);

  if (user) {
    const minutes = duration / 60;
    const cost = minutes * RATE;
    user.balance = Math.max(0, user.balance - cost);
    saveUsers(users);

    console.log(`💸 Deducted $${cost.toFixed(2)} | New balance: $${user.balance.toFixed(2)}`);
  } else {
    console.log("⚠️ No user found on call-ended");
  }

  res.sendStatus(200);
});

// ===== Admin Routes =====
app.post('/admin/create-user', (req, res) => {
  console.log("🛠 Admin create user called");

  const { amount, key } = req.body;
  if (key !== process.env.ADMIN_KEY) {
    console.log("❌ Admin key invalid");
    return res.status(403).json({ error: "Unauthorized" });
  }

  const users = getUsers();
  let newPin;

  do {
    newPin = generatePin();
  } while (users.find(u => u.pin === newPin));

  const newUser = { pin: newPin, balance: parseFloat(amount) };
  users.push(newUser);
  saveUsers(users);

  res.json({ message: "User created", pin: newPin, balance: newUser.balance });
});

// ===== Health =====
app.get('/', (req, res) => {
  res.send('Server alive ✅');
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));