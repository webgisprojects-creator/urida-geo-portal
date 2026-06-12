import * as cityService from '../services/cityService.js';

export const getZoneSummary = async (req, res) => {
  const { city } = req.params;
  try {
    const data = await cityService.getZoneSummary(city);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getWardSummary = async (req, res) => {
  const { city } = req.params;
  try {
    const data = await cityService.getWardSummary(city);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
