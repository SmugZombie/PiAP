'use strict';

const express = require('express');
const router = express.Router();
const profileService = require('../services/profileService');
const networkService = require('../services/networkService');

router.get('/', (req, res) => {
  try {
    res.json(profileService.getAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const profile = profileService.getById(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Not found' });
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const profile = profileService.create(req.body);
    res.status(201).json(profile);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const profile = profileService.update(req.params.id, req.body);
    res.json(profile);
  } catch (err) {
    const status = err.message === 'Profile not found' ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    profileService.remove(req.params.id);
    res.status(204).end();
  } catch (err) {
    const status = err.message === 'Profile not found' ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

router.post('/:id/start', async (req, res) => {
  try {
    const profile = profileService.getById(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Not found' });
    if (profile.active) return res.status(400).json({ error: 'Already active' });

    const active = profileService.getActiveProfile();
    if (active) {
      // Stop the currently running network before starting a new one
      await networkService.stopNetwork();
      profileService.setActive(active.id, false);
    }

    const { stdout, stderr } = await networkService.startNetwork(profile);
    const updated = profileService.setActive(profile.id, true);

    res.json({ profile: updated, stdout, stderr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/stop', async (req, res) => {
  try {
    const profile = profileService.getById(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Not found' });
    if (!profile.active) return res.status(400).json({ error: 'Not active' });

    const { stdout, stderr } = await networkService.stopNetwork();
    const updated = profileService.setActive(profile.id, false);

    res.json({ profile: updated, stdout, stderr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
