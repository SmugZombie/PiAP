'use strict';

const express = require('express');
const path = require('path');

const profileRoutes = require('./routes/profiles');
const clientRoutes = require('./routes/clients');
const logRoutes = require('./routes/logs');
const adminApRoutes = require('./routes/adminAp');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve static UI
app.use(express.static(path.join(__dirname, '..', 'public')));

// Captive portal detection — browsers probe these URLs; redirect to portal page.
// This only fires when the guest AP is active and DNS points here.
const CAPTIVE_PROBE_PATHS = [
  '/generate_204',          // Android / Chrome
  '/hotspot-detect.html',   // Apple
  '/ncsi.txt',              // Windows
  '/connecttest.txt',       // Windows newer
  '/success.txt',           // Firefox
];

app.get(CAPTIVE_PROBE_PATHS, (req, res) => {
  res.redirect(302, '/portal');
});

app.use('/api/profiles', profileRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/admin-ap', adminApRoutes);

// Captive portal page
app.get('/portal', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'captive', 'index.html'));
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PiAP running on port ${PORT}`);
});
