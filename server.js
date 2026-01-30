require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const redis = require('redis');
const sendEmail = require('./mailer');

// MongoDB connection
const connectDB = require('./config/db'); // Your MongoDB connection
const User = require('./model/User');    // MongoDB User model

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

// ================= MONGO DB CONNECT =================
connectDB(); // connect to MongoDB

// ================= HELPERS =================
async function findUser(pinOrPhone) {
  let user = await User.findOne({ $or: [{ pin: pinOrPhone }, { phone: pinOrPhone }] });
  console.log(`findUser(${pinOrPhone}) →`, user);
  return user;
}

async function deductMinutes(user, minutes) {
  let remaining = minutes;
  const now = Date.now();
  console.log(`Deducting ${minutes} min from user:`, user.pin);

  if (user.planMinutes > 0 && now < new Date(user.planExpires).getTime()) {
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

  await user.save();
}

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

// ================= DEBUG EMAIL =================
async function debugEmail(to, subject, body) {
  try {
    if (!to) return console.log("No email provided, skipping send");
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
    console.log('--- /voice called ---');  
    console.log('Raw Twilio body:', req.body);  

    const twiml = new VoiceResponse();  
    const caller = req.body.From;  
    console.log('Caller number received from Twilio:', caller);  

    const user = await findUser(caller);  
    console.log('findUser result:', user);  

    if (!user) {  
      console.log('No user found for this caller number.');  
      twiml.say("You are not registered.");  
      twiml.hangup();  
    } else {  
      console.log('User found, initializing call session.');  
      await setSession(`call:${caller}`, { stage: 'pin', attempts: 0 }, 20);  

      // Stabilize audio for first digit  
      twiml.pause({ length: 1 });  

      twiml.gather({  
        numDigits: 6,  
        action: `${BASE_URL}/check-pin`,  
        method: 'POST',  
        input: 'dtmf',  
        timeout: 10,  
        finishOnKey: '',  
        actionOnEmptyResult: true  
      }).say("Welcome. Enter your six digit PIN.");  
    }  

    res.type('text/xml').send(twiml.toString());  
  } catch (err) {  
    console.error('Error /voice:', err);  
    const twiml = new VoiceResponse();  
    twiml.say("System error. Please try again later.");  
    twiml.hangup();  
    res.type('text/xml').send(twiml.toString());  
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
  
    if (!pin || pin.length < 6) {  
      twiml.say("I did not receive all six digits.");  
      twiml.pause({ length: 1 });  
      twiml.redirect(`${BASE_URL}/voice`);  
      return res.type('text/xml').send(twiml.toString());  
    }  
  
    if (!call) {  
      twiml.say("Session expired.");  
      twiml.hangup();  
      return res.type('text/xml').send(twiml.toString());  
    }  
  
    call.attempts++;  
  
    const user = await findUser(caller); // verify by caller number  
  
    if (!user || user.pin !== pin || call.attempts > 3) {  
      await deleteSession(`call:${caller}`);  
      twiml.say("Invalid PIN.");  
      twiml.hangup();  
      return res.type('text/xml').send(twiml.toString());  
    }  
  
    // Generate OTP  
    const otp = Math.floor(100000 + Math.random() * 900000).toString();  
    console.log('Generated OTP:', otp);  
    await setSession(`otp:${caller}`, { code: otp }, 300);  
  
    if (user.email) await debugEmail(user.email, "Your OTP Code", { message: `OTP: ${otp}` });  
  
    await setSession(`call:${caller}`, { stage: 'otp', pin, attempts: 0 }, 25);  
    twiml.pause({ length: 1 });  
    twiml.gather({  
      numDigits: 6,  
      action: `${BASE_URL}/verify-otp`,  
      method: 'POST',  
      input: 'dtmf',  
      timeout: 10,  
      finishOnKey: '',  
      actionOnEmptyResult: true  
    }).say("OTP sent. Enter code.");  
  
    res.type('text/xml').send(twiml.toString());  
  
  } catch (err) {  
    console.error('Error /check-pin:', err);  
    const twiml = new VoiceResponse();  
    twiml.say("System error. Please try again later.");  
    twiml.hangup();  
    res.type('text/xml').send(twiml.toString());  
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
    const otp = await getSession(`otp:${caller}`);  
    console.log('Session call:', call, 'OTP:', otp);  

    if (!call || !otp || entered !== otp.code) {  
      await deleteSession(`call:${caller}`);  
      await deleteSession(`otp:${caller}`);  
      twiml.say("OTP failed.");  
      twiml.hangup();  
    } else {  
      await deleteSession(`otp:${caller}`);  
      await setSession(`call:${caller}`, { stage: 'dial', pin }, 600);  

      // 25-second window to enter the number to dial  
      twiml.gather({  
        numDigits: 15,  
        action: `${BASE_URL}/dial-number?pin=${pin}`,  
        method: 'POST',  
        input: 'dtmf',  
        timeout: 25,             // <-- wait up to 25 seconds  
        finishOnKey: '',  
        actionOnEmptyResult: true  
      }).say("Enter number to call within 25 seconds.");  
    }  

    res.type('text/xml').send(twiml.toString());  

  } catch (err) {  
    console.error('Error /verify-otp:', err);  
    const twiml = new VoiceResponse();  
    twiml.say("System error. Please try again later.");  
    twiml.hangup();  
    res.type('text/xml').send(twiml.toString());  
  }  
});


// ================= DIAL =================
app.post('/dial-number', twilioParser, async (req, res) => {
  try {
    console.log('--- /dial-number called ---');
    console.log('Request body:', req.body);
    console.log('Request query:', req.query);

    const twiml = new VoiceResponse();

    const numberToCall = req.body.Digits; // Number entered by caller
    const callerPin = req.query.pin;      // Caller PIN from session

    // Find the caller by PIN
    const caller = await findUser(callerPin);

    if (!caller) {
      console.log('Caller not recognized by PIN:', callerPin);
      twiml.say("Caller not recognized. Goodbye.");
      twiml.hangup();
      return res.type('text/xml').send(twiml.toString());
    }

    // If number is not yet provided, prompt user to enter number with 10s limit
    if (!numberToCall) {
      console.log('No number entered yet, prompting user...');
      twiml.gather({
        numDigits: 15,           // maximum digits user can enter
        action: `${BASE_URL}/dial-number?pin=${callerPin}`, // submit back here
        method: 'POST',
        timeout: 10,             // <-- 10 seconds to enter number
        finishOnKey: '',         // no special key to end input
        input: 'dtmf',
        actionOnEmptyResult: true
      }).say("Enter the number you want to call, quickly. You have ten seconds.");

      return res.type('text/xml').send(twiml.toString());
    }

    console.log(`Dialing ${numberToCall} for caller PIN: ${caller.pin}`);

    // Dial the number via Twilio
    const dial = twiml.dial({
      action: `${BASE_URL}/call-ended?pin=${caller.pin}`, // callback when call ends
      method: 'POST',
      callerId: TWILIO_NUMBER
    });

    dial.number(numberToCall); // Twilio will connect the call

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

    const user = await findUser(pin);

    if (user) {
      let remaining = minutesUsed;
      const now = Date.now();

      // Sort plans by expiry (soonest first)
      user.plans.sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));

      for (let plan of user.plans) {
        if (remaining <= 0) break;

        // Only use active plans
        if (new Date(plan.expiresAt).getTime() > now && plan.minutes > 0) {
          const used = Math.min(plan.minutes, remaining);
          plan.minutes -= used;
          remaining -= used;
          console.log(`Used ${used.toFixed(2)} min from plan ${plan.name}, remaining minutes: ${remaining.toFixed(2)}`);
        }
      }

      // If minutes remain, deduct from balance
      if (remaining > 0) {
        const cost = (remaining / 60) * RATE;
        user.balance = Math.max(0, user.balance - cost);
        console.log(`Deducted $${cost.toFixed(2)} from balance, new balance: ${user.balance.toFixed(2)}`);
      }

      // Update total calls
      user.totalCalls = (user.totalCalls || 0) + minutesUsed;
      await user.save();

      // Send call summary email
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

// Create new user (supports multiple plans)
app.post('/admin/create-user', async (req, res) => {
  const { amount, plan, key, email, phone } = req.body;
  if (key !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: "Unauthorized" });

  try {
    // Check if user already exists
    const existingUser = await User.findOne({ email });
    const isUnlimited = email === "uchendugoodluck067@gmail.com";

    if (!isUnlimited && existingUser) {
      return res.status(400).json({ error: "User with this email already exists" });
    }

    // Generate unique PIN
    let pin;
    do {
      pin = generatePin();
    } while (await User.findOne({ pin }));

    // Generate unique referral code
    let referralCode;
    do {
      referralCode = generateReferralCode();
    } while (await User.findOne({ referralCode }));

    const newUser = new User({
      pin,
      email,
      phone,
      balance: amount ? parseFloat(amount) : 0,
      plans: [], // empty plans array initially
      referralCode,
      totalCalls: 0,
      referralBonus: 0
    });

    // Activate initial plan if provided
    if (plan && PLANS[plan.toUpperCase()]) {
      const p = PLANS[plan.toUpperCase()];
      const expiresAt = new Date(Date.now() + p.days * 86400000);

      newUser.plans.push({
        name: plan.toUpperCase(),
        minutes: p.minutes,
        expiresAt,
        purchasedAt: new Date()
      });
    }

    await newUser.save();

    // Latest plan for emails & response
    const latestPlan = newUser.plans[newUser.plans.length - 1] || {
      name: "Wallet Only",
      minutes: 0,
      expiresAt: null
    };

    // Send account creation email
    try {
      await sendEmail(email, "Account Created", {
        title: "Account Created",
        email,
        pin,
        balance: newUser.balance.toFixed(2),
        planName: latestPlan.name,
        planMinutes: latestPlan.minutes,
        planExpires: latestPlan.expiresAt,
        referralCode: newUser.referralCode,
        referralBonus: newUser.referralBonus,
        totalCalls: newUser.totalCalls,
        message: "Your calling account is ready. Let's reshape the bounds of telecommunication"
      });
    } catch (err) {
      console.error("Email error:", err.message);
    }

    res.json({
      message: "User created",
      pin,
      balance: newUser.balance,
      plan: latestPlan.name,
      planMinutes: latestPlan.minutes,
      planExpires: latestPlan.expiresAt ? new Date(latestPlan.expiresAt) : null,
      referralCode: newUser.referralCode,
      phone: newUser.phone
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Admin top-up
app.post('/admin/topup', async (req, res) => {
  const { key, email, amount } = req.body;
  if (key !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: "Unauthorized" });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "User not found" });

    const topupAmount = parseFloat(amount) || 0;
    user.balance += topupAmount;

    // Cap balance for non-unlimited users
    if (user.email !== "uchendugoodluck067@gmail.com" && user.balance > 10000)
      user.balance = 10000;

    await user.save();

    // Latest plan for emails
    const latestPlan = user.plans[user.plans.length - 1] || {
      name: "Wallet Only",
      minutes: 0,
      expiresAt: null
    };

    // Send top-up email
    try {
      await sendEmail(user.email, "Wallet Top-up", {
        title: "Wallet Top-up",
        email: user.email,
        balance: user.balance.toFixed(2),
        planName: latestPlan.name,
        planMinutes: latestPlan.minutes,
        planExpires: latestPlan.expiresAt,
        message: `Your account has been topped up by $${topupAmount.toFixed(2)}. Current balance: $${user.balance.toFixed(2)}.`
      });
    } catch (err) {
      console.error("Email error:", err.message);
    }

    res.json({ message: "Top-up successful", balance: user.balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Admin activate plan (multi-plan support)
app.post('/admin/activate-plan', async (req, res) => {
  const { key, email, plan } = req.body;
  if (key !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: "Unauthorized" });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!PLANS[plan.toUpperCase()])
      return res.status(400).json({ error: "Invalid plan" });

    const p = PLANS[plan.toUpperCase()];
    const expiresAt = new Date(Date.now() + p.days * 86400000);

    user.plans.push({
      name: plan.toUpperCase(),
      minutes: p.minutes,
      expiresAt,
      purchasedAt: new Date()
    });

    await user.save();

    // Latest plan for emails & response
    const latestPlan = user.plans[user.plans.length - 1];

    try {
      await sendEmail(user.email, "Plan Activated", {
        title: "Plan Activated",
        email: user.email,
        planName: latestPlan.name,
        planMinutes: latestPlan.minutes,
        planExpires: latestPlan.expiresAt,
        message: `Your plan ${latestPlan.name} is now active and expires in ${p.days} day(s).`
      });
    } catch (err) {
      console.error("Email error:", err.message);
    }

    res.json({
      message: "Plan activated",
      plan: latestPlan.name,
      minutes: latestPlan.minutes,
      expires: latestPlan.expiresAt
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Get all users (keep same)
app.get('/admin/users', async (req, res) => {
  try {
    const users = await User.find().select('-__v');
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// =================== HEALTH CHECK ===================  
app.get('/', (req, res) => res.send('Teld Server Running 🚀'));

// =================== START SERVER ===================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});