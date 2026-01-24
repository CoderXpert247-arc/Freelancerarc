require('dotenv').config();
const express = require('express');
const fs = require('fs');
const { twiml: { VoiceResponse } } = require('twilio');

const app = express();

// ===== Middleware =====
app.use(express.urlencoded({ extended: true })); // form data
app.use(express.json()); // json body

const RATE = parseFloat(process.env.RATE_PER_MINUTE);

// ===== Helpers =====
function getUsers() {
  try {
    return JSON.parse(fs.readFileSync('users.json'));
  } catch (err) {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
}

function findUser(pin) {
  return getUsers().find(u => u.pin === pin);
}

// 🔹 PIN Generator
function generatePin() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// ===== 1. Incoming Call → Ask PIN =====
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();

  twiml.gather({ numDigits: 4, action: '/check-pin', method: 'POST' })
       .say('Welcome. Enter your four digit access pin.');

  res.type('text/xml');
  res.send(twiml.toString());
});

// ===== 2. Check PIN =====
app.post('/check-pin', (req, res) => {
  const twiml = new VoiceResponse();
  
  // Accept Digits from body or query
  const pin = req.body.Digits || req.query.Digits;
  const user = findUser(pin);

  if (!user) {
    twiml.say('Invalid pin.');
    twiml.hangup();
  } else if (user.balance <= 0) {
    twiml.say('Your balance is empty.');
    twiml.hangup();
  } else {
    twiml.gather({
      numDigits: 15,
      action: `/dial-number?pin=${pin}`,
      method: 'POST'
    }).say('Pin accepted. Enter the number you want to call.');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ===== 3. Dial Call =====
app.post('/dial-number', (req, res) => {
  const twiml = new VoiceResponse();
  const number = req.body.Digits || req.query.Digits;
  const pin = req.query.pin;

  const dial = twiml.dial({
    action: `/call-ended?pin=${pin}`,
    method: 'POST'
  });

  dial.number(number);

  res.type('text/xml');
  res.send(twiml.toString());
});

// ===== 4. Call Ended → Deduct Balance =====
app.post('/call-ended', (req, res) => {
  const duration = parseInt(req.body.DialCallDuration || 0); // seconds
  const pin = req.query.pin;

  const users = getUsers();
  const user = users.find(u => u.pin === pin);

  if (user) {
    const minutes = duration / 60;
    const cost = minutes * RATE;
    user.balance = Math.max(0, user.balance - cost);
    saveUsers(users);

    console.log(`PIN ${pin} used ${duration}s. Cost $${cost.toFixed(2)}. New balance $${user.balance.toFixed(2)}`);
  }

  res.sendStatus(200);
});

// ===== 5. Manual Top-Up (Existing User) =====
app.post('/admin/topup', (req, res) => {
  const { pin, amount, key } = req.body;

  if (key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const users = getUsers();
  const user = users.find(u => u.pin === pin);

  if (!user) return res.status(404).json({ error: "User not found" });

  user.balance += parseFloat(amount);
  saveUsers(users);

  res.json({ message: "Balance updated", newBalance: user.balance });
});

// ===== 6. Create New User (Auto PIN) =====
app.post('/admin/create-user', (req, res) => {
  const { amount, key } = req.body;

  if (key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const users = getUsers();

  let newPin;
  do {
    newPin = generatePin();
  } while (users.find(u => u.pin === newPin)); // ensure unique

  const newUser = {
    pin: newPin,
    balance: parseFloat(amount)
  };

  users.push(newUser);
  saveUsers(users);

  res.json({
    message: "User created",
    pin: newPin,
    balance: newUser.balance
  });
});

// ===== 7. Health Check =====
app.get('/', (req, res) => {
  res.send('Call Gateway Server is running ✅');
});

// ===== Start Server =====
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});