require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const redis = require('redis');
const sendEmail = require('./mailer');

// MongoDB connection
const connectDB = require('./config/db');
const User = require('./model/User');

const { twiml: { VoiceResponse } } = twilio;
const app = express();

// ================= MIDDLEWARE =================
app.use('/admin', express.json());
const twilioParser = express.urlencoded({ extended: false });

// ================= PHONE NORMALIZER (FIX) =================
function normalizePhone(phone) {
  if (!phone) return null;
  return phone.toString().trim().replace(/\s+/g, '');
}

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
    await redisClient.set(key, JSON.stringify(data), { EX: ttl });
  } catch (err) { console.error('Redis setSession error:', err); }
}

async function getSession(key) {
  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) { console.error('Redis getSession error:', err); return null; }
}

async function deleteSession(key) {
  try { await redisClient.del(key); }
  catch (err) { console.error('Redis deleteSession error:', err); }
}

// ================= TWILIO =================
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const RATE = parseFloat(process.env.RATE_PER_MINUTE || "0");

// ================= BASE URL =================
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

// ================= MONGO DB CONNECT =================
connectDB();

// ================= HELPERS =================
async function findUser(pinOrPhone) {
  const value = normalizePhone(pinOrPhone);
  let user = await User.findOne({
    $or: [
      { pin: value },
      { phone: value }
    ]
  });
  return user;
}

async function deductMinutes(user, minutes) {
  let remaining = minutes;
  const now = Date.now();

  if (user.planMinutes > 0 && now < new Date(user.planExpires).getTime()) {
    const usedFromPlan = Math.min(user.planMinutes, remaining);
    user.planMinutes -= usedFromPlan;
    remaining -= usedFromPlan;
  }

  if (remaining > 0) {
    const cost = (remaining / 60) * RATE;
    user.balance = Math.max(0, user.balance - cost);
  }

  await user.save();
}

function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
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

async function debugEmail(to, subject, body) {
  try {
    if (!to) return;
    await sendEmail(to, subject, body);
  } catch (err) {
    console.error('Email error:', err);
  }
}

// ================= TWILIO VOICE FLOW =================
app.post('/voice', twilioParser, async (req, res) => {
  try {
    const twiml = new VoiceResponse();
    const caller = normalizePhone(req.body.From);

    const user = await findUser(caller);

    if (!user) {
      twiml.say("You are not registered.");
      twiml.hangup();
    } else {
      await setSession(`call:${caller}`, { stage: 'pin', attempts: 0 }, 500);

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
    const twiml = new VoiceResponse();
    twiml.say("System error. Please try again later.");
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});



 
 
// ================= CHECK PIN =================    
app.post('/check-pin', twilioParser, async (req, res) => {    
  try {    
    const twiml = new VoiceResponse();    
    const caller = normalizePhone(req.body.From);    
    const pin = req.body.Digits;    
    const call = await getSession(`call:${caller}`);    

    if (!pin || pin.length < 6) {    
      twiml.say("I did not receive all six digits.");    
      twiml.redirect(`${BASE_URL}/voice`);    
      return res.type('text/xml').send(twiml.toString());    
    }    

    if (!call) {    
      twiml.say("Session expired.");    
      twiml.hangup();    
      return res.type('text/xml').send(twiml.toString());    
    }    

    call.attempts++;    
    const user = await findUser(caller);    

    if (!user || user.pin !== pin || call.attempts > 3) {    
      await deleteSession(`call:${caller}`);    
      twiml.say("Invalid PIN.");    
      twiml.hangup();    
      return res.type('text/xml').send(twiml.toString());    
    }    

    const otp = Math.floor(100000 + Math.random() * 900000).toString();    
    await setSession(`otp:${caller}`, { code: otp }, 600);    
    // 🔹 Increase call session TTL to 5 minutes
    await setSession(`call:${caller}`, { stage: 'otp', pin, attempts: 0 }, 300);    

    if (user.email) {    
      await debugEmail(user.email, "Your OTP Code", {    
        message: `Your OTP code is: ${otp}. It will expire in 10 minutes.`    
      });    
    }    

    twiml.gather({    
      numDigits: 6,    
      action: `${BASE_URL}/verify-otp`,    
      method: 'POST',    
      input: 'dtmf',    
      timeout: 60,    
      finishOnKey: '',    
      actionOnEmptyResult: true    
    }).say("OTP sent. Enter the code within 60 seconds.");    

    res.type('text/xml').send(twiml.toString());    
  } catch (err) {    
    const twiml = new VoiceResponse();    
    twiml.say("System error. Please try again later.");    
    twiml.hangup();    
    res.type('text/xml').send(twiml.toString());    
  }    
});    



 
    
    
    // ================= VERIFY OTP =================        
app.post('/verify-otp', twilioParser, async (req, res) => {        
  try {        
    const twiml = new VoiceResponse();        
    const callerNumber = normalizePhone(req.body.From);        
    const entered = req.body.Digits;        
  
    const call = await getSession(`call:${callerNumber}`);        
    const otp = await getSession(`otp:${callerNumber}`);        
  
    if (!call || !otp || entered !== otp.code) {        
      await deleteSession(`call:${callerNumber}`);        
      await deleteSession(`otp:${callerNumber}`);        
      twiml.say("OTP failed.");        
      twiml.hangup();        
      return res.type('text/xml').send(twiml.toString());        
    }        
  
    await deleteSession(`otp:${callerNumber}`);        
  
    // 🔹 Extend session TTL for dial stage  
    await setSession(`call:${callerNumber}`, {        
      stage: 'dial',        
      pin: call.pin        
    }, 300);        
  
    twiml.gather({        
      numDigits: 15,        
      action: `${BASE_URL}/dial-number`,        
      method: 'POST',        
      input: 'dtmf',        
      timeout: 600,        
      finishOnKey: '',        
      actionOnEmptyResult: true        
    }).say("Enter number to call within sixty seconds.");        
  
    res.type('text/xml').send(twiml.toString());        
  
  } catch (err) {        
    console.error('Error /verify-otp:', err);        
    res.status(503).send('Service Unavailable');        
  }        
});        
  
  
  

 // ================= DIAL =================  
app.post('/dial-number', twilioParser, async (req, res) => {  
  const twiml = new VoiceResponse();  
  const callerNumberRaw = req.body.From;  
  let numberToCallRaw = req.body.Digits;  

  try {  
    const callerNumber = normalizePhone(callerNumberRaw);  

    const call = await getSession(`call:${callerNumber}`);  
    if (!call || call.stage !== 'dial' || !call.pin) {  
      twiml.say("Session expired. Goodbye.");  
      twiml.hangup();  
      return res.type('text/xml').send(twiml.toString());  
    }  

    const caller = await findUser(callerNumber);  
    if (!caller) {  
      twiml.say("Caller not recognized. Goodbye.");  
      twiml.hangup();  
      return res.type('text/xml').send(twiml.toString());  
    }  

    if (!numberToCallRaw) {  
      twiml.gather({  
        numDigits: 15,  
        action: `${BASE_URL}/dial-number`,  
        method: 'POST',  
        timeout: 60,  
        input: 'dtmf',  
        finishOnKey: '',  
        actionOnEmptyResult: true  
      }).say(  
        "Enter the country code followed by the number you want to call. Do not include the leading zero. You have sixty seconds."  
      );  
      return res.type('text/xml').send(twiml.toString());  
    }  

    // -------- Normalize target number --------  
    let numberToCall = numberToCallRaw.replace(/\D/g, '');  
    if (numberToCall.startsWith('0') && numberToCall.length > 1) {  
      numberToCall = numberToCall.substring(1);  
    }  
    numberToCall = '+' + numberToCall;  

    // -------- Calculate available time --------  
    let availableMinutes = 0;  
    const now = Date.now();  

    if (Array.isArray(caller.plans)) {  
      caller.plans.forEach(plan => {  
        if (plan.expiresAt && new Date(plan.expiresAt).getTime() > now) {  
          availableMinutes += plan.minutes || 0;  
        }  
      });  
    }  

    availableMinutes += (caller.balance || 0) / RATE;  

    if (availableMinutes <= 0) {  
      twiml.say("You have no minutes remaining.");  
      twiml.hangup();  
      return res.type('text/xml').send(twiml.toString());  
    }  

    const maxCallSeconds = Math.floor(availableMinutes * 60);  

    // ============ CONFERENCE BRIDGE INSTEAD OF DIRECT DIAL ============  
    const room = `room-${caller._id}-${Date.now()}`;  

    await setSession(`room:${room}`, { userId: caller._id }, maxCallSeconds + 60);  

    const dial = twiml.dial();  
    dial.conference({  
      startConferenceOnEnter: false,  
      endConferenceOnExit: true,  
      waitUrl: 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical'  
    }, room);  

    res.type('text/xml').send(twiml.toString());  

    // -------- Create outbound call leg --------  
    await client.calls.create({  
      to: numberToCall,  
      from: TWILIO_NUMBER,  
      url: `${BASE_URL}/outbound-join?room=${room}`,  
      statusCallback: `${BASE_URL}/call-ended`,  
      statusCallbackEvent: ['completed'],  
      timeLimit: maxCallSeconds  
    });  

  } catch (err) {  
    console.error('Error /dial-number:', err);  
    twiml.say("System error. Please try again later.");  
    twiml.hangup();  
    res.type('text/xml').send(twiml.toString());  
  }  
});  


// ================= OUTBOUND JOIN =================  
app.post('/outbound-join', twilioParser, (req, res) => {  
  const room = req.query.room;  
  const twiml = new VoiceResponse();  

  const dial = twiml.dial();  
  dial.conference({  
    startConferenceOnEnter: true,  
    endConferenceOnExit: true  
  }, room);  

  res.type('text/xml').send(twiml.toString());  
});  



     // ================= CALL ENDED (BILLING CORE) =================
app.post('/call-ended', twilioParser, async (req, res) => {
  try {
    // Twilio sends this only for real call legs — NOT OTP/PIN routes
    const callerNumber = normalizePhone(req.body.From);
    const callStatus = req.body.CallStatus; // completed, busy, no-answer etc
    const durationSeconds = parseInt(req.body.CallDuration || 0); // in SECONDS

    // If call never actually connected, duration = 0
    if (callStatus !== 'completed' || durationSeconds <= 0) {
      return res.sendStatus(200); // nothing to bill
    }

    const minutesUsed = durationSeconds / 60; // convert once

    const user = await findUser(callerNumber);
    if (!user) return res.sendStatus(200);

    let remainingMinutesToCharge = minutesUsed;
    const now = Date.now();

    // -------- USE PLAN MINUTES FIRST --------
    if (Array.isArray(user.plans) && user.plans.length > 0) {
      // Use earliest expiring plan first
      user.plans.sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));

      for (let plan of user.plans) {
        if (remainingMinutesToCharge <= 0) break;

        const planValid = plan.expiresAt && new Date(plan.expiresAt).getTime() > now;
        if (planValid && plan.minutes > 0) {
          const used = Math.min(plan.minutes, remainingMinutesToCharge);
          plan.minutes -= used;
          remainingMinutesToCharge -= used;
        }
      }
    }

    // -------- THEN USE WALLET BALANCE --------
    if (remainingMinutesToCharge > 0) {
      const cost = remainingMinutesToCharge * RATE; // RATE = cost per minute
      user.balance = Math.max(0, user.balance - cost);
    }

    // -------- STATS --------
    user.totalCalls = (user.totalCalls || 0) + minutesUsed;

    await user.save();

    await debugEmail(user.email, "Call Summary", {
      message: `Call lasted ${(durationSeconds).toFixed(0)} seconds (${minutesUsed.toFixed(2)} minutes).`
    });

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