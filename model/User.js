const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  minutes: {
    type: Number,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  purchasedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const userSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    unique: true
  },

  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },

  pin: {
    type: String,
    required: true
  },

  balance: {
    type: Number,
    default: 0
  },

  // 🔥 NEW SYSTEM — MULTIPLE PLANS
  plans: {
    type: [planSchema],
    default: []
  },

  referralCode: {
    type: String,
    unique: true
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});


// ======================================================
// 🚀 BACKWARD COMPATIBILITY (IMPORTANT)
// These make old code using planName, planMinutes, planExpires STILL WORK
// ======================================================

// Get ACTIVE plans only
userSchema.methods.getActivePlans = function () {
  const now = new Date();
  return this.plans.filter(p => p.expiresAt > now);
};

// Total remaining minutes across active plans
userSchema.virtual('planMinutes').get(function () {
  return this.getActivePlans().reduce((sum, p) => sum + p.minutes, 0);
});

// Name of most recent active plan
userSchema.virtual('planName').get(function () {
  const active = this.getActivePlans();
  if (active.length === 0) return null;
  return active[active.length - 1].name;
});

// Latest expiry date among active plans
userSchema.virtual('planExpires').get(function () {
  const active = this.getActivePlans();
  if (active.length === 0) return null;
  return active.sort((a, b) => b.expiresAt - a.expiresAt)[0].expiresAt;
});

// Allow virtuals in JSON response
userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });


module.exports = mongoose.model('User', userSchema);