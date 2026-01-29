const mongoose = require('mongoose');

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

  // ✅ NEW: Multiple plans instead of one
  plans: [
    {
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
    }
  ],

  referralCode: {
    type: String,
    unique: true
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('User', userSchema);