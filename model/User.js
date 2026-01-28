const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    unique: true
  },

  pin: {
    type: String,
    required: true
  },

  balance: {
    type: Number,
    default: 0
  },

  plan: {
    type: String,
    default: null
  },

  planMinutes: {
    type: Number,
    default: 0
  },

  planExpires: {
    type: Date,
    default: null
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

module.exports = mongoose.model('User', userSchema);