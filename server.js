require('dotenv').config();
const express = require('express');
const fs = require('fs');
const { twiml: { VoiceResponse } } = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const RATE = parseFloat(process.env.RATE_PER_MINUTE);

// ===== Helpers =====
function getUsers() {
  return JSON.parse(fs.readFileSync('users.json'));
}

function saveUsers(users) {
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
}

function findUser(pin) {
  return getUsers().find(u => u.pin === pin);
}

// ===== 1. Incoming Call → Ask PIN =====
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();

  twiml.gather({ numDigits: 4, action: '/check-pin' })
       .say('Welcome. Enter your four digit access pin.');

  res.type('text/xml');
  res.send(twiml.toString());
});

// ===== 2. Check PIN =====
app.post('/check-pin', (req, res) => {
  const twiml = new VoiceResponse();
  const pin = req.body.Digits;
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
      action: `/dial-number?pin=${pin}`
    }).say('Pin accepted. Enter the number you want to call.');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ===== 3. Dial Call =====
app.post('/dial-number', (req, res) => {
  const twiml = new VoiceResponse();
  const number = req.body.Digits;
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


// ===== 5. MANUAL TOP-UP ENDPOINT (HOW YOU GET PAID) =====
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


// ===== Start Server =====
app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});