require('dotenv').config();
const express = require('express');
const fs = require('fs');
const plivo = require('plivo');

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

// 🔹 PIN Generator
function generatePin() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// ===== 1. Incoming Call → Ask PIN =====
app.post('/voice', (req, res) => {
  const response = new plivo.Response();

  const getDigits = response.addGetDigits({
    action: '/check-pin',
    method: 'POST',
    numDigits: 4,
    timeout: 10
  });
  getDigits.addSpeak('Welcome. Enter your four digit access pin.');

  // fallback if no digits entered
  response.addSpeak('No input received. Goodbye.');

  res.set('Content-Type', 'text/xml');
  res.send(response.toXML());
});

// ===== 2. Check PIN =====
app.post('/check-pin', (req, res) => {
  const digits = req.body.Digits;
  const user = findUser(digits);

  const response = new plivo.Response();

  if (!user) {
    response.addSpeak('Invalid PIN. Goodbye.');
  } else if (user.balance <= 0) {
    response.addSpeak('Your balance is empty. Goodbye.');
  } else {
    const getDigits = response.addGetDigits({
      action: `/dial-number?pin=${digits}`,
      method: 'POST',
      numDigits: 15,
      timeout: 20
    });
    getDigits.addSpeak('PIN accepted. Enter the number you want to call.');
  }

  res.set('Content-Type', 'text/xml');
  res.send(response.toXML());
});

// ===== 3. Dial Call =====
app.post('/dial-number', (req, res) => {
  const number = req.body.Digits;
  const pin = req.query.pin;

  const response = new plivo.Response();

  const dial = response.addDial({
    action: `/call-ended?pin=${pin}`,
    method: 'POST'
  });
  dial.addNumber(number);

  res.set('Content-Type', 'text/xml');
  res.send(response.toXML());
});

// ===== 4. Call Ended → Deduct Balance =====
app.post('/call-ended', (req, res) => {
  const duration = parseInt(req.body.DialDuration || 0); // seconds
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

// ===== 5. MANUAL TOP-UP =====
app.post('/admin/topup', (req, res) => {
  const { pin, amount, key } = req.body;

  if (key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const users = getUsers();
  const user = users.find(u => u.pin === pin);

  if (!user) return res.status(404).json({ error: 'User not found' });

  user.balance += parseFloat(amount);
  saveUsers(users);

  res.json({ message: 'Balance updated', newBalance: user.balance });
});

// ===== 6. CREATE NEW USER =====
app.post('/admin/create-user', (req, res) => {
  const { amount, key } = req.body;

  if (key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const users = getUsers();
  let newPin;
  do {
    newPin = generatePin();
  } while (users.find(u => u.pin === newPin));

  const newUser = {
    pin: newPin,
    balance: parseFloat(amount)
  };

  users.push(newUser);
  saveUsers(users);

  res.json({ message: 'User created', pin: newPin, balance: newUser.balance });
});

// ===== Start Server =====
app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});